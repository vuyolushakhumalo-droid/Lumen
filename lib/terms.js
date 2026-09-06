// ============================================================
// The one place the current terms version is defined, and the two
// writes that record an acceptance.
//
// The browser does not decide the version. It used to send its own
// string, which meant the value recorded against an account was
// whatever the page happened to post -- and the recorded version is
// the thing that makes the agreement provable later. Bump VERSION
// here when you publish updated Terms; the next acceptance records it.
//
// Two records, deliberately:
//   profiles.terms_accepted_at  -- the answer to "has this user
//     accepted, and which version?", asked constantly, and it survives
//     audit_log's `on delete set null`.
//   audit_log 'terms.accepted'  -- the dated history, including
//     re-acceptance when the terms change, with IP and user-agent.
// ============================================================

export const TERMS_VERSION = '1.0';

/**
 * Stamps the profile once and never again. The first acceptance is the
 * one that bound the account; re-stamping would overwrite that date
 * with a later, less useful one.
 *
 * The `is null` guard does the work in the database rather than in a
 * read-then-write, so two concurrent calls cannot both stamp.
 *
 * Never throws: this runs inside sign-up and checkout, and neither
 * should fail because a bookkeeping write did.
 *
 * @returns {Promise<boolean>} true if this call was the one that stamped
 */
export async function stampTermsAccepted(admin, userId) {
  if (!userId) return false;
  try {
    const { data, error } = await admin
      .from('profiles')
      .update({
        terms_accepted_at: new Date().toISOString(),
        terms_version: TERMS_VERSION,
      })
      .eq('id', userId)
      .is('terms_accepted_at', null)
      .select('id');

    if (error) {
      console.error('[terms] could not stamp profile', error);
      return false;
    }
    return (data || []).length > 0;
  } catch (err) {
    console.error('[terms] could not stamp profile', err);
    return false;
  }
}

/** Has this user ever had an acceptance written to the log? */
export async function hasTermsAudit(admin, userId) {
  if (!userId) return false;
  try {
    const { data, error } = await admin
      .from('audit_log')
      .select('id')
      .eq('user_id', userId)
      .eq('action', 'terms.accepted')
      .limit(1);

    if (error) {
      // Treat an unreadable log as "already recorded" so a failing read
      // cannot cause a duplicate row on every checkout.
      console.error('[terms] could not read acceptance history', error);
      return true;
    }
    return (data || []).length > 0;
  } catch (err) {
    console.error('[terms] could not read acceptance history', err);
    return true;
  }
}

/** Appends the dated history row. Never throws, same reasoning as above. */
export async function recordTermsAudit(admin, userId, extra = {}) {
  if (!userId) return;
  try {
    const { error } = await admin.from('audit_log').insert({
      user_id: userId,
      action: 'terms.accepted',
      meta: {
        version: TERMS_VERSION,
        at: new Date().toISOString(),
        ...extra,
      },
    });
    if (error) console.error('[terms] could not write acceptance history', error);
  } catch (err) {
    console.error('[terms] could not write acceptance history', err);
  }
}

/**
 * The identifying details worth keeping alongside an acceptance. Same
 * shape the consent route has always written.
 */
export function requestMeta(request) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;
  return { ip, userAgent: (request.headers.get('user-agent') || '').slice(0, 300) };
}
