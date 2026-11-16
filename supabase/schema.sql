-- =====================================================================
--  Mulk Holdings – IT Asset Manager : database schema for Supabase
--  Run this whole file once in Supabase → SQL Editor → New query → Run.
--  It is safe to re-run (it only creates what is missing / replaces functions).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Admin allow-list. Only logged-in users whose e-mail is in this table
--  can see or change anything. Add your IT team's e-mails here.
-- ---------------------------------------------------------------------
create table if not exists public.app_admins (
  email     text primary key,
  added_at  timestamptz not null default now()
);

-- >>> CHANGE / ADD YOUR ADMIN E-MAILS HERE <<<
insert into public.app_admins (email) values ('unni@mulkholdings.com')
on conflict do nothing;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.current_email()
returns text language sql stable
as $$ select coalesce(auth.jwt() ->> 'email', 'system') $$;

-- ---------------------------------------------------------------------
--  Assets
-- ---------------------------------------------------------------------
create table if not exists public.assets (
  id               uuid primary key default gen_random_uuid(),
  tag              text not null unique,
  description      text,
  category         text,
  brand            text,
  model            text,
  serial_no        text,
  configuration    text,
  status           text not null default 'available'
                   check (status in ('available','checked_out','under_repair','broken','lost','disposed')),
  site             text,
  location         text,
  department       text,
  assigned_to      text,
  purchase_date    date,
  purchase_cost    numeric(12,2),
  vendor           text,
  warranty_expiry  date,
  notes            text,
  last_event_date  date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       text default public.current_email()
);

create index if not exists assets_status_idx   on public.assets (status);
create index if not exists assets_category_idx on public.assets (category);
create index if not exists assets_assigned_idx on public.assets (assigned_to);

-- ---------------------------------------------------------------------
--  History: every check-out, check-in, repair, disposal, edit, import…
-- ---------------------------------------------------------------------
create table if not exists public.asset_events (
  id            bigint generated always as identity primary key,
  asset_id      uuid not null references public.assets(id) on delete cascade,
  action        text not null,
  event_date    date not null default current_date,
  from_status   text,
  to_status     text,
  assigned_to   text,
  department    text,
  site          text,
  location      text,
  vendor        text,
  cost          numeric(12,2),
  notes         text,
  performed_by  text not null default public.current_email(),
  created_at    timestamptz not null default now()
);

create index if not exists asset_events_asset_idx on public.asset_events (asset_id, created_at desc);
create index if not exists asset_events_created_idx on public.asset_events (created_at desc);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists assets_touch on public.assets;
create trigger assets_touch before update on public.assets
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
--  Row level security: admins only
-- ---------------------------------------------------------------------
alter table public.assets       enable row level security;
alter table public.asset_events enable row level security;
alter table public.app_admins   enable row level security;

drop policy if exists admins_all on public.assets;
create policy admins_all on public.assets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admins_all on public.asset_events;
create policy admins_all on public.asset_events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admins_all on public.app_admins;
create policy admins_all on public.app_admins
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.assets, public.asset_events, public.app_admins from anon;
grant select, insert, update, delete on public.assets, public.asset_events, public.app_admins to authenticated;

