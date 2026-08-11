// ============================================================
// Simple in-memory rate limit — stops scripted abuse of /api/generate.
// Good enough for early scale. Swap for Upstash Redis when you
// run on more than one server instance.
// ============================================================
import { ApiError } from './auth.js';

const buckets = new Map();

export function rateLimit(key, { max = 6, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (entry.count >= max) {
    const wait = Math.ceil((entry.resetAt - now) / 1000);
    throw new ApiError(429, `Slow down a moment — try again in ${wait}s.`, { reason: 'rate_limited' });
  }
  entry.count += 1;

  // Opportunistic cleanup so the map doesn't grow forever.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
}

// DB-backed replacement for rateLimit() above -- persistent and
// multi-instance safe, via the check_rate_limit() function (see
// supabase/migrations/0001_submissions.sql).
export async function rateLimitDb(admin, key, { max, windowSec = 60, failOpen = true } = {}) {
  const { data, error } = await admin.rpc('check_rate_limit', {
    p_key: key,
    p_limit: max,
    p_window_sec: windowSec,
  });

  if (error) {
    console.error('[ratelimit] check_rate_limit failed', error);
    if (failOpen) return;
    throw new ApiError(429, 'Busy right now — please try again shortly.', { reason: 'rate_limited' });
  }

  if (data === false) {
    throw new ApiError(429, 'Slow down a moment — please try again shortly.', { reason: 'rate_limited' });
  }
}
