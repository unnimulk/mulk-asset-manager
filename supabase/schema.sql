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
