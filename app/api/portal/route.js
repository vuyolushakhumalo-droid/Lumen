// POST /api/portal — opens Stripe's billing portal (cancel, change card, invoices)
import { handler, requireUser, ApiError } from '@/lib/auth';
import { stripeClient, withStripeCustomer } from '@/lib/stripe';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request) => {
  const { user, profile, admin } = await requireUser(request);
  if (!profile.stripe_customer_id) throw new ApiError(400, 'No billing account yet');

  const session = await withStripeCustomer({ admin, user, profile, route: 'portal' }, (customer) =>
    stripeClient().billingPortal.sessions.create({
      customer,
      return_url: `${process.env.APP_URL}/dashboard`,
    })
  );
  return Response.json({ url: session.url });
});
