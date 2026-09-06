-- Lintel: why a site is not live.
--
-- screenLiveSite() takes a published site offline when an edit
-- introduces content that must never be served -- it sets status back
-- to 'draft'. That is indistinguishable from a customer unpublishing
-- their own site, so the dashboard showed both as "Draft" and the
-- customer was told nothing at all.
--
-- offline_reason holds the hard-block rule id (see HARD_BLOCK_PATTERNS
-- in lib/publish.js) and is null for every ordinary draft. Its presence
-- is the whole signal: set means "we did this", null means "you did".
-- Publishing again clears it, as does unpublishing by hand.

alter table public.sites
  add column if not exists offline_reason text;

alter table public.sites
  add column if not exists offline_at timestamptz;

-- Deliberately not a check constraint against a fixed list of rule ids:
-- the rules live in application code and get added to, and a constraint
-- here would turn "we added a screening rule" into a failed write on the
-- one path whose entire job is taking a bad site offline.

comment on column public.sites.offline_reason is
  'Hard-block rule id when we took this site offline automatically; null for an ordinary draft.';
