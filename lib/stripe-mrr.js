// ============================================================
// Monthly recurring revenue from Stripe: what each subscription actually
// bills, after its discounts, turned into a monthly amount.
//
// Paying = subscriptions Stripe has as 'active' (not trials, not past_due).
// Trials are totalled separately as the MRR they'd add on converting,
// leaving out trials already scheduled to cancel.
//
// - Amounts are as priced in Stripe, so they include VAT where the prices
//   are tax-inclusive.
// - Coupons: 'forever' always counts; 'repeating' counts until it ends;
//   'once' is ignored, since it doesn't recur. A percentage comes off the
//   amount; a fixed amount comes off each invoice, so it's spread over the
//   billing period, and only applies in its own currency.
// - A customer-level discount only applies when the subscription and its
//   items have no discounts of their own.
// - Prices without a fixed per-period amount (metered or tiered) can't be
//   turned into MRR here; they're left out and reported in notes.
// ============================================================

const MONTHS_PER_INTERVAL = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };

function monthlyAmount(amount, recurring) {
  const months = MONTHS_PER_INTERVAL[recurring?.interval];
  if (!months) return null;
  return amount / (months * (recurring.interval_count || 1));
}

// The coupons from a list of discounts that still reduce recurring revenue.
function readCoupons(discounts, nowSec, tally) {
  const coupons = [];
  for (const d of discounts || []) {
    if (!d || typeof d === 'string') { tally.discountsNotRead++; continue; }
    const c = d.coupon;
    if (!c || c.duration === 'once') continue;
    if (c.duration === 'repeating' && d.end && d.end <= nowSec) continue;
    coupons.push(c);
  }
  return coupons;
}

function applyCoupons(amount, coupons, currency, recurring) {
  let out = amount;
  for (const c of coupons) {
    if (c.percent_off != null) {
      out *= 1 - c.percent_off / 100;
    } else if (c.amount_off != null && (!c.currency || c.currency === currency)) {
      const off = monthlyAmount(c.amount_off, recurring);
      if (off != null) out -= off;
    }
  }
  return Math.max(0, out);
}

// One subscription's monthly amount, in its currency's minor units.
function valueOf(sub, nowSec, tally, planForPrice) {
  let total = 0;
  let currency = sub.currency || null;
  let billing = null;
  let plan = null;
  let itemDiscounts = false;

  for (const item of sub.items?.data || []) {
    const price = item.price;
    const recurring = price?.recurring;
    if (!price || price.unit_amount == null || recurring?.usage_type === 'metered' || !MONTHS_PER_INTERVAL[recurring?.interval]) {
      tally.itemsNotCounted++;
      continue;
    }
    billing = billing || recurring;
    currency = price.currency || currency;
    plan = plan || planForPrice(price.id);
    if ((item.discounts || []).length) itemDiscounts = true;
    const amount = monthlyAmount(price.unit_amount * (item.quantity ?? 1), recurring);
    total += applyCoupons(amount, readCoupons(item.discounts, nowSec, tally), price.currency, recurring);
  }

  let coupons = readCoupons(sub.discounts, nowSec, tally);
  if (!(sub.discounts || []).length && !itemDiscounts) {
    const customer = sub.customer && typeof sub.customer === 'object' ? sub.customer : null;
    if (customer?.discount) coupons = readCoupons([customer.discount], nowSec, tally);
  }
  if (billing) total = applyCoupons(total, coupons, currency, billing);

  return { amount: total, currency: currency || 'unknown', plan: plan || 'other' };
}

const toMajor = (minor) => Math.round(minor) / 100;

function addTo(totals, currency, amount) {
  totals[currency] = (totals[currency] || 0) + amount;
}

/**
 * Reads every active and trialing subscription from Stripe (paginating) and
 * returns MRR in major units. Throws if Stripe fails, so callers can avoid
 * caching a failure.
 */
export async function computeStripeMrr(stripe, { now = Date.now(), planForPrice = () => null } = {}) {
  const nowSec = Math.floor(now / 1000);
  const tally = { itemsNotCounted: 0, discountsNotRead: 0 };
  const expand = ['data.discounts', 'data.items.data.discounts', 'data.customer'];

  const paying = { count: 0, byCurrency: {}, byPlan: {} };
  for await (const sub of stripe.subscriptions.list({ status: 'active', limit: 100, expand })) {
    const v = valueOf(sub, nowSec, tally, planForPrice);
    paying.count++;
    addTo(paying.byCurrency, v.currency, v.amount);
    const p = (paying.byPlan[v.plan] = paying.byPlan[v.plan] || { count: 0, byCurrency: {} });
    p.count++;
    addTo(p.byCurrency, v.currency, v.amount);
  }

  const trials = { count: 0, setToCancel: 0, byCurrency: {} };
  for await (const sub of stripe.subscriptions.list({ status: 'trialing', limit: 100, expand })) {
    trials.count++;
    if (sub.cancel_at_period_end || sub.cancel_at) { trials.setToCancel++; continue; }
    const v = valueOf(sub, nowSec, tally, planForPrice);
    addTo(trials.byCurrency, v.currency, v.amount);
  }

  // Headline figures are in one currency: GBP if anything is billed in it,
  // otherwise whichever currency bills the most. Every currency is listed too.
  const all = { ...trials.byCurrency };
  for (const [c, a] of Object.entries(paying.byCurrency)) all[c] = (all[c] || 0) + a;
  const currency = 'gbp' in all ? 'gbp' : (Object.entries(all).sort((a, b) => b[1] - a[1])[0]?.[0] || 'gbp');

  const notes = [];
  if (tally.itemsNotCounted) notes.push(`${tally.itemsNotCounted} subscription item(s) without a fixed per-period price (metered or tiered) were left out.`);
  if (tally.discountsNotRead) notes.push(`${tally.discountsNotRead} discount(s) couldn't be read and weren't applied.`);

  return {
    computedAt: new Date(now).toISOString(),
    currency,
    paying: {
      count: paying.count,
      mrr: toMajor(paying.byCurrency[currency] || 0),
      mrrByCurrency: Object.fromEntries(Object.entries(paying.byCurrency).map(([c, a]) => [c, toMajor(a)])),
      byPlan: Object.fromEntries(Object.entries(paying.byPlan).map(([plan, p]) => [plan, { count: p.count, mrr: toMajor(p.byCurrency[currency] || 0) }])),
    },
    inTrial: {
      count: trials.count,
      mrrIfTheyConvert: toMajor(trials.byCurrency[currency] || 0),
      setToCancel: trials.setToCancel,
    },
    notes,
  };
}
