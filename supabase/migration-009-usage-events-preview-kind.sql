-- ============================================================
-- Allow 'preview' as a usage_events.kind value, for the deferred
-- Haiku edit-preview call. Schema-only: widens the existing check
-- constraint, does not touch any existing row data.
-- ============================================================
alter table usage_events drop constraint if exists usage_events_kind_check;
alter table usage_events add constraint usage_events_kind_check
  check (kind in ('build', 'edit', 'preview'));
