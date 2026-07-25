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
    monthlyBuilds: 90,    // ceiling: ~£15 at sonnet rates
    models: ['haiku', 'sonnet'],
  },
  pro: {
    label: 'Pro',
    windowBuilds: 12,
    monthlyBuilds: 200,   // ~£34 at sonnet rates
    models: ['haiku', 'sonnet'],
  },
  frontier: {
    label: 'Frontier',
    windowBuilds: 12,
    monthlyBuilds: 120,   // Fable costs ~3.5x sonnet, so a tighter ceiling
    models: ['haiku', 'sonnet', 'opus', 'fable'],
  },
  done_for_you: {
    label: 'Done-for-you',
    windowBuilds: 12,
    monthlyBuilds: 200,
    models: ['haiku', 'sonnet'],
  },
  studio: {
    label: 'Studio',
    windowBuilds: 25,
    monthlyBuilds: 600,
    models: ['haiku', 'sonnet', 'opus', 'fable'],
  },
};

// Model keys -> actual Anthropic model IDs.
export const MODEL_IDS = {
  haiku:   'claude-haiku-4-5-20251001',
  sonnet:  'claude-sonnet-4-6',
  opus:    'claude-opus-4-8',
  fable:   'claude-fable-5',
};

// Statuses that count as "allowed to build".
export const ACTIVE_STATUSES = ['trialing', 'active'];

export function planFor(subscription) {
  if (!subscription) return null;
  if (!ACTIVE_STATUSES.includes(subscription.status)) return null;
  return PLANS[subscription.plan] || null;
}
