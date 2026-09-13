-- ============================================================
-- Lumen — database schema
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- profiles (extends Supabase auth.users) ----------
create table if not exists profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  name                text,
  timezone            text default 'Europe/London',
  stripe_customer_id  text unique,
  is_admin            boolean default false,
  -- Which version of the terms this account accepted, and when. Set once
  -- and never overwritten -- the first acceptance is the binding one.
  -- audit_log keeps the dated history; see lib/terms.js.
  terms_accepted_at   timestamptz,
  terms_version       text,
  created_at          timestamptz default now()
);

-- Automatically create a profile row whenever someone signs up
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- subscriptions ----------
create table if not exists subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  plan                    text not null check (plan in ('standard','pro','frontier','done_for_you','studio')),
  status                  text not null check (status in ('trialing','active','past_due','canceled','incomplete')),
  billing_interval        text check (billing_interval in ('month','year')),
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean default false,
  stripe_subscription_id  text unique,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);
create index if not exists idx_subs_user on subscriptions(user_id);

-- ---------- projects ----------
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  name          text not null default 'Untitled project',
  current_code  text,
  preview_url   text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_projects_user on projects(user_id);

-- ---------- versions (append-only history) ----------
create table if not exists versions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  label       text,
  brief       text,
  code        text not null,
  model_used  text,
  created_at  timestamptz default now()
);
create index if not exists idx_versions_project on versions(project_id, created_at desc);

-- ---------- daily usage ----------
create table if not exists usage_daily (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  date        date not null,
  builds_used int not null default 0,
  unique (user_id, date)
);
create index if not exists idx_usage_user_date on usage_daily(user_id, date);

-- ---------- top-up credits (roll over, never expire) ----------
create table if not exists topups (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  credits_purchased  int not null,
  credits_remaining  int not null,
  stripe_payment_id  text,
  created_at         timestamptz default now()
);
create index if not exists idx_topups_user on topups(user_id) where credits_remaining > 0;

-- ---------- published sites ----------
create table if not exists sites (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  subdomain         text unique,
  custom_domain     text unique,
  provider_site_id  text,
  status            text default 'draft' check (status in ('draft','live')),
  last_deployed_at  timestamptz,
  notify_email      text,  -- lets an owner redirect enquiry notifications away from their login address; null means "use the account email"
  -- What we've actually confirmed about custom_domain with the host.
  -- 'pending' until verified; 'error' means the check itself failed,
  -- not that the customer's DNS is wrong (that stays 'pending').
  domain_status     text not null default 'pending' check (domain_status in ('pending','verified','error')),
  domain_checked_at timestamptz,
  domain_error      text,
  -- When the domain was attached, not when it was last looked at --
  -- domain_checked_at moves on every sweep, so it can't answer "how
  -- long has this been pending?". The 14-day cleanup runs off this.
  domain_added_at   timestamptz,
  -- Why a domain disappeared, for the builder to tell the customer.
  domain_note       text,
  -- Set when WE took the site offline (a hard-block rule id), null when
  -- the customer unpublished it themselves. Same status either way, so
  -- this is what tells "Needs attention" apart from "Draft".
  offline_reason    text,
  offline_at        timestamptz
);

create index if not exists sites_domain_pending_idx
  on public.sites (domain_status)
  where custom_domain is not null;

