// ============================================================
// GET /d/:host and /d/:host/* — serves a published site by its custom
// domain or by subdomain host. The middleware rewrites here, now
// preserving the original pathname, so this is an optional catch-all
// that also handles robots.txt and sitemap.xml.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';
import { injectForms } from '@/lib/forms';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request, { params }) {
  const host = String(params.host || '').toLowerCase().replace(/^www\./, '');
  const admin = supabaseAdmin();

  // 1) exact custom domain match
  let { data: site } = await admin
    .from('sites')
    .select('id, project_id, status, last_deployed_at')
    .eq('custom_domain', host)
    .maybeSingle();

  // 2) otherwise treat the first label as a subdomain (site.lintelsites.com)
  if (!site) {
    const base = (process.env.SITES_DOMAIN || '').toLowerCase();
    if (base && host.endsWith('.' + base)) {
      const slug = host.slice(0, -(base.length + 1));
      const res = await admin
        .from('sites')
        .select('id, project_id, status, last_deployed_at')
        .eq('subdomain', slug)
        .maybeSingle();
      site = res.data;
    }
  }

  if (!site || site.status !== 'live') return missing();

  // Generated sites are single-file with section-based (#anchor)
  // navigation, so there are no real sub-paths today -- this is the
  // code to revisit if multi-file project storage lands.
  const rest = (params.rest || []).filter(Boolean);

  if (rest.length === 1 && rest[0] === 'robots.txt') {
    return new Response(
      `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`,
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  if (rest.length === 1 && rest[0] === 'sitemap.xml') {
    const lastmod = site.last_deployed_at
      ? new Date(site.last_deployed_at).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://${host}/</loc><lastmod>${lastmod}</lastmod></url>\n</urlset>\n`;
    return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }

  if (rest.length > 0) return missing();

  const { data: project } = await admin
    .from('projects')
    .select('current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  if (!project?.current_code) return missing();

  return new Response(injectForms(project.current_code, site.id), {
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
<p><a href="https://lintelapp.co.uk">Build one with Lintel</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
