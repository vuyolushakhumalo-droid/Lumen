// ============================================================
// POST   /api/publish   { projectId, slug? }   -> take a project live
// DELETE /api/publish?projectId=...            -> unpublish
// GET    /api/publish?projectId=...            -> current status
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getUsageSnapshot } from '@/lib/usage';
import { findFreeSlug, validateSlug, makeSlug, publicUrl } from '@/lib/publish';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

async function ownedProject(admin, userId, projectId) {
  const { data } = await admin
    .from('projects').select('*')
    .eq('id', projectId).eq('user_id', userId).maybeSingle();
  if (!data) throw new ApiError(404, 'Project not found');
  return data;
}

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError(400, 'No project specified');

  await ownedProject(admin, profile.id, projectId);
  const { data: site } = await admin
    .from('sites').select('*').eq('project_id', projectId).maybeSingle();

  if (!site) return Response.json({ published: false });
  return Response.json({
    published: site.status === 'live',
    subdomain: site.subdomain,
    customDomain: site.custom_domain,
    url: publicUrl(site),
    lastDeployedAt: site.last_deployed_at,
  });
});

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { projectId, slug } = await request.json().catch(() => ({}));
  if (!projectId) throw new ApiError(400, 'No project specified');

  // Publishing is a paid feature — check the subscription is live.
  const snap = await getUsageSnapshot(admin, profile);
  if (!snap.active) {
    throw new ApiError(402, 'You need an active subscription to publish a site.', { reason: 'no_subscription' });
  }

  const project = await ownedProject(admin, profile.id, projectId);
  if (!project.current_code) {
    throw new ApiError(400, 'Build something first — there is nothing to publish yet.');
  }

  const { data: existing } = await admin
    .from('sites').select('*').eq('project_id', projectId).eq('user_id', profile.id).maybeSingle();

  // Work out the address.
  let subdomain;
  if (slug) {
    subdomain = validateSlug(makeSlug(slug));
    const { data: clash } = await admin
      .from('sites').select('id').eq('subdomain', subdomain).maybeSingle();
    if (clash && (!existing || clash.id !== existing.id)) {
      throw new ApiError(409, 'That web address is already taken — try another.');
    }
  } else {
    subdomain = existing?.subdomain || (await findFreeSlug(admin, project.name || 'site'));
  }

  const row = {
    project_id: projectId,
    user_id: profile.id,
    subdomain,
    status: 'live',
    last_deployed_at: new Date().toISOString(),
  };

  let site;
  if (existing) {
    const { data, error } = await admin
      .from('sites').update(row).eq('id', existing.id).eq('user_id', profile.id).select().single();
    if (error) throw new ApiError(500, 'Could not publish the site');
    site = data;
  } else {
    const { data, error } = await admin.from('sites').insert(row).select().single();
    if (error) throw new ApiError(500, 'Could not publish the site');
    site = data;
  }

  await admin.from('audit_log').insert({
    user_id: profile.id,
    action: 'site.published',
    meta: { projectId, subdomain },
  });

  return Response.json({
    published: true,
    subdomain: site.subdomain,
    customDomain: site.custom_domain,
    url: publicUrl(site),
  });
});

export const DELETE = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError(400, 'No project specified');

  await ownedProject(admin, profile.id, projectId);
  await admin.from('sites')
    .update({ status: 'draft' })
    .eq('project_id', projectId).eq('user_id', profile.id);

  return Response.json({ published: false });
});
