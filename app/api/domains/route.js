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
import { addDomainToVercel, removeDomainFromVercel, recordsFor } from '@/lib/domains';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!d) throw new ApiError(400, 'Enter a domain, e.g. mystudio.com');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new ApiError(400, "That doesn't look like a valid domain.");
  if (d.length > 253) throw new ApiError(400, 'That domain is too long.');
  return d;
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

  const vercel = await addDomainToVercel(clean);

  // A newly attached domain is unverified by definition -- clear any
  // state left over from a previous domain on this site.
  const { data: updated, error } = await admin
    .from('sites')
    .update({
      custom_domain: clean,
      domain_status: 'pending',
      domain_checked_at: null,
      domain_error: null,
    })
    .eq('id', site.id).eq('user_id', profile.id).select().single();
  if (error) throw new ApiError(500, 'Could not save the domain');

  return Response.json({
    domain: updated.custom_domain,
    automated: vercel.automated,
    status: 'pending',
    dns: recordsFor(clean),
    note: vercel.automated
      ? 'Add these records at your domain registrar. HTTPS is issued automatically once they resolve.'
      : 'Add these records at your registrar, then add this domain to the hosting project so a certificate can be issued.',
  });
});

export const DELETE = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError(400, 'No project specified');

  // Read it first so we know what to release upstream.
  const { data: site } = await admin
    .from('sites').select('id, custom_domain')
    .eq('project_id', projectId).eq('user_id', profile.id).maybeSingle();

  // Best-effort: if Vercel won't let go of the domain, we still detach
  // it here. Leaving it registered upstream is untidy, not harmful.
  if (site?.custom_domain) await removeDomainFromVercel(site.custom_domain);

  await admin.from('sites')
    .update({
      custom_domain: null,
      domain_status: 'pending',
      domain_checked_at: null,
      domain_error: null,
    })
    .eq('project_id', projectId).eq('user_id', profile.id);

  return Response.json({ ok: true });
});
