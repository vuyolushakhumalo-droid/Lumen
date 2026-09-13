// GET /api/packs — the dashboard's Add-ons card: the price of one clip and of
// one language from Stripe, and how many of each the user has bought and
// used. They're bought through /api/checkout/pack and never expire.
import { unstable_cache } from 'next/cache';
import { handler, requireUser } from '@/lib/auth';
import { stripeClient } from '@/lib/stripe';
import { PACKS, BALANCE_PACKS, MAX_QUANTITY, packSummary } from '@/lib/packs';
import { logError } from '@/lib/monitor';

export const dynamic = 'force-dynamic';
// No `fetchCache = 'force-no-store'`: Next passes it to unstable_cache, which
// would then never cache the price lookups (see app/api/admin/stats).

// Prices change in Stripe by making a new price, so an hour is plenty.
const priceInfo = unstable_cache(
  async (priceId) => {
    const p = await stripeClient().prices.retrieve(priceId);
    return { amount: p.unit_amount, currency: p.currency };
  },
  ['pack-price-v2'],
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

export const GET = handler(async (request) => {
  const { user } = await requireUser(request);
  const [summary, ...prices] = await Promise.all([packSummary(user.id), ...BALANCE_PACKS.map(priceFor)]);

  const packs = {};
  BALANCE_PACKS.forEach((name, i) => {
    const { purchased, used, remaining } = summary[name];
    packs[name] = { label: PACKS[name].label, unit: PACKS[name].unit, onSale: !!prices[i], price: prices[i], purchased, used, remaining };
  });
  return Response.json({ maxQuantity: MAX_QUANTITY, packs });
});
