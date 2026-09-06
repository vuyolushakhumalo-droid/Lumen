// ============================================================
// GET /api/config
// Static HTML pages can't read environment variables, so they
// fetch the PUBLIC ones from here at startup.
// Only ever return values that are safe in a browser.
// ============================================================

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
    sitesDomain: process.env.SITES_DOMAIN || '',
    // A Sentry DSN is public by design -- it is visible in any
    // browser SDK setup, and it only permits writing events.
    sentryDsn: process.env.SENTRY_DSN || '',
  });
}
