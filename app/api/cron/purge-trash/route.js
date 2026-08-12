// GET /api/cron/purge-trash
// Permanently deletes projects that have sat in Trash for 30+ days.
// Not user-facing — only callable by the scheduler, via a Bearer
// token that must match CRON_SECRET. Mirrors the webhook route's
// pattern of skipping requireUser() for service-to-service calls.
import { supabaseAdmin } from '@/lib/supabase';
import { deleteProjectImages } from '@/lib/images';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Runs first, independent of trash purge below -- unrelated concerns,
  // and trash purge has several early returns (lookup failure, nothing
  // expired, delete failure) that shouldn't gate this.
  const staleAttemptsSwept = await sweepStaleAttempts(admin);
  const oldAttemptsPurged = await purgeOldAttempts(admin);
  const rateLimitsSwept = await sweepRateLimits(admin);
  const versionsPruned = await pruneVersions(admin);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expired, error: findError } = await admin
    .from('projects')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (findError) {
    console.error('[cron/purge-trash] lookup failed', findError);
    return Response.json({ error: 'Lookup failed', staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned }, { status: 500 });
  }

  const ids = (expired || []).map((p) => p.id);
  if (!ids.length) return Response.json({ purged: 0, staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned });

  await Promise.all(ids.map((id) => deleteProjectImages(id)));

  const { error: deleteError } = await admin.from('projects').delete().in('id', ids);
  if (deleteError) {
    console.error('[cron/purge-trash] delete failed', deleteError);
    return Response.json({ error: 'Delete failed', staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned }, { status: 500 });
  }

  return Response.json({ purged: ids.length, staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned });
}

// On this runtime, a client disconnect kills the streaming function
// outright -- neither the route's own catch nor the ReadableStream's
// cancel() ever runs, so an aborted build's generation_attempts row can
// never be resolved at abort time. This sweeps anything left behind.
// 25 minutes: the generate routes' maxDuration is 800s (13.3 minutes),
// so a legitimate build can genuinely still be running at 15 -- this
// leaves real headroom above the slowest possible build instead of
// racing it.
async function sweepStaleAttempts(admin) {
  const cutoff = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('generation_attempts')
    .update({ status: 'aborted', stage: 'client_disconnect', finished_at: new Date().toISOString() })
    .eq('status', 'started')
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[cron/purge-trash] stale attempt sweep failed', error);
    return 0;
  }
  return data?.length || 0;
}

// generation_attempts is a log table with no other retention policy --
// left alone it grows forever. 30 days is well past anything the sweep
// above or normal debugging would need.
async function purgeOldAttempts(admin) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('generation_attempts')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[cron/purge-trash] old attempt purge failed', error);
    return 0;
  }
  return data?.length || 0;
}

// rate_limits accumulates one row per distinct key (per user, per IP,
// per site) touched by check_rate_limit(). Nothing else prunes it --
// this calls the DB function built for that (see
// supabase/migrations/0001_submissions.sql), which returns the deleted
// count directly rather than a set of rows.
async function sweepRateLimits(admin) {
  const { data, error } = await admin.rpc('sweep_rate_limits');
  if (error) {
    console.error('[cron/purge-trash] rate limit sweep failed', error);
    return 0;
  }
  return data || 0;
}

// versions keeps one row per build/edit/restore/fork with no other
// retention policy -- capped here at the same 100-per-project ceiling
// prune_versions() enforces (see supabase/migrations/0003_prune_versions.sql).
async function pruneVersions(admin) {
  const { data, error } = await admin.rpc('prune_versions', { p_keep: 100 });
  if (error) {
    console.error('[cron/purge-trash] version prune failed', error);
    return 0;
  }
  return data || 0;
}
