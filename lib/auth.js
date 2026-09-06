// ============================================================
// Auth helpers for API routes.
// Every protected route starts with requireUser(request).
// ============================================================
import { supabaseAdmin } from './supabase.js';
import { logError } from './monitor.js';

export function bearerFrom(request) {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Returns { user, profile } or throws an ApiError.
export async function requireUser(request) {
  const token = bearerFrom(request);
  if (!token) throw new ApiError(401, 'Not signed in');

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new ApiError(401, 'Session expired — please sign in again');

  const { data: profile } = await admin
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  return { user: data.user, profile, admin };
}

export async function requireAdmin(request) {
  const ctx = await requireUser(request);
  if (!ctx.profile?.is_admin) throw new ApiError(403, 'Not allowed');
  return ctx;
}

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Wraps a route handler so thrown ApiErrors become clean JSON responses.
export function handler(fn) {
  return async (request, ctx) => {
    let res;
    try {
      res = await fn(request, ctx);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      // Every route's unhandled failure passes through here, which is
      // why publish and domains need no reporting of their own -- they
      // throw, and this is where a throw becomes a 500. Deliberately
      // only 500s: a 400 or a 409 is the API working.
      if (status === 500) {
        let route = 'api';
        try {
          route = new URL(request.url).pathname.replace(/^\//, '') || 'api';
        } catch { /* keep the default */ }
        logError(`[${route}] unhandled failure`, err);
      }
      res = Response.json(
        { error: err.message || 'Something went wrong', ...(err.extra || {}) },
        { status }
      );
    }
    // Every response here is personalized per Authorization token — never
    // let a shared/edge cache serve it across accounts.
    res.headers.set('Cache-Control', 'private, no-store');
    res.headers.set('Vary', 'Authorization');
    return res;
  };
}
