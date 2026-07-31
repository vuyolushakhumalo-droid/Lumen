// POST /api/checkout/topup  { pack: 25 | 60 | 150 }
// Creates a one-off Stripe Checkout Session (mode: 'payment') for a
// build top-up pack. The webhook's checkout.session.completed handler
// already credits the purchase once Stripe confirms payment.
import { handler, requireUser, ApiError } from '@/lib/auth';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Created per-request, not at build time (env vars don't exist during build).
let _stripe = null;
function stripeClient() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// Stripe returns this when an ID doesn't exist in the current mode — e.g. a
// stripe_customer_id created under test keys, looked up after switching to
// live keys.
function isMissingResource(err) {
  return err?.code === 'resource_missing';
}

const TOPUP_ENV_NAMES = {
  25:  'STRIPE_PRICE_TOPUP_25',
  60:  'STRIPE_PRICE_TOPUP_60',
  150: 'STRIPE_PRICE_TOPUP_150',
};

export const POST = handler(async (request) => {
  const { user, profile, admin } = await requireUser(request);
  const { pack } = await request.json().catch(() => ({}));

  const envName = TOPUP_ENV_NAMES[pack];
  if (!envName) {
    throw new ApiError(400, 'Choose a 25, 60 or 150 build top-up.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(500, 'Checkout is not configured yet: STRIPE_SECRET_KEY is missing in Vercel.');
  }

  const price = process.env[envName];
  if (!price) {
    throw new ApiError(500, `Top-ups are not configured yet — the environment variable ${envName} is missing in Vercel.`);
  }

  // Reuse the Stripe customer if we already made one; if it doesn't exist
  // in the current mode (e.g. a test-mode ID after switching to live keys),
  // make a fresh one and save it. Same recovery pattern as /api/checkout.
  async function freshCustomer() {
    const customer = await stripeClient().customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', user.id);
    return customer.id;
  }

  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    customerId = await freshCustomer();
  }

  async function createSession(custId) {
    return stripeClient().checkout.sessions.create({
      mode: 'payment',
      customer: custId,
      line_items: [{ price, quantity: 1 }],
      metadata: { supabase_user_id: user.id, pack: String(pack) },
      success_url: `${process.env.APP_URL}/dashboard?topup=1`,
      cancel_url: `${process.env.APP_URL}/dashboard`,
    });
  }

  let session;
  try {
    session = await createSession(customerId);
  } catch (err) {
    if (!isMissingResource(err)) throw err;
    customerId = await freshCustomer();
    session = await createSession(customerId);
  }

  return Response.json({ url: session.url });
});
