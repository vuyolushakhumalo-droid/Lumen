// ============================================================
// Publishing helpers — turning a project into a live site.
// ============================================================
import { ApiError } from './auth.js';
import { decodeHtmlEntities } from './text.js';

// Words we keep for ourselves so a customer can't take them.
const RESERVED = new Set([
  'www','api','app','admin','dashboard','builder','help','support','status','mail','email',
  'blog','docs','about','contact','pricing','templates','community','login','signin','signup',
  'start','reset','advisor','account','billing','static','assets','cdn','test','staging','dev',
  'lumen','lintel','preview','site','sites','my','me','new',
]);

export function makeSlug(input) {
  return decodeHtmlEntities(String(input || ''))
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function validateSlug(slug) {
  if (!slug || slug.length < 3) throw new ApiError(400, 'Web address needs at least 3 characters.');
  if (slug.length > 40) throw new ApiError(400, 'Web address is too long (40 characters max).');
  if (!/^[a-z0-9-]+$/.test(slug)) throw new ApiError(400, 'Use only letters, numbers and hyphens.');
  if (/^-|-$/.test(slug)) throw new ApiError(400, "Web address can't start or end with a hyphen.");
  if (RESERVED.has(slug)) throw new ApiError(400, 'That web address is reserved — please choose another.');
  return slug;
}

// Find a free slug, adding -2, -3 … if needed.
export async function findFreeSlug(admin, base, ignoreSiteId = null) {
  let candidate = validateSlug(makeSlug(base) || 'site');
  for (let i = 1; i < 50; i++) {
    const trySlug = i === 1 ? candidate : `${candidate}-${i}`;
    const { data } = await admin
      .from('sites').select('id').eq('subdomain', trySlug).maybeSingle();
    if (!data || data.id === ignoreSiteId) return trySlug;
  }
  return `${candidate}-${Date.now().toString(36).slice(-4)}`;
}

// ============================================================
// Publish-time abuse screening.
//
// Hard blocks only, for now -- content with no legitimate use in a
// generated site, and cheap and reliable to catch with a regex. A
// soft-flag keyword list (queued for review rather than auto-blocked)
// is separate, later work.
//
// Case-insensitive, and tolerant of attribute order/whitespace: each
// pattern is anchored on the tag name, then [^>]* before the target
// attribute -- [^>] can never cross the tag's own closing '>', so the
// attribute can appear anywhere inside the tag without risking a match
// that spans into a different tag entirely. The \s immediately before
// the attribute name (not \b) matters: attributes are whitespace-
// separated, so \s matches a real attribute but not a suffix of a
// longer one -- e.g. data-input-type="password" or a lazy-loaded
// image's data-src don't false-positive.
// ============================================================
const HARD_BLOCK_PATTERNS = [
  {
    id: 'password_input',
    label: 'a password field',
    re: /<input\b[^>]*\stype\s*=\s*["']password["']/i,
  },
  {
    id: 'external_form_action',
    label: 'a form that submits to an external address',
    // Blanket block for now -- becomes an allowlist (Calendly, Maps,
    // Stripe, etc.) once those embeds ship.
    re: /<form\b[^>]*\saction\s*=\s*["']https?:\/\//i,
  },
  {
    id: 'external_script',
    label: 'a script loaded from an external address',
    re: /<script\b[^>]*\ssrc\s*=\s*["']https?:\/\//i,
  },
  {
    id: 'external_iframe',
    label: 'an iframe embedding an external address',
    // Blanket block for now -- becomes an allowlist (Calendly, Maps,
    // Stripe, etc.) once those embeds ship.
    re: /<iframe\b[^>]*\ssrc\s*=\s*["']https?:\/\//i,
  },
];

/**
 * Scans generated HTML for content that must never be published.
 * Returns null if clean, or { id, label } describing the first match.
 */
export function findHardBlock(html) {
  const s = String(html || '');
  for (const rule of HARD_BLOCK_PATTERNS) {
    if (rule.re.test(s)) return { id: rule.id, label: rule.label };
  }
  return null;
}

/**
 * Runs the hard-block screen against freshly-committed content from an
 * edit, not a publish action. An edit is never blocked by this -- if
 * the project currently has a live site and the new content trips a
 * rule, the site is taken offline (status -> 'draft') instead. No-op
 * if the content is clean, or if the project isn't published. Never
 * throws -- a screening failure must not break the edit it's checking.
 */
export async function screenLiveSite(admin, { projectId, code }) {
  const hit = findHardBlock(code);
  if (!hit) return null;

  try {
    const { data: site } = await admin
      .from('sites')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', 'live')
      .maybeSingle();
    if (!site) return null;

    await admin.from('sites').update({ status: 'draft' }).eq('id', site.id);
    console.error('[publish] hard block on live site -- taken offline', { projectId, ruleId: hit.id });
    return hit;
  } catch (err) {
    console.error('[publish] live-site screening failed', projectId, err);
    return null;
  }
}

// The public address of a published site.
export function publicUrl(site) {
  if (site.custom_domain) return `https://${site.custom_domain}`;
  const base = process.env.SITES_DOMAIN;           // e.g. lintelsites.com (needs wildcard DNS)
  if (base) return `https://${site.subdomain}.${base}`;
  const app = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${app}/s/${site.subdomain}`;             // works today, no DNS needed
}
