// POST /api/checkout/pack  { pack: 'motion' | 'languages', quantity: 1-50 }
// Creates a one-off Stripe Checkout Session (mode: 'payment') for clips or
// languages, like build top-ups. The quantity can still be changed on
// Stripe's page, between 1 and 50. They never expire: the webhook credits
// what was paid for to the customer's balance once Stripe confirms payment.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { stripeClient, withStripeCustomer } from '@/lib/stripe';
import { PACKS, BALANCE_PACKS, MAX_QUANTITY } from '@/lib/packs';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request) => {
  const { user, profile, admin } = await requireUser(request);
  const { pack, quantity = 1 } = await request.json().catch(() => ({}));

  if (!BALANCE_PACKS.includes(pack)) {
    throw new ApiError(400, 'Choose clips or languages.');
  }
  const n = typeof quantity === 'string' && /^\d+$/.test(quantity) ? Number(quantity) : quantity;
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
    throw new ApiError(400, `Choose between 1 and ${MAX_QUANTITY}.`);
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(500, 'Checkout is not configured yet: STRIPE_SECRET_KEY is missing in Vercel.');
  }
  const def = PACKS[pack];
  const price = process.env[def.priceEnv];
  if (!price) {
    throw new ApiError(500, `${def.label} is not configured yet: the environment variable ${def.priceEnv} is missing in Vercel.`);
  }

  // Reuses the saved Stripe customer, or makes one — including when the
  // saved one is a test-mode ID that doesn't exist under live keys.
  const session = await withStripeCustomer({ admin, user, profile, route: 'checkout/pack' }, (custId) =>
    stripeClient().checkout.sessions.create({
      mode: 'payment',
      customer: custId,
      line_items: [{
        price,
        quantity: n,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_QUANTITY },
      }],
      metadata: { supabase_user_id: user.id, pack },
      success_url: `${process.env.APP_URL}/dashboard?bought=${pack}#billing`,
      cancel_url: `${process.env.APP_URL}/dashboard#billing`,
    })
  );

  return Response.json({ url: session.url });
});
