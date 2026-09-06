// GET /api/debug-sentry?secret=<CRON_SECRET>
//
// Proves events are actually arriving. Guarded by CRON_SECRET rather
// than left open: an unauthenticated endpoint that manufactures errors
// is a free way to fill someone's Sentry quota.
//
// ?mode=throw    an unhandled throw, the instrumentation.js path
// ?mode=logged   a logged error, the logError path (default)
// ?mode=scrub    sends HTML, an email and a fake auth header, so you
//                can confirm in Sentry that all three were removed
import { logError, monitoringEnabled } from '@/lib/monitor';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  if (!monitoringEnabled()) {
    return Response.json(
      { ok: false, reason: 'SENTRY_DSN is not set, so nothing is being reported.' },
      { status: 503 }
    );
  }

  const mode = url.searchParams.get('mode') || 'logged';

  if (mode === 'throw') {
    throw new Error('Sentry test: unhandled throw from /api/debug-sentry');
  }

  if (mode === 'scrub') {
    logError(
      '[debug-sentry] scrub check',
      new Error('Sentry test: this event should contain no HTML, email or header'),
      {
        html: '<!DOCTYPE html><html><body><h1>A customer site</h1></body></html>',
        enquiry: 'Please call me back on Tuesday, my email is someone@example.com',
        headers: { authorization: 'Bearer should-never-appear', 'content-type': 'application/json' },
      },
      { slug: 'debug-site' }
    );
    return Response.json({
      ok: true,
      mode,
      check: 'In Sentry the event should show [html removed], [email removed] and [redacted].',
    });
  }

  logError('[debug-sentry] logged error test', new Error('Sentry test: logged error'), { slug: 'debug-site' });
  return Response.json({ ok: true, mode, check: 'Look for tag route=debug-sentry, site=debug-site.' });
}
