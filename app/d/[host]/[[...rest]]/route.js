// ============================================================
// GET /d/:host and /d/:host/* — serves a published site by its custom
// domain or by subdomain host. The middleware rewrites here, now
// preserving the original pathname, so this is an optional catch-all
// that also handles robots.txt and sitemap.xml.
// ============================================================
import { supabaseAdmin } from '@/lib/supabase';
import { injectForms } from '@/lib/forms';
import { injectAnalytics } from '@/lib/analytics';
import { injectSeo, parsePlan, extractTitle, extractDescription } from '@/lib/seo';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request, { params }) {
  const host = String(params.host || '').toLowerCase().replace(/^www\./, '');
  const admin = supabaseAdmin();

  // 1) exact custom domain match
  let { data: site } = await admin
    .from('sites')
    .select('id, project_id, status, last_deployed_at, custom_domain, domain_status')
    .eq('custom_domain', host)
    .maybeSingle();

  // 2) otherwise treat the first label as a subdomain (site.lintelsites.com)
  if (!site) {
    const base = (process.env.SITES_DOMAIN || '').toLowerCase();
    if (base && host.endsWith('.' + base)) {
      const slug = host.slice(0, -(base.length + 1));
      const res = await admin
        .from('sites')
        .select('id, project_id, status, last_deployed_at, custom_domain, domain_status')
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

  // A custom domain is the address that should rank -- but only once
  // it's confirmed live. custom_domain is written the moment the
  // customer types it, so pointing search engines at an unverified
  // domain would aim them at an address that may never resolve.
  const verifiedDomain = site.domain_status === 'verified' ? site.custom_domain : null;
  const preferredHost = verifiedDomain || host;
  const isCanonicalHost = !verifiedDomain || host === verifiedDomain;

  if (rest.length === 1 && rest[0] === 'robots.txt') {
    // robots.txt has to agree with the header and the meta tag. A
    // superseded subdomain saying "Allow: /" while serving noindex is
    // a mixed signal, and mixed signals get resolved against you.
    const body = isCanonicalHost
      ? `User-agent: *\nAllow: /\nSitemap: https://${preferredHost}/sitemap.xml\n`
      : `User-agent: *\nDisallow: /\n`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // The share card. Generated per request from the site's own name and
  // colour -- see lib/og.js for why it isn't stored at publish time.
  if (rest.length === 1 && rest[0] === 'og.png') {
    const { data: proj } = await admin
      .from('projects').select('current_code').eq('id', site.project_id).maybeSingle();
    const code = proj?.current_code || '';
    const plan = parsePlan(code) || {};
    try {
      const { renderOgImage } = await import('@/lib/og');
      const image = await renderOgImage({
        name: extractTitle(code),
        tagline: extractDescription(code),
        brandColor: plan.brandColor,
        headingFont: plan.headingFont,
      });

      // Materialise the body here, inside the try. An ImageResponse
      // renders lazily as it is piped, so returning it directly puts
      // the actual rendering outside this catch -- a failure then kills
      // the response mid-stream and the caller gets a reset connection
      // instead of the 404 below.
      const png = await image.arrayBuffer();

      return new Response(png, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          // The CDN holds it for a day so re-shares never hit the
          // renderer. The browser copy is deliberately short: an hour
          // of private caching means a fix to the card looks like it
          // did not deploy, which is exactly the confusion this
          // header caused the first time round.
          'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
        },
      });
    } catch (err) {
      // No card is a missing image. A 500 on a scraper's fetch can get
      // the whole page treated as broken, so fail small and quietly.
      console.error('[og] render failed', host, err);
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  if (rest.length === 1 && rest[0] === 'sitemap.xml') {
    // last_deployed_at only moves on an explicit (re)publish action --
    // ordinary edits go live immediately without one, so it's stale
    // relative to the actual content. updated_at tracks every edit.
    const { data: proj } = await admin
      .from('projects')
      .select('updated_at')
      .eq('id', site.project_id)
      .maybeSingle();
    const lastmodSource = proj?.updated_at || site.last_deployed_at;
    const lastmod = lastmodSource
      ? new Date(lastmodSource).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://${host}/</loc><lastmod>${lastmod}</lastmod></url>\n</urlset>\n`;
    return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }

  if (rest.length > 0) return pageNotFound(host);

  const { data: project } = await admin
    .from('projects')
    .select('current_code')
    .eq('id', site.project_id)
    .maybeSingle();

  if (!project?.current_code) return missing();

  let html = injectForms(project.current_code, site.id);
  html = injectAnalytics(html, site.id);

  // Canonical always points at the address that should rank, so a
  // superseded subdomain still tells search engines where the real
  // site lives rather than just vanishing from the index.
  html = injectSeo(html, {
    plan: parsePlan(project.current_code),
    canonicalUrl: `https://${preferredHost}/`,
    ogImageUrl: `https://${preferredHost}/og.png`,
    noindex: !isCanonicalHost,
  });

  // The gate the old comment here was waiting for. Now that a verified
  // flag exists, the subdomain can be de-indexed in favour of the real
  // domain -- and only when that domain is actually working, so a site
  // whose custom domain never went live keeps its subdomain indexed.
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, s-maxage=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };
  if (!isCanonicalHost) headers['X-Robots-Tag'] = 'noindex, nofollow';

  return new Response(html, { status: 200, headers });
}

function missing() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>Site not found</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#05070C;color:#96A0AD;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
h1{color:#F5F6F9;font-size:24px;margin:0 0 10px;font-weight:600}a{color:#5FE0FF;text-decoration:none}</style>
</head><body><div><h1>This site isn't here</h1>
<p>No published site is connected to this address yet.</p>
<p><a href="https://lintelapp.co.uk">Build one with Lintel</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } }
  );
}

// The site itself resolved fine (live, has content) -- this is a path
// under it that doesn't exist. Distinct from missing() above, which
// means the host isn't connected to a published site at all.
function pageNotFound(host) {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>Page not found</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#05070C;color:#96A0AD;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
h1{color:#F5F6F9;font-size:24px;margin:0 0 10px;font-weight:600}a{color:#5FE0FF;text-decoration:none}</style>
</head><body><div><h1>Page not found</h1>
<p>This site doesn't have a page at that address.</p>
<p><a href="https://${host}/">Back to the homepage</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } }
  );
}
