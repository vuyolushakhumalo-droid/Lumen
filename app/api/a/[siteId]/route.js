// app/api/a/[siteId]/route.js
//
// Public, unauthenticated analytics beacon for published Lintel sites.
// Same shape and the same guards as /api/f -- this is the second route
// that accepts anonymous writes.
//
// Cookieless by construction. No IP is stored, nothing is written to
// the visitor's device, and there is no cross-site or cross-day
// identifier, so this needs no cookie banner.
//
// New env var REQUIRED in Vercel:
//   ANALYTICS_SALT - any long random string. Without it this route
//                    records nothing at all. Rotating it orphans every
//                    existing visitor hash, which is the escape hatch.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';

const MAX_BODY_BYTES = 2 * 1024;
const MAX_FIELD_LEN = 120;

// Per site. A real small-business site does not see 600 views an hour;
// a flood does.
const RATE_LIMIT = 600;
const RATE_WINDOW_SEC = 3600;

// Cheap and deliberately incomplete -- this trims the obvious crawler
// traffic that would otherwise inflate a customer's numbers. It is not
// a security control; nothing here is trusted.
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|slack|preview|monitor|uptime|pingdom|lighthouse|headless|phantomjs|curl|wget|python-requests|axios|got\/|node-fetch/i;

const admin = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

// Every exit from this route is a 204. The beacon ignores the response
// body, and telling a caller why it was dropped only helps someone
// probing the endpoint.
function noContent(origin) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

// No salt, no recording. This used to fall back to a hardcoded key,
// which meant a deployment that forgot the env var silently wrote rows
// keyed by a value published in this repo -- enough for anyone holding
// a visitor's IP and user-agent to confirm they visited a given site on
// a given day. Failing closed costs page views; failing open costs the
// one guarantee this table makes.
let _warnedNoSalt = false;
function analyticsSalt() {
  const salt = process.env.ANALYTICS_SALT;
  if (salt) return salt;
  if (!_warnedNoSalt) {
    _warnedNoSalt = true;
    console.error('[analytics] ANALYTICS_SALT is not set -- refusing to record events');
  }
  return null;
}

// Identifies a returning visitor within one day and nothing beyond it:
// the day is inside the hash, so tomorrow the same person is a
// different string, and there is no way back to the IP.
function visitorHash(ip, ua, day, salt) {
  return crypto
    .createHmac('sha256', salt)
    .update(`${ip}|${ua}|${day}`)
    .digest('hex')
    .slice(0, 32);
}

function deviceFrom(ua) {
  const s = String(ua || '').toLowerCase();
  // Tablets first: an iPad's UA also matches the mobile patterns, and
  // Android tablets are Android without "mobile".
  if (/ipad|tablet|playbook|silk|kindle/.test(s)) return 'tablet';
  if (/android/.test(s) && !/mobile/.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(s)) return 'mobile';
  return 'desktop';
}

function clean(value, max = MAX_FIELD_LEN) {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, max);
  return s || null;
}

export async function POST(req, { params }) {
  const origin = req.headers.get('origin');
  const { siteId } = params;

  // --- opt-outs, before anything is read or written -------------------
  // Do Not Track and Global Privacy Control. The injected script also
  // checks both client-side, so this is the backstop for a beacon that
  // was already in flight or a hand-rolled request.
  if (req.headers.get('dnt') === '1' || req.headers.get('sec-gpc') === '1') {
    return noContent(origin);
  }

  // Before any lookup, hash or write: without a salt there is no
  // privacy-preserving way to record this, so we don't record it. Sits
  // with the opt-outs so a misconfigured deployment doesn't spend a
  // site lookup and a rate-limit slot per beacon either.
  const salt = analyticsSalt();
  if (!salt) return noContent(origin);

  const ua = (req.headers.get('user-agent') || '').slice(0, 300);
  if (!ua || BOT_RE.test(ua)) return noContent(origin);

  // --- body, size-capped before parsing -------------------------------
  // sendBeacon posts a plain string, so this arrives as text/plain and
  // never triggers a CORS preflight. Parsed leniently: a malformed body
  // is dropped, not reported.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return noContent(origin);

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return noContent(origin);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return noContent(origin);

  const section = clean(body.s) || 'home';
  const refHost = clean(body.r);

  const db = admin();

  // --- site must exist and be live ------------------------------------
  // An unpublished site records nothing: there is no legitimate traffic
  // to it, so anything arriving is noise or probing.
  const { data: site, error: siteErr } = await db
    .from('sites')
    .select('id, user_id, status')
    .eq('id', siteId)
    .single();

  if (siteErr || !site || site.status !== 'live') return noContent(origin);

  // --- rate limit, per site -------------------------------------------
  const { data: allowed } = await db.rpc('check_rate_limit', {
    p_key: `analytics:${site.id}`,
    p_limit: RATE_LIMIT,
    p_window_sec: RATE_WINDOW_SEC,
  });
  if (allowed === false) return noContent(origin);

  // --- record ----------------------------------------------------------
  const day = new Date().toISOString().slice(0, 10);
  const country = clean(req.headers.get('x-vercel-ip-country'), 8);

  const { error: insErr } = await db.from('site_events').insert({
    site_id: site.id,
    user_id: site.user_id,
    day,
    section,
    ref_host: refHost,
    country,
    device: deviceFrom(ua),
    visitor: visitorHash(clientIp(req), ua, day, salt),
  });

  // A dropped page view is not worth a visible failure on a customer's
  // site. Log it and answer 204 like every other path.
  if (insErr) console.error('[analytics] insert failed', insErr);

  return noContent(origin);
}
