// ============================================================
// GET /d/:host — serves a published site by its custom domain
// or by subdomain host. The middleware rewrites here.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request, { params }) {
  const host = String(params.host || '').toLowerCase().replace(/^www\./, '');
  const admin = supabaseAdmin();

  // 1) exact custom domain match
  let { data: site } = await admin
    .from('sites')
    .select('project_id, status')
    .eq('custom_domain', host)
    .maybeSingle();

  // 2) otherwise treat the first label as a subdomain (site.lumen.build)
  if (!site) {
    const base = (process.env.SITES_DOMAIN || '').toLowerCase();
    if (base && host.endsWith('.' + base)) {
      const slug = host.slice(0, -(base.length + 1));
      const res = await admin
        .from('sites')
        .select('project_id, status')
        .eq('subdomain', slug)
        .maybeSingle();
      site = res.data;
    }
  }

  if (!site || site.status !== 'live') return missing();

  const { data: project } = await admin
    .from('projects')
    .select('current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  if (!project?.current_code) return missing();

  return new Response(project.current_code, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function missing() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Site not found</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#05070C;color:#96A0AD;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
h1{color:#F5F6F9;font-size:24px;margin:0 0 10px;font-weight:600}a{color:#5FE0FF;text-decoration:none}</style>
</head><body><div><h1>This site isn't here</h1>
<p>No published site is connected to this address yet.</p>
<p><a href="https://lumen.build">Build one with Lumen</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
