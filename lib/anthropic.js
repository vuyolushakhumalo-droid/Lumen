// ============================================================
// Anthropic calls. Server-only — the API key never reaches the browser.
//
// This generates COMPLETE, ORIGINAL websites. The model writes real
// HTML and CSS from scratch each time, so two briefs produce two
// genuinely different sites rather than one template with new words.
// ============================================================
import Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS } from './plans.js';
import { resolveImagePlaceholders } from './images.js';
import { decodeHtmlEntities } from './text.js';
import { withStage } from './attempts.js';

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const ICON_RULES = `## Social links — no exceptions
Social links MUST use real inline SVG brand marks. NEVER use emoji, text labels, letters, or pill-shaped buttons containing the platform name. Use these exact paths inside <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">:
  Facebook:  <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12z"/>
  Instagram: <path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.2 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c0 1.2-.2 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2 0-1.8-.2-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c0-1.2.2-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2zm0 1.8c-3.1 0-3.5 0-4.7.1-1.1 0-1.7.2-2.1.3-.5.2-.9.4-1.2.8-.4.3-.6.7-.8 1.2-.1.4-.3 1-.3 2.1-.1 1.2-.1 1.6-.1 4.7s0 3.5.1 4.7c0 1.1.2 1.7.3 2.1.2.5.4.9.8 1.2.3.4.7.6 1.2.8.4.1 1 .3 2.1.3 1.2.1 1.6.1 4.7.1s3.5 0 4.7-.1c1.1 0 1.7-.2 2.1-.3.5-.2.9-.4 1.2-.8.4-.3.6-.7.8-1.2.1-.4.3-1 .3-2.1.1-1.2.1-1.6.1-4.7s0-3.5-.1-4.7c0-1.1-.2-1.7-.3-2.1-.2-.5-.4-.9-.8-1.2-.3-.4-.7-.6-1.2-.8-.4-.1-1-.3-2.1-.3-1.2-.1-1.6-.1-4.7-.1zm0 3.1a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8zm0 8a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2zm6.3-8.2a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0z"/>
  TikTok:    <path d="M16.6 5.8a4.9 4.9 0 0 1-1-1.1 4.8 4.8 0 0 1-.8-2.5h-3.3v13.2a2.9 2.9 0 1 1-2.1-2.8V9.3a6.2 6.2 0 1 0 5.4 6.1V9a8.2 8.2 0 0 0 4.7 1.5V7.2a4.8 4.8 0 0 1-2.9-1.4z"/>
  X:         <path d="M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.1 22H3l7.3-8.3L2.4 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L8.3 3.8H6.5L17.8 20z"/>
  LinkedIn:  <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.1c.5-1 1.8-2 3.7-2 4 0 4.7 2.5 4.7 5.8V21h-4v-5.6c0-1.3 0-3-1.9-3s-2.2 1.5-2.2 2.9V21H9z"/>
  YouTube:   <path d="M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.7-1.8C19.3 5 12 5 12 5s-7.3 0-8.9.5A2.5 2.5 0 0 0 1.4 7.3C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.7 1.8c1.6.5 8.9.5 8.9.5s7.3 0 8.9-.5a2.5 2.5 0 0 0 1.7-1.8c.4-1.5.4-4.7.4-4.7zM9.8 15.3V8.7l6 3.3z"/>
  WhatsApp:  <path d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.9.9-2.8-.2-.3A8 8 0 1 1 12 20zm4.5-5.9c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.5 6.5 0 0 1-1.9-1.2 7.3 7.3 0 0 1-1.4-1.7c-.1-.2 0-.4.1-.5l.4-.4.2-.4a.4.4 0 0 0 0-.4c0-.1-.5-1.3-.7-1.8s-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c.6.3 1.1.4 1.5.5a3.5 3.5 0 0 0 1.6.1 2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3z"/>
  Give each link an aria-label with the platform name, and only include platforms the brief actually mentions.
- Render them as icon-only links (no visible text), sized 20-24px, in a single row.
- If the existing page uses emoji or text for social links, REPLACE them with these SVG marks.
- Give each link an aria-label with the platform name for screen readers.`;

