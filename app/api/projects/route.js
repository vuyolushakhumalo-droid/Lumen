// GET  /api/projects  — list the user's projects
// POST /api/projects  — create a new (empty) project
import { handler, requireUser, ApiError } from '@/lib/auth';
import { offlineSummary } from '@/lib/publish';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const trashed = new URL(request.url).searchParams.get('trashed') === 'true';

  let query = admin
    .from('projects')
    .select('id, name, preview_url, current_code, updated_at, deleted_at, sites(id, subdomain, custom_domain, status, domain_status, offline_reason)')
    .eq('user_id', profile.id);

  query = trashed ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null);

  const { data } = await query.order(trashed ? 'deleted_at' : 'updated_at', { ascending: false });

  const projects = (data || []).map((p) => {
    const site = Array.isArray(p.sites) ? p.sites[0] : p.sites;
    return {
      id: p.id,
      name: p.name,
      preview_url: p.preview_url,
      current_code: p.current_code,
      updated_at: p.updated_at,
      deletedAt: p.deleted_at,
      hasBuild: !!p.current_code,
      published: !!site && site.status === 'live',
      siteId: site?.id || null,
      subdomain: site?.subdomain || null,
      customDomain: site?.custom_domain || null,
      domainStatus: site?.domain_status || null,
      // Set only when WE took the site offline -- the dashboard shows
      // 'Needs attention' rather than 'Draft' when it is present.
      needsAttention: !!site && site.status !== 'live' && !!site.offline_reason,
      offlineReason: site?.offline_reason ? offlineSummary(site.offline_reason) : null,
    };
  });

  return Response.json({ projects });
});

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { name } = await request.json().catch(() => ({}));
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: profile.id, name: (name || 'New project').slice(0, 80) })
    .select().single();
  if (error) throw new ApiError(500, 'Could not create the project');
  return Response.json({ project: data });
});