-- ---------------------------------------------------------------------
--  asset_action(): one call that changes status AND writes history
--  actions: check_out, check_in, repair, repair_done, broken, lost,
--           dispose, restore, move, note
-- ---------------------------------------------------------------------
create or replace function public.asset_action(
  p_asset_id    uuid,
  p_action      text,
  p_event_date  date    default current_date,
  p_assigned_to text    default null,
  p_department  text    default null,
  p_site        text    default null,
  p_location    text    default null,
  p_vendor      text    default null,
  p_cost        numeric default null,
  p_notes       text    default null
) returns public.assets
language plpgsql
set search_path = public
as $$
declare
  a public.assets;
  new_status text;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;

  select * into a from public.assets where id = p_asset_id for update;
  if not found then raise exception 'Asset not found'; end if;

  p_event_date  := coalesce(p_event_date, current_date);
  p_assigned_to := nullif(trim(p_assigned_to), '');
  p_department  := nullif(trim(p_department), '');
  p_site        := nullif(trim(p_site), '');
  p_location    := nullif(trim(p_location), '');

  case p_action
    when 'check_out' then
      if a.status <> 'available' then
        raise exception 'Only available assets can be checked out (this one is %)', replace(a.status, '_', ' ');
      end if;
      if p_assigned_to is null then raise exception 'Choose who the asset is assigned to'; end if;
      new_status    := 'checked_out';
      a.assigned_to := p_assigned_to;
      a.department  := coalesce(p_department, a.department);
      a.site        := coalesce(p_site, a.site);
      a.location    := coalesce(p_location, a.location);

    when 'check_in' then
      if a.status <> 'checked_out' then
        raise exception 'Only checked-out assets can be checked in';
      end if;
      p_assigned_to := a.assigned_to;           -- record who returned it
      new_status    := 'available';
      a.assigned_to := null;
      a.department  := null;
      a.site        := coalesce(p_site, a.site);
      a.location    := coalesce(p_location, a.location);

    when 'repair' then
      if a.status in ('under_repair','disposed','lost') then
        raise exception 'Asset cannot be sent for repair while %', replace(a.status, '_', ' ');
      end if;
      new_status := 'under_repair';

    when 'repair_done' then
      if a.status <> 'under_repair' then raise exception 'Asset is not under repair'; end if;
      new_status := case when a.assigned_to is not null then 'checked_out' else 'available' end;

    when 'broken' then
      if a.status in ('disposed') then raise exception 'Asset is disposed'; end if;
      new_status := 'broken';

    when 'lost' then
      if a.status in ('disposed') then raise exception 'Asset is disposed'; end if;
      new_status := 'lost';

    when 'dispose' then
      if a.status = 'disposed' then raise exception 'Asset is already disposed'; end if;
      new_status    := 'disposed';
      p_assigned_to := coalesce(p_assigned_to, a.assigned_to);
      a.assigned_to := null;
      a.department  := null;

    when 'restore' then
      if a.status not in ('broken','lost','disposed') then
        raise exception 'Only broken, lost or disposed assets can be restored';
      end if;
      new_status    := 'available';
      a.assigned_to := null;

    when 'move' then
      new_status   := a.status;
      a.site       := coalesce(p_site, a.site);
      a.location   := coalesce(p_location, a.location);
      a.department := coalesce(p_department, a.department);

    when 'note' then
      new_status := a.status;

    else
      raise exception 'Unknown action %', p_action;
  end case;

  insert into public.asset_events
    (asset_id, action, event_date, from_status, to_status,
     assigned_to, department, site, location, vendor, cost, notes)
  values
    (a.id, p_action, p_event_date, a.status, new_status,
     coalesce(p_assigned_to, a.assigned_to), coalesce(p_department, a.department),
     coalesce(p_site, a.site), coalesce(p_location, a.location),
     nullif(trim(p_vendor), ''), p_cost, nullif(trim(p_notes), ''));

  update public.assets set
    status          = new_status,
    assigned_to     = a.assigned_to,
    department      = a.department,
    site            = a.site,
    location        = a.location,
    last_event_date = case when p_action = 'note' then last_event_date else p_event_date end
  where id = a.id
  returning * into a;

  return a;
end $$;

