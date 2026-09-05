-- Lintel: cookieless analytics for published customer sites.
--
-- Two tables by design. site_events is the raw write path -- one row per
-- beacon, high volume, never read by a customer. site_daily is the read
-- path -- one row per site per day, already aggregated, cheap to chart.
-- The nightly rollup moves data from one to the other and the raw rows
-- age out after 90 days.
--
-- Nothing here stores an IP address. `visitor` is an HMAC of
-- (ip + user-agent + day) keyed by ANALYTICS_SALT, so it distinguishes
-- a returning visitor within a single day and is useless across days or
-- across sites. Rotating the salt orphans every existing hash, which is
-- the intended escape hatch.

-- ---------------------------------------------------------------
-- 1. Raw events
-- ---------------------------------------------------------------

create table if not exists public.site_events (
  id       bigserial primary key,
  site_id  uuid not null references public.sites(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null default (now() at time zone 'utc')::date,
  ts       timestamptz not null default now(),
  section  text,
  ref_host text,
  country  text,
  device   text check (device in ('desktop','mobile','tablet')),
  visitor  text not null
);

-- user_id is denormalised from sites, same reasoning as submissions:
-- a single-column check beats a join on every read.

-- The rollup and the purge both scan by (site_id, day).
create index if not exists site_events_site_day_idx
  on public.site_events (site_id, day);

alter table public.site_events enable row level security;

-- No policies at all, deliberately -- service role only, exactly like
-- rate_limits. The public beacon endpoint writes with the service role,
-- which bypasses RLS, so a leaked anon key cannot flood this table and
-- cannot read one site's traffic from another account. Customers never
-- read site_events; they read site_daily.

-- ---------------------------------------------------------------
-- 2. Daily rollup (the read path)
-- ---------------------------------------------------------------

create table if not exists public.site_daily (
  site_id   uuid not null references public.sites(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  day       date not null,
  views     integer not null default 0,
  visitors  integer not null default 0,
  bounces   integer not null default 0,
  sections  jsonb not null default '{}'::jsonb,
  countries jsonb not null default '{}'::jsonb,
  referrers jsonb not null default '{}'::jsonb,
  devices   jsonb not null default '{}'::jsonb,
  primary key (site_id, day)
);

create index if not exists site_daily_user_day_idx
  on public.site_daily (user_id, day desc);

alter table public.site_daily enable row level security;

-- Owners read their own rollups. Still no INSERT/UPDATE policy: only
-- the rollup function writes here.
drop policy if exists site_daily_select_own on public.site_daily;
create policy site_daily_select_own
  on public.site_daily for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- 3. Rollup
-- ---------------------------------------------------------------
-- Aggregates one day of site_events into site_daily. Idempotent: it
-- upserts, so re-running it for a day that's already rolled up simply
-- recomputes the same numbers. Defaults to yesterday (UTC).
--
--   views    = total events
--   visitors = distinct visitor hashes
--   bounces  = visitors who produced exactly one event
--
-- Returns the number of site_daily rows written.

create or replace function public.rollup_site_events(p_day date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day  date;
  v_rows integer;
begin
  v_day := coalesce(p_day, ((now() at time zone 'utc')::date - 1));

  with per_visitor as (
    select site_id, user_id, visitor, count(*)::int as events
    from public.site_events
    where day = v_day
    group by site_id, user_id, visitor
  ),
  totals as (
    select site_id,
           user_id,
           sum(events)::int                          as views,
           count(*)::int                             as visitors,
           count(*) filter (where events = 1)::int   as bounces
    from per_visitor
    group by site_id, user_id
  ),
  sections as (
    select site_id, jsonb_object_agg(k, n) as j
    from (
      select site_id, coalesce(nullif(section, ''), 'home') as k, count(*)::int as n
      from public.site_events where day = v_day group by 1, 2
    ) t group by site_id
  ),
  countries as (
    select site_id, jsonb_object_agg(k, n) as j
    from (
      select site_id, coalesce(nullif(country, ''), 'unknown') as k, count(*)::int as n
      from public.site_events where day = v_day group by 1, 2
    ) t group by site_id
  ),
  referrers as (
    select site_id, jsonb_object_agg(k, n) as j
    from (
      select site_id, coalesce(nullif(ref_host, ''), 'direct') as k, count(*)::int as n
      from public.site_events where day = v_day group by 1, 2
    ) t group by site_id
  ),
  devices as (
    select site_id, jsonb_object_agg(k, n) as j
    from (
      select site_id, coalesce(nullif(device, ''), 'unknown') as k, count(*)::int as n
      from public.site_events where day = v_day group by 1, 2
    ) t group by site_id
  )
  insert into public.site_daily
    (site_id, user_id, day, views, visitors, bounces, sections, countries, referrers, devices)
  select t.site_id, t.user_id, v_day, t.views, t.visitors, t.bounces,
         coalesce(s.j, '{}'::jsonb),
         coalesce(c.j, '{}'::jsonb),
         coalesce(r.j, '{}'::jsonb),
         coalesce(d.j, '{}'::jsonb)
  from totals t
  left join sections  s on s.site_id = t.site_id
  left join countries c on c.site_id = t.site_id
  left join referrers r on r.site_id = t.site_id
  left join devices   d on d.site_id = t.site_id
  on conflict (site_id, day) do update set
    user_id   = excluded.user_id,
    views     = excluded.views,
    visitors  = excluded.visitors,
    bounces   = excluded.bounces,
    sections  = excluded.sections,
    countries = excluded.countries,
    referrers = excluded.referrers,
    devices   = excluded.devices;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.rollup_site_events(date) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- 4. Retention
-- ---------------------------------------------------------------
-- Raw events age out; the daily rollups are small and stay. Called from
-- the existing purge-trash cron rather than adding a new schedule.

create or replace function public.purge_site_events(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    p_days := 90;
  end if;

  delete from public.site_events
  where day < ((now() at time zone 'utc')::date - p_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_site_events(integer) from public, anon, authenticated;
