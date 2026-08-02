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

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expired, error: findError } = await admin
    .from('projects')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (findError) {
    console.error('[cron/purge-trash] lookup failed', findError);
    return Response.json({ error: 'Lookup failed', staleAttemptsSwept, oldAttemptsPurged }, { status: 500 });
  }

  const ids = (expired || []).map((p) => p.id);
  if (!ids.length) return Response.json({ purged: 0, staleAttemptsSwept, oldAttemptsPurged });

  await Promise.all(ids.map((id) => deleteProjectImages(id)));

  const { error: deleteError } = await admin.from('projects').delete().in('id', ids);
  if (deleteError) {
    console.error('[cron/purge-trash] delete failed', deleteError);
    return Response.json({ error: 'Delete failed', staleAttemptsSwept, oldAttemptsPurged }, { status: 500 });
  }

  return Response.json({ purged: ids.length, staleAttemptsSwept, oldAttemptsPurged });
}

// On this runtime, a client disconnect kills the streaming function
// outright -- neither the route's own catch nor the ReadableStream's
// cancel() ever runs, so an aborted build's generation_attempts row can
// never be resolved at abort time. This sweeps anything left behind.
// 15 minutes, not 10: a legitimate build took 5 minutes, so this leaves
// headroom above the slowest real build.
async function sweepStaleAttempts(admin) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
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