const IMAGE_RULES = `## Photography
For decorative elements — backgrounds, dividers, abstract shapes, icons — keep using CSS: tasteful gradients, solid colour blocks, geometric shapes, or inline SVG. Never rely on external placeholder-image services, they break and look broken.
For real photography — hero shots, product or food photos, portraits, and anywhere a genuine photograph belongs — request one instead of faking it. Where an <img> belongs, write a placeholder comment on its own line, in exactly this form:
<!--LUMEN-IMG:{"prompt":"...","aspect":"landscape|portrait|square","alt":"..."}-->
"prompt" describes the photograph's subject, style and lighting in enough detail to generate it well — never describe UI chrome. "aspect" is one of landscape, portrait or square. "alt" is real, specific alt text.
Use at most 5 photographs on the site in total, counting any that already exist — and only where a photograph genuinely belongs, never for icons, patterns, or anything CSS/SVG already handles well.
Never write a real <img src="..."> yourself, and never invent or guess an image URL. Only use the placeholder comment above — the real src is filled in after generation.`;

const SYSTEM_PROMPT = `You are an expert product designer and front-end developer. You build complete, visually striking, production-quality marketing websites from a short description. Your work should look like it came from a senior design studio — distinctive and intentional, never templated or generic.

OUTPUT FORMAT

Return ONE complete, self-contained HTML document and nothing else: no explanation, no markdown, no code fences.
Start with <!DOCTYPE html> and end with </html>. Inline all CSS in a single <style> tag in the head, and any JS in a <script> before </body>.
Immediately after <!DOCTYPE html>, include a single planning comment in exactly this form, on one line:
<!--LUMEN-PLAN {"message":"...","pages":["Home","About"],"palette":"short description","fonts":"the pairing you chose","layout":"the composition you chose","voice":"the tone of the copy","suggestions":["...","..."]} -->
"message" is 2-4 warm sentences addressed to the customer, explaining what you built and why you made the main design choices, as if talking them through it. "suggestions" is 2-3 short next steps they might ask for, each under 8 words, phrased as instructions (e.g. "Add a booking form"). Keep every other value under 12 words.
The document must be complete and valid — never stop mid-element or omit the closing </html>.

STRUCTURE

Build a real multi-page site inside this one file: give each page a <section class="page" id="home">, id="about", and so on, shown one at a time, with a working nav plus a small script that toggles the active section and updates nav state.
Always include Home, plus 2–4 more pages appropriate to the brief (About, Services, Menu, Gallery, Pricing, Contact, Book, FAQ). Never return a single-page site.
Forms: emit <form data-lintel-form="contact"> with normal named inputs and a submit button. Do NOT add an action or method attribute, do not add any JavaScript, and never invent an endpoint URL — submission is wired automatically when the site is published. For a newsletter or mailing-list form use data-lintel-form="list_signup". You may add data-lintel-thanks="..." to customise the confirmation message.
Never link to invented external URLs — no fabricated booking, ordering, or social links to real third-party domains (OpenTable, Deliveroo, Instagram, etc.) unless the brief explicitly gives you that real link. Booking, ordering, or reservation buttons must scroll to an on-page section or use a form wired exactly like the contact form rule above.
Include a footer with the business name and the current year. Use the current year consistently in every copyright notice and any other dated copy on the site.
Include a real <title> and <meta name="description">, with the <title> set to the business name.

TYPOGRAPHY

Choose a characterful, intentional font pairing from Google Fonts (link them in the head). Never default to Arial, Times, or system fonts as the primary typeface.
Use at most two families — one for headings, one for body. Establish a strong hierarchy: large, confident headings; body text 16–18px with line-height ~1.6.

COLOUR & CONTRAST

Define a small, cohesive palette: a background, one or two neutrals, and a SINGLE accent. Use the accent sparingly — primary buttons and key highlights only; everything else stays neutral. Restraint reads as premium.
Every piece of text MUST have strong contrast against its background (meet WCAG AA). Never place light-grey text on a light background, or any low-contrast text. When in doubt, go darker.

LAYOUT & SPACE

Generous whitespace and clear section rhythm. Centre content in a max-width container (~1080–1200px) with consistent horizontal padding.
Use modern CSS (flexbox/grid). The site MUST be fully responsive — add media queries so it looks deliberate on mobile, not just shrunk.

CONTENT

Write real, specific, benefit-led copy tailored to this exact business. Invent plausible concrete details — named menu items with prices, real-sounding testimonials with names, specific feature descriptions.
NEVER use lorem ipsum or placeholder text like "Your headline here."

IMAGERY

${IMAGE_RULES}

${ICON_RULES}

COMPONENTS & POLISH

Buttons, links, and cards get hover and focus states and smooth transitions. Use a consistent border-radius and spacing scale throughout.
Use semantic HTML, include focus styles, and add alt text where relevant.
Deliver a site that feels finished and confident on the FIRST pass — as if a designer sweated the type, spacing, colour, and copy.`;

