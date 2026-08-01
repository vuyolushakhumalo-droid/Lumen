-- ============================================================
-- Tracks how an edit resolved: patch applied on the first attempt,
-- needed a retry, or fell back to full-document regeneration. Builds
-- (kind = 'build') leave this null -- the distinction doesn't apply.
-- Purpose: gather a baseline retry/fallback rate before deciding
-- whether caching previousHtml (paying the write premium on every
-- edit) is worth it.
-- ============================================================
alter table usage_events add column if not exists edit_mode text
  check (edit_mode is null or edit_mode in ('patch_first', 'patch_retry', 'fallback'));
