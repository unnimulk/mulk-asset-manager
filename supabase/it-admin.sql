-- =====================================================================
--  IT admin operations. Run once after usage.sql. Safe to re-run.
--  Health, banned software, a one-time local Administrator password,
--  and a remote MSI/EXE install. No file contents, screen, or keyboard.
-- =====================================================================

do $$
begin
  if to_regclass('public.agent_devices') is null or to_regclass('public.installed_software') is null then
    raise exception 'Run supabase/agent.sql and supabase/asset-admin.sql before supabase/it-admin.sql';
  end if;
end $$;

alter table public.laptop_controls add column if not exists locked boolean not null default false;
alter table public.laptop_controls add column if not exists lock_reason text;

create table if not exists public.device_health (
  asset_id          uuid primary key references public.assets(id) on delete cascade,
  manufacturer      text,
  model             text,
  serial_number     text,
  ram_gb            numeric,
  disk_gb           numeric,
  disk_free_gb      numeric,
  bitlocker         text not null default 'unknown' check (bitlocker in ('on', 'off', 'unknown')),
  defender          text not null default 'unknown' check (defender in ('on', 'off', 'unknown')),
  firewall          text not null default 'unknown' check (firewall in ('on', 'off', 'unknown')),
  defender_age_hours integer,
  pending_reboot    boolean not null default false,
  local_admins      text,
  startup_names     text,
  reported_at       timestamptz not null default now()
);

create table if not exists public.compliance_alerts (
  id               bigint generated always as identity primary key,
  asset_id         uuid not null references public.assets(id) on delete cascade,
  kind             text not null check (kind in ('bitlocker', 'defender', 'firewall', 'disk', 'serial', 'local_admin', 'startup', 'banned')),
  detail           text not null,
  happened_at      timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  constraint compliance_alerts_detail_len check (char_length(detail) between 1 and 300)
);

create index if not exists compliance_alerts_open_idx
  on public.compliance_alerts (happened_at desc) where acknowledged_at is null;

create table if not exists public.banned_programs (
  name_key     text primary key,
  label        text not null,
  created_by   text not null default public.current_email(),
  created_at   timestamptz not null default now(),
  constraint banned_programs_label_len check (char_length(label) between 1 and 80)
);

create table if not exists public.local_admin_resets (
  asset_id      uuid primary key references public.assets(id) on delete cascade,
  password      text,
  requested_by  text,
  requested_at  timestamptz,
  applied_at    timestamptz,
  result        text
);

create table if not exists public.install_jobs (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  name          text not null,
  source_url    text not null,
  silent_args   text,
  status        text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  requested_by  text not null default public.current_email(),
  detail        text,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  constraint install_jobs_name_len check (char_length(name) between 1 and 80),
  constraint install_jobs_url_len check (char_length(source_url) between 12 and 500),
  constraint install_jobs_args_len check (silent_args is null or char_length(silent_args) <= 200)
);

alter table public.device_health enable row level security;
alter table public.compliance_alerts enable row level security;
alter table public.banned_programs enable row level security;
alter table public.local_admin_resets enable row level security;
alter table public.install_jobs enable row level security;

drop policy if exists admins_read on public.device_health;
create policy admins_read on public.device_health for select to authenticated using (public.is_admin());
drop policy if exists admins_read on public.compliance_alerts;
create policy admins_read on public.compliance_alerts for select to authenticated using (public.is_admin());
drop policy if exists admins_ack on public.compliance_alerts;
create policy admins_ack on public.compliance_alerts for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admins_all on public.banned_programs;
create policy admins_all on public.banned_programs for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admins_read on public.local_admin_resets;
create policy admins_read on public.local_admin_resets for select to authenticated using (public.is_admin());
drop policy if exists admins_read on public.install_jobs;
create policy admins_read on public.install_jobs for select to authenticated using (public.is_admin());

revoke all on public.device_health, public.compliance_alerts, public.banned_programs, public.local_admin_resets, public.install_jobs from anon, authenticated;
grant select on public.device_health, public.local_admin_resets to authenticated;
grant select, update on public.compliance_alerts to authenticated;
grant select, insert, delete on public.banned_programs to authenticated;
grant select on public.install_jobs to authenticated;
grant usage, select on sequence public.compliance_alerts_id_seq to authenticated;

create or replace function public.raise_compliance(p_asset uuid, p_kind text, p_detail text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.compliance_alerts
    where asset_id = p_asset and kind = p_kind and acknowledged_at is null and detail = left(p_detail, 300)
  ) then
    return;
  end if;
  insert into public.compliance_alerts (asset_id, kind, detail)
  values (p_asset, p_kind, left(p_detail, 300));
