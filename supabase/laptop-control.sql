-- =====================================================================
--  Laptop control tab. Run once in Supabase → SQL Editor, after schema.sql.
--  Safe to re-run. Stores decisions only: no keystrokes, screenshots, or file contents.
-- =====================================================================

create table if not exists public.laptop_controls (
  asset_id           uuid primary key references public.assets(id) on delete cascade,
  admin              text not null default 'standard' check (admin in ('standard','elevated','standing')),
  elevation_ends_at  timestamptz,
  admin_note         text,
  policy             text not null default 'baseline'
                     check (policy in ('baseline','finance','engineering','legal','executive','field')),
  hold               boolean not null default false,
  hold_reason        text,
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

-- Connection and printer mode. Safe if the tables were created by an earlier run.
alter table public.laptop_controls add column if not exists connection text not null default 'not_connected';
alter table public.laptop_controls drop constraint if exists laptop_controls_connection_check;
alter table public.laptop_controls add constraint laptop_controls_connection_check
  check (connection in ('not_connected','enrolled'));

alter table public.laptop_controls add column if not exists print_mode text not null default 'open';
alter table public.laptop_controls drop constraint if exists laptop_controls_print_mode_check;
alter table public.laptop_controls add constraint laptop_controls_print_mode_check
  check (print_mode in ('open','release','mono','stopped'));

-- A person asks for admin rights. The request does not grant them.
-- An admin on the allow-list approves a short window or denies it.
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

-- Copy activity: channel, file name, label, and what the agent did.
-- No file contents, keystrokes, or screen images.
create table if not exists public.copy_activity (
  id           bigint generated always as identity primary key,
  asset_id     uuid not null references public.assets(id) on delete cascade,
  channel      text not null check (channel in ('usb','clipboard','cloud','mail','print')),
  file_name    text not null,
  label        text,
  action       text not null check (action in ('blocked','warned','quarantined')),
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