const EDIT_PROMPT = `You are editing an existing website. Do not return the whole document — return a list of exact find/replace patches instead.

- Return ONLY one HTML comment and nothing else: no explanation, no markdown, no extra text before or after it. In exactly this form:
<!--LUMEN-PATCH [{"find":"...","replace":"..."},{"find":"...","replace":"..."}] -->
- Every "find" must be copied character-for-character from the current website below — the exact substring being replaced, with enough surrounding context to be unambiguous if that text could otherwise appear more than once. Never paraphrase, reformat, or re-indent text you weren't asked to change.
- Include exactly one patch that updates the plan comment: "find" is the existing <!--LUMEN-PLAN ...--> comment, copied exactly as it appears near the top of the current document; "replace" is a new one in the same place with these fields set: "changed" (what you altered, under 12 words), "message" (2-3 warm sentences telling the customer what you changed and why, as if talking them through it), "suggestions" (2-3 sensible next steps, each under 8 words). Carry over any other fields from the old plan comment unchanged.
- Add one further patch per distinct place the requested change touches — most edits need only one. Do not touch anything the request didn't ask for.
- Existing <img> tags with a real, already-hosted src must be preserved exactly, unchanged — same src, same alt — unless the request explicitly asks to change that specific image. When it does, write a patch whose "find" is that exact <img> tag and whose "replace" is a fresh LUMEN-IMG placeholder. Never touch any other existing image.
- Forms: any form you add or modify must be <form data-lintel-form="contact"> (or data-lintel-form="list_signup" for a mailing list) with no action, no method and no JavaScript. Never write an endpoint URL. Preserve the data-lintel-form attribute on any existing form — removing it stops submissions being captured.
- Never invent external URLs — no fabricated booking, ordering, or social links to real third-party domains (OpenTable, Deliveroo, Instagram, etc.) unless the request supplies the real link. Booking or ordering buttons should scroll to an on-page section or use a <form data-lintel-form="contact"> with an inline confirmation.
- Keep copyright notices and any other dated copy on the current year.

${IMAGE_RULES}
${ICON_RULES}`;

// The safety net: used only when two patch attempts both fail to apply
// cleanly. Exactly what EDIT_PROMPT used to be, verbatim.
const EDIT_FALLBACK_PROMPT = `You are editing an existing website. Apply the requested change and return the COMPLETE updated HTML document.

- Return ONLY the HTML. No fences, no commentary.
- Keep (or update) the <!--LUMEN-PLAN ... --> comment near the top. Set:
  - "changed": what you altered, under 12 words
  - "message": 2-3 warm sentences telling the customer what you changed and why, as if talking them through it
  - "suggestions": 2-3 sensible next steps, each under 8 words
- Change what was asked and keep everything else intact - same design language, structure and content unless the request implies otherwise.
- Preserve the existing pages and navigation unless asked to add or remove pages.
- Keep the file self-contained: inline CSS and JS, no external assets.
- Never invent external URLs — no fabricated booking, ordering, or social links to real third-party domains (OpenTable, Deliveroo, Instagram, etc.) unless the request supplies the real link. Booking or ordering buttons should scroll to an on-page section or use a <form data-lintel-form="contact"> with an inline confirmation.
- Keep copyright notices and any other dated copy on the current year.
- Existing <img> tags with a real, already-hosted src must be preserved exactly, unchanged — same src, same alt — unless the request explicitly asks to change that specific image. When it does, replace only that one <img> tag with a fresh LUMEN-IMG placeholder; leave every other existing image exactly as it is. Never re-emit a placeholder for an image the request didn't ask to change.
- Forms: any form you add or modify must be <form data-lintel-form="contact"> (or data-lintel-form="list_signup" for a mailing list) with no action, no method and no JavaScript. Never write an endpoint URL. Preserve the data-lintel-form attribute on any existing form — removing it stops submissions being captured.

${IMAGE_RULES}
${ICON_RULES}`;

