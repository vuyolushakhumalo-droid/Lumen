-- ============================================================
-- Migration 004 — soft-delete flag for projects
-- Stage 1 of the recycle bin: adds the column only. No delete
-- logic changes yet — projects.deleted_at stays unused until a
-- later stage wires it into the DELETE endpoint and dashboard.
--
-- Run in Supabase: SQL Editor -> New query -> paste -> Run
-- Safe to run on an existing database.
-- ============================================================

alter table projects add column if not exists deleted_at timestamptz;

-- Speeds up the future "list my trash" / "list my active projects"
-- queries once soft-delete logic is actually wired up.
create index if not exists idx_projects_deleted_at
  on projects(user_id, deleted_at);
