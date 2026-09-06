// GET /api/debug-sentry?secret=<CRON_SECRET>
//
// Proves events are actually arriving. Guarded by CRON_SECRET rather
// than left open: an unauthenticated endpoint that manufactures errors
// is a free way to fill someone's Sentry quota.
//
// ?mode=diag     what the process can see about its own monitoring —
//                start here when nothing is arriving
// ?mode=throw    an unhandled throw, the instrumentation.js path
// ?mode=logged   a logged error, the logError path (default)
// ?mode=scrub    sends HTML, an email and a fake auth header, so you
//                can confirm in Sentry that all three were removed
//
// Every mode that captures also AWAITS the flush. A serverless function
// is frozen when it returns, so an un-flushed send is queued into a
// process that stops existing — which is exactly how this route
// returned ok while nothing reached Sentry.
import { logError, monitoringEnabled, flushMonitoring, diagnostics } from '@/lib/monitor';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  const mode = url.searchParams.get('mode') || 'logged';

  // Answers "is the SDK actually on?" without sending anything, and
  // without revealing the DSN's key.
  if (mode === 'diag') {
    const diag = diagnostics();
    return Response.json({
      ok: true,
      mode,
      ...diag,
      verdict: !diag.dsnConfigured
        ? 'SENTRY_DSN is not set in this environment.'
        : !diag.dsnLooksValid
          ? 'SENTRY_DSN is set but is not a valid DSN (expected https://<key>@<host>/<projectId>).'
          : !diag.clientInitialised
            ? 'DSN looks fine but Sentry.init() never ran in this runtime — check instrumentation.js and experimental.instrumentationHook.'
            : 'Sentry is initialised. If events still do not arrive, look at the flush and at the project inbound filters.',
    });
  }

  if (!monitoringEnabled()) {
    return Response.json(
      { ok: false, reason: 'SENTRY_DSN is not set, so nothing is being reported.' },
      { status: 503 }
    );
  }

  if (mode === 'throw') {
    // Not flushed here on purpose: this one is meant to escape, and
    // instrumentation.js owns it. If this mode arrives and the others
    // do not, the difference is the flush.
    throw new Error('Sentry test: unhandled throw from /api/debug-sentry');
  }

  if (mode === 'scrub') {
    await logError(
      '[debug-sentry] scrub check',
      new Error('Sentry test: this event should contain no HTML, email or header'),
      {
        html: '<!DOCTYPE html><html><body><h1>A customer site</h1></body></html>',
        enquiry: 'Please call me back on Tuesday, my email is someone@example.com',
        headers: { authorization: 'Bearer should-never-appear', 'content-type': 'application/json' },
      },
      { slug: 'debug-site' }
    );
    const flushed = await flushMonitoring();
    return Response.json({
      ok: true,
      mode,
      flushed,
      check: 'In Sentry the event should show [html removed], [email removed] and [redacted].',
    });
  }

  await logError('[debug-sentry] logged error test', new Error('Sentry test: logged error'), { slug: 'debug-site' });
  const flushed = await flushMonitoring();
  return Response.json({
    ok: true,
    mode,
    flushed,
    check: 'Look for tag route=debug-sentry, site=debug-site.',
  });
}
