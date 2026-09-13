// GET /api/admin/stats — real numbers for your ops dashboard.
// Only accessible to profiles with is_admin = true.
import { handler, requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const MONTHLY_PRICE = { standard: 29, pro: 59, frontier: 99, done_for_you: 149, studio: 0 };

export const GET = handler(async (request) => {
  const { admin } = await requireAdmin(request);
  const { data: subs } = await admin
    .from('subscriptions')
    .select('plan, status, billing_interval, current_period_end, created_at, user_id');

  const active = (subs || []).filter((s) => ['active', 'trialing'].includes(s.status));
  const trialing = active.filter((s) => s.status === 'trialing');

  // Annual plans are billed at 12x the monthly rate with no discount (see the
  // homepage's billing toggle), so they count at the monthly rate.
  const mrr = active.reduce((sum, s) => sum + (MONTHLY_PRICE[s.plan] || 0), 0);

  // Builds today (UTC): one usage_events row is written per successful build or
  // edit, just before it's charged, including builds paid with top-up credits.
  // 'preview' rows are the Haiku edit previews, not builds. usage_daily stopped
  // being written when usage moved to 5-hour windows, and usage_windows can't
  // give a calendar-day count: its windows cross midnight and top-up builds
  // never reach it. (If saving the chat messages fails after a build commits,
  // the build is charged but not logged, so this can very rarely undercount.)
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: buildsCount } = await admin
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .in('kind', ['build', 'edit'])
    .gte('created_at', dayStart.toISOString());
  const buildsToday = buildsCount || 0;

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
    // No flat per-build estimate: spend depends on the model, whether it was
    // a new build or an edit, retries and images.
    aiCostNote: 'Real AI cost comes from usage_events (input and output tokens per build, by model) and image_generations, priced at current model rates.',
    totalProjects: projectCount || 0,
    recentSubscribers: recent || [],
  });
});
