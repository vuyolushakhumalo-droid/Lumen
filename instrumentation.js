// Next's server-startup hook. Runs once per runtime, before any route
// handler, which is the only place Sentry can install the handlers that
// catch errors nothing else caught.
//
// Needs experimental.instrumentationHook in next.config.js on Next 14.
import * as Sentry from '@sentry/nextjs';
import { sentryOptions, monitoringEnabled } from './lib/monitor.js';

export async function register() {
  if (!monitoringEnabled()) return;      // no DSN locally is normal

  // The middleware runs on the edge runtime and the routes on node.
  // They are separate processes with separate globals, so each needs
  // its own init -- one is not the other's fallback.
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(sentryOptions);
  }
}

/**
 * Errors thrown out of a route handler or the middleware. Next calls
 * this for anything that escaped -- the cases our own try/catch never
 * saw, which are exactly the ones worth knowing about.
 */
export const onRequestError = Sentry.captureRequestError;
