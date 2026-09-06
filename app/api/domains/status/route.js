// ============================================================
// GET /api/domains/status?projectId=...  -> where a custom domain stands
//
// Asks Vercel whether the domain is verified and correctly configured,
// stores the answer on the site, and returns it with the DNS records
// still needed. Safe to call on every page load and behind a "Check
// again" button -- it's a read for the customer, a write for us.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { refreshDomainStatus } from '@/lib/domains';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new ApiError(400, 'No project specified');

  const { data: site } = await admin
    .from('sites')
    .select('id, custom_domain, domain_status, domain_checked_at, domain_error, domain_note')
    .eq('project_id', projectId)
    .eq('user_id', profile.id)
    .maybeSingle();
  if (!site) throw new ApiError(404, 'No site for this project');

  // No domain attached is a normal state, not an error. It may still
  // carry a note -- this is how a customer finds out the nightly
  // cleanup removed a domain they never pointed at us.
  if (!site.custom_domain) {
    return Response.json({
      domain: null,
      status: null,
      records: [],
      verification: [],
      error: null,
      checkedAt: null,
      note: site.domain_note || null,
    });
  }

  const out = await refreshDomainStatus(admin, site);

  return Response.json({
    domain: site.custom_domain,
    status: out.status,
    records: out.records,
    verification: out.verification,
    error: out.error,
    checkedAt: out.checkedAt,
    automated: out.automated,
    note: site.domain_note || null,
  });
});
