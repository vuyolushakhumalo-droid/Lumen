// GET /api/cron/purge-trash
// Permanently deletes projects that have sat in Trash for 30+ days.
// Not user-facing — only callable by the scheduler, via a Bearer
// token that must match CRON_SECRET. Mirrors the webhook route's
// pattern of skipping requireUser() for service-to-service calls.
import { supabaseAdmin } from '@/lib/supabase';
import { deleteProjectImages } from '@/lib/images';
import { refreshDomainStatus, vercelConfigured, removeDomainFromVercel } from '@/lib/domains';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Runs first, independent of trash purge below -- unrelated concerns,
  // and trash purge has several early returns (lookup failure, nothing
  // expired, delete failure) that shouldn't gate this.
  const staleAttemptsSwept = await sweepStaleAttempts(admin);
  const oldAttemptsPurged = await purgeOldAttempts(admin);
  const rateLimitsSwept = await sweepRateLimits(admin);
  const versionsPruned = await pruneVersions(admin);
  const submissionsPurged = await purgeSubmissions(admin);
  const domainsVerified = await sweepPendingDomains(admin);
  const domainsRemoved = await sweepUnverifiedDomains(admin);
  const { rolled: analyticsRolled, purged: eventsPurged } = await sweepAnalytics(admin);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expired, error: findError } = await admin
    .from('projects')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (findError) {
    console.error('[cron/purge-trash] lookup failed', findError);
    return Response.json({ error: 'Lookup failed', staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned, submissionsPurged, domainsVerified, domainsRemoved, analyticsRolled, eventsPurged }, { status: 500 });
  }

  const ids = (expired || []).map((p) => p.id);
  if (!ids.length) return Response.json({ purged: 0, staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned, submissionsPurged, domainsVerified, domainsRemoved, analyticsRolled, eventsPurged });

  await Promise.all(ids.map((id) => deleteProjectImages(id)));

  const { error: deleteError } = await admin.from('projects').delete().in('id', ids);
  if (deleteError) {
    console.error('[cron/purge-trash] delete failed', deleteError);
    return Response.json({ error: 'Delete failed', staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned, submissionsPurged, domainsVerified, domainsRemoved, analyticsRolled, eventsPurged }, { status: 500 });
  }

  return Response.json({ purged: ids.length, staleAttemptsSwept, oldAttemptsPurged, rateLimitsSwept, versionsPruned, submissionsPurged, domainsVerified, domainsRemoved, analyticsRolled, eventsPurged });
}

// On this runtime, a client disconnect kills the streaming function
// outright -- neither the route's own catch nor the ReadableStream's
// cancel() ever runs, so an aborted build's generation_attempts row can
// never be resolved at abort time. This sweeps anything left behind.
// 25 minutes: the generate routes' maxDuration is 800s (13.3 minutes),
// so a legitimate build can genuinely still be running at 15 -- this
// leaves real headroom above the slowest possible build instead of
// racing it.
async function sweepStaleAttempts(admin) {
  const cutoff = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('generation_attempts')
    .update({ status: 'aborted', stage: 'client_disconnect', finished_at: new Date().toISOString() })
    .eq('status', 'started')
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[cron/purge-trash] stale attempt sweep failed', error);
    return 0;
  }
  return data?.length || 0;
}

// generation_attempts is a log table with no other retention policy --
// left alone it grows forever. 30 days is well past anything the sweep
// above or normal debugging would need.
async function purgeOldAttempts(admin) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('generation_attempts')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[cron/purge-trash] old attempt purge failed', error);
    return 0;
  }
  return data?.length || 0;
}

// rate_limits accumulates one row per distinct key (per user, per IP,
// per site) touched by check_rate_limit(). Nothing else prunes it --
// this calls the DB function built for that (see
// supabase/migrations/0001_submissions.sql), which returns the deleted
// count directly rather than a set of rows.
async function sweepRateLimits(admin) {
  const { data, error } = await admin.rpc('sweep_rate_limits');
  if (error) {
    console.error('[cron/purge-trash] rate limit sweep failed', error);
    return 0;
  }
  return data || 0;
}

// versions keeps one row per build/edit/restore/fork with no other
// retention policy -- capped here at the same 100-per-project ceiling
// prune_versions() enforces (see supabase/migrations/0003_prune_versions.sql).
async function pruneVersions(admin) {
  const { data, error } = await admin.rpc('prune_versions', { p_keep: 100 });
  if (error) {
    console.error('[cron/purge-trash] version prune failed', error);
    return 0;
  }
  return data || 0;
}

// submissions accumulates form captures forever unless a customer
// manually erases one -- purge_submissions() drops anything past a
// year old (see supabase/migrations/0004_purge_submissions.sql).
async function purgeSubmissions(admin) {
  const { data, error } = await admin.rpc('purge_submissions', { p_days: 365 });
  if (error) {
    console.error('[cron/purge-trash] submission purge failed', error);
    return 0;
  }
  return data || 0;
}

