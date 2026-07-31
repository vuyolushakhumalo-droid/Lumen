// POST /api/portal — opens Stripe's billing portal (cancel, change card, invoices)
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

export const POST = handler(async (request) => {
  const { profile } = await requireUser(request);
  if (!profile.stripe_customer_id) throw new ApiError(400, 'No billing account yet');

  const session = await stripeClient().billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.APP_URL}/dashboard`,
  });
  return Response.json({ url: session.url });
});
