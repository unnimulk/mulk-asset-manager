-- Admin lock. Run once on a database that already has laptop controls.
-- Safe to re-run. On a Windows computer, Mulk Agent locks the session.
-- This does not wipe the computer, and it does not read files or the keyboard.

alter table public.laptop_controls add column if not exists locked boolean not null default false;
alter table public.laptop_controls add column if not exists lock_reason text;

create or replace function public.refuse_locked_checkout()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'checked_out' and old.status is distinct from 'checked_out' then
    if exists (select 1 from public.laptop_controls c where c.asset_id = new.id and c.locked) then
      raise exception 'This asset is locked. Unlock it in Control before checking it out.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_locked_checkout() from public, anon, authenticated;

drop trigger if exists assets_refuse_locked_checkout on public.assets;
create trigger assets_refuse_locked_checkout
  before update on public.assets
  for each row execute function public.refuse_locked_checkout();

notify pgrst, 'reload schema';
