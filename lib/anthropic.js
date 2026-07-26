// ============================================================
// Anthropic calls. Server-only — the API key never reaches the browser.
//
// This generates COMPLETE, ORIGINAL websites. The model writes real
// HTML and CSS from scratch each time, so two briefs produce two
// genuinely different sites rather than one template with new words.
// ============================================================
import Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS } from './plans.js';

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
Include a contact or enquiry form where it makes sense. Forms must not submit anywhere — intercept the submit and show a friendly inline confirmation message instead.
Include a footer with the business name and the current year.
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

Do not rely on external image files or placeholder-image services — they break and look broken. Create visual interest with CSS instead: tasteful gradients, solid colour blocks, geometric shapes, or inline SVG, used as intentional design elements.

${ICON_RULES}

COMPONENTS & POLISH

Buttons, links, and cards get hover and focus states and smooth transitions. Use a consistent border-radius and spacing scale throughout.
Use semantic HTML, include focus styles, and add alt text where relevant.
Deliver a site that feels finished and confident on the FIRST pass — as if a designer sweated the type, spacing, colour, and copy.`;

const EDIT_PROMPT = `You are editing an existing website. Apply the requested change and return the COMPLETE updated HTML document.

- Return ONLY the HTML. No fences, no commentary.
- Keep (or update) the <!--LUMEN-PLAN ... --> comment near the top. Set:
  - "changed": what you altered, under 12 words
  - "message": 2-3 warm sentences telling the customer what you changed and why, as if talking them through it
  - "suggestions": 2-3 sensible next steps, each under 8 words
- Change what was asked and keep everything else intact - same design language, structure and content unless the request implies otherwise.
- Preserve the existing pages and navigation unless asked to add or remove pages.
- Keep the file self-contained: inline CSS and JS, no external assets.

${ICON_RULES}`;

const MAX_OUTPUT_TOKENS = 128000; // Opus 4.8 / Fable 5's max output on the synchronous Messages API
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

/**
 * Generate or edit a site.
 * brief        - what the user asked for
 * modelKey     - haiku | sonnet | opus | fable
 * previousHtml - existing site, when editing
 */
export async function generateSite({ brief, modelKey = 'sonnet', previousHtml = null, images = [] }) {
  const editing = !!previousHtml;

  const text = editing
    ? `Here is the current website:\n\n${previousHtml}\n\n---\n\nRequested change: ${brief}`
    : `Build a website. Brief: ${brief}`;

  const userContent = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const system = [
    { type: 'text', text: editing ? EDIT_PROMPT : SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
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

    const response = await client().messages.create({
      model: MODEL_IDS[modelKey] || MODEL_IDS.sonnet,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages,
    });

    raw += response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    stopReason = response.stop_reason;
    usage = addUsage(usage, response.usage);

    if (stopReason !== 'max_tokens') break;
  }

  const html = cleanHtml(raw.trim());
  if (!html) throw new Error('The model did not return a usable page');

  return { html, title: extractTitle(html), plan: extractPlan(html), usage, stopReason };
}

/**
 * Streaming version — yields text chunks as the model writes them.
 * Same prompts, same rules; the caller assembles the final HTML.
 */
export async function streamSite({ brief, modelKey = 'sonnet', previousHtml = null, images = [], onChunk, signal }) {
  const editing = !!previousHtml;

  const text = editing
    ? `Here is the current website:\n\n${previousHtml}\n\n---\n\nRequested change: ${brief}`
    : `Build a website. Brief: ${brief}`;

  const userContent = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const system = [
    { type: 'text', text: editing ? EDIT_PROMPT : SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
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

    const stream = await client().messages.stream(
      { model: MODEL_IDS[modelKey] || MODEL_IDS.sonnet, max_tokens: MAX_OUTPUT_TOKENS, system, messages },
      signal ? { signal } : undefined
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        raw += event.delta.text;
        if (onChunk) onChunk(event.delta.text, raw);
      }
    }

    const final = await stream.finalMessage();
    stopReason = final.stop_reason;
    usage = addUsage(usage, final.usage);

    if (stopReason !== 'max_tokens') break;
  }

  const html = cleanHtml(raw);
  if (!html) throw new Error('The model did not return a usable page');

  return { html, title: extractTitle(html), plan: extractPlan(html), usage, stopReason };
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
  if (m && m[1].trim()) return m[1].trim();
  const h1 = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i);
  if (h1 && h1[1].trim()) return h1[1].trim();
  return 'New site';
}
