// ============================================================
// Stripe client and customer lookup, shared by the billing routes.
//
// profiles.stripe_customer_id can hold an ID Stripe no longer knows
// under the current key — the test-mode customers left behind when the
// app switched to live keys. Every route that uses the saved ID goes
// through withStripeCustomer, which swaps a stale one for a fresh
// customer instead of failing the request.
// ============================================================
import Stripe from 'stripe';
import { logError } from './monitor.js';

// Created per-request, not at build time (env vars don't exist during build).
let _stripe = null;
export function stripeClient() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

function keyMode() {
  return /_live_/.test(process.env.STRIPE_SECRET_KEY || '') ? 'live' : 'test';
}

// Stripe answers "No such <object>" with code resource_missing when an ID
// doesn't exist under the current key. An ID from the other mode gets the
// same code, plus "a similar object exists in test mode" in the message.
export function isMissingResource(err) {
  return err?.code === 'resource_missing'
    || /a similar object exists in (test|live) mode/i.test(err?.message || '');
}

// Narrower: the missing object is the customer itself. A missing price or
// subscription is also resource_missing, and a new customer fixes neither.
function isStaleCustomer(err) {
  return isMissingResource(err)
    && (err.param === 'customer' || /no such customer/i.test(err.message || ''));
}

async function createCustomer(admin, user) {
  const customer = await stripeClient().customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });
  const { error } = await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', user.id);
  // Not fatal: this request can still go ahead with the new customer, and
  // the webhook re-links profile and customer when a checkout completes.
  if (error) logError('[stripe] could not save the new customer ID', { userId: user.id, customerId: customer.id }, error);
  return customer.id;
}

/**
 * Runs use(customerId) with the user's Stripe customer, creating one if
 * the profile has none. If Stripe says the saved customer doesn't exist
 * under the current key, a fresh customer replaces it on the profile and
 * use() runs once more. Only once: a second failure is a different problem.
 */
export async function withStripeCustomer({ admin, user, profile, route }, use) {
  let customerId = profile.stripe_customer_id || await createCustomer(admin, user);
  try {
    return await use(customerId);
  } catch (err) {
    if (!isStaleCustomer(err)) throw err;
    const staleCustomerId = customerId;
    customerId = await createCustomer(admin, user);
    console.warn('[stripe] saved customer does not exist under the current key; replaced it', {
      route, userId: user.id, staleCustomerId, customerId, keyMode: keyMode(),
    });
    return await use(customerId);
  }
}
