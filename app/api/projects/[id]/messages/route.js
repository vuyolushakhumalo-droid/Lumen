// GET /api/projects/:id/messages — the conversation for a project
import { handler, requireUser, ApiError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);

  const { data: project } = await admin
    .from('projects').select('id').eq('id', params.id).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const { data } = await admin
    .from('messages')
    .select('id, role, content, plan, model_used, created_at')
    .eq('project_id', params.id)
    .order('created_at', { ascending: true })
    .limit(200);

  return Response.json({ messages: data || [] });
});
