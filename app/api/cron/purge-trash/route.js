// GET /api/cron/purge-trash
// Permanently deletes projects that have sat in Trash for 30+ days.
// Not user-facing — only callable by the scheduler, via a Bearer
// token that must match CRON_SECRET. Mirrors the webhook route's
// pattern of skipping requireUser() for service-to-service calls.
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expired, error: findError } = await admin
    .from('projects')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (findError) {
    console.error('[cron/purge-trash] lookup failed', findError);
    return Response.json({ error: 'Lookup failed' }, { status: 500 });
  }

  const ids = (expired || []).map((p) => p.id);
  if (!ids.length) return Response.json({ purged: 0 });

  const { error: deleteError } = await admin.from('projects').delete().in('id', ids);
  if (deleteError) {
    console.error('[cron/purge-trash] delete failed', deleteError);
    return Response.json({ error: 'Delete failed' }, { status: 500 });
  }

  return Response.json({ purged: ids.length });
}
