-- =====================================================================
--  Mulk Agent. Run once in Supabase → SQL Editor, after laptop-control.sql.
--  Safe to re-run.
--  The computer can read its own rules, ask for admin rights, and report a
--  copy channel. It cannot approve its own request or read other assets.
-- =====================================================================

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.laptop_controls') is null then
    raise exception 'Run supabase/laptop-control.sql before supabase/agent.sql';
  end if;
end $$;

alter table public.laptop_controls add column if not exists connection text not null default 'not_connected';

create table if not exists public.agent_codes (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references public.assets(id) on delete cascade,
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  text not null default public.current_email(),
  created_at  timestamptz not null default now()
);

create table if not exists public.agent_devices (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  token_hash    text not null unique,
  hostname      text,
  windows_user  text,
  last_seen     timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.agent_codes enable row level security;
alter table public.agent_devices enable row level security;

drop policy if exists admins_read on public.agent_codes;
create policy admins_read on public.agent_codes
  for select to authenticated using (public.is_admin());

drop policy if exists admins_read on public.agent_devices;
create policy admins_read on public.agent_devices
  for select to authenticated using (public.is_admin());

revoke all on public.agent_codes, public.agent_devices from anon, authenticated;
grant select on public.agent_codes, public.agent_devices to authenticated;

create or replace function public.agent_create_code(p_asset_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  plain text := '';
  i int;
  b bytea;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if not exists (select 1 from public.assets where id = p_asset_id and status <> 'disposed') then
    raise exception 'Asset not found';
  end if;
  for i in 1..8 loop
    b := gen_random_bytes(1);
    plain := plain || substr(alphabet, 1 + (get_byte(b, 0) % length(alphabet)), 1);
  end loop;
  insert into public.agent_codes (asset_id, code_hash, expires_at)
  values (p_asset_id, encode(digest(plain, 'sha256'), 'hex'), now() + interval '24 hours');
  return plain;
end;
$$;

create or replace function public.agent_device_id(p_token text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.agent_devices
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

alter table public.laptop_controls add column if not exists locked boolean not null default false;
alter table public.laptop_controls add column if not exists lock_reason text;

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

  rules := case when policy_name in ('engineering', 'field')
    then '["USB storage is read only","A plugged-in USB device is reported by its name","Installed software, health, and search text are reported","Files, the screen, and the keyboard are not collected"]'::jsonb
    else '["USB storage is blocked","A plugged-in USB device is reported by its name","Installed software, health, and search text are reported","Files, the screen, and the keyboard are not collected"]'::jsonb
  end;

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

create or replace function public.agent_enroll(p_code text, p_hostname text, p_windows_user text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  code_row public.agent_codes%rowtype;
  token text;
  asset public.assets%rowtype;
begin
  if p_code is null or length(trim(p_code)) < 8 then
    raise exception 'Enter the 8 character code from Control';
  end if;
  if p_windows_user is null or length(trim(p_windows_user)) < 2 then
    raise exception 'Enter the Windows account that uses this computer';
  end if;

  select * into code_row from public.agent_codes
  where code_hash = encode(digest(upper(trim(p_code)), 'sha256'), 'hex')
    and used_at is null
    and expires_at > now()
  for update;
  if not found then
    raise exception 'That code is used or expired. Create a new one in Control';
  end if;

  update public.agent_codes set used_at = now() where id = code_row.id;
  select * into asset from public.assets where id = code_row.asset_id;
  token := encode(gen_random_bytes(32), 'hex');

  insert into public.agent_devices (asset_id, token_hash, hostname, windows_user, last_seen)
  values (
    code_row.asset_id,
    encode(digest(token, 'sha256'), 'hex'),
    left(coalesce(p_hostname, ''), 80),
    left(trim(p_windows_user), 80),
    now()
  );

  insert into public.laptop_controls (asset_id, connection)
  values (code_row.asset_id, 'enrolled')
  on conflict (asset_id) do update set connection = 'enrolled', updated_at = now();

  return jsonb_build_object(
    'token', token,
    'tag', asset.tag,
    'description', asset.description,
    'windows_user', left(trim(p_windows_user), 80)
  );
end;
$$;

create or replace function public.agent_request(p_token text, p_requested_by text, p_reason text)
returns void
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
  if p_requested_by is null or length(trim(p_requested_by)) < 2 then
    raise exception 'Name the person who is asking';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 8 or char_length(trim(p_reason)) > 500 then
    raise exception 'Write a reason between a sentence and a short paragraph';
  end if;
  insert into public.admin_requests (asset_id, requested_by, reason, status)
  values (asset_id, left(trim(p_requested_by), 120), trim(p_reason), 'pending');
  update public.agent_devices set last_seen = now() where id = public.agent_device_id(p_token);
end;
$$;

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
  if p_channel not in ('usb','clipboard','cloud','mail','print') then
    raise exception 'Unknown channel';
  end if;
  if p_action not in ('blocked','warned','quarantined','plugged') then
    raise exception 'Unknown result';
  end if;
  if p_file_name is null or char_length(trim(p_file_name)) < 1 or char_length(trim(p_file_name)) > 180 then
    raise exception 'Use the file name only, up to 180 characters';
  end if;
  if p_label is not null and char_length(p_label) > 80 then
    raise exception 'Keep the label short';
  end if;
  insert into public.copy_activity (asset_id, channel, file_name, label, action)
  values (asset_id, p_channel, trim(p_file_name), nullif(trim(coalesce(p_label, '')), ''), p_action);
  update public.agent_devices set last_seen = now() where id = public.agent_device_id(p_token);
end;
$$;

revoke all on function public.agent_create_code(uuid) from public, anon;
grant execute on function public.agent_create_code(uuid) to authenticated;

revoke all on function public.agent_device_id(text) from public, anon, authenticated;

revoke all on function public.agent_policy(text) from public;
revoke all on function public.agent_enroll(text, text, text) from public;
revoke all on function public.agent_request(text, text, text) from public;
revoke all on function public.agent_report(text, text, text, text, text) from public;

grant execute on function public.agent_policy(text) to anon, authenticated;
grant execute on function public.agent_enroll(text, text, text) to anon, authenticated;
grant execute on function public.agent_request(text, text, text) to anon, authenticated;
grant execute on function public.agent_report(text, text, text, text, text) to anon, authenticated;
