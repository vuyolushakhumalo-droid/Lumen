// PATCH  /api/projects/:id        — rename, or ?fork=true to duplicate
// DELETE /api/projects/:id        — remove a project
import { handler, requireUser, ApiError } from '@/lib/auth';
import { deleteProjectImages } from '@/lib/images';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

async function owned(admin, userId, id) {
  const { data } = await admin
    .from('projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!data) throw new ApiError(404, 'Project not found');
  return data;
}

export const PATCH = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);
  const project = await owned(admin, profile.id, params.id);
  const fork = new URL(request.url).searchParams.get('fork') === 'true';
  const body = await request.json().catch(() => ({}));

  if (fork) {
    const { data: copy, error } = await admin.from('projects').insert({
      user_id: profile.id,
      name: `Copy of ${project.name}`.slice(0, 80),
      current_code: project.current_code,
      preview_url: project.preview_url,
    }).select().single();
    if (error) throw new ApiError(500, 'Could not fork the project');

    if (project.current_code) {
      await admin.from('versions').insert({
        project_id: copy.id, label: 'Forked', brief: 'Forked from ' + project.name,
        code: project.current_code, model_used: 'fork',
      });
    }
    return Response.json({ project: copy });
  }

  if (typeof body.name === 'string' && body.name.trim()) {
    const { data } = await admin.from('projects')
      .update({ name: body.name.trim().slice(0, 80), updated_at: new Date().toISOString() })
      .eq('id', project.id).select().single();
    return Response.json({ project: data });
  }
  throw new ApiError(400, 'Nothing to update');
});

export const DELETE = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);
  const project = await owned(admin, profile.id, params.id);
  const permanent = new URL(request.url).searchParams.get('permanent') === 'true';

  if (permanent) {
    if (!project.deleted_at) {
      throw new ApiError(400, 'Move the project to Trash before deleting it permanently.');
    }
    await deleteProjectImages(params.id);
    await admin.from('projects').delete().eq('id', params.id);
    return Response.json({ ok: true, permanent: true });
  }

  await admin.from('projects')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', params.id);

  // Take any published site offline — a deleted project shouldn't stay live.
  await admin.from('sites')
    .update({ status: 'draft' })
    .eq('project_id', params.id);

  return Response.json({ ok: true });
});
