// ============================================================
// AI-generated site photography.
//
// The build prompts let Claude request a real photograph by emitting
// a <!--LUMEN-IMG:{"prompt":...,"aspect":...,"alt":...}--> placeholder
// where an <img> belongs. This module turns those placeholders into
// real, hosted images after generation:
//   1. work out how many, if any, this user can still generate this
//      month, and cap at 5 per build regardless
//   2. call OpenAI's image API for the allowed ones, in parallel
//   3. upload each result to a public Supabase Storage bucket
//   4. swap each placeholder for a real <img src="..."> tag
// Anything skipped (over the per-build cap, or over the monthly
// allowance) falls back to a plain CSS gradient block instead of
// failing the build. Every real OpenAI attempt — success or failure
// — is logged to image_generations, which also doubles as the
// monthly-usage counter (count this user's rows since month start).
//
// Never base64-embed images into the HTML itself — current_code is
// re-sent to Claude in full on every edit, and inline base64 would
// bloat that badly.
// ============================================================
import { supabaseAdmin } from './supabase.js';
import { PLANS } from './plans.js';
import { monthStart } from './usage.js';
import { withStage } from './attempts.js';
import { randomUUID } from 'node:crypto';

export const IMAGE_BUCKET = 'site-images';
const MAX_IMAGES_PER_BUILD = 5;
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_QUALITY = 'medium';

const SIZE_BY_ASPECT = {
  landscape: '1536x1024',
  portrait: '1024x1536',
  square: '1024x1024',
};

const RATIO_BY_ASPECT = {
  landscape: '16/9',
  portrait: '3/4',
  square: '1/1',
};

function normalizeAspect(a) {
  return ['landscape', 'portrait', 'square'].includes(a) ? a : 'square';
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fallbackBlock(alt, aspect) {
  const ratio = RATIO_BY_ASPECT[aspect] || RATIO_BY_ASPECT.square;
  return `<div role="img" aria-label="${escapeAttr(alt)}" style="aspect-ratio:${ratio};border-radius:14px;background:linear-gradient(135deg,#d8dde3,#eef0f3)"></div>`;
}

function fallbackFromMatch(m) {
  let alt = '', aspect = 'square';
  try { const spec = JSON.parse(m[1]); alt = spec.alt; aspect = normalizeAspect(spec.aspect); } catch (e) {}
  return fallbackBlock(alt, aspect);
}

// The single place the actual OpenAI request body is built. Callers
// keep a reference to it so image_generations logs exactly what was
// sent, not a separately-maintained copy that can silently drift.
function buildImageRequest(prompt, aspect) {
  return {
    model: IMAGE_MODEL,
    prompt,
    size: SIZE_BY_ASPECT[aspect] || SIZE_BY_ASPECT.square,
    quality: IMAGE_QUALITY,
    output_format: 'jpeg',
    n: 1,
  };
}

async function generateImage(requestBody) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) throw new Error(`OpenAI image request failed (${res.status})`);

  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image data');
  return Buffer.from(b64, 'base64');
}

async function uploadImage(projectId, buffer) {
  const admin = supabaseAdmin();
  const path = `${projectId}/${randomUUID()}.jpg`;

  const { error: uploadError } = await admin.storage
    .from(IMAGE_BUCKET)
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) throw uploadError;

  const { data } = admin.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function countImagesThisMonth(admin, userId) {
  try {
    const { count } = await admin
      .from('image_generations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', monthStart().toISOString());
    return count || 0;
  } catch (err) {
    throw withStage('image_generation', err);
  }
}

async function logImageGeneration(admin, { userId, projectId, status, model, quality }) {
  try {
    await admin.from('image_generations').insert({
      user_id: userId, project_id: projectId,
      model, quality, status,
    });
  } catch (err) {
    console.error('[images] failed to log generation', err);
  }
}

async function attemptOne(m, { projectId, userId, admin }) {
  let alt = '', aspect = 'square';
  let requestBody = null;
  try {
    const spec = JSON.parse(m[1]);
    alt = spec.alt;
    aspect = normalizeAspect(spec.aspect);
    const prompt = String(spec.prompt || '').slice(0, 2000);
    if (!prompt) throw new Error('Placeholder is missing a prompt');

    requestBody = buildImageRequest(prompt, aspect);
    const buffer = await generateImage(requestBody);
    const url = await uploadImage(projectId, buffer);
    await logImageGeneration(admin, { userId, projectId, status: 'success', model: requestBody.model, quality: requestBody.quality });
    return { raw: m[0], replacement: `<img src="${url}" alt="${escapeAttr(alt)}" loading="lazy">` };
  } catch (err) {
    console.error('[images] generation failed, using fallback', err);
    await logImageGeneration(admin, {
      userId, projectId, status: 'failed',
      model: requestBody?.model || IMAGE_MODEL,
      quality: requestBody?.quality || IMAGE_QUALITY,
    });
    return { raw: m[0], replacement: fallbackBlock(alt, aspect) };
  }
}

/**
 * Replaces LUMEN-IMG placeholders in html with real hosted <img> tags,
 * subject to a hard 5-per-build cap and the plan's monthly allowance.
 * Always resolves — nothing here ever fails the build.
 */
export async function resolveImagePlaceholders({ html, projectId, userId, plan }) {
  const allMatches = [...html.matchAll(/<!--LUMEN-IMG:(\{[\s\S]*?\})-->/g)];
  if (!allMatches.length) return { html, imagesQuotaExhausted: false };

  const admin = supabaseAdmin();
  const monthlyLimit = PLANS[plan]?.monthlyImages || 0;
  const used = await countImagesThisMonth(admin, userId);
  const remaining = Math.max(0, monthlyLimit - used);

  const capped = allMatches.slice(0, MAX_IMAGES_PER_BUILD);
  const allowed = capped.slice(0, remaining);
  const blocked = capped.slice(remaining);
  const overflow = allMatches.slice(MAX_IMAGES_PER_BUILD);

  // Only a real ("this plan has an allowance and it ran out") case is
  // worth telling the customer about — a 0-allowance plan stays quiet.
  const imagesQuotaExhausted = monthlyLimit > 0 && blocked.length > 0;

  const attempted = await Promise.all(allowed.map((m) => attemptOne(m, { projectId, userId, admin })));
  const skipped = [...blocked, ...overflow].map((m) => ({ raw: m[0], replacement: fallbackFromMatch(m) }));

  let out = html;
  for (const { raw, replacement } of [...attempted, ...skipped]) out = out.replace(raw, replacement);
  return { html: out, imagesQuotaExhausted };
}

/** Deletes every stored image for a project. Best-effort — logs, never throws. */
export async function deleteProjectImages(projectId) {
  const admin = supabaseAdmin();
  try {
    const { data: files, error } = await admin.storage.from(IMAGE_BUCKET).list(projectId);
    if (error || !files?.length) return;
    await admin.storage.from(IMAGE_BUCKET).remove(files.map((f) => `${projectId}/${f.name}`));
  } catch (err) {
    console.error('[images] failed to delete images for project', projectId, err);
  }
}
