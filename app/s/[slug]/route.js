// ============================================================
// GET /s/:slug — serves a published customer site.
// This is what the public sees. No auth: it's a public website.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';
import { injectForms } from '@/lib/forms';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request, { params }) {
  const slug = String(params.slug || '').toLowerCase();
  const admin = supabaseAdmin();

  // TEMPORARY DEBUG: remove once the stale-content investigation is done.
  let supabaseHost = '';
  try { supabaseHost = new URL(process.env.SUPABASE_URL).hostname; } catch (e) {}

  const { data: site } = await admin
    .from('sites')
    .select('id, project_id, status')
    .eq('subdomain', slug)
    .maybeSingle();

  if (!site || site.status !== 'live') return notFound({ supabaseHost });

  // While migrating to lintelsites.com subdomains: once SITES_DOMAIN is
  // set, stop serving HTML here and redirect there instead. 307, not
  // 301 -- this needs to stay reversible while testing, and permanent
  // redirects get cached hard by browsers.
  const sitesDomain = (process.env.SITES_DOMAIN || '').toLowerCase();
  if (sitesDomain) {
    const { search } = new URL(request.url);
    return Response.redirect(`https://${slug}.${sitesDomain}${search}`, 307);
  }

  const { data: project } = await admin
    .from('projects')
    .select('current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  if (!project?.current_code) return notFound({ supabaseHost, projectId: site.project_id });

  const code = injectForms(project.current_code, site.id);

  return new Response(code, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // No caching: every request must reflect current projects.current_code.
      'Cache-Control': 'public, max-age=0, s-maxage=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      // TEMPORARY DEBUG headers: remove once the stale-content investigation is done.
      'X-Dbg-Project-Id': site.project_id,
      'X-Dbg-Code-Length': String(code.length),
      'X-Dbg-Has-2024': String(code.includes('© 2024')),
      'X-Dbg-Has-2026': String(code.includes('© 2026')),
      'X-Dbg-Supabase-Host': supabaseHost,
    },
  });
}

function notFound({ supabaseHost = '', projectId = '' } = {}) {
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
<p><a href="/">Build your own with Lintel</a></p></div></body></html>`,
    {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // TEMPORARY DEBUG headers: remove once the stale-content investigation is done.
        'X-Dbg-Supabase-Host': supabaseHost,
        'X-Dbg-Project-Id': projectId,
      },
    }
  );
}