// A fast, cheap teaser shown only when an edit is taking a while.
// Present-progressive, non-committal -- the real result can still end
// up held back by the similarity guard, so this must never claim the
// change is finished.
const PREVIEW_PROMPT = `You are about to make a change to a customer's website, but you have not started yet. In ONE short sentence, written in the present progressive tense (e.g. "Looking at...", "Working on...", "Checking..."), tell the customer what you're starting to look at, based on their request below. Never say the change is finished, never describe a result, never use past tense -- you have not made it yet and it might not end up exactly as asked. Plain, warm, human tone, no exclamation marks. Return ONLY the sentence: no quotes, no preamble, no markdown.`;

const MAX_PREVIEW_TOKENS = 60;

export async function previewSummary({ brief, signal }) {
  const response = await client().messages.create(
    {
      model: MODEL_IDS.haiku,
      max_tokens: MAX_PREVIEW_TOKENS,
      system: PREVIEW_PROMPT,
      messages: [{ role: 'user', content: brief }],
    },
    signal ? { signal } : undefined
  );
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, usage: response.usage || {} };
}

const MAX_OUTPUT_TOKENS = 128000; // Opus 5 / Fable 5's max output on the synchronous Messages API
const MAX_CONTINUATION_ROUNDS = 3; // plus the initial call -- up to 4 requests total per build

const CONTINUE_INSTRUCTION = 'Continue the HTML document exactly where you left off. Do not repeat any earlier text, add commentary, or use markdown fences -- resume writing raw HTML from the exact point you stopped, and finish the document completely, ending with </html>.';

// Sums numeric usage fields (input_tokens, output_tokens, and any cache
// fields) across every round of a possibly-continued generation.
function addUsage(total, u) {
  if (!u) return total;
  for (const k of Object.keys(u)) {
    if (typeof u[k] === 'number') total[k] = (total[k] || 0) + u[k];
  }
  return total;
}

// Single non-streaming Claude call, with the same continuation-round
// support as the streaming path. Used for edit patch attempts, the
// full-regen fallback, and generateSite's (non-streaming) new builds.
async function completeOnce({ system, userContent, modelKey, signal }) {
  let raw = '';
  let stopReason = null;
  let usage = {};

  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    const messages = round === 0
      ? [{ role: 'user', content: userContent }]
      : [
          { role: 'user', content: userContent },
          { role: 'assistant', content: raw },
          { role: 'user', content: CONTINUE_INSTRUCTION },
        ];

    let response;
    try {
      response = await client().messages.create(
        { model: MODEL_IDS[modelKey] || MODEL_IDS.opus, max_tokens: MAX_OUTPUT_TOKENS, system, messages },
        signal ? { signal } : undefined
      );
    } catch (err) {
      throw withStage('model_call', err);
    }

    raw += response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    stopReason = response.stop_reason;
    usage = addUsage(usage, response.usage);

    if (stopReason !== 'max_tokens') break;
  }

  return { raw, stopReason, usage };
}

// Parses a <!--LUMEN-PATCH [...]--> comment into a validated array of
// {find, replace} pairs, or null if it's missing or malformed.
function extractPatches(text) {
  const m = text.match(/<!--\s*LUMEN-PATCH\s*(\[[\s\S]*?\])\s*-->/i);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr) || !arr.length) return null;
    if (!arr.every((p) => p && typeof p.find === 'string' && typeof p.replace === 'string')) return null;
    return arr;
  } catch (e) {
    return null;
  }
}

// Applies every patch via exact string substitution. All-or-nothing:
// returns null if any "find" is missing or matches more than once,
// rather than risk a half-applied edit.
function applyPatches(previousHtml, patches) {
  let out = previousHtml;
  for (const { find, replace } of patches) {
    const occurrences = out.split(find).length - 1;
    if (occurrences !== 1) return null;
    out = out.replace(find, replace);
  }
  return out;
}

