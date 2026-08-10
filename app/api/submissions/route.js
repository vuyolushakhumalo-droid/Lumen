// GET    /api/submissions — the signed-in user's form submissions, newest
//        first. Query params: site (optional site id filter), limit
//        (default 50, max 200), before (ISO timestamp cursor for paging).
// DELETE /api/submissions?id=... — deletes one submission, honouring an
//        erasure request from the visitor who submitted it.
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const params = new URL(request.url).searchParams;

  const site = params.get('site');
  const before = params.get('before');

  let limit = parseInt(params.get('limit'), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let query = admin
    .from('submissions')
    .select('id, site_id, kind, payload, created_at, sites(subdomain)')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (site) query = query.eq('site_id', site);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw new ApiError(500, 'Could not load submissions');

  const submissions = (data || []).map((s) => ({
    id: s.id,
    site_id: s.site_id,
    subdomain: s.sites?.subdomain || null,
    kind: s.kind,
    payload: s.payload,
    created_at: s.created_at,
  }));

  return Response.json({ submissions });
});

export const DELETE = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) throw new ApiError(400, 'Missing id');

  const { data, error } = await admin
    .from('submissions')
    .delete()
    .eq('id', id)
    .eq('user_id', profile.id)
    .select('id');

  if (error) throw new ApiError(500, 'Could not delete submission');
  if (!data || !data.length) throw new ApiError(404, 'Submission not found');

  return Response.json({ ok: true });
});
