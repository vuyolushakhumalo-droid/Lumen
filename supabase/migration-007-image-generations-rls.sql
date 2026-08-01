-- ============================================================
-- image_generations (migration-005) was created without RLS —
-- an oversight. Fixing it here to match the rest of the schema and
-- usage_events: no policies, readable only via the service-role key.
-- ============================================================
alter table image_generations enable row level security;
