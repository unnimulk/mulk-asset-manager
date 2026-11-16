-- =====================================================================
--  Network location and USB plug alerts. Run once after asset-admin.sql.
--  Safe to re-run.
--  Stores the public IP and the city/country that IP maps to. Not GPS.
--  A country other than AE raises an alert. Any new USB device raises an alert.
-- =====================================================================

do $$
begin
  if to_regclass('public.agent_devices') is null then
    raise exception 'Run supabase/agent.sql before supabase/presence.sql';
  end if;
end $$;

alter table public.agent_devices add column if not exists public_ip text;
alter table public.agent_devices add column if not exists local_ip text;
alter table public.agent_devices add column if not exists country_code text;
alter table public.agent_devices add column if not exists country_name text;
alter table public.agent_devices add column if not exists region_name text;
alter table public.agent_devices add column if not exists city text;
alter table public.agent_devices add column if not exists outside_uae boolean;
alter table public.agent_devices add column if not exists location_at timestamptz;

create table if not exists public.location_events (
  id               bigint generated always as identity primary key,
  asset_id         uuid not null references public.assets(id) on delete cascade,
  public_ip        text,
  local_ip         text,
  country_code     text,
  country_name     text,
  region_name      text,
  city             text,
  outside_uae      boolean not null default false,
  happened_at      timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  constraint location_events_ip_len check (public_ip is null or char_length(public_ip) <= 45),
  constraint location_events_local_len check (local_ip is null or char_length(local_ip) <= 45)
);

create index if not exists location_events_open_idx
  on public.location_events (happened_at desc)
  where outside_uae and acknowledged_at is null;

alter table public.location_events enable row level security;

drop policy if exists admins_read on public.location_events;
create policy admins_read on public.location_events
  for select to authenticated using (public.is_admin());

drop policy if exists admins_ack on public.location_events;
create policy admins_ack on public.location_events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.location_events from anon, authenticated;
grant select, update on public.location_events to authenticated;
grant usage, select on sequence public.location_events_id_seq to authenticated;

do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.copy_activity'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%action%'
  loop
    execute format('alter table public.copy_activity drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.copy_activity
  add constraint copy_activity_action_check
  check (action in ('blocked', 'warned', 'quarantined', 'plugged'));

create or replace function public.agent_report(
  p_token text,
  p_channel text,
  p_file_name text,
  p_label text,
  p_action text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_id uuid;
begin
  select d.asset_id into asset_id from public.agent_devices d
  where d.id = public.agent_device_id(p_token);
  if asset_id is null then
    raise exception 'This computer is not enrolled';
  end if;
  if p_channel not in ('usb', 'clipboard', 'cloud', 'mail', 'print') then
    raise exception 'Unknown channel';
  end if;
  if p_action not in ('blocked', 'warned', 'quarantined', 'plugged') then
    raise exception 'Unknown result';
  end if;
  if p_file_name is null or char_length(btrim(p_file_name)) < 1 or char_length(btrim(p_file_name)) > 180 then
    raise exception 'Use the file name only, up to 180 characters';
  end if;
  if p_label is not null and char_length(p_label) > 80 then
    raise exception 'Keep the label short';
  end if;
  insert into public.copy_activity (asset_id, channel, file_name, label, action)
  values (asset_id, p_channel, btrim(p_file_name), nullif(btrim(coalesce(p_label, '')), ''), p_action);
  update public.agent_devices set last_seen = now() where id = public.agent_device_id(p_token);
end;
$$;

create or replace function public.agent_report_presence(
  p_token text,
  p_public_ip text,
  p_local_ip text,
  p_country_code text,
  p_country_name text,
  p_region_name text,
  p_city text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
  v_ip text;
  v_local text;
  v_code text;
  v_country text;
  v_region text;
  v_city text;
  outside boolean;
  changed boolean;
  alert boolean := false;
begin
  select * into dev from public.agent_devices
  where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;

  v_ip := nullif(left(btrim(coalesce(p_public_ip, '')), 45), '');
  if v_ip is not null and v_ip !~ '^[0-9A-Fa-f:.]+$' then
    raise exception 'Unrecognized IP address';
  end if;
  v_local := nullif(left(btrim(coalesce(p_local_ip, '')), 45), '');
  if v_local is not null and v_local !~ '^[0-9A-Fa-f:.]+$' then
    v_local := null;
  end if;
  v_code := upper(nullif(left(btrim(coalesce(p_country_code, '')), 2), ''));
  if v_code is not null and v_code !~ '^[A-Z]{2}$' then
    v_code := null;
  end if;
  v_country := nullif(left(btrim(coalesce(p_country_name, '')), 80), '');
  v_region := nullif(left(btrim(coalesce(p_region_name, '')), 80), '');
  v_city := nullif(left(btrim(coalesce(p_city, '')), 80), '');

  if v_code is null then
    v_code := dev.country_code;
    v_country := coalesce(v_country, dev.country_name);
    v_region := coalesce(v_region, dev.region_name);
    v_city := coalesce(v_city, dev.city);
    v_ip := coalesce(v_ip, dev.public_ip);
  end if;

  outside := v_code is not null and v_code <> 'AE';
  changed := dev.public_ip is distinct from v_ip
    or dev.country_code is distinct from v_code
    or dev.city is distinct from v_city;

  update public.agent_devices
  set public_ip = v_ip,
      local_ip = coalesce(v_local, local_ip),
      country_code = v_code,
      country_name = v_country,
      region_name = v_region,
      city = v_city,
      outside_uae = outside,
      location_at = case when changed then now() else location_at end,
      last_seen = now()
  where id = dev.id;

  if outside and (dev.outside_uae is distinct from true or dev.country_code is distinct from v_code) then
    insert into public.location_events (
      asset_id, public_ip, local_ip, country_code, country_name, region_name, city, outside_uae
    ) values (
      dev.asset_id, v_ip, coalesce(v_local, dev.local_ip), v_code, v_country, v_region, v_city, true
    );
    alert := true;
  elsif changed and v_ip is not null then
    insert into public.location_events (
      asset_id, public_ip, local_ip, country_code, country_name, region_name, city, outside_uae,
      acknowledged_at, acknowledged_by
    ) values (
      dev.asset_id, v_ip, coalesce(v_local, dev.local_ip), v_code, v_country, v_region, v_city, outside,
      now(), 'recorded'
    );
  end if;

  return jsonb_build_object(
    'alert', alert,
    'outside_uae', outside,
    'public_ip', v_ip,
    'country_code', v_code,
    'country', v_country,
    'city', v_city
  );
end;
$$;

revoke all on function public.agent_report_presence(text, text, text, text, text, text, text) from public;
grant execute on function public.agent_report_presence(text, text, text, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
