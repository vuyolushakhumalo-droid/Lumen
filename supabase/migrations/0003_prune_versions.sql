-- Lintel: cap version history per project.
-- versions has no retention policy of its own -- an active project can
-- accumulate one row per build/edit/restore/fork forever. This keeps
-- the newest N (default 100) per project and deletes the rest. Called
-- from the existing purge-trash cron rather than adding a second
-- schedule.
create or replace function public.prune_versions(p_keep integer default 100)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_keep is null or p_keep < 1 then
    p_keep := 100;
  end if;

  with ranked as (
    select id,
           row_number() over (
             partition by project_id
             order by created_at desc, id desc
           ) as rn
    from public.versions
  )
  delete from public.versions v
  using ranked r
  where v.id = r.id
    and r.rn > p_keep;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_versions(integer) from public, anon, authenticated;