// ---- similarity guard for the edit fallback path ----
// Cheap heuristics, not real text-diffing — enough to catch "generated
// an unrelated site" without the cost or complexity of a real diff.
function titleOf(html) {
  const m = html.match(/<title>([^<]{1,80})<\/title>/i);
  return m ? m[1].trim().toLowerCase() : '';
}

function significantWords(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase();
  return new Set(text.match(/[a-z0-9]{4,}/g) || []);
}

function wordOverlapRatio(a, b) {
  const setA = significantWords(a);
  const setB = significantWords(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// True if newHtml looks like a different site rather than an edited
// version of previousHtml. Requires at least two of three signals to
// look wrong, so one legitimately large edit (e.g. "add three new
// sections") doesn't trip it on length or word-overlap alone.
function isNearTotalReplacement(previousHtml, newHtml) {
  const prevTitle = titleOf(previousHtml);
  const newTitle = titleOf(newHtml);
  const titleChanged = String(prevTitle || '').trim() !== String(newTitle || '').trim();

  const overlap = wordOverlapRatio(previousHtml, newHtml);
  const lenRatio = newHtml.length / Math.max(1, previousHtml.length);

  const suspicious = [
    titleChanged,
    overlap < 0.3,
    lenRatio < 0.5 || lenRatio > 2.2,
  ].filter(Boolean).length;

  return suspicious >= 2;
}

// Shared by generateSite and streamSite for edits. Two patch attempts,
// then a full-document regeneration fallback so an edit never
// half-applies. Not streamed — patches (and the rare fallback) are
// small enough that live token-by-token display isn't needed.
async function runEdit({ brief, previousHtml, images, modelKey, projectId, userId, plan, signal }) {
  const text = `Here is the current website:\n\n${previousHtml}\n\n---\n\nRequested change: ${brief}`;
  const userContent = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const patchSystem = [{ type: 'text', text: EDIT_PROMPT, cache_control: { type: 'ephemeral' } }];

  let usage = {};
  let patched = null;
  let succeededOnAttempt = null;

  for (let attempt = 0; attempt < 2 && !patched; attempt++) {
    const { raw, usage: u } = await completeOnce({ system: patchSystem, userContent, modelKey, signal });
    usage = addUsage(usage, u);
    try {
      const patches = extractPatches(raw);
      if (patches) {
        patched = applyPatches(previousHtml, patches);
        if (patched) succeededOnAttempt = attempt;
      }
    } catch (err) {
      throw withStage('patch_apply', err);
    }
  }

  let rawHtml, stopReason;
  let usedFallback = false;
  let editMode;
  if (patched) {
    rawHtml = patched;
    stopReason = 'patch_applied';
    editMode = succeededOnAttempt === 0 ? 'patch_first' : 'patch_retry';
  } else {
    usedFallback = true;
    editMode = 'fallback';
    const fallbackSystem = [{ type: 'text', text: EDIT_FALLBACK_PROMPT, cache_control: { type: 'ephemeral' } }];
    const { raw, stopReason: sr, usage: u } = await completeOnce({ system: fallbackSystem, userContent, modelKey, signal });
    usage = addUsage(usage, u);
    stopReason = sr;
    rawHtml = raw;
  }

  const cleaned = cleanHtml(rawHtml);
  if (!cleaned) throw withStage('clean_html', new Error('The model did not return a usable page'));
  const { html, imagesQuotaExhausted } = await resolveImagePlaceholders({ html: cleaned, projectId, userId, plan });

  // Only the fallback path can produce a full-document replacement --
  // patch application is inherently targeted, so it never needs this check.
  const needsConfirmation = usedFallback && isNearTotalReplacement(previousHtml, html);

  return {
    html, title: extractTitle(html), plan: extractPlan(html), usage, stopReason,
    imagesQuotaExhausted, usedFallback, needsConfirmation, editMode,
  };
}

/**
 * Generate or edit a site.
 * brief        - what the user asked for
 * modelKey     - haiku | sonnet | opus | fable
 * previousHtml - existing site, when editing
 */
export async function generateSite({ brief, modelKey = 'opus', previousHtml = null, images = [], projectId, userId, plan }) {
  const editing = !!previousHtml;

  if (editing) {
    return await runEdit({ brief, previousHtml, images, modelKey, projectId, userId, plan });
  }

  const text = `Build a website. Brief: ${brief}`;
  const userContent = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;
  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const { raw, stopReason, usage } = await completeOnce({ system, userContent, modelKey });

  const cleaned = cleanHtml(raw.trim());
  if (!cleaned) throw withStage('clean_html', new Error('The model did not return a usable page'));
  const { html, imagesQuotaExhausted } = await resolveImagePlaceholders({ html: cleaned, projectId, userId, plan });

  return { html, title: extractTitle(html), plan: extractPlan(html), usage, stopReason, imagesQuotaExhausted };
}

/**
 * Streaming version — yields text chunks as the model writes them.
 * Same prompts, same rules; the caller assembles the final HTML.
 * Edits don't stream (see runEdit) — only new builds do.
 */
export async function streamSite({ brief, modelKey = 'opus', previousHtml = null, images = [], onChunk, signal, projectId, userId, plan }) {
  const editing = !!previousHtml;

  if (editing) {
    return await runEdit({ brief, previousHtml, images, modelKey, projectId, userId, plan, signal });
  }

  const text = `Build a website. Brief: ${brief}`;

  const userContent = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  let raw = '';
  let stopReason = null;
  let usage = {};

  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    const messages = round === 0
      ? [{ role: 'user', content: userContent }]
      : [
          { role: 'user', content: userContent },
          { role: 'assistant', content: raw },
          { role: 'user', content: CONTINUE_INSTRUCTION },
        ];

    let final;
    try {
      const stream = await client().messages.stream(
        { model: MODEL_IDS[modelKey] || MODEL_IDS.opus, max_tokens: MAX_OUTPUT_TOKENS, system, messages },
        signal ? { signal } : undefined
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          raw += event.delta.text;
          if (onChunk) onChunk(event.delta.text, raw);
        }
      }

      final = await stream.finalMessage();
    } catch (err) {
      throw withStage('model_call', err);
    }

    stopReason = final.stop_reason;
    usage = addUsage(usage, final.usage);

    if (stopReason !== 'max_tokens') break;
  }

  const cleaned = cleanHtml(raw);
  if (!cleaned) throw withStage('clean_html', new Error('The model did not return a usable page'));
  const { html, imagesQuotaExhausted } = await resolveImagePlaceholders({ html: cleaned, projectId, userId, plan });

  return { html, title: extractTitle(html), plan: extractPlan(html), usage, stopReason, imagesQuotaExhausted };
}

