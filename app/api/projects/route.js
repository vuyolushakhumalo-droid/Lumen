// GET  /api/projects  — list the user's projects
// POST /api/projects  — create a new (empty) project
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { data } = await admin
    .from('projects')
    .select('id, name, preview_url, current_code, updated_at, sites(subdomain, custom_domain, status)')
    .eq('user_id', profile.id)
    .order('updated_at', { ascending: false });

  const projects = (data || []).map((p) => {
    const site = Array.isArray(p.sites) ? p.sites[0] : p.sites;
    return {
      id: p.id,
      name: p.name,
      preview_url: p.preview_url,
      current_code: p.current_code,
      updated_at: p.updated_at,
      hasBuild: !!p.current_code,
      published: !!site && site.status === 'live',
      subdomain: site?.subdomain || null,
      customDomain: site?.custom_domain || null,
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