// A custom domain sits 'pending' until something confirms DNS actually
// points here, and otherwise that only happens when the customer opens
// the builder and looks. This finishes the job overnight: a domain set
// up on Tuesday evening is verified by Wednesday morning without them
// pressing anything.
//
// Sequential, not Promise.all: this is a courtesy sweep against a
// third-party API, and there's no deadline worth rate-limiting for.
// Capped so one runaway account can't stretch the cron run.
const DOMAIN_SWEEP_LIMIT = 200;

async function sweepPendingDomains(admin) {
  if (!vercelConfigured()) return 0;

  const { data, error } = await admin
    .from('sites')
    .select('id, custom_domain, domain_status, domain_checked_at, domain_error')
    .not('custom_domain', 'is', null)
    .neq('domain_status', 'verified')
    .limit(DOMAIN_SWEEP_LIMIT);

  if (error) {
    console.error('[cron/purge-trash] domain sweep lookup failed', error);
    return 0;
  }

  let verified = 0;
  for (const site of data || []) {
    try {
      const out = await refreshDomainStatus(admin, site);
      if (out?.status === 'verified') verified++;
    } catch (err) {
      // refreshDomainStatus already swallows its own failures; this is
      // belt-and-braces so one bad row can't abandon the rest.
      console.error('[cron/purge-trash] domain check failed', site.id, err);
    }
  }
  return verified;
}

// A domain the customer typed but never pointed at us stays registered
// on the hosting project forever, and shows in their builder as a
// permanently "pending" domain they've long forgotten about. Two weeks
// is long past a DNS change taking effect, so at that point it is
// abandoned rather than in progress.
//
// The note is the point of doing this here rather than silently: the
// customer gets told what happened and what to do, next time they open
// the builder.
const DOMAIN_PENDING_DAYS = 14;
const DOMAIN_SWEEP_MAX = 50;

async function sweepUnverifiedDomains(admin) {
  const cutoff = new Date(Date.now() - DOMAIN_PENDING_DAYS * 86400000).toISOString();

  const { data, error } = await admin
    .from('sites')
    .select('id, user_id, custom_domain, domain_added_at')
    .not('custom_domain', 'is', null)
    .neq('domain_status', 'verified')
    .lt('domain_added_at', cutoff)
    .limit(DOMAIN_SWEEP_MAX);

  if (error) {
    console.error('[cron/purge-trash] unverified domain lookup failed', error);
    return 0;
  }
  if (!data?.length) return 0;

  let removed = 0;
  for (const site of data) {
    const domain = site.custom_domain;
    try {
      // Best-effort upstream, same as the customer-initiated detach:
      // if the host won't release it we still clear our side, because
      // leaving the customer stuck with a dead domain is worse than
      // leaving a stale registration behind.
      await removeDomainFromVercel(domain);

      const { error: updateError } = await admin
        .from('sites')
        .update({
          custom_domain: null,
          domain_status: 'pending',
          domain_checked_at: null,
          domain_error: null,
          domain_added_at: null,
          domain_note: `We removed ${domain} because it was never connected — add it again when your DNS is ready.`,
        })
        .eq('id', site.id);

      if (updateError) {
        console.error('[cron/purge-trash] could not clear domain', domain, updateError);
        continue;
      }

      await admin.from('audit_log').insert({
        user_id: site.user_id,
        action: 'domain.removed_unverified',
        meta: {
          siteId: site.id,
          domain,
          addedAt: site.domain_added_at,
          days: DOMAIN_PENDING_DAYS,
        },
      });

      removed++;
    } catch (err) {
      console.error('[cron/purge-trash] domain cleanup failed', domain, err);
    }
  }
  return removed;
}

// Analytics: fold yesterday's raw beacons into the per-day rollup the
// dashboard reads, then age out raw events past 90 days. Yesterday, not
// today, so the day being aggregated is closed -- this runs at 03:00 UTC
// (see vercel.json).
//
// The rollup upserts, so a re-run for the same day recomputes rather
// than double-counts, and a missed night can be replayed by calling
// rollup_site_events(date) directly.
const EVENT_RETENTION_DAYS = 90;

async function sweepAnalytics(admin) {
  let rolled = 0;
  let purged = 0;

  const { data: rollData, error: rollError } = await admin.rpc('rollup_site_events', { p_day: null });
  if (rollError) console.error('[cron/purge-trash] analytics rollup failed', rollError);
  else rolled = rollData || 0;

  // Independent of the rollup: retention must still run even if
  // aggregation failed, or raw events would grow unbounded.
  const { data: purgeData, error: purgeError } = await admin.rpc('purge_site_events', {
    p_days: EVENT_RETENTION_DAYS,
  });
  if (purgeError) console.error('[cron/purge-trash] site event purge failed', purgeError);
  else purged = purgeData || 0;

  return { rolled, purged };
}
