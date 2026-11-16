-- =====================================================================
--  Asset admin reports. Run once after supabase/agent.sql.
--  Safe to re-run.
--  Stores program name, version, and publisher from the Windows uninstall
--  list, plus a removable-drive notice. No documents, keystrokes, or screens.
-- =====================================================================

do $$
begin
  if to_regclass('public.agent_devices') is null then
    raise exception 'Run supabase/agent.sql before supabase/asset-admin.sql';
  end if;
end $$;

create table if not exists public.installed_software (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  name          text not null,
  name_key      text not null,
  version       text,
  publisher     text,
  installed_on  date,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  removed_at    timestamptz,
  constraint installed_software_name_len check (char_length(name) between 1 and 160),
  constraint installed_software_version_len check (version is null or char_length(version) <= 80),
  constraint installed_software_publisher_len check (publisher is null or char_length(publisher) <= 120)
);

create unique index if not exists installed_software_asset_name_idx
  on public.installed_software (asset_id, name_key);

create index if not exists installed_software_asset_idx
  on public.installed_software (asset_id) where removed_at is null;

create table if not exists public.software_events (
  id               bigint generated always as identity primary key,
  asset_id         uuid not null references public.assets(id) on delete cascade,
  name             text not null,
  version          text,
  publisher        text,
  kind             text not null check (kind in ('installed', 'removed')),
  happened_at      timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  constraint software_events_name_len check (char_length(name) between 1 and 160)
);

create index if not exists software_events_open_idx
  on public.software_events (happened_at desc) where acknowledged_at is null;

alter table public.copy_activity add column if not exists acknowledged_at timestamptz;
alter table public.copy_activity add column if not exists acknowledged_by text;

-- Rows that already existed are the baseline, not a new alert.
update public.copy_activity
set acknowledged_at = coalesce(acknowledged_at, happened_at),
    acknowledged_by = coalesce(acknowledged_by, 'baseline')
where acknowledged_at is null;

alter table public.installed_software enable row level security;
alter table public.software_events enable row level security;

drop policy if exists admins_read on public.installed_software;
create policy admins_read on public.installed_software
  for select to authenticated using (public.is_admin());

drop policy if exists admins_read on public.software_events;
create policy admins_read on public.software_events
  for select to authenticated using (public.is_admin());

drop policy if exists admins_ack on public.software_events;
create policy admins_ack on public.software_events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.installed_software, public.software_events from anon, authenticated;
grant select on public.installed_software to authenticated;
grant select, update on public.software_events to authenticated;
grant usage, select on sequence public.software_events_id_seq to authenticated;

create or replace function public.agent_sync_software(p_token text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dev_id uuid;
  v_asset uuid;
  baseline boolean;
  item jsonb;
  n text;
  nk text;
  ver text;
  pub text;
  inst date;
  seen text[] := '{}';
  added int := 0;
  removed int := 0;
  kept int := 0;
  existing public.installed_software%rowtype;
begin
  dev_id := public.agent_device_id(p_token);
  if dev_id is null then
    raise exception 'This computer is not enrolled';
  end if;
  select d.asset_id into v_asset from public.agent_devices d where d.id = dev_id;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Software list must be a list';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Refusing an empty software list';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'Send at most 500 programs';
  end if;

  select not exists (
    select 1 from public.installed_software s where s.asset_id = v_asset
  ) into baseline;

  for item in select value from jsonb_array_elements(p_items)
  loop
    n := left(btrim(coalesce(item->>'name', '')), 160);
    if n = '' then
      continue;
    end if;
    nk := lower(n);
    if nk = any (seen) then
      continue;
    end if;
    seen := array_append(seen, nk);
    ver := nullif(left(btrim(coalesce(item->>'version', '')), 80), '');
    pub := nullif(left(btrim(coalesce(item->>'publisher', '')), 120), '');
    begin
      inst := nullif(item->>'installed_on', '')::date;
    exception when others then
      inst := null;
    end;

    select * into existing from public.installed_software
    where asset_id = v_asset and name_key = nk;

    if not found then
      insert into public.installed_software (asset_id, name, name_key, version, publisher, installed_on)
      values (v_asset, n, nk, ver, pub, inst);
      if baseline then
        kept := kept + 1;
      else
        insert into public.software_events (asset_id, name, version, publisher, kind)
        values (v_asset, n, ver, pub, 'installed');
        added := added + 1;
      end if;
    else
      update public.installed_software
      set name = n,
          version = ver,
          publisher = coalesce(pub, publisher),
          installed_on = coalesce(inst, installed_on),
          last_seen = now(),
          removed_at = null
      where id = existing.id;
      if existing.removed_at is not null and not baseline then
        insert into public.software_events (asset_id, name, version, publisher, kind)
        values (v_asset, n, ver, pub, 'installed');
        added := added + 1;
      else
        kept := kept + 1;
      end if;
    end if;
  end loop;

  if not baseline then
    for existing in
      select * from public.installed_software
      where asset_id = v_asset
        and removed_at is null
        and not (name_key = any (seen))
    loop
      update public.installed_software
      set removed_at = now(), last_seen = now()
      where id = existing.id;
      insert into public.software_events (asset_id, name, version, publisher, kind)
      values (v_asset, existing.name, existing.version, existing.publisher, 'removed');
      removed := removed + 1;
    end loop;
  end if;

  update public.agent_devices set last_seen = now() where id = dev_id;

  return jsonb_build_object(
    'baseline', baseline,
    'added', added,
    'removed', removed,
    'kept', kept
  );
end;
$$;

revoke all on function public.agent_sync_software(text, jsonb) from public;
grant execute on function public.agent_sync_software(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
