-- Lintel: clips and languages become one-off packs that never expire.
--
-- 0011 sold Motion and Languages as monthly subscription items. Now clips
-- and languages are bought by quantity through Stripe Checkout (payment
-- mode), like build top-ups, and the webhook credits each purchase to a
-- balance: one packs row per user and pack, with purchased and used and no
-- period. Lintel Plus stays the only recurring item: its row carries 6 clips
-- a month (allowance, used, period_start), it makes languages unlimited, and
-- consume_pack() uses a Plus month's clips before bought ones.
--
-- pack_purchases records each purchase once, by Checkout Session, so a
-- webhook delivered twice credits once. Safe to run again.

-- ------------------------------------------------------------
-- Balances.
-- ------------------------------------------------------------
alter table public.packs add column if not exists purchased integer not null default 0;
alter table public.packs drop constraint if exists packs_purchased_check;
alter table public.packs add constraint packs_purchased_check check (purchased >= 0);

-- A Lintel Plus item used to write a row for every pack it granted; its
-- clips now live on the plus row itself, so bring this month's clip usage
-- across before those rows go.
update public.packs p
   set allowance = m.allowance, used = m.used, period_start = m.period_start
  from public.packs m
 where p.pack = 'plus'
   and m.pack = 'motion'
   and m.stripe_subscription_item_id = p.stripe_subscription_item_id;

-- Rows that came from subscription items for anything but Plus: the monthly
-- Motion and Languages items, and what Plus used to expand into. Bought
-- balances never have an item ID, so a second run leaves them alone.
delete from public.packs
 where pack <> 'plus'
   and stripe_subscription_item_id is not null;

alter table public.packs alter column period_start drop not null;

-- Plus rows are subscription items with a monthly allowance; every other row
-- is a balance: bought, no period, no item.
alter table public.packs drop constraint if exists packs_row_shape;
alter table public.packs add constraint packs_row_shape check (
  (pack = 'plus' and purchased = 0)
  or (pack <> 'plus' and allowance = 0 and period_start is null
      and stripe_subscription_id is null and stripe_subscription_item_id is null)
);

create unique index if not exists packs_balance_idx on public.packs (user_id, pack) where pack <> 'plus';

-- ------------------------------------------------------------
-- Purchases, one row per pack per Checkout Session.
-- ------------------------------------------------------------
create table if not exists public.pack_purchases (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  pack                        text not null check (pack in ('motion', 'languages')),
  quantity                    integer not null check (quantity > 0),
  amount_total                integer,
  currency                    text,
  stripe_checkout_session_id  text not null,
  stripe_payment_intent_id    text,
  created_at                  timestamptz not null default now(),
  unique (stripe_checkout_session_id, pack)
);

create index if not exists pack_purchases_user_idx on public.pack_purchases (user_id, created_at desc);

alter table public.pack_purchases enable row level security;

drop policy if exists "own pack purchases" on public.pack_purchases;
create policy "own pack purchases" on public.pack_purchases
  for select using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- New rows. A balance has no period. A Lintel Plus row re-added in the same
-- month carries on that month's clip usage rather than handing out a fresh
-- allowance; otherwise its period starts now, moved back to the 28th if it's
-- later in the month, so adding months never drifts (Jan 31 -> Feb 28 -> Mar 28).
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
  -- Bought clips and languages are balances that never expire: no period.
  if new.pack <> 'plus' then
    new.period_start := null;
    return new;
  end if;

  select used, period_start into v_prev
  from packs
  where user_id = new.user_id and pack = 'plus' and period_start is not null
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

