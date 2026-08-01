// ============================================================
// TEMPORARY DEBUG ENDPOINT — remove after confirming
// migration-006 (usage_events) and migration-007 (image_generations
// RLS) have been run. Checks table existence via a cheap count query;
// a missing table errors with a clear "relation does not exist".
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

async function checkTable(admin, table) {
  const { error, count } = await admin.from(table).select('id', { count: 'exact', head: true });
  if (error) return { exists: false, error: error.message };
  return { exists: true, rowCount: count ?? null };
}

export async function GET() {
  const admin = supabaseAdmin();

  const [usageEvents, imageGenerations] = await Promise.all([
    checkTable(admin, 'usage_events'),
    checkTable(admin, 'image_generations'),
  ]);

  return Response.json({ usage_events: usageEvents, image_generations: imageGenerations });
}
