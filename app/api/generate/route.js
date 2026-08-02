// ============================================================
// POST /api/generate
// The core endpoint. Order matters:
//   auth -> subscription -> limits -> model permission
//   -> generate -> save version -> THEN count the build
// A failed generation never costs the customer a build.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { assertCanBuild, recordBuild, getUsageSnapshot, logUsageEvent, resolvePreviousHtml, rollbackVersion } from '@/lib/usage';
import { generateSite } from '@/lib/anthropic';
import { makeSlug } from '@/lib/publish';
import { rateLimit } from '@/lib/ratelimit';
import { chooseModel } from '@/lib/routing';
import { startAttempt, finishAttempt } from '@/lib/attempts';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300;   // full sites take longer than a few seconds

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);

  // Cheap guard against scripted hammering (separate from the daily allowance).
  rateLimit(`gen:${profile.id}`, { max: 6, windowMs: 60_000 });

  const body = await request.json().catch(() => ({}));
  const { projectId, brief, model = 'auto', clientExpectsEdit } = body;

  if (!brief || typeof brief !== 'string' || brief.trim().length < 3) {
    throw new ApiError(400, 'Tell us what you want to build.');
  }
  if (brief.length > 4000) {
    throw new ApiError(400, 'That brief is a bit long — try trimming it.');
  }

  // 1. May this user build at all? (model is chosen below)
  const snapshot = await assertCanBuild(admin, profile, model === 'auto' ? null : model);

  // 2. Find or create the project.
  let project;
  if (projectId) {
    const { data } = await admin
      .from('projects').select('*')
      .eq('id', projectId).eq('user_id', profile.id)   // ownership check
      .maybeSingle();
    if (!data) throw new ApiError(404, 'Project not found');
    project = data;
  } else {
    const { data, error } = await admin
      .from('projects')
      .insert({ user_id: profile.id, name: 'New project' })
      .select().single();
    if (error) throw new ApiError(500, 'Could not create the project');
    project = data;
  }

  // 2b. What is this request working from? project.current_code is the
  //     normal source; if it's empty but versions exist, that's a
  //     stale read, not a genuinely new project -- resolvePreviousHtml
  //     recovers the last known content so this can't silently become
  //     an unrelated new build that overwrites real prior work.
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
    throw new ApiError(409, 'no_saved_site', {
      message: "This project has no saved site on the server, so it can't be edited. The site you were viewing was never saved. Your next message will start a new build from scratch.",
    });
  }

  // current_code was empty but a prior version existed -- resolvePreviousHtml
  // recovered it. That's a data-integrity gap worth surfacing to the
  // customer, not just a console.warn only we can see.
  const recoveredFromVersion = !project.current_code && !!previousHtml;

  const isEdit = !!previousHtml;
  const routed = chooseModel({
    brief,
    isEdit,
    requested: model,
    allowedModels: snapshot.allowedModels,
  });

  // Logged as early as possible -- before the model call -- so a
  // failure at any point from here on leaves a trace, not just successes.
  const attemptId = await startAttempt(admin, {
    projectId: project.id, userId: profile.id, kind: isEdit ? 'edit' : 'build',
    model: routed.model, clientExpectsEdit: !!clientExpectsEdit,
    previousHtmlLength: previousHtml?.length ?? 0,
  });

  // 3. Generate. If this throws, nothing is charged.
  let result;
  try {
    result = await generateSite({
      brief,
      modelKey: routed.model,
      previousHtml,
      projectId: project.id,
      userId: profile.id,
      plan: snapshot.plan,
    });
  } catch (err) {
    console.error('[generate] model call failed', err);
    const isAbort = err?.name === 'AbortError';
    await finishAttempt(admin, attemptId, {
      status: isAbort ? 'aborted' : 'failed',
      stage: err?.stage || 'model_call',
      error: isAbort ? null : err,
    });
    throw new ApiError(502, 'The build failed — please try again. You have not been charged a build.');
  }

  const code = result.html;
  const title = result.title || 'New site';
  const plan = result.plan || null;
  const previewUrl = `${makeSlug(title)}.lumen.build`;

  // A near-total replacement from the edit fallback path is held back
  // rather than auto-applied -- current_code is left untouched, and
  // the caller must explicitly confirm via /apply-replacement.
  if (result.needsConfirmation) {
    const pendingReply = "This edit came back looking like a full replacement rather than a small change, so I've held it back — review it and confirm if you want to apply it, or keep your current site."
      + (recoveredFromVersion ? " One more thing: your saved site was out of sync, so I recovered your last saved version and worked from that instead." : '');

    try {
      await admin.from('messages').insert([
        { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
        { project_id: project.id, user_id: profile.id, role: 'assistant', content: pendingReply, plan, model_used: routed.model },
      ]);

      await logUsageEvent(admin, {
        userId: profile.id, projectId: project.id, model: routed.model,
        usage: result.usage, kind: 'edit', editMode: result.editMode,
      });
    } catch (err) {
      await finishAttempt(admin, attemptId, { status: 'failed', stage: 'db_write', error: err });
      throw new ApiError(500, 'Built, but could not save. Try again.');
    }

    await finishAttempt(admin, attemptId, { status: 'succeeded' });

    const charged = await recordBuild(admin, profile, snapshot);
    const after = await getUsageSnapshot(admin, profile);

    return Response.json({
      projectId: project.id,
      pending: true,
      pendingCode: code,
      title,
      plan,
      reply: pendingReply,
      model: routed.model,
      modelReason: routed.reason,
      chargedFrom: charged.source,
      buildsLeft: after.buildsLeft,
      topupCredits: after.topupCredits,
      resetsAt: after.resetsAt,
    });
  }

  // 4a. Save the conversation so it survives a refresh.
  const reply = plan?.message
    ? plan.message
    : (isEdit
        ? `Updated ${title}.${plan?.changed ? ' ' + plan.changed : ''}`
        : `Built ${title} — have a look on the right.`);
  const imageNote = result.imagesQuotaExhausted
    ? " You've used this month's photo allowance, so any new images use a placeholder style instead — more unlocks next month."
    : '';
  const recoveryNote = recoveredFromVersion
    ? " One thing to flag: your saved site was out of sync, so I recovered your last saved version and worked from that instead."
    : '';

  // A committed fallback replacement (one that passed the similarity
  // guard) still gets an explicit undo path, since it's a bigger
  // change than a normal targeted edit.
  let undoToVersionId = null;
  if (result.usedFallback) {
    const { data: lastVersion } = await admin
      .from('versions').select('id').eq('project_id', project.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    undoToVersionId = lastVersion?.id || null;
  }
  const undoNote = undoToVersionId
    ? " This was a full replacement rather than a small edit — use Undo if it isn't what you wanted."
    : '';

  const shouldRename =
    !project.name || project.name === 'New project' || project.name === 'Untitled project';

  // Insert the version before writing current_code, not after -- so
  // current_code is never updated without a matching version already
  // existing (the write invariant resolvePreviousHtml protects on the
  // read side). If the write below conflicts or fails, this version is
  // rolled back rather than left pointing at content that was never
  // actually applied.
  let versionId;
  try {
    const { data, error } = await admin.from('versions').insert({
      project_id: project.id,
      label: title,
      brief: brief.slice(0, 500),
      code,
      model_used: routed.model,
    }).select('id').single();
    if (error) throw error;
    versionId = data.id;
  } catch (err) {
    await finishAttempt(admin, attemptId, { status: 'failed', stage: 'db_write', error: err });
    throw new ApiError(500, 'Built, but could not save. Try again.');
  }

  // Conditional on code_version so a write that landed elsewhere while
  // this was generating can't be silently overwritten.
  let committed;
  try {
    const { data, error } = await admin.from('projects').update({
      current_code: code,
      preview_url: previewUrl,
      updated_at: new Date().toISOString(),
      code_version: baseCodeVersion + 1,
      ...(shouldRename ? { name: title } : {}),
    }).eq('id', project.id).eq('code_version', baseCodeVersion).select('id');
    if (error) throw error;
    committed = data;
  } catch (err) {
    await rollbackVersion(admin, versionId);
    await finishAttempt(admin, attemptId, { status: 'failed', stage: 'db_write', error: err });
    throw new ApiError(500, 'Built, but could not save. Try again.');
  }

  if (!committed || !committed.length) {
    // Someone else's write landed first -- current_code was never
    // touched, nothing was charged. The version inserted above was
    // never applied, so it's rolled back rather than left as clutter.
    await rollbackVersion(admin, versionId);
    const conflictReply = "This project was changed in another tab while your edit was generating. Your version is ready — apply it, or discard it and start from the current site.";
    await finishAttempt(admin, attemptId, { status: 'conflict', stage: 'lock_conflict' });
    const after = await getUsageSnapshot(admin, profile);
    return Response.json({
      projectId: project.id,
      pending: true,
      pendingCode: code,
      title,
      plan,
      reply: conflictReply,
      model: routed.model,
      modelReason: routed.reason,
      conflict: true,
      buildsLeft: after.buildsLeft,
      topupCredits: after.topupCredits,
      resetsAt: after.resetsAt,
    });
  }

  // current_code and its version are now durably committed -- anything
  // from here on is best-effort bookkeeping, not a reason to tell the
  // customer the build failed.
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
    console.error('[generate] post-commit bookkeeping failed', err);
    messagesSaved = false;
    bookkeepingError = err;
  }

  // The build itself succeeded, saved, and is about to be charged --
  // a bookkeeping failure here doesn't change that, so it's still
  // logged as succeeded, just flagged with its own stage rather than
  // folded into 'failed', which would skew the failure rate this
  // table exists to measure.
  await finishAttempt(admin, attemptId, messagesSaved
    ? { status: 'succeeded' }
    : { status: 'succeeded', stage: 'bookkeeping_incomplete', error: bookkeepingError });

  // 5. Only now does it count against the allowance.
  const charged = await recordBuild(admin, profile, snapshot);
  const after = await getUsageSnapshot(admin, profile);

  return Response.json({
    projectId: project.id,
    name: shouldRename ? title : project.name,
    code,
    previewUrl,
    title,
    edited: isEdit,
    model: routed.model,
    modelReason: routed.reason,
    plan,
    reply: reply + imageNote + undoNote + recoveryNote
      + (messagesSaved ? '' : " Saved, but the chat history didn't update — refresh to see it."),
    undoToVersionId,
    truncated: result.stopReason === 'max_tokens',
    chargedFrom: charged.source,
    buildsLeft: after.buildsLeft,
    topupCredits: after.topupCredits,
    resetsAt: after.resetsAt,
  });
});
