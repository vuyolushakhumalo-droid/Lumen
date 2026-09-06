// ============================================================
// Error monitoring.
//
// Sentry sees that something broke and where. It must never see what
// the customer wrote, what their visitors sent them, or anything from
// the environment. Three kinds of data are actively kept out:
//
//   - generated site HTML (whole customer sites pass through the
//     generate routes, and a Supabase error can carry the row that
//     failed to write)
//   - enquiry contents (names, messages, phone numbers, whatever a
//     visitor typed into someone's contact form)
//   - email addresses, anywhere
//
// The approach is deny-by-default: nothing is attached to an event
// except values assembled here on purpose, and scrub() runs over the
// finished event as a backstop for anything the SDK collected itself.
//
// Two layers, because the first one was not enough on its own.
// Scrubbing the CONTENTS of a value only removes what we thought to
// look for -- an enquiry with its email address stripped is still an
// enquiry, and "call me back on Tuesday" is still what a visitor typed.
// So a value under a content-shaped KEY is removed whole, regardless of
// what is in it. Pattern-matching is the backstop, not the rule.
// ============================================================
import * as Sentry from '@sentry/nextjs';

const DSN = process.env.SENTRY_DSN || '';

/** Header names that must never leave the process. */
const HEADER_DENYLIST = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'apikey',
  'stripe-signature', 'x-vercel-signature', 'proxy-authorization',
]);

const EMAIL_RE = /\b[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}\b/gi;

/**
 * Keys whose VALUE is customer content, whatever it happens to contain.
 *
 * Scrubbing the contents of these was not enough: an enquiry with its
 * email removed is still an enquiry, and "Please call me back on
 * Tuesday" is exactly the thing a visitor typed into someone's contact
 * form. Pattern-matching the inside of a message can only ever catch
 * the patterns we thought of; knowing the field is customer content
 * settles it regardless of what is in there.
 *
 * Anchored, so a key that merely mentions one of these words survives —
 * logMessage and errorText are ours, message and text are theirs.
 */
const CONTENT_KEY_RE = new RegExp(
  '^(' + [
    'enquiry', 'enquiries', 'inquiry', 'inquiries',
    'message', 'messages', 'msg',
    'submission', 'submissions',
    'body', 'payload', 'form', 'formdata', 'fields',
    'brief', 'prompt', 'reply', 'answer',
    'content', 'text', 'note', 'notes', 'comment', 'comments',
    'html', 'code', 'current_code', 'currentcode', 'previoushtml',
    'name', 'phone', 'tel', 'address', 'postcode',
  ].join('|') + ')$',
  'i'
);

// Anything long enough to be a document rather than a message. A
// stack frame or an error string is short; a site is not.
const MAX_STRING = 500;

/**
 * True for a string that looks like markup rather than a message. A
 * whole customer site reaching Sentry is the single worst outcome here,
 * so this errs towards dropping.
 */
function looksLikeHtml(s) {
  return /<\/?(?:html|head|body|section|div|script|style|form)\b/i.test(s);
}

function scrubString(s) {
  let out = String(s);
  if (looksLikeHtml(out)) return '[html removed]';
  out = out.replace(EMAIL_RE, '[email removed]');
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + `… [${out.length} chars truncated]`;
  return out;
}

/**
 * Walks an event and scrubs every string in it. Depth- and breadth-
 * capped so a pathological object can't stall the process.
 */
function scrub(value, depth = 0) {
  if (depth > 6) return '[too deep]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      if (HEADER_DENYLIST.has(k.toLowerCase())) { out[k] = '[redacted]'; continue; }
      // The key decides, not the contents. Applied before recursing, so
      // a nested object under one of these names goes wholesale rather
      // than being walked and partially cleaned.
      if (CONTENT_KEY_RE.test(k)) { out[k] = '[content removed]'; continue; }
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return undefined;                       // functions, symbols -- not ours to send
}

/**
 * The last thing that runs before an event leaves. Everything above is
 * about what we choose to attach; this is about what the SDK attached
 * on its own, which is the half we don't control.
 */
