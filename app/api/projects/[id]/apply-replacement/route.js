// POST /api/projects/:id/apply-replacement  { code, title }
// Commits a previously-generated "pending" full-document replacement
// that the edit-fallback similarity guard held back for confirmation.
// The candidate HTML was never persisted when it was generated -- the
// client holds it and sends it back here once the user explicitly
// agrees to apply it.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { makeSlug } from '@/lib/publish';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request, { params }) => {
  const { profile, admin } = await requireUser(request);
  const { code, title } = await request.json().catch(() => ({}));

  if (!code || typeof code !== 'string' || !/<html[\s>]/i.test(code)) {
    throw new ApiError(400, 'No valid replacement to apply.');
  }

  const { data: project } = await admin
    .from('projects').select('*').eq('id', params.id).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const label = title || project.name || 'Update';
  const previewUrl = `${makeSlug(label)}.lumen.build`;

  await admin.from('versions').insert({
    project_id: project.id,
    label,
    brief: 'Applied a held-back replacement',
    code,
    model_used: 'confirmed-replacement',
  });

  await admin.from('projects').update({
    current_code: code,
    preview_url: previewUrl,
    updated_at: new Date().toISOString(),
  }).eq('id', project.id);

  return Response.json({ ok: true, code, previewUrl });
});
