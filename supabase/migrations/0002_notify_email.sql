-- Lintel: let owners redirect enquiry notifications away from their
-- login address. Null means "use the account email".

alter table public.sites
  add column if not exists notify_email text;

-- Cheap sanity check; the real validation belongs in the UI.
alter table public.sites
  drop constraint if exists sites_notify_email_shape;

alter table public.sites
  add constraint sites_notify_email_shape
  check (notify_email is null or notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
