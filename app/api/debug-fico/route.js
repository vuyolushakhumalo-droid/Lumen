// ============================================================
// TEMPORARY DEBUG ENDPOINT — remove after the "fico" investigation
// is done. Mirrors app/s/[slug]/route.js's lookup for slug "fico",
// but reports metadata instead of serving the page.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = supabaseAdmin();

  const { data: site } = await admin
    .from('sites')
    .select('id, project_id, status')
    .eq('subdomain', 'fico')
    .maybeSingle();

  let projectRef = null;
  try {
    projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  } catch (e) {}

  if (!site) {
    return Response.json({ site: null, project: null, supabaseProjectRef: projectRef });
  }

  const { data: project } = await admin
    .from('projects')
    .select('id, updated_at, current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  const code = project?.current_code || '';

  return Response.json({
    site: { id: site.id, project_id: site.project_id, status: site.status },
    project: project
      ? {
          id: project.id,
          updated_at: project.updated_at,
          codeLength: code.length,
          hasCopyright2026: code.includes('© 2026'),
          hasCopyright2024: code.includes('© 2024'),
          hasOpenTable: code.includes('opentable'),
        }
      : null,
    supabaseProjectRef: projectRef,
  });
}
