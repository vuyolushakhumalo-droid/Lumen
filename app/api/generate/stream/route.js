// ============================================================
// POST /api/generate/stream
// Same rules as /api/generate, but streams the site as it is
// written so the customer can watch it being built.
//
// The response is a plain text stream of HTML, followed by a
// final metadata line beginning with <!--LUMEN-META.
// ============================================================
import { requireUser, ApiError } from '@/lib/auth';
import { assertCanBuild, recordBuild, getUsageSnapshot, logUsageEvent, resolvePreviousHtml, rollbackVersion } from '@/lib/usage';
import { streamSite } from '@/lib/anthropic';
import { makeSlug, screenLiveSite } from '@/lib/publish';
import { rateLimitDb } from '@/lib/ratelimit';
import { chooseModel } from '@/lib/routing';
import { startAttempt, finishAttempt } from '@/lib/attempts';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 800; // needs Fluid compute enabled on the Vercel project (Pro/Enterprise ceiling is 800s with it on, 300s default without)

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 5;
const CLAUDE_MAX_BASE64_BYTES = 5 * 1024 * 1024; // Claude's hard limit on the base64-encoded image payload
const MAX_IMAGE_BYTES = CLAUDE_MAX_BASE64_BYTES * 3 / 4; // ~3.75MB of original file bytes, before base64 inflates it ~33%