-- ---------------------------------------------------------------------
--  import_assets(): bulk insert / update by Asset Tag (used by Import page)
-- ---------------------------------------------------------------------
create or replace function public.import_assets(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r jsonb;
  existing public.assets;
  new_id uuid;
  n_new int := 0;
  n_upd int := 0;
  v_status text;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(r->>'tag'), '') = '' then continue; end if;

    v_status := coalesce(nullif(r->>'status', ''), 'available');
    if v_status not in ('available','checked_out','under_repair','broken','lost','disposed') then
      v_status := 'available';
    end if;

    select * into existing from public.assets where tag = trim(r->>'tag');

    if not found then
      insert into public.assets (tag, description, category, brand, model, serial_no, configuration,
        status, site, location, department, assigned_to, purchase_date, purchase_cost, vendor,
        warranty_expiry, notes, last_event_date, created_at)
      values (trim(r->>'tag'), nullif(r->>'description',''), nullif(r->>'category',''),
        nullif(r->>'brand',''), nullif(r->>'model',''), nullif(r->>'serial_no',''),
        nullif(r->>'configuration',''), v_status, nullif(r->>'site',''), nullif(r->>'location',''),
        nullif(r->>'department',''), nullif(r->>'assigned_to',''),
        nullif(r->>'purchase_date','')::date, nullif(r->>'purchase_cost','')::numeric,
        nullif(r->>'vendor',''), nullif(r->>'warranty_expiry','')::date, nullif(r->>'notes',''),
        nullif(r->>'last_event_date','')::date,
        coalesce(nullif(r->>'created_at','')::timestamptz, now()))
      returning id into new_id;

      insert into public.asset_events (asset_id, action, event_date, to_status, assigned_to,
        department, site, location, notes)
      values (new_id, 'imported',
        coalesce(nullif(r->>'last_event_date','')::date, current_date),
        v_status, nullif(r->>'assigned_to',''), nullif(r->>'department',''),
        nullif(r->>'site',''), nullif(r->>'location',''), 'Imported from spreadsheet');
      n_new := n_new + 1;
    else
      update public.assets set
        description   = coalesce(nullif(r->>'description',''), description),
        category      = coalesce(nullif(r->>'category',''), category),
        brand         = coalesce(nullif(r->>'brand',''), brand),
        model         = coalesce(nullif(r->>'model',''), model),
        serial_no     = coalesce(nullif(r->>'serial_no',''), serial_no),
        configuration = coalesce(nullif(r->>'configuration',''), configuration),
        status        = v_status,
        site          = nullif(r->>'site',''),
        location      = nullif(r->>'location',''),
        department    = nullif(r->>'department',''),
        assigned_to   = nullif(r->>'assigned_to',''),
        purchase_date = coalesce(nullif(r->>'purchase_date','')::date, purchase_date),
        purchase_cost = coalesce(nullif(r->>'purchase_cost','')::numeric, purchase_cost),
        vendor        = coalesce(nullif(r->>'vendor',''), vendor),
        warranty_expiry = coalesce(nullif(r->>'warranty_expiry','')::date, warranty_expiry),
        notes         = coalesce(nullif(r->>'notes',''), notes),
        last_event_date = coalesce(nullif(r->>'last_event_date','')::date, last_event_date)
      where id = existing.id;

      insert into public.asset_events (asset_id, action, from_status, to_status, assigned_to,
        department, site, location, notes)
      values (existing.id, 'updated', existing.status, v_status, nullif(r->>'assigned_to',''),
        nullif(r->>'department',''), nullif(r->>'site',''), nullif(r->>'location',''),
        'Updated from spreadsheet import');
      n_upd := n_upd + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', n_new, 'updated', n_upd);
end $$;

-- log manual creates / edits made through the form
create or replace function public.log_asset_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.skip_log', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.asset_events (asset_id, action, to_status, assigned_to, department, site, location, notes)
    values (new.id, 'created', new.status, new.assigned_to, new.department, new.site, new.location, 'Asset created');
  end if;
  return new;
end $$;

drop trigger if exists assets_log_insert on public.assets;
create trigger assets_log_insert after insert on public.assets
for each row execute function public.log_asset_change();