export function beforeSend(event) {
  try {
    // The SDK can attach the whole process env on some integrations.
    // There is no version of this we want.
    if (event.contexts) delete event.contexts.runtime?.env;
    delete event.extra?.env;

    if (event.request) {
      const headers = event.request.headers || {};
      for (const name of Object.keys(headers)) {
        if (HEADER_DENYLIST.has(name.toLowerCase())) headers[name] = '[redacted]';
      }
      // A body can be an enquiry, a brief, or a whole site.
      delete event.request.data;
      delete event.request.cookies;
      if (event.request.query_string) event.request.query_string = scrubString(event.request.query_string);
      if (event.request.url) event.request.url = scrubString(event.request.url);
    }

    // No user identity: an id is enough to correlate, an email is not.
    if (event.user) {
      event.user = event.user.id ? { id: event.user.id } : undefined;
    }

    if (event.extra) event.extra = scrub(event.extra);
    if (event.contexts) event.contexts = scrub(event.contexts);
    if (event.tags) event.tags = scrub(event.tags);
    if (event.message) event.message = scrubString(event.message);

    for (const ex of event.exception?.values || []) {
      if (ex.value) ex.value = scrubString(ex.value);
    }
    for (const bc of event.breadcrumbs || []) {
      if (bc.message) bc.message = scrubString(bc.message);
      if (bc.data) bc.data = scrub(bc.data);
    }
    return event;
  } catch (err) {
    // A scrubber that throws must drop the event, not send it unscrubbed.
    console.error('[monitor] scrub failed, dropping the event', err);
    return null;
  }
}

export const sentryOptions = {
  dsn: DSN,
  // Every error, no sampling. There are few of them and each one
  // matters; a sampled-out error is a bug nobody hears about.
  sampleRate: 1.0,
  // Performance tracing off, deliberately: it is the expensive part,
  // and spans carry URLs and payload shapes we would then have to
  // scrub as carefully as everything else.
  tracesSampleRate: 0,
  enableTracing: false,
  // The SDK's own PII collection, off at the source rather than
  // scrubbed after the fact.
  sendDefaultPii: false,
  maxValueLength: MAX_STRING,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
  beforeSend,
};

/** Nothing initialises without a DSN, and that is a normal local state. */
export function monitoringEnabled() {
  return !!DSN;
}

/**
 * Waits for queued events to actually reach Sentry.
 *
 * This is not an optimisation. A serverless function is frozen the
 * moment it returns its response, so the SDK's send -- which is async
 * and fire-and-forget by design -- never completes. The event is
 * captured, queued, and then the process stops existing. Everything
 * looked fine at every step and nothing arrived.
 *
 * Always resolves. A flush that times out must not become the error.
 */
export async function flushMonitoring(timeout = 2000) {
  if (!DSN) return false;
  try {
    return await Sentry.flush(timeout);
  } catch (err) {
    console.error('[monitor] flush failed', err);
    return false;
  }
}

/**
 * What the process can see about its own monitoring, with nothing
 * secret in it. The DSN's host and project id say whether the value is
 * the shape we expect and which project it points at; the public key
 * is never included.
 */
