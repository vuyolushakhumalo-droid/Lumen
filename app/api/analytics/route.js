// ============================================================
// GET /api/analytics?site=...&days=30
//
// Reads the nightly rollup in site_daily for closed days, and
// aggregates today's raw site_events on the fly so the numbers include
// this morning rather than stopping at midnight.
//
// Full breakdowns are a paid feature. Standard sees only a visitor
// count -- enough to know the site is being read, not enough to analyse
// it. Everything else is gated behind FULL_PLANS below.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { getSubscription } from '@/lib/usage';
import { ACTIVE_STATUSES } from '@/lib/plans';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Plans that see the full breakdown. Standard (and anyone without an
// active subscription) gets the teaser.
const FULL_PLANS = ['pro', 'frontier', 'done_for_you', 'studio'];

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;            // matches purge_site_events() retention
const TOP_N = 8;

// Today's raw rows are read and aggregated per request. The beacon is
// rate-limited to 600/hour per site, so a day is bounded at ~14k rows;
// this cap keeps a pathological site from stalling the dashboard.
const TODAY_EVENT_CAP = 20000;

function dayString(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// jsonb maps from site_daily are { key: count }. Merge many into one.
function mergeCounts(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [k, v] of Object.entries(source)) {
    const n = Number(v);
    if (Number.isFinite(n)) target[k] = (target[k] || 0) + n;
  }
  return target;
}

function topList(counts, n = TOP_N) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Aggregate raw events into the same shape a site_daily row carries, so
 * today slots into the series alongside the rolled-up days.
 * Mirrors rollup_site_events(): views = events, visitors = distinct
 * visitor hashes, bounces = visitors with exactly one event.
 */
function aggregateEvents(rows) {
  const perVisitor = new Map();
  const sections = {};
  const countries = {};
  const referrers = {};
  const devices = {};

  for (const r of rows) {
    perVisitor.set(r.visitor, (perVisitor.get(r.visitor) || 0) + 1);
    sections[r.section || 'home'] = (sections[r.section || 'home'] || 0) + 1;
    countries[r.country || 'unknown'] = (countries[r.country || 'unknown'] || 0) + 1;
    referrers[r.ref_host || 'direct'] = (referrers[r.ref_host || 'direct'] || 0) + 1;
    devices[r.device || 'unknown'] = (devices[r.device || 'unknown'] || 0) + 1;
  }

  let bounces = 0;
  for (const n of perVisitor.values()) if (n === 1) bounces++;

  return {
    views: rows.length,
    visitors: perVisitor.size,
    bounces,
    sections,
    countries,
    referrers,
    devices,
  };
}

export const GET = handler(async (request) => {
  const { profile, admin } = await requireUser(request);
  const url = new URL(request.url);
  const siteId = url.searchParams.get('site');
  if (!siteId) throw new ApiError(400, 'No site specified');

  const requested = parseInt(url.searchParams.get('days') || '', 10);
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_DAYS)
    : DEFAULT_DAYS;

  // --- ownership ------------------------------------------------------
  // Scoped by user_id, not just id: this is the whole access check, so a
  // guessed site id from another account must return nothing rather than
  // someone else's traffic.
  const { data: site } = await admin
    .from('sites')
    .select('id, user_id, subdomain, custom_domain')
    .eq('id', siteId)
    .eq('user_id', profile.id)
    .maybeSingle();
  if (!site) throw new ApiError(404, 'No such site');

  // --- plan -----------------------------------------------------------
  // Same lookup getUsageSnapshot does: newest live subscription, and a
  // plan only counts while its status is active.
  const sub = await getSubscription(admin, profile.id);
  const active = sub && ACTIVE_STATUSES.includes(sub.status);
  const planKey = active ? sub.plan : null;
  const full = FULL_PLANS.includes(planKey);

  // --- range ------------------------------------------------------------
  const today = new Date();
  const todayStr = dayString(today);
  const startStr = dayString(addDays(today, -(days - 1)));

  // Closed days come from the rollup; today is still accumulating.
  const { data: rolled, error: rollErr } = await admin
    .from('site_daily')
    .select('day, views, visitors, bounces, sections, countries, referrers, devices')
    .eq('site_id', site.id)
    .eq('user_id', profile.id)
    .gte('day', startStr)
    .lt('day', todayStr)
    .order('day', { ascending: true });

  if (rollErr) {
    console.error('[analytics] rollup read failed', rollErr);
    throw new ApiError(500, 'Could not load analytics');
  }

  const { data: todayRows, error: todayErr } = await admin
    .from('site_events')
    .select('visitor, section, country, ref_host, device')
    .eq('site_id', site.id)
    .eq('user_id', profile.id)
    .eq('day', todayStr)
    .limit(TODAY_EVENT_CAP);

  if (todayErr) console.error('[analytics] today read failed', todayErr);

  const todayAgg = aggregateEvents(todayRows || []);

  // --- series, zero-filled so the chart needs no gap handling ----------
  const byDay = new Map((rolled || []).map((r) => [r.day, r]));
  if (todayAgg.views > 0) byDay.set(todayStr, { day: todayStr, ...todayAgg });

  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayString(addDays(today, -i));
    const row = byDay.get(key);
    daily.push({
      day: key,
      views: row?.views || 0,
      visitors: row?.visitors || 0,
      bounces: row?.bounces || 0,
    });
  }

  // Visitors is the sum of DAILY distinct visitors -- someone who
  // returns on three days counts three times. Deduplicating across days
  // is impossible by design: the visitor hash changes daily.
  const totals = daily.reduce(
    (acc, d) => {
      acc.views += d.views;
      acc.visitors += d.visitors;
      acc.bounces += d.bounces;
      return acc;
    },
    { views: 0, visitors: 0, bounces: 0 }
  );

  // --- teaser ----------------------------------------------------------
  if (!full) {
    return Response.json({ teaser: true, visitors: totals.visitors, days });
  }

  const sections = {};
  const countries = {};
  const referrers = {};
  const devices = {};
  for (const r of byDay.values()) {
    mergeCounts(sections, r.sections);
    mergeCounts(countries, r.countries);
    mergeCounts(referrers, r.referrers);
    mergeCounts(devices, r.devices);
  }

  return Response.json({
    teaser: false,
    days,
    site: { id: site.id, subdomain: site.subdomain, customDomain: site.custom_domain },
    daily,
    totals: {
      views: totals.views,
      visitors: totals.visitors,
      // Share of visitors who looked at exactly one thing and left.
      bounceRate: totals.visitors ? totals.bounces / totals.visitors : 0,
    },
    sections: topList(sections),
    countries: topList(countries),
    referrers: topList(referrers),
    devices: topList(devices),
  });
});
