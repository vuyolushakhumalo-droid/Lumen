// ============================================================
// Supabase clients.
//  - admin client: uses the SERVICE ROLE key, bypasses RLS.
//    NEVER import this into anything that runs in the browser.
//  - user client: reads the caller's session from the request.
// ============================================================
import { createClient } from '@supabase/supabase-js';

// TEMPORARY DEBUG: force every request this client makes to bypass
// Next.js's fetch Data Cache, in case it's memoizing supabase-js's
// internal fetch() calls per URL. Remove once the investigation is done.
function noStoreFetch(url, init) {
  return fetch(url, { ...init, cache: 'no-store' });
}

export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: noStoreFetch } }
  );
}

// Builds a client scoped to the signed-in user, from their bearer token.
export function supabaseForToken(accessToken) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: noStoreFetch },
    }
  );
}