export function diagnostics() {
  const out = {
    dsnConfigured: !!DSN,
    clientInitialised: false,
    dsnHost: null,
    dsnProjectId: null,
    dsnLooksValid: false,
    environment: sentryOptions.environment,
    release: sentryOptions.release || null,
    runtime: process.env.NEXT_RUNTIME || 'unknown',
    sampleRate: sentryOptions.sampleRate,
    tracesSampleRate: sentryOptions.tracesSampleRate,
  };

  try {
    // getClient() returns undefined when init never ran -- which is the
    // difference between "the DSN is set" and "the SDK is actually on".
    out.clientInitialised = !!Sentry.getClient();
  } catch { /* older SDKs, or not initialised */ }

  if (DSN) {
    try {
      const u = new URL(DSN);
      out.dsnHost = u.host;                                   // o0.ingest.sentry.io
      out.dsnProjectId = u.pathname.replace(/^\//, '') || null;
      // A DSN is https://<publicKey>@<host>/<projectId>. Missing the
      // key or the project id is the usual copy-paste failure, and the
      // SDK treats a malformed DSN as "disabled" without complaining.
      out.dsnLooksValid = !!(u.username && u.host && out.dsnProjectId);
    } catch {
      out.dsnLooksValid = false;
    }
  }

  return out;
}

/**
 * Report an error from a named route.
 *
 * Only the fields passed here are attached. Callers pass identifiers --
 * a route name, a site slug, a rule id -- never content.
 *
 * @param {unknown} error
 * @param {object}  o
 * @param {string}  o.route  e.g. 'api/publish'
 * @param {string} [o.slug]  the site's subdomain, when the failure is about one site
 * @param {object} [o.tags]  extra low-cardinality identifiers
 * @param {object} [o.extra] extra identifiers; scrubbed like everything else
 */
export function captureRouteError(error, { route, slug, tags = {}, extra = {} } = {}) {
  if (!DSN) return Promise.resolve(false);
  try {
    Sentry.withScope((scope) => {
      scope.setTag('route', route || 'unknown');
      if (slug) scope.setTag('site', slug);
      for (const [k, v] of Object.entries(tags)) {
        if (v != null) scope.setTag(k, String(v).slice(0, 100));
      }
      scope.setContext('detail', scrub(extra));
      scope.setLevel('error');
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
    // Returned, not awaited here: callers on a serverless path must
    // await this before returning, or the send never finishes.
    return flushMonitoring();
  } catch (err) {
    // Monitoring must never be the thing that breaks a request.
    console.error('[monitor] could not report an error', err);
    return Promise.resolve(false);
  }
}

/**
 * Drop-in for console.error that also reports.
 *
 * The codebase already prefixes every error log with its own tag --
 * "[cron/purge-trash] domain sweep lookup failed" -- so the route comes
 * out of the message that was already being written, rather than from
 * 34 hand-edited call sites that would drift the first time one moved.
 *
 * Everything after the message becomes scrubbed context. A Supabase
 * error object is not an Error and carries no stack, so an Error among
 * the arguments is preferred when there is one.
 *
 * Pass { slug } as the last argument to tag the site.
 */
export function logError(...args) {
  let opts = {};
  if (args.length > 1) {
    const last = args[args.length - 1];
    if (last && typeof last === 'object' && !(last instanceof Error) && typeof last.slug === 'string') {
      opts = args.pop();
    }
  }

  console.error(...args);
  if (!DSN) return Promise.resolve(false);

  const [first, ...rest] = args;
  const message = typeof first === 'string' ? first : String(first);
  const route = (message.match(/^\[([^\]]+)\]/) || [])[1] || 'unknown';
  const cause = rest.find((a) => a instanceof Error);

  const detail = {};
  rest.forEach((a, i) => {
    if (a instanceof Error) return;                       // already the exception
    detail[`arg${i}`] = a;
  });

  // Returns the flush promise. Safe to call without awaiting -- most
  // call sites do -- but a route on its way out should await it.
  return cause
    ? captureRouteError(cause, { route, slug: opts.slug, extra: { logMessage: message, ...detail } })
    : captureRouteMessage(message, { route, slug: opts.slug, extra: detail });
}

/**
 * The same, for a failure we detect and log rather than throw -- a
 * Supabase error object, say, which is not an Error and whose payload
 * may quote the row it refused to write.
 */
export function captureRouteMessage(message, opts = {}) {
  if (!DSN) return Promise.resolve(false);
  try {
    Sentry.withScope((scope) => {
      scope.setTag('route', opts.route || 'unknown');
      if (opts.slug) scope.setTag('site', opts.slug);
      for (const [k, v] of Object.entries(opts.tags || {})) {
        if (v != null) scope.setTag(k, String(v).slice(0, 100));
      }
      scope.setContext('detail', scrub(opts.extra || {}));
      scope.setLevel('error');
      Sentry.captureMessage(scrubString(message), 'error');
    });
    return flushMonitoring();
  } catch (err) {
    console.error('[monitor] could not report a message', err);
    return Promise.resolve(false);
  }
}
