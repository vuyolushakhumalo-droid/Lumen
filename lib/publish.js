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

// How many old addresses a site keeps pointing at it. Old links decay
// in value and every kept slug is one nobody else can have, so this is
// a courtesy with a limit rather than a permanent reservation.
const MAX_OLD_SLUGS = 5;

/**
 * Records the address a site just moved away from, and releases the one
 * it moved to if some other site used to own it.
 *
 * Never throws: called after the publish has already committed.
 */
export async function rememberOldSlug(admin, siteId, previousSlug, newSlug) {
  try {
    // Claiming an address always wins over a redirect to it -- a live
    // site at /foo must not be shadowed by an old site's forwarding.
    await admin.from('slug_redirects').delete().eq('old_slug', newSlug);

    if (!previousSlug || previousSlug === newSlug) return;

    // upsert, not insert: this slug may have redirected somewhere
    // before, and the newest owner is the right answer.
    const { error } = await admin
      .from('slug_redirects')
      .upsert({ old_slug: previousSlug, site_id: siteId, created_at: new Date().toISOString() },
              { onConflict: 'old_slug' });
    if (error) {
      console.error('[publish] could not record old slug', previousSlug, error);
      return;
    }

    // Trim to the newest MAX_OLD_SLUGS for this site.
    const { data: kept } = await admin
      .from('slug_redirects')
      .select('old_slug')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false });

    const stale = (kept || []).slice(MAX_OLD_SLUGS).map((r) => r.old_slug);
    if (stale.length) {
      await admin.from('slug_redirects').delete().in('old_slug', stale);
    }
  } catch (err) {
    console.error('[publish] slug redirect bookkeeping failed', err);
  }
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
// Hosts whose embeds may load on a published site. A URL passes when its
// hostname equals an entry or is a subdomain of one (ends with "." + entry).
const EMBED_ALLOWLIST = [
  // bookings
  'calendly.com', 'assets.calendly.com', 'cal.com', 'app.cal.com',
  // payments and shop
  'js.stripe.com', 'buy.stripe.com',
  'sdks.shopifycdn.com', 'cdn.shopify.com',
  // maps and video
  'www.google.com', 'maps.google.com', 'www.youtube-nocookie.com',
  // members
  'static.memberstack.com',
  // food ordering
  // TODO: GloriaFood's script host goes here. Take it verbatim from the
  // real embed snippet when the first restaurant signs up -- do not guess
  // it, a wrong host silently blocks every ordering button.
];

// Extra path constraints for hosts that serve far more than embeds.
// The Google hosts on their own would allow any Google-hosted URL.
const EMBED_PATH_PREFIXES = {
  'www.google.com': '/maps/embed',
  'maps.google.com': '/maps/embed',
};

/**
 * True when a script/iframe src may load on a published site.
 * Fails closed: anything unparseable, non-http, off-list, or off-path
 * is refused.
 */
function isAllowedEmbedUrl(raw) {
  let value = String(raw).trim();
  // Protocol-relative ("//host/path") inherits the page's https.
  if (value.startsWith('//')) value = `https:${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;                                  // unparseable -- fail closed
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();
  const entry = EMBED_ALLOWLIST.find((h) => host === h || host.endsWith('.' + h));
  if (!entry) return false;

  const prefix = EMBED_PATH_PREFIXES[host] ?? EMBED_PATH_PREFIXES[entry];
  return !prefix || url.pathname.startsWith(prefix);
}

// ------------------------------------------------------------------
// Inline JavaScript that sends data somewhere off the allowlist.
//
// The other four rules key on an attribute. This one reads the inline
// script bodies, which is where an exfiltration would actually live --
// an external <script src> is already blocked, so anything doing this
// has to do it inline.
//
// Deliberately only matches a STRING LITERAL first argument. A URL
// built from a variable or a template string can't be resolved without
// executing the page, and guessing would either miss it anyway or
// false-positive on ordinary code. That gap is accepted: this catches
// the pasted-snippet case, not a determined author.
//
// It is also what makes our own injections safe. lib/forms.js does
// `fetch(EP, ...)` and lib/analytics.js does `sendBeacon(EP, ...)`,
// both with EP a variable -- neither is a literal, so neither can be
// matched however the endpoint is configured.
// ------------------------------------------------------------------

const INLINE_REQUEST_PATTERNS = [
  // fetch('...') and navigator.sendBeacon('...')
  { re: /\b(?:fetch|navigator\s*\.\s*sendBeacon)\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g, url: 2 },
  // new WebSocket('...')
  { re: /\bnew\s+WebSocket\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g, url: 2 },
  // xhr.open('POST', '...') -- keyed on the HTTP method so window.open,
  // whose first argument is the URL itself, can't match.
  {
    re: /\.\s*open\s*\(\s*(['"`])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(['"`])((?:(?!\2)[\s\S])*?)\2/gi,
    url: 3,
  },
];

