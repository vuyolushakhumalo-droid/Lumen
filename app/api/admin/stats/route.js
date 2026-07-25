// GET /api/admin/stats — real numbers for your ops dashboard.
// Only accessible to profiles with is_admin = true.
import { handler, requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MONTHLY_PRICE = { standard: 29, pro: 49, frontier: 90, done_for_you: 149, studio: 0 };

export const GET = handler(async (request) => {
  const { admin } = await requireAdmin(request);
  const today = new Date().toISOString().slice(0, 10);

  const { data: subs } = await admin
    .from('subscriptions')
    .select('plan, status, billing_interval, current_period_end, created_at, user_id');

  const active = (subs || []).filter((s) => ['active', 'trialing'].includes(s.status));
  const trialing = active.filter((s) => s.status === 'trialing');

  const mrr = active.reduce((sum, s) => {
    const base = MONTHLY_PRICE[s.plan] || 0;
    return sum + (s.billing_interval === 'year' ? (base * 11) / 12 : base);
  }, 0);

  const { data: usageToday } = await admin
    .from('usage_daily').select('builds_used').eq('date', today);
  const buildsToday = (usageToday || []).reduce((n, u) => n + u.builds_used, 0);

  const { count: projectCount } = await admin
    .from('projects').select('id', { count: 'exact', head: true });

  const { data: recent } = await admin
    .from('subscriptions')
    .select('plan, status, created_at, profiles(email)')
    .order('created_at', { ascending: false })
    .limit(10);

  return Response.json({
    activeSubscribers: active.length,
    trialing: trialing.length,
    mrr: Math.round(mrr * 100) / 100,
    buildsToday,
    estimatedAiCostToday: Math.round(buildsToday * 0.09 * 100) / 100,
    totalProjects: projectCount || 0,
    recentSubscribers: recent || [],
  });
});
