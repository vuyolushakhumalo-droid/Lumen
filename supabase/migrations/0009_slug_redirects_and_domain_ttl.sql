-- Lintel: keep old addresses working, and stop dead domains piling up.
--
-- Two unrelated problems, one migration, because both are small and
-- both are about a site's address.

-- ---------------------------------------------------------------
-- 1. Old subdomains
-- ---------------------------------------------------------------
-- Renaming a published site's slug silently broke every link anyone
-- had already shared: the old address just 404'd. This keeps the last
-- few, and the host router 301s them to wherever the site lives now.
--
-- old_slug is the primary key rather than an ordinary column, and that
-- is the whole design: a slug can only ever point at one place, so a
-- new site claiming a previously-used address is a delete followed by
-- an insert, and there is no state where two sites both think they
-- own it. The claim is enforced here, not in application logic.

create table if not exists public.slug_redirects (
  old_slug   text primary key,
  site_id    uuid not null references public.sites(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The cap-to-5 prune reads by site, newest first.
create index if not exists slug_redirects_site_idx
  on public.slug_redirects (site_id, created_at desc);

alter table public.slug_redirects enable row level security;

-- No policies, deliberately -- service role only, like rate_limits.
-- The host router reads this on an unauthenticated public request
-- using the service key, and nothing in the browser ever needs it.

-- ---------------------------------------------------------------
-- 2. Unverified domains
-- ---------------------------------------------------------------
-- A customer types a domain, we register it with the host, and then
-- their DNS never gets pointed at us. Nothing ever cleaned those up,
-- so they accumulate on the hosting project forever.
--
-- domain_checked_at can't answer "how long has this been pending?" --
-- it moves every time the nightly sweep looks at it. This records when
-- the domain was actually attached, which is the clock the 14-day
-- cleanup runs against.

alter table public.sites
  add column if not exists domain_added_at timestamptz;

-- Why the customer's domain vanished, for the builder to show them.
-- Cleared the moment they attach a domain again.
alter table public.sites
  add column if not exists domain_note text;

-- Backfill: existing pending domains get today as their start date, not
-- their real (unknown) one. Deliberately generous -- dating them from
-- some earlier point would delete a domain someone connected yesterday
-- the first time this cron runs.
update public.sites
set domain_added_at = now()
where custom_domain is not null
  and domain_added_at is null;
