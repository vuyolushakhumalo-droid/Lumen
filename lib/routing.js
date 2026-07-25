// ============================================================
// Task-based model routing.
//
// Customers pick a "quality level", not a raw model. We then choose
// the cheapest model that will do the job well:
//
//   small edit        -> Haiku    (~£0.06)
//   new site / rework -> Sonnet   (~£0.17)
//   complex rebuild   -> Opus     (~£0.29)   only when asked for
//   top-tier          -> Fable    (~£0.58)   Frontier plan only
//
// This typically cuts AI spend by a third with no visible
// difference to the customer.
// ============================================================

// Phrases that signal a small, contained change.
const SMALL_EDIT = /\b(change|swap|replace|rename|update|fix|tweak|adjust|make it|make the|bigger|smaller|bolder|lighter|darker|warmer|cooler|move|remove|delete|hide|show|add a button|add a link|shorter|longer|reword|rewrite the (headline|title|heading|copy|text)|colour|color|font|spacing|padding|margin)\b/i;

// Detail-sensitive work: Haiku is fast but less reliable at following
// exact markup rules, so route these to Sonnet even when they look small.
const NEEDS_CARE = /\b(icon|logo|social|facebook|instagram|tiktok|twitter|linkedin|youtube|whatsapp|svg|favicon|brand mark)\b/i;

// Phrases that signal real structural work.
const BIG_JOB = /\b(rebuild|redesign|start over|from scratch|completely|entirely|new design|different design|add a page|new page|restructure|reorganise|reorganize|whole site|all pages|e-?commerce|shop|checkout|booking system|multi-?step)\b/i;

export function chooseModel({ brief, isEdit, requested, allowedModels }) {
  const text = String(brief || '');
  const allow = (m) => (allowedModels || []).includes(m);

  // If the customer explicitly picked the top engine, respect it.
  if (requested === 'fable' && allow('fable')) return { model: 'fable', reason: 'requested' };
  if (requested === 'opus' && allow('opus')) return { model: 'opus', reason: 'requested' };
  if (requested === 'haiku' && allow('haiku')) return { model: 'haiku', reason: 'requested' };

  // Editing an existing site
  if (isEdit) {
    const structural = BIG_JOB.test(text);
    const delicate = NEEDS_CARE.test(text);
    if (!structural && !delicate && SMALL_EDIT.test(text) && text.length < 220 && allow('haiku')) {
      return { model: 'haiku', reason: 'small edit' };
    }
    if (structural && allow('opus') && requested === 'auto') {
      return { model: 'opus', reason: 'structural rework' };
    }
    return { model: allow('sonnet') ? 'sonnet' : 'haiku', reason: 'edit' };
  }

  // Building something new
  if (BIG_JOB.test(text) && allow('opus') && requested === 'auto') {
    return { model: 'opus', reason: 'complex build' };
  }
  return { model: allow('sonnet') ? 'sonnet' : 'haiku', reason: 'new site' };
}
