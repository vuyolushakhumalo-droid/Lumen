-- Lintel: custom-domain verification state.
--
-- custom_domain was treated as authoritative the moment the customer
-- typed it -- the dashboard linked to it, the canonical tag pointed at
-- it, and nothing ever checked that DNS had been configured. These
-- columns record what we've actually confirmed with the host.
--
-- 'pending'  = saved, not yet confirmed live (the default, and where
--              every existing row starts)
-- 'verified' = the host reports it verified AND correctly configured
-- 'error'    = we could not check (bad token, API failure); NOT the
--              same as "the customer hasn't set their DNS yet", which
--              stays 'pending'

alter table public.sites
  add column if not exists domain_status text not null default 'pending';

alter table public.sites
  add column if not exists domain_checked_at timestamptz;

alter table public.sites
  add column if not exists domain_error text;

alter table public.sites
  drop constraint if exists sites_domain_status_check;

alter table public.sites
  add constraint sites_domain_status_check
  check (domain_status in ('pending','verified','error'));

-- The overnight sweep looks for exactly this: sites with a custom
-- domain that haven't been confirmed yet.
create index if not exists sites_domain_pending_idx
  on public.sites (domain_status)
  where custom_domain is not null;