-- ------------------------------------------------------------
-- A user's live Lintel Plus rows (with this month's clip usage: a month that
-- has ended shows as unused, reset or not) and their bought balances.
-- ------------------------------------------------------------
create or replace function public.pack_rows(p_user_id uuid, p_statuses text[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(s.r order by s.created_at, s.id), '[]'::jsonb)
  from (
    select p.created_at, p.id, jsonb_build_object(
      'pack', p.pack,
      'status', p.status,
      'allowance', p.allowance,
      'used', case when pack_period_start(p.period_start, now()) > p.period_start then 0 else p.used end,
      'periodStart', pack_period_start(p.period_start, now()),
      'periodEnd', ((pack_period_start(p.period_start, now()) at time zone 'UTC') + interval '1 month') at time zone 'UTC',
      'itemId', p.stripe_subscription_item_id
    ) as r
    from packs p
    where p.user_id = p_user_id and p.pack = 'plus' and p.status = any (p_statuses)
    union all
    select p.created_at, p.id, jsonb_build_object(
      'pack', p.pack,
      'purchased', p.purchased,
      'used', p.used
    ) as r
    from packs p
    where p.user_id = p_user_id and p.pack <> 'plus'
  ) s;
$$;

-- ------------------------------------------------------------
-- Use n clips or languages, atomically. Locks the rows, rolls a finished Plus
-- month, and either takes all n or nothing. Clips come from this Plus month
-- first, then from bought ones; languages are unlimited with Plus. Returns
-- { ok: true, remaining }, { ok: true, unlimited: true }, or
-- { ok: false, reason: 'no_pack' | 'allowance_used', remaining }.
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
  v_now         timestamptz := now();
  v_row         record;
  v_plus_rows   integer := 0;
  v_plus_left   integer := 0;
  v_balance_id  uuid;
  v_bought      integer;
  v_bought_used integer;
  v_left        integer;
  v_need        integer;
  v_take        integer;
begin
  if p_pack is null or p_pack not in ('motion', 'languages') then
    raise exception 'consume_pack: % has nothing to use up', p_pack;
  end if;
  if p_n is null or p_n < 1 then
    raise exception 'consume_pack: n must be at least 1, got %', p_n;
  end if;

  -- Live Lintel Plus rows, locked, with a finished month rolled.
  for v_row in
    select id, allowance, used, period_start
    from packs
    where user_id = p_user_id and pack = 'plus' and status = any (p_statuses)
    order by created_at, id
    for update
  loop
    v_plus_rows := v_plus_rows + 1;
    if pack_period_start(v_row.period_start, v_now) > v_row.period_start then
      update packs
         set used = 0, period_start = pack_period_start(v_row.period_start, v_now)
       where id = v_row.id;
      v_plus_left := v_plus_left + v_row.allowance;
    else
      v_plus_left := v_plus_left + greatest(v_row.allowance - v_row.used, 0);
    end if;
  end loop;

  if p_pack = 'languages' and v_plus_rows > 0 then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  select id, purchased, used into v_balance_id, v_bought, v_bought_used
  from packs
  where user_id = p_user_id and pack = p_pack
  for update;

  v_left := v_plus_left + greatest(coalesce(v_bought, 0) - coalesce(v_bought_used, 0), 0);

  if v_plus_rows = 0 and v_balance_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_pack', 'remaining', 0);
  end if;
  if v_left < p_n then
    return jsonb_build_object('ok', false, 'reason', 'allowance_used', 'remaining', v_left);
  end if;

  v_need := p_n;
  for v_row in
    select id, allowance, used
    from packs
    where user_id = p_user_id and pack = 'plus' and status = any (p_statuses) and used < allowance
    order by created_at, id
  loop
    exit when v_need = 0;
    v_take := least(v_need, v_row.allowance - v_row.used);
    update packs set used = used + v_take where id = v_row.id;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then
    update packs set used = used + v_need where id = v_balance_id;
  end if;

  return jsonb_build_object('ok', true, 'remaining', v_left - p_n);
end;
$$;

-- ------------------------------------------------------------
-- Credit a paid purchase of clips or languages to the user's balance. Each
-- Checkout Session credits each pack once: a repeat returns credited false.
-- Returns { credited, purchased }.
-- ------------------------------------------------------------
create or replace function public.credit_pack_purchase(
  p_user_id                uuid,
  p_pack                   text,
  p_quantity               integer,
  p_checkout_session_id    text,
  p_payment_intent_id      text,
  p_amount_total           integer,
  p_currency               text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase  uuid;
  v_purchased integer;
begin
  if p_pack is null or p_pack not in ('motion', 'languages') then
    raise exception 'credit_pack_purchase: % is not bought by quantity', p_pack;
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'credit_pack_purchase: quantity must be at least 1, got %', p_quantity;
  end if;
  if p_user_id is null or p_checkout_session_id is null then
    raise exception 'credit_pack_purchase: user and checkout session are required';
  end if;

  insert into pack_purchases (user_id, pack, quantity, amount_total, currency, stripe_checkout_session_id, stripe_payment_intent_id)
  values (p_user_id, p_pack, p_quantity, p_amount_total, p_currency, p_checkout_session_id, p_payment_intent_id)
  on conflict (stripe_checkout_session_id, pack) do nothing
  returning id into v_purchase;

  if v_purchase is null then
    select purchased into v_purchased from packs where user_id = p_user_id and pack = p_pack;
    return jsonb_build_object('credited', false, 'purchased', coalesce(v_purchased, 0));
  end if;

  insert into packs (user_id, pack, purchased)
  values (p_user_id, p_pack, p_quantity)
  on conflict (user_id, pack) where pack <> 'plus' do update
    set purchased = packs.purchased + excluded.purchased
  returning purchased into v_purchased;

  return jsonb_build_object('credited', true, 'purchased', v_purchased);
end;
$$;

-- ------------------------------------------------------------
-- Nightly (purge-trash cron): write down the reset for every live Lintel Plus
-- row whose month has ended. Balances have no month. Returns how many rows
-- were reset.
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
   where pack = 'plus'
     and status <> 'canceled'
     and pack_period_start(period_start, now()) > period_start;
  get diagnostics v_reset = row_count;
  return v_reset;
end;
$$;

revoke all on function public.packs_before_insert() from public, anon, authenticated;
revoke all on function public.pack_rows(uuid, text[]) from public, anon, authenticated;
revoke all on function public.consume_pack(uuid, text, integer, text[]) from public, anon, authenticated;
revoke all on function public.credit_pack_purchase(uuid, text, integer, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.reset_pack_periods() from public, anon, authenticated;
