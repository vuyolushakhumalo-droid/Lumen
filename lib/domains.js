// ============================================================
// Custom-domain registration and verification against Vercel.
//
// Shared by POST/DELETE /api/domains, GET /api/domains/status, and the
// overnight sweep in the purge-trash cron -- all three need the same
// notion of "is this domain actually live yet".
//
// Everything here is best-effort by design. With no VERCEL_API_TOKEN or
// VERCEL_PROJECT_ID configured, domains are still saved and the
// customer is still shown DNS records, exactly as before; we simply
// never claim a domain is verified when we haven't confirmed it.
// Nothing in this file may throw into a request path.
// ============================================================

// Vercel's current recommendations. 76.76.21.21 is the legacy apex IP:
// it still resolves, but new domains should point at 216.150.1.1.
// These are only the fallback -- where Vercel tells us what it wants
// for a specific domain, that answer wins.
const DEFAULT_A = '216.150.1.1';
const DEFAULT_CNAME = 'cname.vercel-dns.com';

export function vercelConfigured() {
  return !!(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID);
}

function withTeam(path) {
  const team = process.env.VERCEL_TEAM_ID;
  if (!team) return path;
  return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}`;
}

// Never throws; returns { ok, status, body }.
async function vercelFetch(path, init = {}) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Registry suffixes that take a second label, so acme.co.uk is apex
// rather than a subdomain of co.uk. Not a full public-suffix list --
// just the ones our customers actually buy. Vercel's own apexName wins
// whenever we have it; this is only the offline fallback.
const MULTI_LABEL_SUFFIXES = [
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'com.au', 'co.nz', 'co.za',
];

// A domain is apex when it has no subdomain label.
function looksApex(domain) {
  const parts = String(domain).toLowerCase().split('.');
  if (parts.length === 2) return true;
  if (parts.length === 3) {
    return MULTI_LABEL_SUFFIXES.includes(parts.slice(-2).join('.'));
  }
  return false;
}

// Vercel returns recommendations as [{ rank, value: [...] }] for IPv4
// and [{ rank, value: '...' }] for CNAME. Accept either, plus a bare
// string, and ignore anything unrecognisable.
function pickRecommended(list) {
  const first = Array.isArray(list) ? list[0] : list;
  if (!first) return null;
  const value = typeof first === 'string' ? first : first?.value;
  const out = Array.isArray(value) ? value[0] : value;
  return typeof out === 'string' && out ? out : null;
}

/**
 * The DNS records the customer needs to set.
 * `config` is a /v6/domains/{domain}/config body when we have one --
 * its recommendations take precedence over our defaults.
 * `apexOverride` is Vercel's own apex determination when known.
 */
export function recordsFor(domain, config = null, apexOverride) {
  const a = pickRecommended(config?.recommendedIPv4) || DEFAULT_A;
  const cname = pickRecommended(config?.recommendedCNAME) || DEFAULT_CNAME;
  const apex = typeof apexOverride === 'boolean' ? apexOverride : looksApex(domain);

  return apex
    ? [
        { type: 'A', name: '@', value: a },
        { type: 'CNAME', name: 'www', value: cname },
      ]
    : [{ type: 'CNAME', name: String(domain).split('.')[0], value: cname }];
}

// The /config response shape is the one thing here we haven't been able
// to confirm against a live token -- specifically whether the
// recommended records come back as recommendedIPv4/recommendedCNAME.
// Log the whole body once per process so the first real call settles it.
// recordsFor() falls back to the documented defaults either way, so a
// wrong guess is invisible to customers; delete this once confirmed.
let _loggedConfigShape = false;
function logConfigShapeOnce(cfg) {
  if (_loggedConfigShape) return;
  _loggedConfigShape = true;
  try {
    console.debug('[domains] /v6 config response shape', JSON.stringify(cfg?.body));
  } catch {
    console.debug('[domains] /v6 config response was not serialisable');
  }
}

/** Register a domain with the hosting project so a certificate is issued. */
export async function addDomainToVercel(domain) {
  if (!vercelConfigured()) return { automated: false };
  try {
    const { ok, body } = await vercelFetch(
      withTeam(`/v10/projects/${process.env.VERCEL_PROJECT_ID}/domains`),
      { method: 'POST', body: JSON.stringify({ name: domain }) }
    );
    if (!ok && body?.error?.code !== 'domain_already_exists') {
      console.error('[domains] vercel add failed', body);
      return { automated: false, error: body?.error?.message };
    }
    return { automated: true };
  } catch (err) {
    console.error('[domains] vercel add call failed', err);
    return { automated: false };
  }
}

/**
 * Release a domain from the hosting project. Best-effort: a failure
 * here must never stop the customer detaching it on our side, it just
 * leaves the domain attached in Vercel for manual cleanup.
 */
export async function removeDomainFromVercel(domain) {
  if (!vercelConfigured() || !domain) return { automated: false };
  try {
    const { ok, status, body } = await vercelFetch(
      withTeam(`/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${encodeURIComponent(domain)}`),
      { method: 'DELETE' }
    );
    // 404 means it was never there, which is the state we wanted anyway.
    if (!ok && status !== 404) {
      console.error('[domains] vercel remove failed', body);
      return { automated: false, error: body?.error?.message };
    }
    return { automated: true };
  } catch (err) {
    console.error('[domains] vercel remove call failed', err);
    return { automated: false };
  }
}

/**
 * Ask Vercel where a domain stands. Returns
 * { status, records, verification, error } and never throws.
 *
 * 'verified' requires BOTH halves: the domain is verified as ours AND
 * its DNS is not misconfigured. Anything short of that is 'pending' --
 * the customer still has something to do. 'error' is reserved for our
 * own failure to check.
 */
export async function checkDomainWithVercel(domain) {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const lookup = () =>
    vercelFetch(withTeam(`/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}`));
  let reg, cfg;

  try {
    [reg, cfg] = await Promise.all([
      lookup(),
      vercelFetch(withTeam(`/v6/domains/${encodeURIComponent(domain)}/config`)),
    ]);
  } catch (err) {
    console.error('[domains] vercel check failed', domain, err);
    return {
      status: 'error',
      error: "Couldn't reach the hosting provider to check this domain.",
      records: recordsFor(domain),
      verification: [],
    };
  }

  logConfigShapeOnce(cfg);

  // Not registered on the project: either it was added before a Vercel
  // token existed, or someone removed it in the dashboard. Register it
  // and look again -- one retry, so a failure can't loop.
  if (reg.status === 404) {
    const added = await addDomainToVercel(domain);
    if (added.automated) {
      try {
        reg = await lookup();
      } catch (err) {
        console.error('[domains] vercel re-lookup failed', domain, err);
      }
    }
  }

  const config = cfg.ok ? cfg.body : null;

  // Still not there -- a real pending state with a clear cause, not a
  // failed check.
  if (reg.status === 404) {
    return {
      status: 'pending',
      error: 'This domain is not registered with the hosting project yet.',
      records: recordsFor(domain, config),
      verification: [],
    };
  }

  if (!reg.ok) {
    console.error('[domains] vercel domain lookup failed', reg.body);
    return {
      status: 'error',
      error: reg.body?.error?.message || "Couldn't check this domain.",
      records: recordsFor(domain, config),
      verification: [],
    };
  }

  // The TXT challenge Vercel asks for when the domain is already known
  // to another account. Normalised to the same shape as the DNS rows.
  const verification = Array.isArray(reg.body?.verification)
    ? reg.body.verification.map((v) => ({
        type: v?.type || 'TXT',
        name: v?.domain || '',
        value: v?.value || '',
        reason: v?.reason || '',
      }))
    : [];

  const verified = reg.body?.verified === true;
  // If the config call failed we don't know -- assume misconfigured, so
  // a check we couldn't complete never reads as verified.
  const misconfigured = cfg.ok ? cfg.body?.misconfigured !== false : true;
  const apex =
    typeof reg.body?.name === 'string' && typeof reg.body?.apexName === 'string'
      ? reg.body.name === reg.body.apexName
      : undefined;

  const records = recordsFor(domain, config, apex);

  if (verified && !misconfigured) {
    return { status: 'verified', error: null, records, verification };
  }

  return {
    status: 'pending',
    error: !verified && verification.length
      ? 'Add the TXT record below to prove you own this domain.'
      : null,
    records,
    verification,
  };
}

/**
 * Check a site's custom domain and store the result.
 * `site` needs { id, custom_domain, domain_status, domain_checked_at }.
 * Returns null when there's no domain to check.
 */
export async function refreshDomainStatus(admin, site) {
  const domain = site?.custom_domain;
  if (!domain) return null;

  // Nothing to check against: show the records again, keep whatever
  // status is stored, and be honest that this wasn't a real check.
  if (!vercelConfigured()) {
    return {
      status: site.domain_status || 'pending',
      records: recordsFor(domain),
      verification: [],
      error: site.domain_error || null,
      checkedAt: site.domain_checked_at || null,
      automated: false,
    };
  }

  const result = await checkDomainWithVercel(domain);
  const checkedAt = new Date().toISOString();

  try {
    const { error } = await admin
      .from('sites')
      .update({
        domain_status: result.status,
        domain_checked_at: checkedAt,
        domain_error: result.error || null,
      })
      .eq('id', site.id);
    if (error) console.error('[domains] could not store domain status', site.id, error);
  } catch (err) {
    console.error('[domains] could not store domain status', site.id, err);
  }

  return {
    status: result.status,
    records: result.records,
    verification: result.verification,
    error: result.error || null,
    checkedAt,
    automated: true,
  };
}