/** Addresses that are ours, so a site talking to us is not exfiltration. */
function ownHosts() {
  const hosts = new Set(['lintelapp.co.uk', 'www.lintelapp.co.uk', 'lintelsites.com']);
  for (const raw of [process.env.APP_URL, process.env.SITES_DOMAIN]) {
    if (!raw) continue;
    const v = String(raw).trim().toLowerCase();
    try {
      hosts.add(new URL(v.includes('://') ? v : `https://${v}`).hostname);
    } catch { /* not a URL; ignore */ }
  }
  return hosts;
}

function isOwnHost(host) {
  for (const own of ownHosts()) {
    if (host === own || host.endsWith('.' + own)) return true;
  }
  return false;
}

/** Host-level allowlist check -- no path constraint, unlike embeds. */
function isAllowedRequestHost(host) {
  return EMBED_ALLOWLIST.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * True when this URL is somewhere we won't let a site send data.
 * Anything we cannot resolve to an off-list host returns false: the
 * rule only fires on a URL it can actually read.
 */
function isDisallowedRequestUrl(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return false;
  if (value.includes('${')) return false;            // template -- not a literal
  if (value.startsWith('//')) value = 'https:' + value;
  // No scheme means same-origin. Relative URLs are explicitly ignored.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;                                     // unreadable -- can't prove it
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (isOwnHost(host)) return false;
  return !isAllowedRequestHost(host);
}

/** Inline <script> bodies only -- external ones are a different rule. */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\ssrc\s*=/i.test(m[1] || '')) continue;
    out.push(m[2] || '');
  }
  return out;
}

/** @returns {string|null} the offending URL, for the report */
export function findInlineRequest(html) {
  for (const code of inlineScripts(String(html || ''))) {
    for (const { re, url } of INLINE_REQUEST_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const candidate = m[url];
        if (isDisallowedRequestUrl(candidate)) return candidate;
      }
    }
  }
  return null;
}