-- the import function writes its own 'imported' event; silence the insert trigger there
create or replace function public.import_assets_wrapper(p_rows jsonb)
returns jsonb language plpgsql set search_path = public as $$
begin
  perform set_config('app.skip_log', 'on', true);
  return public.import_assets(p_rows);
end $$;

grant execute on function public.asset_action(uuid,text,date,text,text,text,text,text,numeric,text) to authenticated;
grant execute on function public.import_assets(jsonb) to authenticated;
grant execute on function public.import_assets_wrapper(jsonb) to authenticated;
grant execute on function public.is_admin() to authenticated;
revoke execute on function public.asset_action(uuid,text,date,text,text,text,text,text,numeric,text) from anon, public;
revoke execute on function public.import_assets(jsonb) from anon, public;
revoke execute on function public.import_assets_wrapper(jsonb) from anon, public;

-- hardening (Supabase security advisor)
alter function public.current_email() set search_path = public;
alter function public.touch_updated_at() set search_path = public;
revoke execute on function public.log_asset_change() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
--  Laptop control (also in supabase/laptop-control.sql for existing databases)
-- ---------------------------------------------------------------------

create table if not exists public.laptop_controls (
  asset_id           uuid primary key references public.assets(id) on delete cascade,
  admin              text not null default 'standard' check (admin in ('standard','elevated','standing')),
  elevation_ends_at  timestamptz,
  admin_note         text,
  policy             text not null default 'baseline'
                     check (policy in ('baseline','finance','engineering','legal','executive','field')),
  hold               boolean not null default false,
  hold_reason        text,
  locked             boolean not null default false,
  lock_reason        text,
  updated_at         timestamptz not null default now(),
  updated_by         text default public.current_email()
);

drop trigger if exists laptop_controls_touch on public.laptop_controls;
create trigger laptop_controls_touch before update on public.laptop_controls
for each row execute function public.touch_updated_at();

create table if not exists public.laptop_control_events (
  id            bigint generated always as identity primary key,
  asset_id      uuid not null references public.assets(id) on delete cascade,
  action        text not null,
  detail        text,
  performed_by  text not null default public.current_email(),
  created_at    timestamptz not null default now()
);

create index if not exists laptop_control_events_asset_idx
  on public.laptop_control_events (asset_id, created_at desc);

alter table public.laptop_controls enable row level security;
alter table public.laptop_control_events enable row level security;

drop policy if exists admins_all on public.laptop_controls;
create policy admins_all on public.laptop_controls
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admins_all on public.laptop_control_events;
create policy admins_all on public.laptop_control_events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.laptop_controls, public.laptop_control_events from anon;
grant select, insert, update, delete on public.laptop_controls, public.laptop_control_events to authenticated;
grant usage, select on sequence public.laptop_control_events_id_seq to authenticated;

alter table public.laptop_controls add column if not exists connection text not null default 'not_connected';
alter table public.laptop_controls drop constraint if exists laptop_controls_connection_check;
alter table public.laptop_controls add constraint laptop_controls_connection_check
  check (connection in ('not_connected','enrolled'));

alter table public.laptop_controls add column if not exists print_mode text not null default 'open';
alter table public.laptop_controls drop constraint if exists laptop_controls_print_mode_check;
alter table public.laptop_controls add constraint laptop_controls_print_mode_check
  check (print_mode in ('open','release','mono','stopped'));

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

create table if not exists public.admin_requests (
  id             bigint generated always as identity primary key,
  asset_id       uuid not null references public.assets(id) on delete cascade,
  requested_by   text not null,
  reason         text not null,
  status         text not null default 'pending' check (status in ('pending','approved','denied')),
  window_choice  text,
  decision_note  text,
  decided_by     text,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  constraint admin_requests_reason_len check (char_length(reason) between 8 and 500),
  constraint admin_requests_window_check check (window_choice is null or window_choice in ('1h','4h','close'))
);

create index if not exists admin_requests_status_idx on public.admin_requests (status, created_at desc);

