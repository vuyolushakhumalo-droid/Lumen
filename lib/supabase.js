// ============================================================
// Supabase clients.
//  - admin client: uses the SERVICE ROLE key, bypasses RLS.
//    NEVER import this into anything that runs in the browser.
//  - user client: reads the caller's session from the request.
// ============================================================
import { createClient } from '@supabase/supabase-js';

export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// Builds a client scoped to the signed-in user, from their bearer token.
export function supabaseForToken(accessToken) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }
  );
}
