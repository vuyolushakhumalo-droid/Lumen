// ============================================================
// POST /api/generate
// The core endpoint. Order matters:
//   auth -> subscription -> limits -> model permission
//   -> generate -> save version -> THEN count the build
// A failed generation never costs the customer a build.
// ============================================================
import { handler, requireUser, ApiError } from '@/lib/auth';
import { assertCanBuild, recordBuild, getUsageSnapshot, logUsageEvent } from '@/lib/usage';
import { generateSite } from '@/lib/anthropic';
import { makeSlug } from '@/lib/publish';
import { rateLimit } from '@/lib/ratelimit';
import { chooseModel } from '@/lib/routing';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300;   // full sites take longer than a few seconds

export const POST = handler(async (request) => {
  const { profile, admin } = await requireUser(request);

  // Cheap guard against scripted hammering (separate from the daily allowance).
  rateLimit(`gen:${profile.id}`, { max: 6, windowMs: 60_000 });

  const body = await request.json().catch(() => ({}));
  const { projectId, brief, model = 'auto' } = body;

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

  // 2b. Pick the cheapest model that will do this job well.
  const isEdit = !!project.current_code;
  const routed = chooseModel({
    brief,
    isEdit,
    requested: model,
    allowedModels: snapshot.allowedModels,
  });

  // 3. Generate. If this throws, nothing is charged.
  //    An existing site means this is an edit, so send the current HTML along.
  let result;
  try {
    result = await generateSite({
      brief,
      modelKey: routed.model,
      previousHtml: project.current_code || null,
      projectId: project.id,
      userId: profile.id,
      plan: snapshot.plan,
    });
  } catch (err) {
    console.error('[generate] model call failed', err);
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
    const pendingReply = "This edit came back looking like a full replacement rather than a small change, so I've held it back — review it and confirm if you want to apply it, or keep your current site.";

    await admin.from('messages').insert([
      { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
      { project_id: project.id, user_id: profile.id, role: 'assistant', content: pendingReply, plan, model_used: routed.model },
    ]);

    await logUsageEvent(admin, {
      userId: profile.id, projectId: project.id, model: routed.model,
      usage: result.usage, kind: 'edit', editMode: result.editMode,
    });

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

  await admin.from('messages').insert([
    { project_id: project.id, user_id: profile.id, role: 'user', content: brief.slice(0, 4000) },
    { project_id: project.id, user_id: profile.id, role: 'assistant', content: reply, plan, model_used: routed.model },
  ]);

  // 4. Persist: new version + project head.
  await admin.from('versions').insert({
    project_id: project.id,
    label: title,
    brief: brief.slice(0, 500),
    code,
    model_used: routed.model,
  });

  await logUsageEvent(admin, {
    userId: profile.id, projectId: project.id, model: routed.model,
    usage: result.usage, kind: isEdit ? 'edit' : 'build', editMode: result.editMode,
  });

  const shouldRename =
    !project.name || project.name === 'New project' || project.name === 'Untitled project';

  await admin.from('projects').update({
    current_code: code,
    preview_url: previewUrl,
    updated_at: new Date().toISOString(),
    ...(shouldRename ? { name: title } : {}),
  }).eq('id', project.id);

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
    reply: reply + imageNote + undoNote,
    undoToVersionId,
    truncated: result.stopReason === 'max_tokens',
    chargedFrom: charged.source,
    buildsLeft: after.buildsLeft,
    topupCredits: after.topupCredits,
    resetsAt: after.resetsAt,
  });
});