function fail(status, message, extra = {}) {
  return Response.json({ error: message, ...extra }, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' },
  });
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
    await rateLimitDb(admin, `gen:${profile.id}`, { max: 6 });
  } catch (e) {
    return fail(429, e.message, e.extra);
  }

  const body = await request.json().catch(() => ({}));
  const { projectId, brief, model = 'auto', images, clientExpectsEdit } = body;

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

  // project.current_code is the normal source for previousHtml; if it's
  // empty but versions exist, that's a stale read, not a genuinely new
  // project -- resolvePreviousHtml recovers the last known content so
  // this can't silently become an unrelated new build that overwrites
  // real prior work.
  const previousHtml = await resolvePreviousHtml(admin, project);

  // The base this edit is computed against -- checked against the current
  // value at write time so a concurrent write elsewhere can't be silently
  // overwritten. Not updated_at: that's also touched by unrelated writes
  // (e.g. renaming a project) and would cause false conflicts.
  const baseCodeVersion = project.code_version ?? 0;

  // The client believes it has a site loaded for this project, but the
  // server has nothing -- no current_code, no version history either.
  // Guessing here (either silently building fresh, or silently editing
  // nothing) is exactly what caused the original bug. Refuse instead
  // and let the customer decide. No model call, no write, no charge.
  if (!previousHtml && clientExpectsEdit) {
    const refusedId = await startAttempt(admin, {
      projectId: project.id, userId: profile.id, kind: 'edit',
      clientExpectsEdit: true, previousHtmlLength: 0,
    });
    await finishAttempt(admin, refusedId, { status: 'refused' });
    return fail(409, 'no_saved_site', {
      message: "This project has no saved site on the server, so it can't be edited. The site you were viewing was never saved. Your next message will start a new build from scratch.",
    });
  }

  // current_code was empty but a prior version existed -- resolvePreviousHtml
  // recovered it. That's a data-integrity gap worth surfacing to the
  // customer, not just a console.warn only we can see.
  const recoveredFromVersion = !project.current_code && !!previousHtml;

  const isEdit = !!previousHtml;
  const routed = chooseModel({ brief, isEdit, requested: model, allowedModels: snapshot.allowedModels });

  // Logged as early as possible -- before the model call -- so a
  // failure at any point from here on leaves a trace, not just successes.
  const attemptId = await startAttempt(admin, {
    projectId: project.id, userId: profile.id, kind: isEdit ? 'edit' : 'build',
    model: routed.model, clientExpectsEdit: !!clientExpectsEdit,
    previousHtmlLength: previousHtml?.length ?? 0,
  });

  const encoder = new TextEncoder();

  // Shared by start() and cancel() below, so however this attempt ends,
  // the row is updated exactly once.
  let finished = false;
  async function finish(status, stage, error) {
    if (finished) return;
    finished = true;
    await finishAttempt(admin, attemptId, { status, stage, error });
  }

  // Drives the Anthropic call's own signal. Bridged from two sources:
  // request.signal (fires reliably on client disconnect in this runtime)
  // and cancel() below (belt and braces, in case the platform ever does
  // invoke it) -- either aborts the upstream call, so it stops generating
  // (and we stop paying for) output tokens nobody will see, instead of
  // running to completion unread.
  const anthropicAbort = new AbortController();
  if (request.signal.aborted) {
    anthropicAbort.abort(request.signal.reason);
  } else {
    request.signal.addEventListener('abort', () => anthropicAbort.abort(request.signal.reason));
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (text) => controller.enqueue(encoder.encode(text));

      try {
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
            previousHtml,
            images: cleanImages,
            onChunk: (chunk) => send(chunk),
            signal: anthropicAbort.signal,
            projectId: project.id,
            userId: profile.id,
            plan: snapshot.plan,
          });
        } catch (err) {
          console.error('[generate/stream] failed', err);
          const isAbort = err?.name === 'AbortError';
          await finish(isAbort ? 'aborted' : 'failed', err?.stage || 'model_call', isAbort ? null : err);
          send(`\n<!--LUMEN-META ${JSON.stringify({
            error: 'The build failed — please try again. You have not been charged a build.',
          })} -->`);
          return;
        }

        // Save everything, then count the build.
        try {
          const title = result.title || 'New site';
          const plan = result.plan || null;
          const previewUrl = `${makeSlug(title)}.lintelsites.com`;

          // A near-total replacement from the edit fallback path is held
          // back rather than auto-applied -- current_code stays untouched,
          // and the client must explicitly confirm via /apply-replacement.
          if (result.needsConfirmation) {
            const pendingReply = "This edit came back looking like a full replacement rather than a small change, so I've held it back — review it and confirm if you want to apply it, or keep your current site."
              + (recoveredFromVersion ? " One more thing: your saved site was out of sync, so I recovered your last saved version and worked from that instead." : '');

            await admin.from('messages').insert([
              { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
              { project_id: project.id, user_id: profile.id, role: 'assistant', content: pendingReply, plan, model_used: routed.model },
            ]);

            await logUsageEvent(admin, {
              userId: profile.id, projectId: project.id, model: routed.model,
              usage: result.usage, kind: 'edit', editMode: result.editMode,
            });

            await finish('succeeded', null, null);

            await recordBuild(admin, profile, snapshot);
            const after = await getUsageSnapshot(admin, profile);

            send(`\n<!--LUMEN-META ${JSON.stringify({
              projectId: project.id,
              title,
              pending: true,
              pendingCode: result.html,
              plan,
              reply: pendingReply,
              model: routed.model,
              edited: isEdit,
              buildsLeft: after.buildsLeft,
              topupCredits: after.topupCredits,
              resetsAt: after.resetsAt,
            })} -->`);
            return;
          }

          const shouldRename =
            !project.name || project.name === 'New project' || project.name === 'Untitled project';

          let reply = plan?.message
            ? plan.message
            : (isEdit
                ? `Updated ${title}.${plan?.changed ? ' ' + plan.changed : ''}`
                : `Built ${title} — have a look on the right.`);
          if (result.imagesQuotaExhausted) {
            reply += " You've used this month's photo allowance, so any new images use a placeholder style instead — more unlocks next month.";
          }
          if (recoveredFromVersion) {
            reply += " One thing to flag: your saved site was out of sync, so I recovered your last saved version and worked from that instead.";
          }

          // A committed fallback replacement still gets an explicit undo
          // path, since it's a bigger change than a normal targeted edit.
          // Must run before the version insert below, or it would just
          // find the version this request is about to create.
          let undoToVersionId = null;
          if (result.usedFallback) {
            const { data: lastVersion } = await admin
              .from('versions').select('id').eq('project_id', project.id)
              .order('created_at', { ascending: false }).limit(1).maybeSingle();
            undoToVersionId = lastVersion?.id || null;
          }
          if (undoToVersionId) {
            reply += " This was a full replacement rather than a small edit — use Undo if it isn't what you wanted.";
          }

          // Insert the version before writing current_code, not after --
          // so current_code is never written without a matching version
          // already existing. If the write below conflicts or fails,
          // this version is rolled back rather than left pointing at
          // content that was never actually applied.
          let versionId;
          try {
            const { data, error } = await admin.from('versions').insert({
              project_id: project.id, label: title, brief: brief.slice(0, 500),
              code: result.html, model_used: routed.model,
            }).select('id').single();
            if (error) throw error;
            versionId = data.id;
          } catch (err) {
            console.error('[generate/stream] version insert failed', err);
            await finish('failed', 'db_write', err);
            send(`\n<!--LUMEN-META ${JSON.stringify({ error: 'Built, but could not save. Try again.' })} -->`);
            return;
          }

          // Conditional on code_version so a write that landed elsewhere
          // while this was generating can't be silently overwritten.
          const { data: committed, error: commitError } = await admin.from('projects').update({
            current_code: result.html,
            preview_url: previewUrl,
            updated_at: new Date().toISOString(),
            code_version: baseCodeVersion + 1,
            ...(shouldRename ? { name: title } : {}),
          }).eq('id', project.id).eq('user_id', profile.id).eq('code_version', baseCodeVersion).select('id');

          if (commitError) {
            await rollbackVersion(admin, versionId);
            console.error('[generate/stream] commit failed', commitError);
            await finish('failed', 'db_write', commitError);
            send(`\n<!--LUMEN-META ${JSON.stringify({ error: 'Built, but could not save. Try again.' })} -->`);
            return;
          }

          if (!committed || !committed.length) {
            // Someone else's write landed first -- current_code was never
            // touched, nothing was charged. The version inserted above
            // was never applied, so it's rolled back rather than left
            // as clutter.
            await rollbackVersion(admin, versionId);
            const conflictReply = "This project was changed in another tab while your edit was generating. Your version is ready — apply it, or discard it and start from the current site.";
            await finish('conflict', 'lock_conflict', null);
            const after = await getUsageSnapshot(admin, profile);
            send(`\n<!--LUMEN-META ${JSON.stringify({
              projectId: project.id,
              title,
              pending: true,
              pendingCode: result.html,
              plan,
              reply: conflictReply,
              model: routed.model,
              edited: isEdit,
              conflict: true,
              buildsLeft: after.buildsLeft,
              topupCredits: after.topupCredits,
              resetsAt: after.resetsAt,
            })} -->`);
            return;
          }

          // Publish-time abuse screening also applies to edits on an
          // already-live site: the edit itself is never blocked, but
          // content that would fail hard-block screening takes the
          // site offline rather than staying live with it.
          const unpublished = await screenLiveSite(admin, { projectId: project.id, code: result.html });

          // current_code and its version are now durably committed --
          // anything from here on is best-effort bookkeeping, not a
          // reason to tell the customer the build failed.
          let messagesSaved = true;
          let bookkeepingError = null;
          try {
            await admin.from('messages').insert([
              { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
              { project_id: project.id, user_id: profile.id, role: 'assistant', content: reply, plan, model_used: routed.model },
            ]);

            await logUsageEvent(admin, {
              userId: profile.id, projectId: project.id, model: routed.model,
              usage: result.usage, kind: isEdit ? 'edit' : 'build', editMode: result.editMode,
            });
          } catch (err) {
            console.error('[generate/stream] post-commit bookkeeping failed', err);
            messagesSaved = false;
            bookkeepingError = err;
          }

          // The build itself succeeded, saved, and is about to be
          // charged -- a bookkeeping failure here doesn't change that,
          // so it's still logged as succeeded, just flagged with its
          // own stage rather than folded into 'failed', which would
          // skew the failure rate this table exists to measure.
          await finish('succeeded', messagesSaved ? null : 'bookkeeping_incomplete', messagesSaved ? null : bookkeepingError);

          await recordBuild(admin, profile, snapshot);
          const after = await getUsageSnapshot(admin, profile);

          send(`\n<!--LUMEN-META ${JSON.stringify({
            projectId: project.id,
            name: shouldRename ? title : project.name,
            title,
            code: result.html,
            plan,
            reply: reply + (messagesSaved ? '' : " Saved, but the chat history didn't update — refresh to see it."),
            unpublished: unpublished ? { id: unpublished.id, message: unpublished.message } : null,
            undoToVersionId,
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
          await finish('failed', 'db_write', err);
          send(`\n<!--LUMEN-META ${JSON.stringify({ error: 'Built, but could not save. Try again.' })} -->`);
        }
      } catch (err) {
        // Last-resort safety net -- anything unexpected that slipped past
        // the two blocks above still gets logged, rather than leaving a
        // 'started' row stuck forever.
        console.error('[generate/stream] unexpected failure', err);
        await finish('failed', err?.stage || null, err);
        try {
          send(`\n<!--LUMEN-META ${JSON.stringify({ error: 'Something went wrong. Try again.' })} -->`);
        } catch (e) {}
      } finally {
        // If the client already disconnected, the controller may be
        // closed or errored already -- close() on it throws, and a throw
        // from finally replaces whatever the try/catch above was doing.
        try {
          controller.close();
        } catch (e) {}
      }
    },
    async cancel(reason) {
      // Fires when the client disconnects or explicitly stops the build --
      // this can happen instead of start()'s own catch if it occurs
      // outside the streamSite() call (e.g. during the save phase), since
      // nothing else here is listening for that. The finished guard means
      // this never overwrites an outcome start() already recorded.
      anthropicAbort.abort(reason);
      await finish('aborted', 'client_disconnect', null);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'Vary': 'Authorization',
      'X-Accel-Buffering': 'no',
    },
  });
}
