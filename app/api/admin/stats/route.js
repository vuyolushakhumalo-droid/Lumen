// GET /api/admin/stats — real numbers for your ops dashboard.
// Only accessible to profiles with is_admin = true.
import { unstable_cache } from 'next/cache';
import { handler, requireAdmin } from '@/lib/auth';
import { stripeClient } from '@/lib/stripe';
import { computeStripeMrr } from '@/lib/stripe-mrr';
import { logError } from '@/lib/monitor';

export const dynamic = 'force-dynamic';
// No `fetchCache = 'force-no-store'` here, unlike the other routes: Next
// passes it to unstable_cache, which then skips the cache on every load, so
// the Stripe MRR below would never be cached. The database queries stay
// uncached regardless: the Supabase clients send cache: 'no-store' themselves.

// List prices: only used for MRR if Stripe can't be reached.
const MONTHLY_PRICE = { standard: 29, pro: 59, frontier: 99, done_for_you: 149, studio: 0 };

const round2 = (n) => Math.round(n * 100) / 100;

// Annual plans are billed at 12x the monthly rate with no discount (see the
// homepage's billing toggle), so every subscription counts at its monthly rate.
const monthlyValue = (list) => list.reduce((sum, s) => sum + (MONTHLY_PRICE[s.plan] || 0), 0);

// Stripe price IDs back to plans, the same mapping the Stripe webhook uses.
function planForPrice(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_STANDARD_MONTHLY]: 'standard',
    [process.env.STRIPE_PRICE_STANDARD_ANNUAL]: 'standard',
    [process.env.STRIPE_PRICE_PRO_MONTHLY]: 'pro',
    [process.env.STRIPE_PRICE_PRO_ANNUAL]: 'pro',
    [process.env.STRIPE_PRICE_FRONTIER_MONTHLY]: 'frontier',
    [process.env.STRIPE_PRICE_FRONTIER_ANNUAL]: 'frontier',
  };
  return (priceId && map[priceId]) || null;
}

// MRR from what Stripe actually bills (after discounts), asked of Stripe at most
// once every five minutes: the result is kept in Next's data cache, which on
// Vercel is shared by every server instance. A Stripe error throws, so a
// failure is never cached and the next load tries again.
const stripeMrr = unstable_cache(
  () => computeStripeMrr(stripeClient(), { planForPrice }),
  ['admin-stats-stripe-mrr-v1'],
  { revalidate: 300 },
);

export const GET = handler(async (request) => {
  const { admin } = await requireAdmin(request);
  const { data: subs } = await admin
    .from('subscriptions')
    .select('plan, status, billing_interval, current_period_end, trial_end, cancel_at_period_end, created_at, user_id');

  let revenue;
  try {
    const s = await stripeMrr();
    revenue = {
      mrrSource: 'stripe',
      mrrAsOf: s.computedAt,
      currency: s.currency,
      payingSubscribers: s.paying.count,
      mrr: s.paying.mrr,
      mrrByPlan: s.paying.byPlan,
      ...(Object.keys(s.paying.mrrByCurrency).length > 1 ? { mrrByCurrency: s.paying.mrrByCurrency } : {}),
      inTrial: s.inTrial,
      ...(s.notes.length ? { mrrNotes: s.notes } : {}),
    };
  } catch (err) {
    logError('[admin/stats] Stripe MRR failed; showing list prices', err);
    // Same split from the database at list prices: paying = 'active' only (not
    // trials, not past_due); trials with the MRR they'd add, leaving out trials
    // already set to cancel.
    const paying = (subs || []).filter((s) => s.status === 'active');
    const inTrial = (subs || []).filter((s) => s.status === 'trialing');
    const trialsConverting = inTrial.filter((s) => !s.cancel_at_period_end);
    revenue = {
      mrrSource: 'list_prices',
      mrrError: `Stripe could not be reached (${String(err?.message || err).slice(0, 200)}), so MRR is from list prices in the database.`,
      currency: 'gbp',
      payingSubscribers: paying.length,
      mrr: round2(monthlyValue(paying)),
      inTrial: {
        count: inTrial.length,
        mrrIfTheyConvert: round2(monthlyValue(trialsConverting)),
        setToCancel: inTrial.length - trialsConverting.length,
      },
    };
  }

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
    ...revenue,
    buildsToday,
    // No flat per-build estimate: spend depends on the model, whether it was
    // a new build or an edit, retries and images.
    aiCostNote: 'Real AI cost comes from usage_events (input and output tokens per build, by model) and image_generations, priced at current model rates.',
    totalProjects: projectCount || 0,
    recentSubscribers: recent || [],
  });
});
