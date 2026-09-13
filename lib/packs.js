// ============================================================
// Add-on packs: Motion, Languages, Forms Pro and Lintel Plus.
//
// Sold as extra items on the customer's existing Stripe subscription, so
// they bill on the plan's invoice. The Stripe webhook (and the add-ons
// route, straight after a change) turns those items into rows in `packs`
// with syncPacksFromSubscription: one row per pack an item grants, and
// Lintel Plus grants every pack.
//
// The counting lives in the database (supabase/migrations/0011_packs.sql),
// so consume() is atomic: it locks the rows, rolls a finished month, and
// refuses rather than going past the cap. Only subscriptions in
// ACTIVE_STATUSES count, the same rule as building.
// ============================================================
import { supabaseAdmin } from './supabase.js';
import { ACTIVE_STATUSES } from './plans.js';

export const PACKS = {
  motion: {
    label: 'Motion',
    allowance: 6,               // clips a month
    per: 'month',
    priceEnv: 'STRIPE_PRICE_PACK_MOTION',
  },
  languages: {
    label: 'Languages',
    // Not used up month to month: the number of languages each site can
    // have. Translating and re-translating are charged as builds.
    allowance: 3,
    per: 'site',
    priceEnv: 'STRIPE_PRICE_PACK_LANGUAGES',
  },
  forms_pro: {
    label: 'Forms Pro',
    // Not sold on its own yet and nothing to count: Lintel Plus switches it on.
    allowance: 0,
    per: null,
    priceEnv: null,
  },
  plus: {
    label: 'Lintel Plus',
    // Grants every other pack, each row with that pack's own allowance.
    allowance: 0,
    per: null,
    priceEnv: 'STRIPE_PRICE_PACK_PLUS',
  },
};

export const PACK_NAMES = Object.keys(PACKS);
export const PLUS_GRANTS = PACK_NAMES.filter((p) => p !== 'plus');
// The ones with a Stripe price, in the order the dashboard shows them.
export const SELLABLE_PACKS = PACK_NAMES.filter((p) => PACKS[p].priceEnv);

// A Stripe price ID back to the pack it sells, or null for anything else
// (a plan, or an unset env var).
export function packForPrice(priceId) {
  if (!priceId) return null;
  return SELLABLE_PACKS.find((p) => process.env[PACKS[p].priceEnv] === priceId) || null;
}

function checkPack(pack) {
  if (!PACKS[pack]) throw new Error(`[packs] unknown pack "${pack}" (packs: ${PACK_NAMES.join(', ')})`);
}

async function rpc(admin, name, params) {
  const { data, error } = await admin.rpc(name, params);
  if (error) throw new Error(`[packs] ${name} failed: ${error.message}`);
  return data;
}

// The user's live rows, with this period's usage worked out by the database.
async function liveRows(userId) {
  return (await rpc(supabaseAdmin(), 'pack_rows', { p_user_id: userId, p_statuses: ACTIVE_STATUSES })) || [];
}

function totalsFor(rows, pack) {
  const mine = rows.filter((r) => r.pack === pack);
  const ends = mine.map((r) => r.periodEnd).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    has: mine.length > 0,
    own: mine.some((r) => !r.viaPlus),       // bought on its own
    viaPlus: mine.some((r) => r.viaPlus),    // comes with Lintel Plus
    allowance: mine.reduce((n, r) => n + r.allowance, 0),
    used: mine.reduce((n, r) => n + r.used, 0),
    remaining: mine.reduce((n, r) => n + Math.max(0, r.allowance - r.used), 0),
    periodEnd: ends[0] || null,
  };
}

export async function hasPack(userId, pack) {
  checkPack(pack);
  return totalsFor(await liveRows(userId), pack).has;
}

// What's left of the pack's allowance this period (0 without the pack).
export async function remaining(userId, pack) {
  checkPack(pack);
  return totalsFor(await liveRows(userId), pack).remaining;
}

// Every pack at once, for the dashboard.
export async function packSummary(userId) {
  const rows = await liveRows(userId);
  return Object.fromEntries(PACK_NAMES.map((p) => [p, totalsFor(rows, p)]));
}

/**
 * Uses n of the pack's monthly allowance. Atomic: takes all n or nothing.
 * Returns { ok: true, remaining } or, refusing at the cap,
 * { ok: false, reason: 'no_pack' | 'allowance_used', remaining }.
 */
export async function consume(userId, pack, n = 1) {
  checkPack(pack);
  if (PACKS[pack].per !== 'month') {
    throw new Error(`[packs] ${PACKS[pack].label} has no monthly allowance to use up`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`[packs] consume needs a whole number of at least 1, got ${n}`);
  }
  return rpc(supabaseAdmin(), 'consume_pack', {
    p_user_id: userId, p_pack: pack, p_n: n, p_statuses: ACTIVE_STATUSES,
  });
}

// Nightly: writes down the reset for rows whose month has ended. The other
// functions already treat those months as reset, so this is housekeeping.
export async function resetPeriods() {
  return (await rpc(supabaseAdmin(), 'reset_pack_periods', {})) || 0;
}

/**
 * Mirrors a Stripe subscription's add-on items into `packs`. Pass the whole
 * subscription as Stripe has it now, with every item. Throws on failure, so
 * the webhook answers 500 and Stripe retries.
 */
export async function syncPacksFromSubscription(admin, subscription, userId) {
  const grants = [];
  for (const item of subscription.items?.data || []) {
    const pack = packForPrice(item.price?.id);
    if (!pack) continue;
    for (const granted of pack === 'plus' ? ['plus', ...PLUS_GRANTS] : [pack]) {
      grants.push({ item_id: item.id, pack: granted, allowance: PACKS[granted].allowance });
    }
  }
  return rpc(admin, 'sync_subscription_packs', {
    p_user_id: userId,
    p_subscription_id: subscription.id,
    p_status: subscription.status,
    p_rows: grants,
  });
}
