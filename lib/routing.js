// ============================================================
// Task-based model routing.
//
// Each plan now guarantees a fixed floor model for every build and
// edit -- no classification by brief content. Fable is used by
// default only on plans pinned to it (Frontier); other plans that
// permit Fable (Studio) only reach it on an explicit request.
// ============================================================

export function chooseModel({ isEdit, requested, allowedModels }) {
  const allow = (m) => (allowedModels || []).includes(m);

  // Explicit request for the top engine, on a plan that allows it.
  if (requested === 'fable' && allow('fable')) return { model: 'fable', reason: 'requested' };

  // Default to the best model the plan guarantees: Opus where
  // available, otherwise Fable (Frontier, which permits only Fable).
  if (allow('opus')) return { model: 'opus', reason: isEdit ? 'edit' : 'new site' };
  if (allow('fable')) return { model: 'fable', reason: isEdit ? 'edit' : 'new site' };

  // Should be unreachable given current plan config -- fail loudly
  // rather than silently falling back to an unlisted, cheaper model.
  throw new Error('No permitted model for this plan');
}
