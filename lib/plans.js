// ============================================================
// Plan configuration — the single place to tune limits.
// Change a number here and it takes effect everywhere.
//
// Allowances refresh on a rolling 5-hour window, so nobody
// waits until midnight. The monthly ceiling bounds worst-case
// cost, since a full site build is a large AI output.
//
// Rough cost per build (GBP): haiku £0.06 · sonnet £0.17
//                             opus £0.29 · fable £0.58
// Keep monthlyBuilds x cost comfortably under the plan price.
// ============================================================

export const WINDOW_HOURS = 5;

export const PLANS = {
  standard: {
    label: 'Standard',
    windowBuilds: 6,      // per 5-hour window
    monthlyBuilds: 60,    // ~£17/mo at opus rates
    monthlyImages: 40,
    models: ['opus'],
  },
  pro: {
    label: 'Pro',
    windowBuilds: 12,
    monthlyBuilds: 120,   // ~£35/mo at opus rates
    monthlyImages: 80,
    models: ['opus'],
  },
  frontier: {
    label: 'Frontier',
    windowBuilds: 12,
    monthlyBuilds: 100,   // ~£58/mo at fable rates -- every build is now fable, not just on request
    monthlyImages: 100,
    models: ['fable'],
  },
  done_for_you: {
    label: 'Done-for-you',
    windowBuilds: 12,
    monthlyBuilds: 200,   // ~£58/mo at opus rates
    monthlyImages: 100,   // floor: at least Frontier's allowance
    models: ['opus'],
  },
  studio: {
    label: 'Studio',
    windowBuilds: 25,
    monthlyBuilds: 600,   // ~£174/mo at opus rates; fable available on request
    monthlyImages: 100,   // floor: at least Frontier's allowance
    models: ['opus', 'fable'],
  },
};

// Model keys -> actual Anthropic model IDs.
export const MODEL_IDS = {
  haiku:   'claude-haiku-4-5-20251001',
  sonnet:  'claude-sonnet-4-6',
  opus:    'claude-opus-5',
  fable:   'claude-fable-5',
};

// Statuses that count as "allowed to build".
export const ACTIVE_STATUSES = ['trialing', 'active'];

export function planFor(subscription) {
  if (!subscription) return null;
  if (!ACTIVE_STATUSES.includes(subscription.status)) return null;
  return PLANS[subscription.plan] || null;
}
