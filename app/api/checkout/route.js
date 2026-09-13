// POST /api/checkout  { plan, interval }
// Creates a Stripe Checkout Session with a 7-day trial attached — new
// customers only. Anyone with a prior Stripe subscription (of any status)
// skips the trial.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';
import {
  stampTermsAccepted,
  hasTermsAudit,
  recordTermsAudit,
  requestMeta,
} from '@/lib/terms';
import { stripeClient, isMissingResource, withStripeCustomer } from '@/lib/stripe';
import { packForPrice } from '@/lib/packs';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const PRICE_IDS = {
  standard: { month: process.env.STRIPE_PRICE_STANDARD_MONTHLY, year: process.env.STRIPE_PRICE_STANDARD_ANNUAL },
  pro:      { month: process.env.STRIPE_PRICE_PRO_MONTHLY,      year: process.env.STRIPE_PRICE_PRO_ANNUAL },
  frontier: { month: process.env.STRIPE_PRICE_FRONTIER_MONTHLY, year: process.env.STRIPE_PRICE_FRONTIER_ANNUAL },
};

// A subscription saved under the other mode's key — a test-mode row left
// behind after going live — doesn't exist here. Treat it as no
// subscription, so a plan change becomes a real checkout instead of a 500.
async function retrieveSubscription(subscriptionId, userId) {
  if (!subscriptionId) return null;
  try {
    return await stripeClient().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (!isMissingResource(err)) throw err;
    console.warn('[stripe] saved subscription does not exist under the current key; starting a new checkout', {
      userId, subscriptionId,
    });
    return null;
  }
}

export const POST = handler(async (request) => {
  const { user, profile, admin } = await requireUser(request);
  const { plan = 'pro', interval = 'month' } = await request.json().catch(() => ({}));

  const ENV_NAMES = {
    standard: { month: 'STRIPE_PRICE_STANDARD_MONTHLY', year: 'STRIPE_PRICE_STANDARD_ANNUAL' },
    pro:      { month: 'STRIPE_PRICE_PRO_MONTHLY',      year: 'STRIPE_PRICE_PRO_ANNUAL' },
    frontier: { month: 'STRIPE_PRICE_FRONTIER_MONTHLY', year: 'STRIPE_PRICE_FRONTIER_ANNUAL' },
  };

  if (!ENV_NAMES[plan]) {
    throw new ApiError(400, `"${plan}" isn't a plan we sell. Choose Standard, Pro or Frontier.`);
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(500, 'Checkout is not configured yet: STRIPE_SECRET_KEY is missing in Vercel.');
  }

  const price = PRICE_IDS[plan]?.[interval];
  if (!price) {
    const missing = ENV_NAMES[plan][interval === 'year' ? 'year' : 'month'];
    throw new ApiError(500, `Checkout is not configured for this plan yet — the environment variable ${missing} is missing in Vercel.`);
  }

  // Already on a plan? Update that subscription in place instead of
  // starting a second one — Stripe prorates the difference automatically.
  const existing = await getSubscription(admin, user.id);
  const stripeSub = existing && ACTIVE_STATUSES.includes(existing.status)
    ? await retrieveSubscription(existing.stripe_subscription_id, user.id)
    : null;
  if (stripeSub) {
    if (existing.plan === plan && existing.billing_interval === interval) {
      throw new ApiError(400, "You're already on this plan.");
    }

    // Lintel Plus is an extra item on the same subscription: change the
    // plan's item, never whichever happens to come first.
    const planPrices = Object.values(PRICE_IDS).flatMap((p) => [p.month, p.year]).filter(Boolean);
    const planItem = stripeSub.items.data.find((i) => planPrices.includes(i.price?.id))
      || stripeSub.items.data.find((i) => !packForPrice(i.price?.id));
    const itemId = planItem?.id;
    if (!itemId) {
      throw new ApiError(500, 'Could not find your subscription item to update.');
    }
    // Stripe bills a subscription's items together, so they must share a
    // billing period; Lintel Plus is monthly.
    const addOns = stripeSub.items.data.filter((i) => i !== planItem && packForPrice(i.price?.id));
    if (addOns.some((i) => i.price?.recurring?.interval !== interval)) {
      throw new ApiError(400, interval === 'year'
        ? 'Lintel Plus is billed monthly, so remove it in Billing before switching to annual billing.'
        : 'Lintel Plus is billed on a different schedule, so remove it in Billing before switching.');
    }

    await stripeClient().subscriptions.update(existing.stripe_subscription_id, {
      items: [{ id: itemId, price }],
      proration_behavior: 'create_prorations',
      metadata: { supabase_user_id: user.id, plan },
    });

    return Response.json({ ok: true, updated: true });
  }

  async function createSession(custId, eligibleForTrial) {
    return stripeClient().checkout.sessions.create({
      mode: 'subscription',
      customer: custId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        ...(eligibleForTrial ? { trial_period_days: 7 } : {}),
        metadata: { supabase_user_id: user.id, plan },
      },
      metadata: { supabase_user_id: user.id, plan },
      allow_promotion_codes: true,
      // Stripe keeps its own independent record of the agreement, tied
      // to the payment rather than to our database.
      //
      // REQUIRES a Terms of Service URL in the Stripe Dashboard
      // (Settings -> Business -> Public details). Without it this call
      // fails outright and nobody can subscribe.
      consent_collection: { terms_of_service: 'required' },
      success_url: `${process.env.APP_URL}/builder?subscribed=1`,
      cancel_url: `${process.env.APP_URL}/#pricing`,
    });
  }

  // Terms, recorded server-side before we take any money. The browser's
  // consent call is fire-and-forget, and for an account that had to
  // confirm an email first it never fires at all -- sign-up returns
  // before there is a session to authenticate it with. So this is the
  // backstop: reaching checkout means going through the sign-up form and
  // its agreement checkbox, and no subscriber should exist without a
  // record of that. Both writes no-op if one is already there.
  await stampTermsAccepted(admin, user.id);
  if (!(await hasTermsAudit(admin, user.id))) {
    const { ip, userAgent } = requestMeta(request);
    await recordTermsAudit(admin, user.id, { ip, userAgent, source: 'checkout' });
  }

  // Reuses the saved Stripe customer, or makes one — including when the
  // saved one is a test-mode ID that doesn't exist under live keys.
  // Trial-once: no second free trial for a customer who has ever had a
  // subscription before, active or not.
  const session = await withStripeCustomer({ admin, user, profile, route: 'checkout' }, async (custId) => {
    const priorSubs = await stripeClient().subscriptions.list({ customer: custId, status: 'all', limit: 1 });
    return createSession(custId, priorSubs.data.length === 0);
  });

  return Response.json({ url: session.url });
});
