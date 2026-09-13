// GET  /api/packs — the dashboard's Add-ons card: each add-on, its price
//                   from Stripe, and the allowance used this period.
// POST /api/packs  { pack: 'motion' | 'languages' | 'plus', action: 'add' | 'remove' }
//
// Add-ons are extra items on the customer's existing plan subscription, so
// they bill on the same invoice. Adding charges the rest of the billing
// month on the next invoice. Removing ends the add-on straight away with no
// refund: its allowance is usable the moment it's added, so refunding the
// unused time would make it close to free (and a re-added pack carries on
// the month's usage rather than starting fresh; see 0011_packs.sql).
// Lintel Plus replaces Motion and Languages, and they're refunded pro rata
// when it does, since their usage carries over into Plus.
import { unstable_cache } from 'next/cache';
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';
import { stripeClient, isMissingResource } from '@/lib/stripe';
import { PACKS, PLUS_GRANTS, SELLABLE_PACKS, packForPrice, packSummary, syncPacksFromSubscription } from '@/lib/packs';
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

async function state(admin, userId) {
  const sub = await getSubscription(admin, userId);
  const active = !!sub && ACTIVE_STATUSES.includes(sub.status) && !!sub.stripe_subscription_id;
  const summary = await packSummary(userId);

  const packs = {};
  await Promise.all(SELLABLE_PACKS.map(async (name) => {
    const def = PACKS[name];
    const priceId = process.env[def.priceEnv];
    let price = null;
    if (priceId && process.env.STRIPE_SECRET_KEY) {
      try {
        price = await priceInfo(priceId);
      } catch (err) {
        logError('[packs] price lookup failed', name, err);
      }
    }
    packs[name] = {
      label: def.label,
      includes: def.allowance,   // what the add-on gives
      per: def.per,
      onSale: !!price,
      price,
      ...summary[name],          // what this user has now: has, own, viaPlus, allowance, used, remaining, periodEnd
    };
  }));

  return {
    subscription: { active, status: sub?.status || 'none', interval: sub?.billing_interval || null },
    packs,
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

  if (!SELLABLE_PACKS.includes(pack)) {
    throw new ApiError(400, 'Choose Motion, Languages or Lintel Plus.');
  }
  if (action !== 'add' && action !== 'remove') {
    throw new ApiError(400, 'Choose whether to add or remove the add-on.');
  }
  const def = PACKS[pack];
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(500, 'Add-ons are not configured yet: STRIPE_SECRET_KEY is missing in Vercel.');
  }
  const priceId = process.env[def.priceEnv];
  if (!priceId) {
    throw new ApiError(500, `${def.label} is not configured yet: the environment variable ${def.priceEnv} is missing in Vercel.`);
  }

  const existing = await getSubscription(admin, user.id);
  if (!existing || !ACTIVE_STATUSES.includes(existing.status) || !existing.stripe_subscription_id) {
    throw new ApiError(402, 'Add-ons join your plan, so you need an active plan first.', { reason: 'no_subscription' });
  }

  let sub;
  try {
    sub = await stripeClient().subscriptions.retrieve(existing.stripe_subscription_id);
  } catch (err) {
    if (!isMissingResource(err)) throw err;
    throw new ApiError(409, "We couldn't find your subscription in Stripe. Please contact us and we'll sort it out.");
  }
  if (!ACTIVE_STATUSES.includes(sub.status)) {
    throw new ApiError(402, 'Add-ons join your plan, so you need an active plan first.', { reason: 'no_subscription' });
  }

  // A plan plus at most three add-ons, well inside the items Stripe includes.
  const items = sub.items?.data || [];
  const itemFor = (name) => items.find((i) => packForPrice(i.price?.id) === name);
  const plusItem = itemFor('plus');
  let change;

  if (action === 'add') {
    if (itemFor(pack)) throw new ApiError(400, `${def.label} is already on your plan.`);
    if (pack !== 'plus' && plusItem) throw new ApiError(400, `Lintel Plus already includes ${def.label}.`);

    // Stripe bills a subscription's items together, so they must share its
    // billing period and currency.
    const price = await priceInfo(priceId);
    const planItem = items.find((i) => !packForPrice(i.price?.id));
    const planRecurring = planItem?.price?.recurring;
    if (planRecurring && (planRecurring.interval !== price.interval || (planRecurring.interval_count || 1) !== price.intervalCount)) {
      throw new ApiError(400, planRecurring.interval === 'year'
        ? "Add-ons are billed monthly, so they can't be added to an annual plan yet."
        : "This add-on is billed on a different schedule from your plan, so it can't be added to it.");
    }
    if (planItem?.price?.currency && price.currency !== planItem.price.currency) {
      throw new ApiError(400, "This add-on is priced in a different currency from your plan, so it can't be added to it.");
    }

    const replaced = pack === 'plus' ? PLUS_GRANTS.map(itemFor).filter(Boolean) : [];
    change = {
      items: [{ price: priceId, quantity: 1 }, ...replaced.map((i) => ({ id: i.id, deleted: true }))],
      proration_behavior: 'create_prorations',
    };
  } else {
    const item = itemFor(pack);
    if (!item) {
      if (pack !== 'plus' && plusItem) throw new ApiError(400, `${def.label} comes with Lintel Plus. Remove Lintel Plus instead.`);
      throw new ApiError(400, `${def.label} isn't on your plan.`);
    }
    change = { items: [{ id: item.id, deleted: true }], proration_behavior: 'none' };
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
