// POST /api/generate/preview  { projectId, brief }
// A fast, cheap teaser for an edit that's taking a while -- fired by
// the client only if the main edit request hasn't resolved within a
// couple of seconds. Never counted against the build allowance or the
// generation rate limit, since it isn't itself a generation attempt.
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription, logUsageEvent } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';
import { previewSummary } from '@/lib/anthropic';
import { rateLimitDb } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);

  // Separate, more generous budget from the real generation limiter --
  // this must never cannibalize a user's actual build rate limit, but
  // an unprotected endpoint that costs money per call still needs
  // some abuse guard.
  await rateLimitDb(admin, `preview:${profile.id}`, { max: 20 });

  const { projectId, brief } = await request.json().catch(() => ({}));
  if (!projectId) throw new ApiError(400, 'No project specified');
  if (!brief || typeof brief !== 'string') throw new ApiError(400, 'No request to preview');

  const { data: project } = await admin
    .from('projects').select('id').eq('id', projectId).eq('user_id', profile.id).maybeSingle();
  if (!project) throw new ApiError(404, 'Project not found');

  const sub = await getSubscription(admin, profile.id);
  if (!sub || !ACTIVE_STATUSES.includes(sub.status)) {
    throw new ApiError(402, 'You need an active subscription to build.');
  }

  let text, usage;
  try {
    ({ text, usage } = await previewSummary({ brief: brief.slice(0, 4000), signal: request.signal }));
  } catch (err) {
    if (err?.name === 'AbortError') return new Response(null, { status: 204 });
    throw err;
  }

  await logUsageEvent(admin, {
    userId: profile.id, projectId, model: 'haiku', usage, kind: 'preview',
  });

  return Response.json({ text });
});
