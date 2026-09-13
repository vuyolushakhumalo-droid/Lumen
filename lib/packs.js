// ============================================================
// Add-ons: Motion clips, Languages and Lintel Plus.
//
// Clips and languages are bought by quantity through Stripe Checkout, like
// build top-ups, and never expire. The webhook credits each purchase to a
// balance (one `packs` row per user and pack: purchased, used), recording it
// once in pack_purchases so a repeated webhook credits once.
//
// Lintel Plus is the only recurring add-on, an extra item on the customer's
// plan subscription, mirrored by syncPacksFromSubscription. Its row carries
// 6 clips a month; it makes languages unlimited and switches on Forms Pro.
// A Plus month's clips are used before bought ones.
//
// The counting lives in the database (supabase/migrations/0011_packs.sql and
// 0012_one_off_packs.sql), so consume() is atomic: it locks the rows, rolls a
// finished Plus month, and takes all n or refuses. Plus counts only while its
// subscription is in ACTIVE_STATUSES, the same rule as building; bought
// balances always count.
// ============================================================
import { supabaseAdmin } from './supabase.js';
import { ACTIVE_STATUSES } from './plans.js';

export const PLUS_MONTHLY_CLIPS = 6;
export const MAX_QUANTITY = 50;       // per purchase

export const PACKS = {
  motion: { label: 'Motion', unit: 'clip', priceEnv: 'STRIPE_PRICE_CLIP' },               // price of one clip
  languages: { label: 'Languages', unit: 'language', priceEnv: 'STRIPE_PRICE_LANGUAGE' }, // price of one language
  forms_pro: { label: 'Forms Pro', unit: null, priceEnv: null },                           // not sold: comes with Lintel Plus
  plus: { label: 'Lintel Plus', unit: null, priceEnv: 'STRIPE_PRICE_PACK_PLUS' },          // monthly
};

export const PACK_NAMES = Object.keys(PACKS);
export const BALANCE_PACKS = ['motion', 'languages'];
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

function summarise(rows) {
  const plusRows = rows.filter((r) => r.pack === 'plus');
  const ends = plusRows.map((r) => r.periodEnd).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  const plus = {
    has: plusRows.length > 0,
    clips: {
      allowance: plusRows.reduce((n, r) => n + r.allowance, 0),
      used: plusRows.reduce((n, r) => n + r.used, 0),
      remaining: plusRows.reduce((n, r) => n + Math.max(0, r.allowance - r.used), 0),
    },
    periodEnd: ends[0] || null,
  };
  const balance = (pack) => {
    const row = rows.find((r) => r.pack === pack);
    const purchased = row?.purchased || 0;
    const used = row?.used || 0;
    return { purchased, used, remaining: Math.max(0, purchased - used) };
  };
  const motion = balance('motion');
  return {
    // available: bought clips left plus what's left of this Plus month
    motion: { ...motion, available: motion.remaining + plus.clips.remaining },
    languages: { ...balance('languages'), unlimited: plus.has },
    forms_pro: { has: plus.has },
    plus,
  };
}

// Everything at once, for the dashboard.
export async function packSummary(userId) {
  return summarise((await rpc(supabaseAdmin(), 'pack_rows', { p_user_id: userId, p_statuses: ACTIVE_STATUSES })) || []);
}

// Whether the user can use the pack now: a clip left (this Plus month's or
// bought), a language left or unlimited, or Lintel Plus (or Forms Pro) live.
export async function hasPack(userId, pack) {
  checkPack(pack);
  const s = await packSummary(userId);
  if (pack === 'motion') return s.motion.available > 0;
  if (pack === 'languages') return s.languages.unlimited || s.languages.remaining > 0;
  return s.plus.has;
}

// Clips or languages left to use: Infinity for languages with Lintel Plus.
export async function remaining(userId, pack) {
  checkPack(pack);
  if (!BALANCE_PACKS.includes(pack)) throw new Error(`[packs] ${PACKS[pack].label} has nothing to count`);
  const s = await packSummary(userId);
  if (pack === 'motion') return s.motion.available;
  return s.languages.unlimited ? Infinity : s.languages.remaining;
}

/**
 * Uses n clips or languages. Atomic: takes all n or nothing, clips from this
 * Plus month before bought ones. Returns { ok: true, remaining },
 * { ok: true, unlimited: true } (languages with Plus), or, refusing,
 * { ok: false, reason: 'no_pack' | 'allowance_used', remaining }.
 */
export async function consume(userId, pack, n = 1) {
  checkPack(pack);
  if (!BALANCE_PACKS.includes(pack)) throw new Error(`[packs] ${PACKS[pack].label} has nothing to use up`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`[packs] consume needs a whole number of at least 1, got ${n}`);
  return rpc(supabaseAdmin(), 'consume_pack', {
    p_user_id: userId, p_pack: pack, p_n: n, p_statuses: ACTIVE_STATUSES,
  });
}

// Nightly: writes down the reset for Lintel Plus months that have ended. The
// other functions already treat those months as reset, so this is housekeeping.
export async function resetPeriods() {
  return (await rpc(supabaseAdmin(), 'reset_pack_periods', {})) || 0;
}

/**
 * Credits a paid purchase to the user's balance, once per Checkout Session
 * and pack. Returns { credited, purchased }. Throws on failure, so the
 * webhook answers 500 and Stripe retries.
 */
export async function creditPackPurchase(admin, { userId, pack, quantity, checkoutSessionId, paymentIntentId = null, amountTotal = null, currency = null }) {
  return rpc(admin, 'credit_pack_purchase', {
    p_user_id: userId,
    p_pack: pack,
    p_quantity: quantity,
    p_checkout_session_id: checkoutSessionId,
    p_payment_intent_id: paymentIntentId,
    p_amount_total: amountTotal,
    p_currency: currency,
  });
}

/**
 * Mirrors a Stripe subscription's Lintel Plus item into `packs`. Pass the
 * whole subscription as Stripe has it now, with every item. Throws on
 * failure, so the webhook answers 500 and Stripe retries.
 */
export async function syncPacksFromSubscription(admin, subscription, userId) {
  const rows = (subscription.items?.data || [])
    .filter((item) => packForPrice(item.price?.id) === 'plus')
    .map((item) => ({ item_id: item.id, pack: 'plus', allowance: PLUS_MONTHLY_CLIPS }));
  return rpc(admin, 'sync_subscription_packs', {
    p_user_id: userId,
    p_subscription_id: subscription.id,
    p_status: subscription.status,
    p_rows: rows,
  });
}
