// ============================================================
// Attempt-and-failure log for the generation pipeline.
//
// Every function here is best-effort and self-contained: a logging
// failure must never break or fail a build, so each one has its own
// try/catch and only ever console.error's.
// ============================================================

// Tags an error with which pipeline stage it happened in. Read by the
// calling route via err.stage; left unset, callers default to 'model_call'.
export function withStage(stage, err) {
  if (err && typeof err === 'object' && !err.stage) err.stage = stage;
  return err;
}

export async function startAttempt(admin, { projectId, userId, kind, model, clientExpectsEdit, previousHtmlLength }) {
  try {
    const { data, error } = await admin
      .from('generation_attempts')
      .insert({
        project_id: projectId,
        user_id: userId,
        kind: kind || null,
        status: 'started',
        model: model || null,
        client_expects_edit: !!clientExpectsEdit,
        previous_html_length: previousHtmlLength ?? 0,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    console.error('[attempts] failed to log start', err);
    return null;
  }
}

function formatError(error) {
  if (!error) return null;
  try {
    const message = error.message || String(error);
    const stackLines = (error.stack || '').split('\n').slice(0, 4).join('\n');
    return `${message}\n${stackLines}`.slice(0, 2000);
  } catch (e) {
    return null;
  }
}

export async function finishAttempt(admin, attemptId, { status, stage, error } = {}) {
  if (!attemptId) return;
  try {
    await admin.from('generation_attempts').update({
      status,
      stage: stage || null,
      error_text: formatError(error),
      finished_at: new Date().toISOString(),
    }).eq('id', attemptId);
  } catch (err) {
    console.error('[attempts] failed to log finish', err);
  }
}
