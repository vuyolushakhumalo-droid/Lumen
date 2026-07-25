// POST /api/projects/:id/undelete — undo a soft-delete
// Clears deleted_at so the project reappears in listings. The site
// stays unpublished — restoring a project should never silently
// bring a site back online.
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);

  const { data: project } = await admin
    .from('projects').select('id').eq('id', params.id).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const { data, error } = await admin
    .from('projects')
    .update({ deleted_at: null })
    .eq('id', params.id)
    .select().single();
  if (error) throw new ApiError(500, 'Could not restore the project');

  return Response.json({ project: data });
});
