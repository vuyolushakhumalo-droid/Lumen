// ============================================================
// Publishing helpers — turning a project into a live site.
// ============================================================
import { ApiError } from './auth.js';

// Words we keep for ourselves so a customer can't take them.
const RESERVED = new Set([
  'www','api','app','admin','dashboard','builder','help','support','status','mail','email',
  'blog','docs','about','contact','pricing','templates','community','login','signin','signup',
  'start','reset','advisor','account','billing','static','assets','cdn','test','staging','dev',
  'lumen','preview','site','sites','my','me','new',
]);

export function makeSlug(input) {
  return String(input || '')
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

// The public address of a published site.
export function publicUrl(site) {
  if (site.custom_domain) return `https://${site.custom_domain}`;
  const base = process.env.SITES_DOMAIN;           // e.g. lumen.build (needs wildcard DNS)
  if (base) return `https://${site.subdomain}.${base}`;
  const app = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${app}/s/${site.subdomain}`;             // works today, no DNS needed
}