// Strip any stray markdown fencing and confirm we have a real document.
function cleanHtml(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = out.search(/<!DOCTYPE html>|<html[\s>]/i);
  if (start > 0) out = out.slice(start);

  const end = out.toLowerCase().lastIndexOf('</html>');
  if (end > -1) out = out.slice(0, end + 7);

  if (!/<html[\s>]/i.test(out)) return null;
  return out;
}

// Pull out the model's own description of how it built the site.
function extractPlan(html) {
  const m = html.match(/<!--\s*LUMEN-PLAN\s*(\{[\s\S]*?\})\s*-->/i);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    const clean = {};
    ['message', 'pages', 'palette', 'fonts', 'layout', 'voice', 'changed', 'suggestions'].forEach((k) => {
      if (raw[k] == null) return;
      if (k === 'pages' && Array.isArray(raw[k])) {
        clean.pages = raw[k].slice(0, 8).map((s) => String(s).slice(0, 30));
      } else if (k === 'suggestions' && Array.isArray(raw[k])) {
        clean.suggestions = raw[k].slice(0, 3).map((s) => String(s).slice(0, 60));
      } else if (k === 'message') {
        clean.message = String(raw[k]).slice(0, 600);
      } else {
        clean[k] = String(raw[k]).slice(0, 120);
      }
    });
    return Object.keys(clean).length ? clean : null;
  } catch (e) {
    return null;
  }
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]{1,80})<\/title>/i);
  if (m && m[1].trim()) return decodeHtmlEntities(m[1].trim());
  const h1 = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i);
  if (h1 && h1[1].trim()) return decodeHtmlEntities(h1[1].trim());
  return 'New site';
}
