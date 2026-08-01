// ============================================================
// Usage metering — the rules that protect your margin.
//
// Allowance refreshes on a rolling 5-hour window, so the longest
// anyone waits is a few hours rather than until midnight.
// A monthly ceiling bounds worst-case cost.
//
// Order of spend: window allowance first, then top-up credits.
// Failed generations are NEVER charged (we only count on success).
// ============================================================
import { PLANS, ACTIVE_STATUSES, WINDOW_HOURS } from './plans.js';
import { ApiError } from './auth.js';

const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

// Windows are aligned to fixed boundaries from the epoch, so every
// user's window is predictable and the server and browser agree.
export function windowStart(when = new Date()) {
  return new Date(Math.floor(when.getTime() / WINDOW_MS) * WINDOW_MS);
}

export function windowEnd(when = new Date()) {
  return new Date(windowStart(when).getTime() + WINDOW_MS);
}

export function monthStart(when = new Date()) {
  return new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 1));
}

/**
 * Resolves what "previousHtml" should be for a generation request.
 * project.current_code is the normal source, but if it's falsy while
 * the project actually has version history, that's a stale/out-of-sync
 * read, not a genuinely new project -- fall back to the most recent
 * version's code so the request is still classified and generated as
 * an edit, rather than silently becoming an unrelated new build that
 * overwrites real prior work.
 */
export async function resolvePreviousHtml(admin, project) {
  if (project.current_code) return project.current_code;

  const { data: lastVersion } = await admin
    .from('versions')
    .select('code')
    .eq('project_id', project.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastVersion?.code) {
    console.warn('[usage] current_code was empty but version history exists -- recovering from last version', project.id);
    return lastVersion.code;
  }
  return null;
}

export async function getSubscription(admin, userId) {
  // A user can accumulate rows (abandoned checkouts, past cancellations).
  // Always prefer a live one; fall back to the most recent otherwise.
  const { data } = await admin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (!data || !data.length) return null;
  const live = data.find((s) => ACTIVE_STATUSES.includes(s.status));
  return live || data[0];
}

export async function getUsageSnapshot(admin, profile) {
  const sub = await getSubscription(admin, profile.id);
  const active = sub && ACTIVE_STATUSES.includes(sub.status);
  const plan = active ? PLANS[sub.plan] : null;

  const wStart = windowStart();
  const wEnd = windowEnd();

  // Builds used in the current window
  const { data: current } = await admin
    .from('usage_windows')
    .select('builds_used')
    .eq('user_id', profile.id)
    .eq('window_start', wStart.toISOString())
    .maybeSingle();

  // Builds used this calendar month
  const { data: monthRows } = await admin
    .from('usage_windows')
    .select('builds_used')
    .eq('user_id', profile.id)
    .gte('window_start', monthStart().toISOString());

  const { data: packs } = await admin
    .from('topups')
    .select('credits_remaining')
    .eq('user_id', profile.id)
    .gt('credits_remaining', 0);

  const used = current?.builds_used || 0;
  const monthUsed = (monthRows || []).reduce((n, r) => n + r.builds_used, 0);
  const limit = plan?.windowBuilds || 0;
  const monthLimit = plan?.monthlyBuilds || 0;
  const topupCredits = (packs || []).reduce((n, p) => n + p.credits_remaining, 0);

  const withinWindow = used < limit;
  const withinMonth = monthUsed < monthLimit;

  return {
    plan: sub?.plan || null,
    planLabel: plan?.label || null,
    status: sub?.status || 'none',
    active: !!active,

    // window
    windowHours: WINDOW_HOURS,
    dailyLimit: limit,            // kept for older callers
    windowLimit: limit,
    used,
    buildsLeft: Math.max(0, limit - used),
    resetsAt: wEnd.toISOString(),

    // month
    monthUsed,
    monthLimit,
    monthLeft: Math.max(0, monthLimit - monthUsed),

    topupCredits,
    canBuild: !!active && ((withinWindow && withinMonth) || topupCredits > 0),
    allowedModels: plan?.models || [],
    currentPeriodEnd: sub?.current_period_end || null,
    cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
  };
}

// Never lets a failed insert block or fail the caller's request.
export async function logUsageEvent(admin, { userId, projectId, model, usage, kind, editMode }) {
  try {
    await admin.from('usage_events').insert({
      user_id: userId,
      project_id: projectId,
      model,
      input_tokens: usage?.input_tokens || 0,
      output_tokens: usage?.output_tokens || 0,
      kind,
      edit_mode: editMode || null,
    });
  } catch (err) {
    console.error('[usage] failed to log usage event', err);
  }
}

// Called BEFORE generating. Throws if the user may not build.
export async function assertCanBuild(admin, profile, modelKey) {
  const snap = await getUsageSnapshot(admin, profile);

  if (!snap.active) {
    throw new ApiError(402, 'You need an active subscription to build.', { reason: 'no_subscription' });
  }
  if (modelKey && !snap.allowedModels.includes(modelKey)) {
    throw new ApiError(403, `Your plan doesn't include that model.`, {
      reason: 'model_not_allowed', allowedModels: snap.allowedModels,
    });
  }

  const outOfMonth = snap.monthUsed >= snap.monthLimit;
  const outOfWindow = snap.used >= snap.windowLimit;

  if (outOfMonth && snap.topupCredits < 1) {
    throw new ApiError(429, "You've used this month's builds.", {
      reason: 'month_limit', monthLimit: snap.monthLimit,
    });
  }
  if (outOfWindow && snap.topupCredits < 1) {
    throw new ApiError(429, "You've used this session's builds.", {
      reason: 'window_limit', resetsAt: snap.resetsAt, buildsLeft: 0,
    });
  }
  return snap;
}

// Called AFTER a successful generation. Spends allowance, then a top-up.
export async function recordBuild(admin, profile, snapshot) {
  const wStart = windowStart().toISOString();

  const withinWindow = snapshot.used < snapshot.windowLimit;
  const withinMonth = snapshot.monthUsed < snapshot.monthLimit;

  if (withinWindow && withinMonth) {
    await admin.rpc('increment_window_usage', { p_user_id: profile.id, p_window: wStart });
    return { source: 'allowance' };
  }

  const { data: spent } = await admin.rpc('spend_topup_credit', { p_user_id: profile.id });
  if (spent) return { source: 'topup' };

  await admin.rpc('increment_window_usage', { p_user_id: profile.id, p_window: wStart });
  return { source: 'allowance' };
}
