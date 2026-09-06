// ============================================================
// POST /api/consent
// Records that a user accepted the Terms and Privacy Policy.
//
// The version is NOT taken from the request. The browser used to send
// its own string, which meant the recorded version was whatever the
// page posted -- and that recorded version is what makes the agreement
// provable later. It now comes from lib/terms.js, server-side, and
// anything the client sends is ignored.
//
// Two writes, both in lib/terms.js: the profile is stamped once (the
// state), and the log gets a dated row every time (the history).
// ============================================================
import { handler, requireUser } from '@/lib/auth';
import {
  TERMS_VERSION,
  stampTermsAccepted,
  recordTermsAudit,
  requestMeta,
} from '@/lib/terms';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { ip, userAgent } = requestMeta(request);

  await stampTermsAccepted(admin, profile.id);
  await recordTermsAudit(admin, profile.id, { ip, userAgent, source: 'signup' });

  return Response.json({ ok: true, version: TERMS_VERSION });
});
