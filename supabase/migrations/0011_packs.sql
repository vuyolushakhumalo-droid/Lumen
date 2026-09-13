-- Lintel: add-on packs -- Motion, Languages, Forms Pro and Lintel Plus.
--
-- Packs are sold as extra items on the customer's existing Stripe
-- subscription, so they bill on the plan's invoice. The Stripe webhook
-- mirrors those items here through sync_subscription_packs(): one row per
-- pack an item grants. A Lintel Plus item writes a 'plus' row and a row for
-- every other pack, all carrying the item's ID, each with its own allowance
-- and usage.
--
-- Allowances are monthly, counted from period_start. The functions below
-- roll a finished month themselves, so a late or missed nightly reset never
-- lets anyone past the cap or holds anyone at it; reset_pack_periods() just
-- writes the rolled values down.
--
-- The app goes through lib/packs.js with the service role. Customers can
-- read their own rows; every function is service role only.

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

alter table public.packs enable row level security;

drop policy if exists "own packs" on public.packs;
create policy "own packs" on public.packs
  for select using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Start of the month-long period that p_at falls in, counting whole months
-- from p_start (in UTC). Before a month has passed, that's p_start itself.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- New rows. Taking a pack off and adding it again (or swapping Motion for
-- Lintel Plus) mustn't hand out a fresh allowance: a new row carries on the
-- month and usage of the latest row for the same pack while that month is
-- still running. Otherwise the period starts now, moved back to the 28th if
-- it's later in the month, so adding months never lands on a short month's
-- end and drifts (Jan 31 -> Feb 28 -> Mar 28).
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Mirror one Stripe subscription's add-on items. p_rows is every pack the
-- items grant, as [{ "item_id", "pack", "allowance" }] (lib/packs.js expands
-- Lintel Plus). Rows of this subscription that aren't listed are cancelled;
-- listed rows are created, or have their allowance and status updated. Usage
-- and period are never touched here. Idempotent, and serialised per
-- subscription so the webhook and the add-ons route can't interleave.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- A user's rows in the given statuses, with this period's usage: a row whose
-- month has ended shows as unused in the new month, reset or not.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Use n of a pack's allowance, atomically. Locks the user's rows for the
-- pack, rolls any whose month has ended, and either takes all n (oldest row
-- first) or takes nothing: it never goes past the cap. Returns
-- { ok: true, remaining } or { ok: false, reason: 'no_pack' | 'allowance_used', remaining }.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Nightly (purge-trash cron): write down the reset for every live row whose
-- month has ended. Returns how many rows were reset.
-- ------------------------------------------------------------
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
