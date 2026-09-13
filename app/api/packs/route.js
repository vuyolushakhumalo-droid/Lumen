// GET  /api/packs — the dashboard's Add-ons card: prices from Stripe, clips
//                   and languages bought and used, and Lintel Plus.
// POST /api/packs  { pack: 'plus', action: 'add' | 'remove' }
//
// Clips and languages are one-off purchases that never expire, bought through
// /api/checkout/pack. Lintel Plus is the only recurring add-on: an extra item
// on the customer's plan subscription, billed on the same invoice. Adding it
// charges the rest of the billing month on the next invoice. Removing it ends
// it straight away with no refund: its clips are usable the moment it's
// added, so refunding the unused time would make them nearly free (and
// re-adding it in the same month carries on that month's clip usage; see
// 0012_one_off_packs.sql).
import { unstable_cache } from 'next/cache';
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';
import { stripeClient, isMissingResource } from '@/lib/stripe';
import { PACKS, MAX_QUANTITY, PLUS_MONTHLY_CLIPS, packForPrice, packSummary, syncPacksFromSubscription } from '@/lib/packs';
import { logError } from '@/lib/monitor';

export const dynamic = 'force-dynamic';
// No `fetchCache = 'force-no-store'`: Next passes it to unstable_cache, which
// would then never cache the price lookups (see app/api/admin/stats).

// Prices change in Stripe by making a new price, so an hour is plenty.
const priceInfo = unstable_cache(
  async (priceId) => {
    const p = await stripeClient().prices.retrieve(priceId);
    return {
      amount: p.unit_amount,
      currency: p.currency,
      interval: p.recurring?.interval || null,
      intervalCount: p.recurring?.interval_count || 1,
    };
  },
  ['pack-price-v1'],
  { revalidate: 3600 },
);

async function priceFor(name) {
  const priceId = process.env[PACKS[name].priceEnv];
  if (!priceId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    return await priceInfo(priceId);
  } catch (err) {
    logError('[packs] price lookup failed', name, err);
    return null;
  }
}

async function state(admin, userId) {
  const sub = await getSubscription(admin, userId);
  const active = !!sub && ACTIVE_STATUSES.includes(sub.status) && !!sub.stripe_subscription_id;
  const [summary, clipPrice, languagePrice, plusPrice] = await Promise.all([
    packSummary(userId), priceFor('motion'), priceFor('languages'), priceFor('plus'),
  ]);
  return {
    subscription: { active, status: sub?.status || 'none', interval: sub?.billing_interval || null },
    maxQuantity: MAX_QUANTITY,
    packs: {
      motion: { label: PACKS.motion.label, unit: PACKS.motion.unit, onSale: !!clipPrice, price: clipPrice, ...summary.motion },
      languages: { label: PACKS.languages.label, unit: PACKS.languages.unit, onSale: !!languagePrice, price: languagePrice, ...summary.languages },
      plus: { label: PACKS.plus.label, clipsPerMonth: PLUS_MONTHLY_CLIPS, onSale: !!plusPrice, price: plusPrice, ...summary.plus },
    },
  };
}

// A change Stripe refuses (a 4xx) is something the customer can act on, so
// it comes back as a 400 with Stripe's reason rather than a bare 500.
async function stripeChange(fn) {
  try {
    return await fn();
  } catch (err) {
    if (String(err?.type || '').startsWith('Stripe') && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) {
      throw new ApiError(400, `Stripe couldn't make that change: ${err.message}`);
    }
    throw err;
  }
}

export const GET = handler(async (request) => {
  const { user, admin } = await requireUser(request);
  return Response.json(await state(admin, user.id));
});

export const POST = handler(async (request) => {
  const { user, admin } = await requireUser(request);
  const { pack, action } = await request.json().catch(() => ({}));

  if (pack === 'motion' || pack === 'languages') {
    throw new ApiError(400, `${pack === 'motion' ? 'Clips' : 'Languages'} are bought as you need them rather than added to your plan.`);
  }
  if (pack !== 'plus') throw new ApiError(400, 'Choose Lintel Plus.');
  if (action !== 'add' && action !== 'remove') {
    throw new ApiError(400, 'Choose whether to add or remove Lintel Plus.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(500, 'Add-ons are not configured yet: STRIPE_SECRET_KEY is missing in Vercel.');
  }
  const priceId = process.env.STRIPE_PRICE_PACK_PLUS;
  if (!priceId) {
    throw new ApiError(500, 'Lintel Plus is not configured yet: the environment variable STRIPE_PRICE_PACK_PLUS is missing in Vercel.');
  }

  const existing = await getSubscription(admin, user.id);
  if (!existing || !ACTIVE_STATUSES.includes(existing.status) || !existing.stripe_subscription_id) {
    throw new ApiError(402, 'Lintel Plus joins your plan, so you need an active plan first.', { reason: 'no_subscription' });
  }

  let sub;
  try {
    sub = await stripeClient().subscriptions.retrieve(existing.stripe_subscription_id);
  } catch (err) {
    if (!isMissingResource(err)) throw err;
    throw new ApiError(409, "We couldn't find your subscription in Stripe. Please contact us and we'll sort it out.");
  }
  if (!ACTIVE_STATUSES.includes(sub.status)) {
    throw new ApiError(402, 'Lintel Plus joins your plan, so you need an active plan first.', { reason: 'no_subscription' });
  }

  const items = sub.items?.data || [];
  const plusItem = items.find((i) => packForPrice(i.price?.id) === 'plus');
  let change;

  if (action === 'add') {
    if (plusItem) throw new ApiError(400, 'Lintel Plus is already on your plan.');

    // Stripe bills a subscription's items together, so they must share its
    // billing period and currency.
    const price = await priceInfo(priceId);
    const planItem = items.find((i) => !packForPrice(i.price?.id));
    const planRecurring = planItem?.price?.recurring;
    if (planRecurring && (planRecurring.interval !== price.interval || (planRecurring.interval_count || 1) !== price.intervalCount)) {
      throw new ApiError(400, planRecurring.interval === 'year'
        ? "Lintel Plus is billed monthly, so it can't be added to an annual plan yet."
        : "Lintel Plus is billed on a different schedule from your plan, so it can't be added to it.");
    }
    if (planItem?.price?.currency && price.currency !== planItem.price.currency) {
      throw new ApiError(400, "Lintel Plus is priced in a different currency from your plan, so it can't be added to it.");
    }
    change = { items: [{ price: priceId, quantity: 1 }], proration_behavior: 'create_prorations' };
  } else {
    if (!plusItem) throw new ApiError(400, "Lintel Plus isn't on your plan.");
    change = { items: [{ id: plusItem.id, deleted: true }], proration_behavior: 'none' };
  }

  const updated = await stripeChange(() => stripeClient().subscriptions.update(sub.id, change));

  // Show the change straight away. The webhook makes the same sync, so a
  // failure here only delays the dashboard, and mustn't report the Stripe
  // change as failed.
  try {
    await syncPacksFromSubscription(admin, updated, user.id);
  } catch (err) {
    logError('[packs] sync after change failed; the webhook will catch up', err);
  }
  await admin.from('audit_log').insert({
    user_id: user.id,
    action: action === 'add' ? 'pack.added' : 'pack.removed',
    meta: { pack, subscription: sub.id },
  });

  return Response.json({ ok: true, ...(await state(admin, user.id)) });
});
