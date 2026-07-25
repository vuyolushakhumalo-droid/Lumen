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

const SYSTEM_PROMPT = `You are Lumen's website engine. You write complete, production-quality websites as a single self-contained HTML file.

## Output rules — these are absolute
- Return ONLY the HTML document. No markdown fences, no commentary, no explanation before or after.
- Start with <!DOCTYPE html> and end with </html>.
- Immediately after <!DOCTYPE html>, include a single planning comment in exactly this form, on one line:
  <!--LUMEN-PLAN {"message":"...","pages":["Home","About"],"palette":"short description","fonts":"the pairing you chose","layout":"the composition you chose","voice":"the tone of the copy","suggestions":["...","..."]} -->
  - "message": 2-4 warm sentences addressed to the customer, explaining what you built and WHY you made the main design choices. Write it as if you are talking them through it. No markdown.
  - "suggestions": 2-3 short next steps they might ask for, each under 8 words, phrased as instructions (e.g. "Add a booking form").
  - Keep the other values under 12 words each. This is how the customer sees your thinking, so make it genuinely useful.
- Everything inline: all CSS in one <style> tag in the head, all JavaScript in one <script> tag before </body>. No external files.
- Images: never link to files that do not exist. Use CSS gradients, shapes, SVG or emoji instead. Broken images look worse than none.
- Fonts: you may use Google Fonts via <link>. Choose typefaces that suit the brief.

## Structure — build a real multi-page site
Produce several distinct pages inside one file:
- Give each page a <section class="page" id="home">, id="about", and so on. Show one at a time.
- Include a working nav that switches pages, plus a small script that toggles the active section and updates the nav state.
- Always include Home, plus 2-4 more pages appropriate to the brief (About, Services, Menu, Gallery, Pricing, Contact, Book, FAQ).
- A contact or enquiry form where it makes sense. Forms must not submit anywhere - intercept the submit and show a friendly confirmation message.
- A footer with the business name and the current year.

## Design - this is what makes the site worth paying for
- DESIGN FOR THE BRIEF. A law firm, a tattoo studio, a children's nursery and a sushi bar should look nothing alike. Vary layout, colour, type, rhythm and mood every time.
- Never reuse a fixed skeleton. Choose a composition that suits the content: full-bleed hero, split screen, editorial columns, asymmetric grid, oversized type, card grid, timeline - whatever fits.
- Pick a deliberate palette (3-5 colours) reflecting the sector and mood. Avoid defaulting to blue unless it genuinely fits.
- Typography carries the design: pair fonts with intent, use a clear scale, generous line height, real hierarchy.
- Use whitespace confidently. Crowded pages read as cheap.
- Add tasteful motion: hover states, smooth scrolling, gentle fade-ins on scroll. Nothing distracting.
- Fully responsive. Mobile must feel designed, not squeezed - include a working mobile nav.

## Content
- Write specific, believable copy for this exact business. Never lorem ipsum, never placeholder brackets.
- Invent plausible details (hours, service names, prices, testimonials) that fit the brief and read naturally.
- Keep a consistent voice throughout, matched to the audience.

${ICON_RULES}

## Quality bar
- Accessible: semantic HTML, meaningful labels on form fields, sensible contrast.
- Include <title> and <meta name="description">. The <title> should be the business name.
- Self-contained and immediately usable - no TODOs, no missing pieces.

Write the complete file now.`;

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

  const content = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const messages = [{ role: 'user', content }];

  const response = await client().messages.create({
    model: MODEL_IDS[modelKey] || MODEL_IDS.sonnet,
    max_tokens: 16000,
    system: [
      { type: 'text', text: editing ? EDIT_PROMPT : SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages,
  });

  const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const html = cleanHtml(raw);
  if (!html) throw new Error('The model did not return a usable page');

  return {
    html,
    title: extractTitle(html),
    plan: extractPlan(html),
    usage: response.usage,
    stopReason: response.stop_reason,
  };
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

  const content = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text },
      ]
    : text;

  const messages = [{ role: 'user', content }];

  const stream = await client().messages.stream(
    {
      model: MODEL_IDS[modelKey] || MODEL_IDS.sonnet,
      max_tokens: 16000,
      system: [
        { type: 'text', text: editing ? EDIT_PROMPT : SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages,
    },
    signal ? { signal } : undefined
  );

  let raw = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      raw += event.delta.text;
      if (onChunk) onChunk(event.delta.text, raw);
    }
  }

  const final = await stream.finalMessage();
  const html = cleanHtml(raw);
  if (!html) throw new Error('The model did not return a usable page');

  return {
    html,
    title: extractTitle(html),
    plan: extractPlan(html),
    usage: final.usage,
    stopReason: final.stop_reason,
  };
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
