// POST /api/checkout/topup  { pack: 25 | 60 | 150 }
// Creates a one-off Stripe Checkout Session (mode: 'payment') for a
// build top-up pack. The webhook's checkout.session.completed handler
// already credits the purchase once Stripe confirms payment.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { stripeClient, withStripeCustomer } from '@/lib/stripe';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

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

  // Reuses the saved Stripe customer, or makes one — including when the
  // saved one is a test-mode ID that doesn't exist under live keys.
  const session = await withStripeCustomer({ admin, user, profile, route: 'checkout/topup' }, (custId) =>
    stripeClient().checkout.sessions.create({
      mode: 'payment',
      customer: custId,
      line_items: [{ price, quantity: 1 }],
      metadata: { supabase_user_id: user.id, pack: String(pack) },
      success_url: `${process.env.APP_URL}/dashboard?topup=1`,
      cancel_url: `${process.env.APP_URL}/dashboard`,
    })
  );

  return Response.json({ url: session.url });
});
