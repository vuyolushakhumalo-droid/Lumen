// app/api/f/[siteId]/route.js
//
// Public, unauthenticated form capture for published Lintel sites.
// Every guard here is load-bearing: this is the only route that accepts
// anonymous writes.
//
// New env vars required in Vercel:
//   RESEND_API_KEY   - the same key used for Supabase SMTP, or a second one
//   FORM_IP_SALT     - any long random string; rotating it orphans old hashes

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';
export const maxDuration = 30;

const MAX_BODY_BYTES = 20 * 1024;
const MAX_FIELDS = 12;
const MAX_FIELD_LEN = 5000;
const HONEYPOT = 'company_website';

// Per-site limits. Generous for a real business, useless for a flood.
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 3600;

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
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

function hashIp(ip) {
  return crypto
    .createHmac('sha256', process.env.FORM_IP_SALT || 'lintel')
    .update(ip)
    .digest('hex')
    .slice(0, 32);
}

function ok(origin, body = { ok: true }) {
  return Response.json(body, { status: 200, headers: corsHeaders(origin) });
}

export async function POST(req, { params }) {
  const origin = req.headers.get('origin');
  const { siteId } = params;

  // --- body, size-capped before parsing -------------------------------
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: 'too_large' }, { status: 413, headers: corsHeaders(origin) });
  }

  let fields;
  try {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      fields = JSON.parse(raw);
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400, headers: corsHeaders(origin) });
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return Response.json({ error: 'bad_body' }, { status: 400, headers: corsHeaders(origin) });
  }

  // --- honeypot -------------------------------------------------------
  // A hidden field no human fills in. Answer 200 so bots learn nothing.
  if (typeof fields[HONEYPOT] === 'string' && fields[HONEYPOT].trim() !== '') {
    return ok(origin);
  }
  delete fields[HONEYPOT];

  // --- shape ----------------------------------------------------------
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.length > MAX_FIELDS) {
    return Response.json({ error: 'bad_shape' }, { status: 400, headers: corsHeaders(origin) });
  }
  const payload = {};
  for (const k of keys) {
    const v = fields[k];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.length > MAX_FIELD_LEN) {
      return Response.json({ error: 'field_too_long' }, { status: 400, headers: corsHeaders(origin) });
    }
    payload[String(k).slice(0, 64)] = s;
  }

  const kind = fields.__kind === 'list_signup' ? 'list_signup' : 'message';
  delete payload.__kind;

  const db = admin();

  // --- site must exist ------------------------------------------------
  const { data: site, error: siteErr } = await db
    .from('sites')
    .select('id, user_id, subdomain, status, notify_email')
    .eq('id', siteId)
    .single();

  if (siteErr || !site) {
    return Response.json({ error: 'unknown_site' }, { status: 404, headers: corsHeaders(origin) });
  }

  // --- rate limit, per site -------------------------------------------
  const { data: allowed } = await db.rpc('check_rate_limit', {
    p_key: `form:${site.id}`,
    p_limit: RATE_LIMIT,
    p_window_sec: RATE_WINDOW_SEC,
  });
  if (allowed === false) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: corsHeaders(origin) });
  }

  // --- store first ----------------------------------------------------
  const { data: row, error: insErr } = await db
    .from('submissions')
    .insert({
      site_id: site.id,
      user_id: site.user_id,
      kind,
      payload,
      ip_hash: hashIp(clientIp(req)),
      user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
    })
    .select('id')
    .single();

  if (insErr) {
    console.error('[form] insert failed', insErr);
    return Response.json({ error: 'store_failed' }, { status: 500, headers: corsHeaders(origin) });
  }

  // --- notify second, never blocking the success response -------------
  try {
    const { data: owner } = await db.auth.admin.getUserById(site.user_id);
    const to = site.notify_email || owner?.user?.email;
    if (to && process.env.RESEND_API_KEY) {
      const lines = Object.entries(payload)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Lintel <noreply@lintelapp.co.uk>',
          to,
          subject: `New enquiry from ${site.subdomain}`,
          text: `${lines}\n\n---\nSee all enquiries in your Lintel dashboard.`,
        }),
      });

      if (res.ok) {
        await db
          .from('submissions')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', row.id);
      } else {
        console.error('[form] resend failed', res.status, await res.text());
      }
    }
  } catch (e) {
    // Stored is what matters. notified_at stays null and the sweep retries.
    console.error('[form] notify threw', e);
  }

  return ok(origin, { ok: true, id: row.id });
}
