// ============================================================
// POST /api/consent  { version }
// Records that a user accepted the Terms and Privacy Policy.
//
// Keeping a dated record of who agreed to which version is what
// makes the agreement provable later.
// ============================================================
import { handler, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { version } = await request.json().catch(() => ({}));

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;

  await admin.from('audit_log').insert({
    user_id: profile.id,
    action: 'terms.accepted',
    meta: {
      version: String(version || '1.0').slice(0, 20),
      ip,
      userAgent: (request.headers.get('user-agent') || '').slice(0, 300),
      at: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
});
