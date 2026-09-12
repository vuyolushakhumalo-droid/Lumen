// POST /api/enquiry  { name, email, interest, message, company_website }
//
// Enquiries about Lintel's own services (Studio, Done for you) from the
// marketing site. Anonymous, so every guard matters: a size cap, a honeypot,
// and per-visitor plus global rate limits. Stored first, emailed second —
// a failed email never loses the enquiry.
//
// Env: RESEND_API_KEY (already used by site forms), FORM_IP_SALT.
import crypto from 'crypto';
import { handler, ApiError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { rateLimitDb } from '@/lib/ratelimit';
import { logError } from '@/lib/monitor';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const TEAM_EMAIL = 'support@lintelapp.co.uk';
const INTERESTS = { studio: 'Studio', done_for_you: 'Done for you', other: 'Something else' };
const MAX_BODY_BYTES = 12 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FALLBACK = 'That didn’t send — please email support@lintelapp.co.uk.';

// Postgres text columns reject NUL characters, so they are stripped first.
const NUL = new RegExp(String.fromCharCode(0), 'g');
const clean = (v, max) => String(v == null ? '' : v).replace(NUL, '').trim().slice(0, max);

function ipHash(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  return crypto.createHmac('sha256', process.env.FORM_IP_SALT || 'lintel').update(ip).digest('hex').slice(0, 32);
}

export const POST = handler(async (request) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new ApiError(413, 'That message is too long — try trimming it.');

  let body;
  try { body = JSON.parse(raw); } catch { throw new ApiError(400, FALLBACK); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, FALLBACK);

  // A hidden field no person fills in. Succeed quietly so bots learn nothing.
  if (clean(body.company_website, 200)) return Response.json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const message = clean(body.message, 4000);
  const interest = Object.prototype.hasOwnProperty.call(INTERESTS, body.interest) ? body.interest : 'studio';
  if (!name) throw new ApiError(400, 'Please add your name.');
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Please add an email address we can reply to.');
  if (message.length < 10) throw new ApiError(400, 'Tell us a little about the project.');

  const admin = supabaseAdmin();
  const visitor = ipHash(request);
  await rateLimitDb(admin, `enquiry:ip:${visitor}`, { max: 3, windowSec: 3600 });
  await rateLimitDb(admin, 'enquiry:all', { max: 60, windowSec: 3600 });

  const { data: row, error } = await admin
    .from('enquiries')
    .insert({
      interest, name, email, message,
      ip_hash: visitor,
      user_agent: clean(request.headers.get('user-agent'), 300),
    })
    .select('id')
    .single();
  if (error) {
    logError('[enquiry] insert failed', error);
    throw new ApiError(500, FALLBACK);
  }

  try {
    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Lintel <noreply@lintelapp.co.uk>',
          to: TEAM_EMAIL,
          reply_to: email,
          subject: `${INTERESTS[interest]} enquiry from ${name}`,
          text: `${INTERESTS[interest]} enquiry\n\nName: ${name}\nEmail: ${email}\n\n${message}\n\n---\nEnquiry ${row.id}`,
        }),
      });
      if (res.ok) {
        await admin.from('enquiries').update({ notified_at: new Date().toISOString() }).eq('id', row.id);
      } else {
        logError('[enquiry] resend failed', res.status, await res.text());
      }
    }
  } catch (err) {
    // Stored is what matters; notified_at stays null so it can be followed up.
    logError('[enquiry] notify threw', err);
  }

  return Response.json({ ok: true });
});
