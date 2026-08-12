-- Lintel: retention for form submissions.
-- No sweep exists for submissions today -- rows accumulate forever
-- unless a customer manually erases one via
-- DELETE /api/submissions?id=.... Called from the existing purge-trash
-- cron rather than adding a new schedule.
create or replace function public.purge_submissions(p_days integer default 365)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    p_days := 365;
  end if;

  delete from public.submissions
  where created_at < now() - make_interval(days => p_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_submissions(integer) from public, anon, authenticated;
