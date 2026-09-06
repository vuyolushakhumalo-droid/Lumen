// ============================================================
// POST /api/webhooks/stripe
// THIS is the real access gate. Stripe tells us who has paid,
// and this file writes that into the database.
//
// Signature-verified, idempotent, and never trusts the client.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';
import Stripe from 'stripe';
import { logError } from '@/lib/monitor';

export const dynamic = 'force-dynamic';

// Created per-request, not at build time (env vars don't exist during build).
let _stripe = null;
function stripeClient() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// Map a Stripe price ID back to one of our plans.
function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_STANDARD_MONTHLY]: 'standard',
    [process.env.STRIPE_PRICE_STANDARD_ANNUAL]:  'standard',
    [process.env.STRIPE_PRICE_PRO_MONTHLY]:      'pro',
    [process.env.STRIPE_PRICE_PRO_ANNUAL]:       'pro',
    [process.env.STRIPE_PRICE_FRONTIER_MONTHLY]: 'frontier',
    [process.env.STRIPE_PRICE_FRONTIER_ANNUAL]:  'frontier',
  };
  return map[priceId] || null;
}

const TOPUP_CREDITS = {
  [process.env.STRIPE_PRICE_TOPUP_25]:  25,
  [process.env.STRIPE_PRICE_TOPUP_60]:  60,
  [process.env.STRIPE_PRICE_TOPUP_150]: 150,
};

async function userIdForCustomer(admin, customerId, fallbackMetadata = {}) {
  if (fallbackMetadata.supabase_user_id) return fallbackMetadata.supabase_user_id;
  const { data } = await admin
    .from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  return data?.id || null;
}

async function upsertSubscription(admin, subscription) {
  const userId = await userIdForCustomer(admin, subscription.customer, subscription.metadata || {});
  if (!userId) {
    logError('[webhook] no user for customer', subscription.customer);
    return;
  }

  const item = subscription.items?.data?.[0];
  const plan = planFromPriceId(item?.price?.id) || subscription.metadata?.plan || 'standard';

  const row = {
    user_id: userId,
    plan,
    status: subscription.status,          // trialing | active | past_due | canceled | incomplete
    billing_interval: item?.price?.recurring?.interval || 'month',
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    trial_end: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString() : null,
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    stripe_subscription_id: subscription.id,
    updated_at: new Date().toISOString(),
  };

  // Idempotent: the same event arriving twice produces the same row.
  await admin.from('subscriptions').upsert(row, { onConflict: 'stripe_subscription_id' });
  await admin.from('audit_log').insert({
    user_id: userId,
    action: `subscription.${subscription.status}`,
    meta: { plan, subscription: subscription.id },
  });
}

export async function POST(request) {
  const admin = supabaseAdmin();
  const signature = request.headers.get('stripe-signature');
  const raw = await request.text();   // raw body required for verification

  let event;
  try {
    event = stripeClient().webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logError('[webhook] bad signature', err.message);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Subscription checkout — link the customer to the user.
        if (session.mode === 'subscription' && session.subscription) {
          const userId = session.metadata?.supabase_user_id;
          if (userId && session.customer) {
            await admin.from('profiles')
              .update({ stripe_customer_id: session.customer }).eq('id', userId);
          }
          const sub = await stripeClient().subscriptions.retrieve(session.subscription);
          await upsertSubscription(admin, sub);
        }

        // One-off top-up purchase.
        if (session.mode === 'payment') {
          const lineItems = await stripeClient().checkout.sessions.listLineItems(session.id, { limit: 5 });
          const priceId = lineItems.data?.[0]?.price?.id;
          const credits = TOPUP_CREDITS[priceId];
          const userId = await userIdForCustomer(admin, session.customer, session.metadata || {});
          if (credits && userId) {
            await admin.from('topups').insert({
              user_id: userId,
              credits_purchased: credits,
              credits_remaining: credits,
              stripe_payment_id: session.payment_intent,
            });
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await upsertSubscription(admin, event.data.object);
        break;

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await admin.from('subscriptions')
            .update({ status: 'past_due', updated_at: new Date().toISOString() })
            .eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }

      default:
        // Unhandled events are fine — acknowledge so Stripe stops retrying.
        break;
    }
  } catch (err) {
    logError('[webhook] handler failed', event.type, err);
    // 500 tells Stripe to retry, which is what we want on a transient failure.
    return new Response('Handler error', { status: 500 });
  }

  return Response.json({ received: true });
}
