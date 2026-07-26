// ============================================================
// POST /api/generate/stream
// Same rules as /api/generate, but streams the site as it is
// written so the customer can watch it being built.
//
// The response is a plain text stream of HTML, followed by a
// final metadata line beginning with <!--LUMEN-META.
// ============================================================
import { requireUser, ApiError } from '@/lib/auth';
import { assertCanBuild, recordBuild, getUsageSnapshot } from '@/lib/usage';
import { streamSite } from '@/lib/anthropic';
import { makeSlug } from '@/lib/publish';
import { rateLimit } from '@/lib/ratelimit';
import { chooseModel } from '@/lib/routing';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 5;
const CLAUDE_MAX_BASE64_BYTES = 5 * 1024 * 1024; // Claude's hard limit on the base64-encoded image payload
const MAX_IMAGE_BYTES = CLAUDE_MAX_BASE64_BYTES * 3 / 4; // ~3.75MB of original file bytes, before base64 inflates it ~33%

function fail(status, message, extra = {}) {
  return Response.json({ error: message, ...extra }, { status });
}

// Validates the optional `images` field. Returns a clean array of
// { mediaType, data } ready to hand to Claude, or throws { status, message }.
function validateImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw { status: 400, message: 'images must be a list.' };
  if (images.length > MAX_IMAGES) throw { status: 400, message: `You can attach up to ${MAX_IMAGES} images.` };

  return images.map((img) => {
    if (!img || typeof img.mediaType !== 'string' || typeof img.data !== 'string') {
      throw { status: 400, message: 'Each image needs a mediaType and base64 data.' };
    }
    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      throw { status: 400, message: `Unsupported image type: ${img.mediaType}` };
    }
    const approxBytes = Math.ceil((img.data.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      throw { status: 400, message: 'Each image must be 3.75MB or smaller.' };
    }
    return { mediaType: img.mediaType, data: img.data };
  });
}

export async function POST(request) {
  let ctx;
  try {
    ctx = await requireUser(request);
  } catch (e) {
    return fail(e.status || 401, e.message);
  }
  const { profile, admin } = ctx;

  try {
    rateLimit(`gen:${profile.id}`, { max: 6, windowMs: 60_000 });
  } catch (e) {
    return fail(429, e.message, e.extra);
  }

  const body = await request.json().catch(() => ({}));
  const { projectId, brief, model = 'auto', images } = body;

  if (!brief || typeof brief !== 'string' || brief.trim().length < 3) {
    return fail(400, 'Tell us what you want to build.');
  }
  if (brief.length > 4000) return fail(400, 'That brief is a bit long — try trimming it.');

  let cleanImages;
  try {
    cleanImages = validateImages(images);
  } catch (e) {
    return fail(e.status || 400, e.message || 'Invalid images.');
  }

  // Limits and permissions
  let snapshot;
  try {
    snapshot = await assertCanBuild(admin, profile, model === 'auto' ? null : model);
  } catch (e) {
    return fail(e.status || 403, e.message, e.extra);
  }

  // Project
  let project;
  if (projectId) {
    const { data } = await admin
      .from('projects').select('*').eq('id', projectId).eq('user_id', profile.id).maybeSingle();
    if (!data) return fail(404, 'Project not found');
    project = data;
  } else {
    const { data, error } = await admin
      .from('projects').insert({ user_id: profile.id, name: 'New project' }).select().single();
    if (error) return fail(500, 'Could not create the project');
    project = data;
  }

  const isEdit = !!project.current_code;
  const routed = chooseModel({ brief, isEdit, requested: model, allowedModels: snapshot.allowedModels });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (text) => controller.enqueue(encoder.encode(text));

      // Tell the client what we're doing before any HTML arrives.
      send(`<!--LUMEN-START ${JSON.stringify({
        projectId: project.id,
        model: routed.model,
        reason: routed.reason,
        editing: isEdit,
      })} -->\n`);

      let result;
      try {
        result = await streamSite({
          brief,
          modelKey: routed.model,
          previousHtml: project.current_code || null,
          images: cleanImages,
          onChunk: (chunk) => send(chunk),
          signal: request.signal,
        });
      } catch (err) {
        console.error('[generate/stream] failed', err);
        send(`\n<!--LUMEN-META ${JSON.stringify({
          error: 'The build failed — please try again. You have not been charged a build.',
        })} -->`);
        controller.close();
        return;
      }

      // Save everything, then count the build.
      try {
        const title = result.title || 'New site';
        const plan = result.plan || null;
        const previewUrl = `${makeSlug(title)}.lumen.build`;
        const reply = plan?.message
          ? plan.message
          : (isEdit
              ? `Updated ${title}.${plan?.changed ? ' ' + plan.changed : ''}`
              : `Built ${title} — have a look on the right.`);

        await admin.from('messages').insert([
          { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
          { project_id: project.id, user_id: profile.id, role: 'assistant', content: reply, plan, model_used: routed.model },
        ]);

        await admin.from('versions').insert({
          project_id: project.id, label: title, brief: brief.slice(0, 500),
          code: result.html, model_used: routed.model,
        });

        const shouldRename =
          !project.name || project.name === 'New project' || project.name === 'Untitled project';

        await admin.from('projects').update({
          current_code: result.html,
          preview_url: previewUrl,
          updated_at: new Date().toISOString(),
          ...(shouldRename ? { name: title } : {}),
        }).eq('id', project.id);

        await recordBuild(admin, profile, snapshot);
        const after = await getUsageSnapshot(admin, profile);

        send(`\n<!--LUMEN-META ${JSON.stringify({
          projectId: project.id,
          name: shouldRename ? title : project.name,
          title,
          plan,
          reply,
          previewUrl,
          model: routed.model,
          edited: isEdit,
          truncated: result.stopReason === 'max_tokens',
          buildsLeft: after.buildsLeft,
          topupCredits: after.topupCredits,
          resetsAt: after.resetsAt,
        })} -->`);
      } catch (err) {
        console.error('[generate/stream] save failed', err);
        send(`\n<!--LUMEN-META ${JSON.stringify({ error: 'Built, but could not save. Try again.' })} -->`);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
