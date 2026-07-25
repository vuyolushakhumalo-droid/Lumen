// ============================================================
// Small helpers for site output.
// (Sites are now written entirely by the model — see lib/anthropic.js —
//  so there is no template here any more.)
// ============================================================

export function slugify(s) {
  return (String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'site').slice(0, 30);
}