alter table sites drop constraint if exists sites_notify_email_shape;
alter table sites add constraint sites_notify_email_shape
  check (notify_email is null or notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- ---------- old subdomains, so shared links keep working ----------
-- old_slug is the primary key on purpose: a slug points at one site or
-- none, so a new site claiming a used address is a delete + insert and
-- there is no state where two sites both own it. Service role only.
create table if not exists slug_redirects (
  old_slug   text primary key,
  site_id    uuid not null references sites(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists slug_redirects_site_idx on slug_redirects(site_id, created_at desc);

-- ---------- form submissions from published sites ----------
-- user_id is denormalised from sites so RLS is a single-column check
-- rather than a join on every read.
create table if not exists submissions (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'message'
              check (kind in ('message', 'list_signup')),
  payload     jsonb not null,
  ip_hash     text,
  user_agent  text,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists submissions_user_created_idx on submissions(user_id, created_at desc);
create index if not exists submissions_site_created_idx on submissions(site_id, created_at desc);

-- ---------- site analytics: raw events ----------
-- One row per beacon. High volume, never read by a customer, aged out
-- after 90 days by purge_site_events(). No IP is stored: `visitor` is
-- an HMAC of (ip + user-agent + day) keyed by ANALYTICS_SALT, which
-- distinguishes a returning visitor within one day and nothing further.
create table if not exists site_events (
  id       bigserial primary key,
  site_id  uuid not null references sites(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null default (now() at time zone 'utc')::date,
  ts       timestamptz not null default now(),
  section  text,
  ref_host text,
  country  text,
  device   text check (device in ('desktop','mobile','tablet')),
  visitor  text not null
);
create index if not exists site_events_site_day_idx on site_events(site_id, day);

-- ---------- site analytics: daily rollup ----------
-- The read path: one row per site per day, written only by
-- rollup_site_events(). This is what the dashboard charts.
create table if not exists site_daily (
  site_id   uuid not null references sites(id) on delete cascade,
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
create index if not exists site_daily_user_day_idx on site_daily(user_id, day desc);

-- ---------- persistent rate limiting ----------
-- Replaces the in-memory limiter, which is not multi-instance safe on
-- Vercel. Used by the public form-capture endpoint first, then by the
-- rest of the mutation routes in the security block.
create table if not exists rate_limits (
  key          text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);
create index if not exists rate_limits_window_idx on rate_limits(window_start);

-- ---------- audit log (support, abuse, disputes) ----------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete set null,
  action      text not null,
  meta        jsonb,
  created_at  timestamptz default now()
);
create index if not exists idx_audit_created on audit_log(created_at desc);

-- ---------- enquiries to Lintel (Studio, Done for you) ----------
-- From the marketing site's enquiry form via /api/enquiry. Ours, not a
-- customer's: never shown in a dashboard, service role only.
create table if not exists enquiries (
  id          uuid primary key default gen_random_uuid(),
  interest    text not null default 'studio'
              check (interest in ('studio', 'done_for_you', 'other')),
  name        text not null,
  email       text not null,
  message     text not null,
  ip_hash     text,
  user_agent  text,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists enquiries_created_idx on enquiries(created_at desc);

-- ---------- add-on packs (Motion, Languages, Forms Pro, Lintel Plus) ----------
-- Extra items on the customer's plan subscription, mirrored by the Stripe
-- webhook through sync_subscription_packs(): one row per pack an item grants
-- (Lintel Plus grants every pack). Monthly allowance counted from
-- period_start. See supabase/migrations/0011_packs.sql and lib/packs.js.
create table if not exists public.packs (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null references public.profiles(id) on delete cascade,
  pack                         text not null
                               check (pack in ('motion', 'languages', 'forms_pro', 'plus')),
  allowance                    integer not null default 0 check (allowance >= 0),
  used                         integer not null default 0 check (used >= 0),
  period_start                 timestamptz not null default now(),
  -- Which subscription the item belongs to, so a sync only ever touches
  -- that subscription's rows (a customer can have old or abandoned ones).
  stripe_subscription_id       text,
  stripe_subscription_item_id  text,
  -- The subscription's Stripe status, or 'canceled' once the item is gone.
  status                       text not null default 'active'
                               check (status in ('trialing', 'active', 'past_due', 'unpaid', 'incomplete',
                                                 'incomplete_expired', 'paused', 'canceled')),
  created_at                   timestamptz not null default now(),
  unique (stripe_subscription_item_id, pack)
);
create index if not exists packs_user_pack_idx on public.packs (user_id, pack);
create index if not exists packs_subscription_idx on public.packs (stripe_subscription_id);

-- ============================================================
-- Row Level Security
-- Users may only ever touch their own rows. The server uses the
-- service-role key, which bypasses RLS for trusted operations.
-- ============================================================
alter table profiles      enable row level security;
alter table subscriptions enable row level security;
alter table projects      enable row level security;
alter table versions      enable row level security;
alter table usage_daily   enable row level security;
alter table topups        enable row level security;
alter table sites         enable row level security;
alter table submissions   enable row level security;
alter table rate_limits   enable row level security;
alter table site_events   enable row level security;
alter table site_daily    enable row level security;
alter table enquiries     enable row level security;
alter table packs         enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own subscription" on subscriptions;
create policy "own subscription" on subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "own projects" on projects;
create policy "own projects" on projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own versions" on versions;
create policy "own versions" on versions
  for select using (
    exists (select 1 from projects p where p.id = versions.project_id and p.user_id = auth.uid())
  );

drop policy if exists "own usage" on usage_daily;
create policy "own usage" on usage_daily
  for select using (auth.uid() = user_id);

drop policy if exists "own topups" on topups;
create policy "own topups" on topups
  for select using (auth.uid() = user_id);

drop policy if exists "own packs" on public.packs;
create policy "own packs" on public.packs
  for select using (auth.uid() = user_id);

drop policy if exists "own sites" on sites;
create policy "own sites" on sites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Owners can read their own form submissions.
drop policy if exists submissions_select_own on submissions;
create policy submissions_select_own
  on submissions for select
  using (auth.uid() = user_id);

-- Owners can delete their own submissions (needed for erasure requests
-- from the visitors who submitted them).
drop policy if exists submissions_delete_own on submissions;
create policy submissions_delete_own
  on submissions for delete
  using (auth.uid() = user_id);

-- No INSERT policy on purpose. The public capture endpoint writes with
-- the service role, which bypasses RLS. Nothing holding an anon key can
-- write here, so a leaked anon key cannot be used to flood the table.

-- rate_limits: no policies at all, service role only.

-- site_events: no policies at all either, same reasoning as rate_limits.
-- The public beacon writes with the service role, and customers never
-- read raw events -- they read the daily rollup below.

-- Owners can read their own daily rollups. No write policy: only
-- rollup_site_events() writes here.
drop policy if exists site_daily_select_own on site_daily;
create policy site_daily_select_own
  on site_daily for select
  using (auth.uid() = user_id);

-- ============================================================
-- Helper: atomically increment today's build count.
-- Called ONLY after a successful generation.
-- ============================================================
create or replace function increment_usage(p_user_id uuid, p_date date)
returns int language plpgsql security definer as $$
declare
  new_count int;
begin
  insert into usage_daily (user_id, date, builds_used)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set builds_used = usage_daily.builds_used + 1
  returning builds_used into new_count;
  return new_count;
end;
$$;

-- ============================================================
-- Helper: spend one top-up credit (oldest pack first).
-- Returns true if a credit was available and consumed.
-- ============================================================
create or replace function spend_topup_credit(p_user_id uuid)
returns boolean language plpgsql security definer as $$
declare
  target uuid;
begin
  select id into target
  from topups
  where user_id = p_user_id and credits_remaining > 0
  order by created_at asc
  limit 1
  for update skip locked;

  if target is null then
    return false;
  end if;

  update topups set credits_remaining = credits_remaining - 1 where id = target;
  return true;
end;
$$;

-- ============================================================
-- Helper: atomically bump a rate-limit counter and report whether the
-- caller is allowed. Returns true when the request is ALLOWED. Used by
-- the public form-capture endpoint (app/api/f/[siteId]).
-- ============================================================
create or replace function check_rate_limit(
  p_key        text,
  p_limit      integer,
  p_window_sec integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into rate_limits as r (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set count = case
          when r.window_start < now() - make_interval(secs => p_window_sec)
          then 1
          else r.count + 1
        end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_sec)
          then now()
          else r.window_start
        end
  returning r.count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function check_rate_limit(text, integer, integer) from public, anon, authenticated;

-- ============================================================
-- Helper: drop rate_limits rows whose window closed long ago. Called
-- from the existing purge cron rather than adding a second schedule.
-- ============================================================
create or replace function sweep_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from rate_limits
  where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function sweep_rate_limits() from public, anon, authenticated;

-- ============================================================
-- Helper: drop enquiries older than 2 years (the privacy policy's
-- period for support messages). Called from the purge cron.
-- enquiries has no RLS policies at all: service role only.
-- ============================================================
create or replace function purge_enquiries(p_days integer default 730)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    p_days := 730;
  end if;
  delete from enquiries
  where created_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function purge_enquiries(integer) from public, anon, authenticated;

-- ============================================================
-- Add-on packs. Allowances are monthly, counted from period_start; these
-- functions roll a finished month themselves, and reset_pack_periods()
-- (nightly) writes the rolled values down. Service role only.
-- ============================================================

-- Start of the month-long period that p_at falls in, counting whole months
-- from p_start (in UTC). Before a month has passed, that's p_start itself.
create or replace function public.pack_period_start(p_start timestamptz, p_at timestamptz default now())
returns timestamptz
language plpgsql
immutable
set search_path = public
as $$
declare
  v_start  timestamp;
  v_at     timestamp;
  v_months integer;
begin
  if p_start is null or p_at is null or p_at < p_start then
    return p_start;
  end if;
  v_start := p_start at time zone 'UTC';
  v_at := p_at at time zone 'UTC';
  -- Calendar months between the two, then back off while that overshoots.
  v_months := greatest(0,
    (extract(year from v_at)::integer - extract(year from v_start)::integer) * 12
    + extract(month from v_at)::integer - extract(month from v_start)::integer);
  while v_months > 0 and v_start + make_interval(months => v_months) > v_at loop
    v_months := v_months - 1;
  end loop;
  return (v_start + make_interval(months => v_months)) at time zone 'UTC';
end;
$$;

-- New rows. Taking a pack off and adding it again (or swapping Motion for
-- Lintel Plus) mustn't hand out a fresh allowance: a new row carries on the
-- month and usage of the latest row for the same pack while that month is
-- still running. Otherwise the period starts now, moved back to the 28th if
-- it's later in the month, so adding months never lands on a short month's
-- end and drifts (Jan 31 -> Feb 28 -> Mar 28).
create or replace function public.packs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev record;
  v_day  integer;
begin
  select used, period_start into v_prev
  from packs
  where user_id = new.user_id and pack = new.pack
  order by period_start desc, created_at desc
  limit 1;

  if found and pack_period_start(v_prev.period_start, now()) = v_prev.period_start then
    new.period_start := v_prev.period_start;
    new.used := v_prev.used;
    return new;
  end if;

  new.period_start := coalesce(new.period_start, now());
  v_day := extract(day from new.period_start at time zone 'UTC')::integer;
  if v_day > 28 then
    new.period_start := new.period_start - make_interval(days => v_day - 28);
  end if;
  return new;
end;
$$;

drop trigger if exists packs_before_insert on public.packs;
create trigger packs_before_insert
  before insert on public.packs
  for each row execute function public.packs_before_insert();

-- Mirror one Stripe subscription's add-on items. p_rows is every pack the
-- items grant, as [{ "item_id", "pack", "allowance" }] (lib/packs.js expands
-- Lintel Plus). Rows of this subscription that aren't listed are cancelled;
-- listed rows are created, or have their allowance and status updated. Usage
-- and period are never touched here. Idempotent, and serialised per
-- subscription so the webhook and the add-ons route can't interleave.
create or replace function public.sync_subscription_packs(
  p_user_id          uuid,
  p_subscription_id  text,
  p_status           text,
  p_rows             jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_canceled integer;
  v_upserted integer;
begin
  if p_user_id is null or p_subscription_id is null or p_status is null then
    raise exception 'sync_subscription_packs: user, subscription and status are required';
  end if;

  perform pg_advisory_xact_lock(hashtext('packs:' || p_subscription_id));

  update packs
     set status = 'canceled'
   where stripe_subscription_id = p_subscription_id
     and status <> 'canceled'
     and not exists (
       select 1
       from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(item_id text, pack text, allowance integer)
       where r.item_id = packs.stripe_subscription_item_id and r.pack = packs.pack
     );
  get diagnostics v_canceled = row_count;

  insert into packs (user_id, pack, allowance, status, stripe_subscription_id, stripe_subscription_item_id)
  select p_user_id, r.pack, coalesce(r.allowance, 0), p_status, p_subscription_id, r.item_id
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(item_id text, pack text, allowance integer)
  on conflict (stripe_subscription_item_id, pack) do update
    set allowance = excluded.allowance,
        status = excluded.status,
        stripe_subscription_id = excluded.stripe_subscription_id;
  get diagnostics v_upserted = row_count;

  return jsonb_build_object('upserted', v_upserted, 'canceled', v_canceled);
end;
$$;

-- A user's rows in the given statuses, with this period's usage: a row whose
-- month has ended shows as unused in the new month, reset or not.
create or replace function public.pack_rows(p_user_id uuid, p_statuses text[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'pack', p.pack,
    'status', p.status,
    'allowance', p.allowance,
    'used', case when pack_period_start(p.period_start, now()) > p.period_start then 0 else p.used end,
    'periodStart', pack_period_start(p.period_start, now()),
    'periodEnd', ((pack_period_start(p.period_start, now()) at time zone 'UTC') + interval '1 month') at time zone 'UTC',
    'itemId', p.stripe_subscription_item_id,
    'viaPlus', p.pack <> 'plus' and exists (
      select 1 from packs q
      where q.stripe_subscription_item_id = p.stripe_subscription_item_id and q.pack = 'plus'
    )
  ) order by p.created_at, p.id), '[]'::jsonb)
  from packs p
  where p.user_id = p_user_id and p.status = any (p_statuses);
$$;

-- Use n of a pack's allowance, atomically. Locks the user's rows for the
-- pack, rolls any whose month has ended, and either takes all n (oldest row
-- first) or takes nothing: it never goes past the cap. Returns
-- { ok: true, remaining } or { ok: false, reason: 'no_pack' | 'allowance_used', remaining }.
create or replace function public.consume_pack(
  p_user_id  uuid,
  p_pack     text,
  p_n        integer,
  p_statuses text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now       timestamptz := now();
  v_row       record;
  v_rows      integer := 0;
  v_remaining integer := 0;
  v_need      integer;
  v_take      integer;
begin
  if p_n is null or p_n < 1 then
    raise exception 'consume_pack: n must be at least 1, got %', p_n;
  end if;

  for v_row in
    select id, allowance, used, period_start
    from packs
    where user_id = p_user_id and pack = p_pack and status = any (p_statuses)
    order by created_at, id
    for update
  loop
    v_rows := v_rows + 1;
    if pack_period_start(v_row.period_start, v_now) > v_row.period_start then
      update packs
         set used = 0, period_start = pack_period_start(v_row.period_start, v_now)
       where id = v_row.id;
      v_remaining := v_remaining + v_row.allowance;
    else
      v_remaining := v_remaining + greatest(v_row.allowance - v_row.used, 0);
    end if;
  end loop;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_pack', 'remaining', 0);
  end if;
  if v_remaining < p_n then
    return jsonb_build_object('ok', false, 'reason', 'allowance_used', 'remaining', v_remaining);
  end if;

  v_need := p_n;
  for v_row in
    select id, allowance, used
    from packs
    where user_id = p_user_id and pack = p_pack and status = any (p_statuses) and used < allowance
    order by created_at, id
  loop
    v_take := least(v_need, v_row.allowance - v_row.used);
    update packs set used = used + v_take where id = v_row.id;
    v_need := v_need - v_take;
    exit when v_need = 0;
  end loop;

  return jsonb_build_object('ok', true, 'remaining', v_remaining - p_n);
end;
$$;

-- Nightly (purge-trash cron): write down the reset for every live row whose
-- month has ended. Returns how many rows were reset.
create or replace function public.reset_pack_periods()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reset integer;
begin
  update packs
     set used = 0, period_start = pack_period_start(period_start, now())
   where status <> 'canceled'
     and pack_period_start(period_start, now()) > period_start;
  get diagnostics v_reset = row_count;
  return v_reset;
end;
$$;

revoke all on function public.pack_period_start(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.packs_before_insert() from public, anon, authenticated;
revoke all on function public.sync_subscription_packs(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.pack_rows(uuid, text[]) from public, anon, authenticated;
revoke all on function public.consume_pack(uuid, text, integer, text[]) from public, anon, authenticated;
revoke all on function public.reset_pack_periods() from public, anon, authenticated;
