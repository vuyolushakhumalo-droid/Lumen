// ============================================================
// GET /api/export?projectId=...          -> download the site
// GET /api/export?projectId=...&all=1    -> everything (all versions)
//
// Our Ownership policy promises export at any time. This is it.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { slugify } from '@/lib/render';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');
  const wantAll = url.searchParams.get('all') === '1';

  if (!projectId) throw new ApiError(400, 'No project specified');

  const { data: project } = await admin
    .from('projects').select('*')
    .eq('id', projectId).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');
  if (!project.current_code) throw new ApiError(400, 'Nothing to export yet — build something first.');

  const name = slugify(project.name || 'site');

  // Single file: the live site, ready to host anywhere.
  if (!wantAll) {
    return new Response(project.current_code, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}-index.html"`,
      },
    });
  }

  // Full export: every version plus a readme, as a plain JSON bundle.
  const { data: versions } = await admin
    .from('versions')
    .select('id, label, brief, model_used, created_at, code')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(30);

  const { data: site } = await admin
    .from('sites').select('subdomain, custom_domain, status').eq('project_id', projectId).maybeSingle();

  const bundle = {
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    },
    published: site ? { subdomain: site.subdomain, customDomain: site.custom_domain, status: site.status } : null,
    currentSite: project.current_code,
    versions: (versions || []).map((v) => ({
      label: v.label,
      brief: v.brief,
      model: v.model_used,
      createdAt: v.created_at,
      html: v.code,
    })),
    readme:
      'This is a complete export of your Lumen project. "currentSite" is the live version — ' +
      'save it as index.html and host it anywhere. "versions" holds your earlier builds. ' +
      'Your site is yours: no attribution or permission required.',
  };

  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}-lumen-export.json"`,
    },
  });
});
