// ============================================================
// POST   /api/domains  { projectId, domain }  -> attach a custom domain
// DELETE /api/domains?projectId=...           -> detach it
//
// Attaching stores the domain and returns the DNS records the
// customer needs to set. If a Vercel token is configured, the
// domain is also registered with the hosting project automatically.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getUsageSnapshot } from '@/lib/usage';

export const dynamic = 'force-dynamic';

function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!d) throw new ApiError(400, 'Enter a domain, e.g. mystudio.com');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new ApiError(400, "That doesn't look like a valid domain.");
  if (d.length > 253) throw new ApiError(400, 'That domain is too long.');
  return d;
}

// Optional: register the domain with Vercel so certificates are issued.
async function addToVercel(domain) {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return { automated: false };

  const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';
  try {
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${projectId}/domains${teamQuery}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: domain }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body?.error?.code !== 'domain_already_exists') {
      console.error('[domains] vercel add failed', body);
      return { automated: false, error: body?.error?.message };
    }
    return { automated: true };
  } catch (err) {
    console.error('[domains] vercel call failed', err);
    return { automated: false };
  }
}

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const { projectId, domain } = await request.json().catch(() => ({}));
  if (!projectId) throw new ApiError(400, 'No project specified');

  const snap = await getUsageSnapshot(admin, profile);
  if (!snap.active) throw new ApiError(402, 'You need an active subscription to connect a domain.');

  const clean = cleanDomain(domain);

  const { data: taken } = await admin
    .from('sites').select('id, project_id').eq('custom_domain', clean).maybeSingle();
  if (taken && taken.project_id !== projectId) {
    throw new ApiError(409, 'That domain is already connected to another site.');
  }

  const { data: site } = await admin
    .from('sites').select('*').eq('project_id', projectId).eq('user_id', profile.id).maybeSingle();
  if (!site) throw new ApiError(400, 'Publish the site first, then connect your domain.');

  const vercel = await addToVercel(clean);

  const { data: updated, error } = await admin
    .from('sites').update({ custom_domain: clean }).eq('id', site.id).select().single();
  if (error) throw new ApiError(500, 'Could not save the domain');

  const apex = clean.split('.').length === 2;

  return Response.json({
    domain: updated.custom_domain,
    automated: vercel.automated,
    dns: apex
      ? [{ type: 'A', name: '@', value: '76.76.21.21' },
         { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }]
      : [{ type: 'CNAME', name: clean.split('.')[0], value: 'cname.vercel-dns.com' }],
    note: vercel.automated
      ? 'Add these records at your domain registrar. HTTPS is issued automatically once they resolve.'
      : 'Add these records at your registrar, then add this domain to the hosting project so a certificate can be issued.',
  });
});

export const DELETE = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError(400, 'No project specified');

  await admin.from('sites')
    .update({ custom_domain: null })
    .eq('project_id', projectId).eq('user_id', profile.id);

  return Response.json({ ok: true });
});
