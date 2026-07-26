// ============================================================
// GET /s/:slug — serves a published customer site.
// This is what the public sees. No auth: it's a public website.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const slug = String(params.slug || '').toLowerCase();
  const admin = supabaseAdmin();

  const { data: site } = await admin
    .from('sites')
    .select('project_id, status')
    .eq('subdomain', slug)
    .maybeSingle();

  if (!site || site.status !== 'live') return notFound();

  const { data: project } = await admin
    .from('projects')
    .select('current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  if (!project?.current_code) return notFound();

  return new Response(project.current_code, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // No caching: every request must reflect current projects.current_code.
      'Cache-Control': 'public, max-age=0, s-maxage=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function notFound() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site not found</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#05070C;color:#96A0AD;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
h1{color:#F5F6F9;font-size:24px;margin:0 0 10px;font-weight:600}
a{color:#5FE0FF;text-decoration:none}</style></head>
<body><div><h1>This site isn't here</h1>
<p>It may have been unpublished or moved.</p>
<p><a href="/">Build your own with Lumen</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
