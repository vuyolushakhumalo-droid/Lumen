// POST /api/checkout  { plan, interval }
// Creates a Stripe Checkout Session with the 30-day trial attached.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

// Created per-request, not at build time (env vars don't exist during build).
let _stripe = null;
function stripeClient() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

const PRICE_IDS = {
  standard: { month: process.env.STRIPE_PRICE_STANDARD_MONTHLY, year: process.env.STRIPE_PRICE_STANDARD_ANNUAL },
  pro:      { month: process.env.STRIPE_PRICE_PRO_MONTHLY,      year: process.env.STRIPE_PRICE_PRO_ANNUAL },
  frontier: { month: process.env.STRIPE_PRICE_FRONTIER_MONTHLY, year: process.env.STRIPE_PRICE_FRONTIER_ANNUAL },
};

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
  if (existing && ACTIVE_STATUSES.includes(existing.status)) {
    if (existing.plan === plan && existing.billing_interval === interval) {
      throw new ApiError(400, "You're already on this plan.");
    }

    const stripeSub = await stripeClient().subscriptions.retrieve(existing.stripe_subscription_id);
    const itemId = stripeSub.items.data[0]?.id;
    if (!itemId) {
      throw new ApiError(500, 'Could not find your subscription item to update.');
    }

    await stripeClient().subscriptions.update(existing.stripe_subscription_id, {
      items: [{ id: itemId, price }],
      proration_behavior: 'create_prorations',
      metadata: { supabase_user_id: user.id, plan },
    });

    return Response.json({ ok: true, updated: true });
  }

  // Reuse the Stripe customer if we already made one.
  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const customer = await stripeClient().customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await admin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  const session = await stripeClient().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    subscription_data: {
      trial_period_days: 30,
      metadata: { supabase_user_id: user.id, plan },
    },
    metadata: { supabase_user_id: user.id, plan },
    allow_promotion_codes: true,
    success_url: `${process.env.APP_URL}/builder?subscribed=1`,
    cancel_url: `${process.env.APP_URL}/#pricing`,
  });

  return Response.json({ url: session.url });
});
