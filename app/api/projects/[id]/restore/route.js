// POST /api/projects/:id/restore  { versionId }
// Restoring is non-destructive: it appends a new version.
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);
  const { versionId } = await request.json().catch(() => ({}));

  const { data: project } = await admin
    .from('projects').select('*').eq('id', params.id).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const { data: version } = await admin
    .from('versions').select('*').eq('id', versionId).eq('project_id', params.id).maybeSingle();
  if (!version) throw new ApiError(404, 'Version not found');

  await admin.from('projects')
    .update({ current_code: version.code, updated_at: new Date().toISOString() })
    .eq('id', project.id).eq('user_id', profile.id);

  await admin.from('versions').insert({
    project_id: project.id,
    label: `Restored: ${version.label || 'version'}`,
    brief: 'Restored from history',
    code: version.code,
    model_used: 'restore',
  });

  return Response.json({ ok: true, code: version.code });
});