create table if not exists public.copy_activity (
  id           bigint generated always as identity primary key,
  asset_id     uuid not null references public.assets(id) on delete cascade,
  channel      text not null check (channel in ('usb','clipboard','cloud','mail','print')),
  file_name    text not null,
  label        text,
  action       text not null check (action in ('blocked','warned','quarantined','plugged')),
  happened_at  timestamptz not null default now(),
  reported_by  text not null default public.current_email(),
  constraint copy_activity_name_len check (char_length(file_name) between 1 and 180),
  constraint copy_activity_label_len check (label is null or char_length(label) <= 80)
);

create index if not exists copy_activity_when_idx on public.copy_activity (happened_at desc);

alter table public.admin_requests enable row level security;
alter table public.copy_activity enable row level security;

drop policy if exists admins_all on public.admin_requests;
create policy admins_all on public.admin_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admins_all on public.copy_activity;
create policy admins_all on public.copy_activity
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.admin_requests, public.copy_activity from anon;
grant select, insert, update, delete on public.admin_requests, public.copy_activity to authenticated;
grant usage, select on sequence public.admin_requests_id_seq to authenticated;
grant usage, select on sequence public.copy_activity_id_seq to authenticated;

-- ---------------------------------------------------------------------
--  Mulk Agent (also in supabase/agent.sql)
-- ---------------------------------------------------------------------
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

-- =====================================================================
--  Search log, active hours, and app time. Run once after presence.sql.
--  Safe to re-run.
--  Stores the search text, the app name, and how long the laptop was in use.
--  It does not store page contents, passwords, or document titles.
-- =====================================================================

do $$
begin
  if to_regclass('public.agent_devices') is null then
    raise exception 'Run supabase/agent.sql before supabase/usage.sql';
  end if;
end $$;

create table if not exists public.web_searches (
  id           bigint generated always as identity primary key,
  asset_id     uuid not null references public.assets(id) on delete cascade,
  query        text not null,
  engine       text not null,
  searched_at  timestamptz not null,
  constraint web_searches_query_len check (char_length(query) between 1 and 300),
  constraint web_searches_engine_len check (char_length(engine) between 1 and 40)
);

create unique index if not exists web_searches_dedupe
  on public.web_searches (asset_id, engine, searched_at, query);

create index if not exists web_searches_when_idx
  on public.web_searches (searched_at desc);

create table if not exists public.device_days (
  asset_id        uuid not null references public.assets(id) on delete cascade,
  activity_date   date not null,
  active_seconds  integer not null default 0,
  first_active    timestamptz,
  last_active     timestamptz,
  primary key (asset_id, activity_date),
  constraint device_days_seconds_check check (active_seconds >= 0 and active_seconds <= 86400)
);

create table if not exists public.app_usage (
  asset_id        uuid not null references public.assets(id) on delete cascade,
  activity_date   date not null,
  app_name        text not null,
  active_seconds  integer not null default 0,
  primary key (asset_id, activity_date, app_name),
  constraint app_usage_name_len check (char_length(app_name) between 1 and 80),
  constraint app_usage_seconds_check check (active_seconds >= 0 and active_seconds <= 86400)
);

alter table public.web_searches enable row level security;
alter table public.device_days enable row level security;
alter table public.app_usage enable row level security;

drop policy if exists admins_read on public.web_searches;
create policy admins_read on public.web_searches
  for select to authenticated using (public.is_admin());

drop policy if exists admins_read on public.device_days;
create policy admins_read on public.device_days
  for select to authenticated using (public.is_admin());

drop policy if exists admins_read on public.app_usage;
create policy admins_read on public.app_usage
  for select to authenticated using (public.is_admin());

revoke all on public.web_searches, public.device_days, public.app_usage from anon, authenticated;
grant select on public.web_searches, public.device_days, public.app_usage to authenticated;
grant usage, select on sequence public.web_searches_id_seq to authenticated;

