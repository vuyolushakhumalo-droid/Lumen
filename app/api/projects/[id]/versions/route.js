// GET /api/projects/:id/versions — powers the History panel
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const GET = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);

  const { data: project } = await admin
    .from('projects').select('id').eq('id', params.id).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const { data } = await admin
    .from('versions')
    .select('id, label, brief, model_used, created_at')
    .eq('project_id', params.id)
    .order('created_at', { ascending: false })
    .limit(30);

  return Response.json({ versions: data || [] });
});