// `why` and `fix` are written for the customer, not for us: they are
// shown in the builder chat when a live site is taken offline, and the
// person reading them did not write the offending markup -- the model
// did, on their behalf. So they say what was in the page and what to do
// next, never "your code" or a rule id.
const HARD_BLOCK_PATTERNS = [
  {
    id: 'password_input',
    label: 'a password field',
    why: 'which would invite visitors to type a real password into a page that has no way to protect it',
    fix: "If you wanted a members' area or a client login, describe what it should do in words rather than pasting code, and I'll build something that works safely.",
    re: /<input\b[^>]*\stype\s*=\s*["']password["']/i,
  },
  {
    id: 'external_form_action',
    label: 'a form that sends what visitors type to another company',
    why: "so enquiries would go somewhere other than your inbox, and we couldn't show them in your dashboard",
    fix: "Tell me in words which fields you want on the form and I'll wire it back to your enquiries, where you can read and export them.",
    // Stays a blanket block, deliberately: no legitimate embed posts one
    // of our forms off-site, and submissions are wired at publish time.
    re: /<form\b[^>]*\saction\s*=\s*["'](?:https?:)?\/\//i,
  },
  {
    id: 'external_script',
    label: 'a script loaded from a website we do not recognise',
    why: "which runs someone else's code in your visitors' browsers, and we can't vouch for what it does",
    fix: "If you were adding a booking, payment, shop, map or video widget, tell me which company it's from — describe the change in words rather than pasting code, and I'll add a version we support.",
    re: /<script\b[^>]*\ssrc\s*=\s*(["'])((?:https?:)?\/\/[^"']*)\1/gi,
    allow: (m) => isAllowedEmbedUrl(m[2]),
  },
  {
    id: 'external_iframe',
    label: 'an embedded page from a website we do not recognise',
    why: "which loads another site inside yours, and we can't vouch for what it shows your visitors",
    fix: "If you were embedding a booking calendar, map or video, tell me which company it's from — describe the change in words rather than pasting code, and I'll add a version we support.",
    re: /<iframe\b[^>]*\ssrc\s*=\s*(["'])((?:https?:)?\/\/[^"']*)\1/gi,
    allow: (m) => isAllowedEmbedUrl(m[2]),
  },
  {
    id: 'inline_external_request',
    // NOT live yet. findHardBlock skips this unless the caller opts in,
    // so the publish path and screenLiveSite behave exactly as before.
    // scripts/rescan-live-sites.mjs --experimental turns it on for a
    // read-only audit, which is how we find out what it would catch
    // before it can take anyone's site down.
    experimental: true,
    label: 'code that sends what visitors do to another company',
    why: "which would quietly pass your visitors' activity to a service we can't vouch for, without them being asked",
    fix: "If you were adding analytics, a chat widget or a booking tool, tell me which company it's from — describe the change in words rather than pasting code, and I'll add a version we support.",
    find: findInlineRequest,
  },
];

/** Look up a rule by the id stored on sites.offline_reason. */
export function describeHardBlock(id) {
  const rule = HARD_BLOCK_PATTERNS.find((r) => r.id === id);
  if (!rule) return null;
  return { id: rule.id, label: rule.label, why: rule.why, fix: rule.fix };
}

/**
 * The whole explanation, as the customer reads it in the chat. Kept
 * here rather than in the builder so the wording is defined once and
 * the dashboard, the chat and the rescan script cannot drift apart.
 */
export function offlineMessage(hit) {
  return [
    `I've taken your site offline. The version just saved includes ${hit.label}, ${hit.why}.`,
    "It stays unpublished until that's gone, so nobody lands on it in the meantime — everything you've built is safe, and publishing again is one click once it's fixed.",
    hit.fix,
  ].join('\n\n');
}

/** The one-liner the dashboard shows under a "Needs attention" pill. */
export function offlineSummary(id) {
  const rule = describeHardBlock(id);
  if (!rule) return 'This site was taken offline automatically. Open it in the builder to see why.';
  return `Taken offline automatically: the site includes ${rule.label}. Open it in the builder to fix it.`;
}

/**
 * Scans generated HTML for content that must never be published.
 * Returns null if clean, or { id, label } describing the first match.
 */
export function findHardBlock(html, options = {}) {
  const s = String(html || '');
  for (const rule of HARD_BLOCK_PATTERNS) {
    // Experimental rules are opt-in. Default-off is the whole point:
    // a rule that can unpublish a customer's site gets audited against
    // real sites before it is allowed to do that.
    if (rule.experimental && !options.experimental) continue;

    const hit = { id: rule.id, label: rule.label, why: rule.why, fix: rule.fix };

    // Rules with their own matcher return the offending value, which is
    // worth carrying into the report -- "which URL?" is the first thing
    // anyone asks.
    if (rule.find) {
      const detail = rule.find(s);
      if (detail) return { ...hit, detail };
      continue;
    }

    if (!rule.allow) {
      // A /g regex carries lastIndex between calls; .test() on a shared
      // pattern would skip matches on every second call. These two are
      // not global, but resetting keeps that true if one ever becomes so.
      rule.re.lastIndex = 0;
      if (rule.re.test(s)) return hit;
      continue;
    }
    // Allowlisted rules must check every occurrence: one bad embed among
    // good ones still blocks.
    for (const m of s.matchAll(rule.re)) {
      if (!rule.allow(m)) return hit;
    }
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

    // offline_reason is what separates this from a customer who
    // unpublished their own site: same status, different cause, and the
    // dashboard reads "Needs attention" rather than "Draft" because of it.
    await admin
      .from('sites')
      .update({
        status: 'draft',
        offline_reason: hit.id,
        offline_at: new Date().toISOString(),
      })
      .eq('id', site.id);

    console.error('[publish] hard block on live site -- taken offline', { projectId, ruleId: hit.id });
    return { ...hit, message: offlineMessage(hit) };
  } catch (err) {
    console.error('[publish] live-site screening failed', projectId, err);
    return null;
  }
}

// The public address of a published site. A custom domain only counts
// once it's verified -- custom_domain is written the moment the customer
// types it, and handing back an address that doesn't resolve yet makes
// their own site look broken. The subdomain always works.
export function publicUrl(site) {
  if (site.custom_domain && site.domain_status === 'verified') return `https://${site.custom_domain}`;
  const base = process.env.SITES_DOMAIN;           // e.g. lintelsites.com (needs wildcard DNS)
  if (base) return `https://${site.subdomain}.${base}`;
  const app = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${app}/s/${site.subdomain}`;             // works today, no DNS needed
}