end;
$$;

revoke all on function public.raise_compliance(uuid, text, text) from public, anon, authenticated;

create or replace function public.agent_report_health(
  p_token text,
  p_manufacturer text,
  p_model text,
  p_serial text,
  p_ram_gb numeric,
  p_disk_gb numeric,
  p_disk_free_gb numeric,
  p_bitlocker text,
  p_defender text,
  p_firewall text,
  p_defender_age_hours integer,
  p_pending_reboot boolean,
  p_local_admins text,
  p_startup_names text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
  prev public.device_health%rowtype;
  asset_serial text;
  v_bit text;
  v_def text;
  v_fw text;
  v_admins text;
  v_startup text;
  v_serial text;
  v_age integer;
  banned record;
begin
  select * into dev from public.agent_devices where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  select * into prev from public.device_health where asset_id = dev.asset_id;

  v_bit := case lower(coalesce(p_bitlocker, '')) when 'on' then 'on' when 'off' then 'off' else 'unknown' end;
  v_def := case lower(coalesce(p_defender, '')) when 'on' then 'on' when 'off' then 'off' else 'unknown' end;
  v_fw := case lower(coalesce(p_firewall, '')) when 'on' then 'on' when 'off' then 'off' else 'unknown' end;
  v_serial := nullif(left(btrim(coalesce(p_serial, '')), 80), '');
  v_admins := nullif(left(btrim(coalesce(p_local_admins, '')), 500), '');
  v_startup := nullif(left(btrim(coalesce(p_startup_names, '')), 500), '');
  v_age := case
    when p_defender_age_hours is null or p_defender_age_hours < 0 or p_defender_age_hours > 100000 then null
    else p_defender_age_hours
  end;

  insert into public.device_health (
    asset_id, manufacturer, model, serial_number, ram_gb, disk_gb, disk_free_gb,
    bitlocker, defender, firewall, defender_age_hours, pending_reboot, local_admins, startup_names, reported_at
  ) values (
    dev.asset_id,
    nullif(left(btrim(coalesce(p_manufacturer, '')), 80), ''),
    nullif(left(btrim(coalesce(p_model, '')), 80), ''),
    v_serial,
    p_ram_gb, p_disk_gb, p_disk_free_gb,
    v_bit, v_def, v_fw, v_age, coalesce(p_pending_reboot, false),
    v_admins, v_startup, now()
  )
  on conflict (asset_id) do update set
    manufacturer = excluded.manufacturer,
    model = excluded.model,
    serial_number = excluded.serial_number,
    ram_gb = excluded.ram_gb,
    disk_gb = excluded.disk_gb,
    disk_free_gb = excluded.disk_free_gb,
    bitlocker = excluded.bitlocker,
    defender = excluded.defender,
    firewall = excluded.firewall,
    defender_age_hours = excluded.defender_age_hours,
    pending_reboot = excluded.pending_reboot,
    local_admins = excluded.local_admins,
    startup_names = excluded.startup_names,
    reported_at = now();

  if v_bit = 'off' then
    perform public.raise_compliance(dev.asset_id, 'bitlocker', 'Disk encryption is off');
  end if;
  if v_def = 'off' then
    perform public.raise_compliance(dev.asset_id, 'defender', 'Microsoft Defender real-time protection is off');
  elsif v_age is not null and v_age > 168 then
    perform public.raise_compliance(dev.asset_id, 'defender', 'Defender signatures are older than 7 days');
  end if;
  if v_fw = 'off' then
    perform public.raise_compliance(dev.asset_id, 'firewall', 'Windows Firewall is off');
  end if;
  if p_disk_free_gb is not null and p_disk_gb is not null and p_disk_gb > 0
     and (p_disk_free_gb < 15 or p_disk_free_gb / p_disk_gb < 0.10) then
    perform public.raise_compliance(dev.asset_id, 'disk', 'Less than 15 GB or 10 percent of the system disk is free');
  end if;

  select nullif(btrim(serial_no), '') into asset_serial from public.assets where id = dev.asset_id;
  if v_serial is not null and asset_serial is not null
     and lower(replace(v_serial, ' ', '')) <> lower(replace(asset_serial, ' ', '')) then
    perform public.raise_compliance(dev.asset_id, 'serial', 'Reported serial ' || v_serial || ' does not match the asset record');
  end if;

  if prev.asset_id is not null and prev.local_admins is distinct from v_admins and v_admins is not null then
    perform public.raise_compliance(dev.asset_id, 'local_admin', 'Local administrators changed: ' || v_admins);
  end if;
  if prev.asset_id is not null and prev.startup_names is distinct from v_startup and v_startup is not null then
    perform public.raise_compliance(dev.asset_id, 'startup', 'Startup programs changed: ' || v_startup);
  end if;

  for banned in
    select b.label
    from public.banned_programs b
    join public.installed_software s
      on s.asset_id = dev.asset_id and s.removed_at is null
     and char_length(b.name_key) >= 3
     and s.name_key = b.name_key
  loop
    perform public.raise_compliance(dev.asset_id, 'banned', 'Banned program is installed: ' || banned.label);
  end loop;

  update public.agent_devices set last_seen = now() where id = dev.id;
end;
$$;

create or replace function public.admin_set_local_password(p_asset_id uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if not exists (select 1 from public.assets where id = p_asset_id and status <> 'disposed') then
    raise exception 'Asset not found';
  end if;
  if p_password is null or char_length(p_password) < 12 or char_length(p_password) > 64 then
    raise exception 'Use 12 to 64 characters';
  end if;
  if p_password !~ '[A-Z]' or p_password !~ '[a-z]' or p_password !~ '[0-9]' then
    raise exception 'Include an upper-case letter, a lower-case letter, and a digit';
  end if;
  insert into public.local_admin_resets (asset_id, password, requested_by, requested_at, applied_at, result)
  values (p_asset_id, p_password, public.current_email(), now(), null, null)
  on conflict (asset_id) do update
  set password = excluded.password,
      requested_by = excluded.requested_by,
      requested_at = now(),
      applied_at = null,
      result = null;
end;
$$;

create or replace function public.agent_take_local_password(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
  secret text;
begin
  select * into dev from public.agent_devices where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  select password into secret from public.local_admin_resets
  where asset_id = dev.asset_id and password is not null;
  return secret;
end;
$$;

create or replace function public.agent_finish_local_password(p_token text, p_ok boolean, p_detail text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
begin
  select * into dev from public.agent_devices where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  update public.local_admin_resets
  set password = case when coalesce(p_ok, false) then null else password end,
      applied_at = case when coalesce(p_ok, false) then now() else applied_at end,
      result = left(coalesce(p_detail, case when coalesce(p_ok, false) then 'Changed' else 'Failed' end), 180)
  where asset_id = dev.asset_id;
  update public.agent_devices set last_seen = now() where id = dev.id;
end;
$$;

create or replace function public.admin_queue_install(
  p_asset_id uuid,
  p_name text,
  p_url text,
  p_silent_args text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  job uuid;
  v_name text;
  v_url text;
  v_args text;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if not exists (select 1 from public.assets where id = p_asset_id and status <> 'disposed') then
    raise exception 'Asset not found';
  end if;
  v_name := left(btrim(coalesce(p_name, '')), 80);
  v_url := left(btrim(coalesce(p_url, '')), 500);
  v_args := nullif(left(btrim(coalesce(p_silent_args, '')), 200), '');
  if char_length(v_name) < 1 then
    raise exception 'Name the software';
  end if;
  if v_url !~ '^https://' then
    raise exception 'The installer link must start with https://';
  end if;
  if v_args ~ '[;&|`$<>]' then
    raise exception 'Silent arguments cannot contain shell characters';
  end if;
  if right(lower(split_part(split_part(v_url, '?', 1), '#', 1)), 4) not in ('.msi', '.exe') then
    raise exception 'The link must end in .msi or .exe';
  end if;
  insert into public.install_jobs (asset_id, name, source_url, silent_args, status)
  values (p_asset_id, v_name, v_url, v_args, 'pending')
  returning id into job;
  return job;
end;
$$;

create or replace function public.agent_take_install(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
  job public.install_jobs%rowtype;
begin
  select * into dev from public.agent_devices where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  update public.install_jobs
  set status = 'failed', finished_at = now(), detail = 'Timed out before the result was reported'
  where asset_id = dev.asset_id and status = 'running' and started_at < now() - interval '2 hours';

  select * into job from public.install_jobs
  where asset_id = dev.asset_id and status = 'pending'
  order by requested_at
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;
  update public.install_jobs
  set status = 'running', started_at = now()
  where id = job.id;
  update public.agent_devices set last_seen = now() where id = dev.id;
  return jsonb_build_object(
    'id', job.id,
    'name', job.name,
    'source_url', job.source_url,
    'silent_args', coalesce(job.silent_args, '')
  );
end;
$$;

create or replace function public.agent_finish_install(p_token text, p_job uuid, p_ok boolean, p_detail text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
begin
  select * into dev from public.agent_devices where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  update public.install_jobs
  set status = case when coalesce(p_ok, false) then 'succeeded' else 'failed' end,
      finished_at = now(),
      detail = left(coalesce(p_detail, ''), 300)
  where id = p_job and asset_id = dev.asset_id and status = 'running';
  update public.agent_devices set last_seen = now() where id = dev.id;
end;
$$;

revoke all on function public.agent_report_health(text, text, text, text, numeric, numeric, numeric, text, text, text, integer, boolean, text, text) from public;
grant execute on function public.agent_report_health(text, text, text, text, numeric, numeric, numeric, text, text, text, integer, boolean, text, text) to anon, authenticated;

revoke all on function public.admin_set_local_password(uuid, text) from public, anon;
grant execute on function public.admin_set_local_password(uuid, text) to authenticated;
revoke all on function public.agent_take_local_password(text) from public;
grant execute on function public.agent_take_local_password(text) to anon, authenticated;
revoke all on function public.agent_finish_local_password(text, boolean, text) from public;
grant execute on function public.agent_finish_local_password(text, boolean, text) to anon, authenticated;

revoke all on function public.admin_queue_install(uuid, text, text, text) from public, anon;
grant execute on function public.admin_queue_install(uuid, text, text, text) to authenticated;
revoke all on function public.agent_take_install(text) from public;
grant execute on function public.agent_take_install(text) to anon, authenticated;
revoke all on function public.agent_finish_install(text, uuid, boolean, text) from public;
grant execute on function public.agent_finish_install(text, uuid, boolean, text) to anon, authenticated;

-- The window should describe what is actually collected.
create or replace function public.agent_policy(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dev public.agent_devices%rowtype;
  asset public.assets%rowtype;
  ctrl public.laptop_controls%rowtype;
  has_ctrl boolean := false;
  live_admin text := 'standard';
  policy_name text := 'baseline';
  ends_at timestamptz;
  hold_flag boolean := false;
  hold_text text;
  lock_flag boolean := false;
  lock_text text;
  usb text := 'block';
  usb_rule text;
  rules jsonb;
begin
  select * into dev from public.agent_devices
  where id = public.agent_device_id(p_token);
  if not found then
    raise exception 'This computer is not enrolled';
  end if;
  update public.agent_devices set last_seen = now() where id = dev.id;
  select * into asset from public.assets where id = dev.asset_id;
  select * into ctrl from public.laptop_controls where asset_id = dev.asset_id;
  has_ctrl := found;

  if has_ctrl then
    policy_name := coalesce(ctrl.policy, 'baseline');
    ends_at := ctrl.elevation_ends_at;
    hold_flag := coalesce(ctrl.hold, false);
    hold_text := ctrl.hold_reason;
    lock_flag := coalesce(ctrl.locked, false);
    lock_text := ctrl.lock_reason;
    if ctrl.admin = 'standing' then
      live_admin := 'standing';
    elsif ctrl.admin = 'elevated' and ctrl.elevation_ends_at is not null and ctrl.elevation_ends_at > now() then
      live_admin := 'elevated';
    end if;
    usb := case policy_name when 'engineering' then 'read' when 'field' then 'read' else 'block' end;
    if hold_flag or lock_flag then
      live_admin := 'standard';
      usb := 'block';
    end if;
  end if;

  usb_rule := case usb when 'read' then 'USB storage is read only' else 'USB storage is blocked' end;
  rules := jsonb_build_array(
    usb_rule,
    'A plugged-in USB device is reported by its name',
    'Installed software, health, and search text are reported',
    'Files, the screen, and the keyboard are not collected'
  );

  return jsonb_build_object(
    'tag', asset.tag,
    'description', asset.description,
    'assigned_to', asset.assigned_to,
    'hostname', dev.hostname,
    'windows_user', dev.windows_user,
    'admin', live_admin,
    'elevation_ends_at', ends_at,
    'policy', policy_name,
    'usb', usb,
    'hold', hold_flag,
    'hold_reason', hold_text,
    'locked', lock_flag,
    'lock_reason', lock_text,
    'rules', rules
  );
end;
$$;

notify pgrst, 'reload schema';