create or replace function public.agent_report_usage(
  p_token text,
  p_date text,
  p_active_seconds integer,
  p_apps jsonb,
  p_searches jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  dev_id uuid;
  v_asset uuid;
  v_date date;
  v_seconds integer;
  item jsonb;
  v_app text;
  app_seconds integer;
  q text;
  v_engine text;
  at_time timestamptz;
  added_searches integer := 0;
  added_apps integer := 0;
  inserted integer;
begin
  dev_id := public.agent_device_id(p_token);
  if dev_id is null then
    raise exception 'This computer is not enrolled';
  end if;
  select d.asset_id into v_asset from public.agent_devices d where d.id = dev_id;

  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Use a calendar date';
  end if;
  v_date := p_date::date;
  if v_date < (current_date - 14) or v_date > (current_date + 1) then
    raise exception 'That date is outside the reporting window';
  end if;

  v_seconds := least(greatest(coalesce(p_active_seconds, 0), 0), 28800);

  if v_seconds > 0 then
    insert into public.device_days (asset_id, activity_date, active_seconds, first_active, last_active)
    values (v_asset, v_date, least(v_seconds, 86400), now(), now())
    on conflict (asset_id, activity_date) do update
    set active_seconds = least(public.device_days.active_seconds + excluded.active_seconds, 86400),
        first_active = least(public.device_days.first_active, excluded.first_active),
        last_active = greatest(public.device_days.last_active, excluded.last_active);
  end if;

  if p_apps is not null and jsonb_typeof(p_apps) = 'array' then
    if jsonb_array_length(p_apps) > 40 then
      raise exception 'Send at most 40 apps';
    end if;
    for item in select value from jsonb_array_elements(p_apps)
    loop
      v_app := left(btrim(coalesce(item->>'name', '')), 80);
      app_seconds := least(greatest(coalesce((item->>'seconds')::integer, 0), 0), 28800);
      if v_app = '' or app_seconds <= 0 then
        continue;
      end if;
      insert into public.app_usage (asset_id, activity_date, app_name, active_seconds)
      values (v_asset, v_date, v_app, least(app_seconds, 86400))
      on conflict (asset_id, activity_date, app_name) do update
      set active_seconds = least(public.app_usage.active_seconds + excluded.active_seconds, 86400);
      added_apps := added_apps + 1;
    end loop;
  end if;

  if p_searches is not null and jsonb_typeof(p_searches) = 'array' then
    if jsonb_array_length(p_searches) > 80 then
      raise exception 'Send at most 80 searches';
    end if;
    for item in select value from jsonb_array_elements(p_searches)
    loop
      q := left(btrim(coalesce(item->>'query', '')), 300);
      v_engine := left(btrim(coalesce(item->>'engine', '')), 40);
      begin
        at_time := nullif(item->>'at', '')::timestamptz;
      exception when others then
        at_time := null;
      end;
      if q = '' or v_engine = '' or at_time is null then
        continue;
      end if;
      if at_time < now() - interval '14 days' or at_time > now() + interval '1 day' then
        continue;
      end if;
      insert into public.web_searches (asset_id, query, engine, searched_at)
      values (v_asset, q, v_engine, date_trunc('second', at_time))
      on conflict (asset_id, engine, searched_at, query) do nothing;
      get diagnostics inserted = row_count;
      added_searches := added_searches + inserted;
    end loop;
  end if;

  update public.agent_devices set last_seen = now() where id = dev_id;

  return jsonb_build_object(
    'active_seconds', v_seconds,
    'apps', added_apps,
    'searches', added_searches
  );
end;
$$;

revoke all on function public.agent_report_usage(text, text, integer, jsonb, jsonb) from public;
grant execute on function public.agent_report_usage(text, text, integer, jsonb, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
--  IT admin operations (also in supabase/it-admin.sql)
-- ---------------------------------------------------------------------

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
