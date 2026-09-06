// ============================================================
// The 1200x630 card a shared link renders as.
//
// Generated on request at https://<the site>/og.png rather than baked
// at publish time. Two reasons: a site's name and colour change on any
// edit, not just a publish, so a stored image goes stale silently and
// wrong branding on a shared link is worse than none; and there is no
// file to store, upload, invalidate or clean up when a site is deleted.
// Scrapers fetch this once and cache it themselves, so it is not a hot
// path -- and the response carries a long s-maxage regardless.
// ============================================================
import { ImageResponse } from 'next/og';
import { decodeEntities } from './seo.js';

const WIDTH = 1200;
const HEIGHT = 630;
const FONT_TIMEOUT_MS = 2500;

// Fallback is near-black -- deliberately ours, not a guess at theirs. A
// wrong brand colour looks like a mistake; a neutral one just looks plain.
const FALLBACK_BG = '#0C1119';

/** #abc and #aabbcc only. Anything else is not a colour we'll trust. */
export function normaliseHex(value) {
  const s = String(value || '').trim();
  const m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return '#' + hex.toLowerCase();
}

/**
 * Relative luminance, so the name is readable on whatever the site's
 * colour turns out to be -- a pale brand needs dark text, and a card
 * with unreadable text is no better than the grey box it replaces.
 */
export function luminance(hexBg) {
  const h = hexBg.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Both text colours, derived from the background that is actually being
 * painted -- never from whether a brand colour was supplied.
 *
 * That distinction was the bug: the fallback background got a fixed
 * light ink, and the muted colour was then chosen by comparing that ink
 * against '#FFFFFF'. It wasn't equal, so the description was drawn in
 * near-black on a near-black card and effectively disappeared. Deriving
 * both from `bg` means there is no path where they disagree.
 */
export function cardColors(brandColor) {
  const bg = normaliseHex(brandColor) || FALLBACK_BG;
  const light = luminance(bg) <= 0.45;         // background is dark -> light text
  return {
    bg,
    ink: light ? '#FFFFFF' : '#101418',
    // The description is deliberately quieter than the name, but still
    // has to clear legibility on its own.
    muted: light ? 'rgba(255,255,255,0.80)' : 'rgba(16,20,24,0.75)',
  };
}

/**
 * Google's CSS endpoint serves woff2 to modern browsers, which satori
 * cannot read. An ancient user-agent gets TTF back instead.
 *
 * Best-effort by design: a font that won't load must not cost us the
 * card. Falling through returns null and the bundled default is used.
 */
async function loadGoogleFont(family, weight = 700) {
  const name = String(family || '').trim().replace(/["']/g, '').split(',')[0].trim();
  if (!name || !/^[A-Za-z0-9 ]{2,40}$/.test(name)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FONT_TIMEOUT_MS);
  try {
    const cssUrl =
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@${weight}`;
    const css = await fetch(cssUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)' },
    }).then((r) => (r.ok ? r.text() : ''));

    const url = (css.match(/src:\s*url\(([^)]+)\)/) || [])[1];
    if (!url) return null;

    const data = await fetch(url, { signal: controller.signal }).then((r) =>
      r.ok ? r.arrayBuffer() : null
    );
    if (!data) return null;
    return { name, data, weight, style: 'normal' };
  } catch {
    return null;                       // timeout, offline, unknown family
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} o
 * @param {string} o.name        business name, from the site's <title>
 * @param {string} [o.tagline]   the meta description, trimmed
 * @param {string} [o.brandColor] hex from the LUMEN-PLAN comment
 * @param {string} [o.headingFont] font family the model chose
 */
export async function renderOgImage({ name, tagline, brandColor, headingFont }) {
  const { bg, ink, muted } = cardColors(brandColor);

  // Both come from the page's own <title> and meta description, so they
  // arrive HTML-encoded. Drawn straight into an image that reads as
  // "Fern &amp; Field" -- decode before it reaches the canvas.
  const title = decodeEntities(name).slice(0, 70) || 'Website';
  const sub = decodeEntities(tagline).slice(0, 110);

  const font = await loadGoogleFont(headingFont);
  const fontFamily = font ? `"${font.name}"` : 'sans-serif';

  // Long names step down a size rather than wrapping to three lines.
  const titleSize = title.length > 42 ? 62 : title.length > 26 ? 78 : 96;

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', background: bg, padding: '80px 90px',
          fontFamily,
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                fontSize: titleSize, color: ink, lineHeight: 1.1,
                fontWeight: 700, letterSpacing: '-0.02em',
                display: 'flex', flexWrap: 'wrap',
              },
              children: title,
            },
          },
          sub && {
            type: 'div',
            props: {
              style: {
                fontSize: 30, color: muted, marginTop: 28, lineHeight: 1.35,
                display: 'flex', flexWrap: 'wrap',
              },
              children: sub,
            },
          },
        ].filter(Boolean),
      },
    },
    {
      width: WIDTH,
      height: HEIGHT,
      ...(font ? { fonts: [font] } : {}),
    }
  );
}
