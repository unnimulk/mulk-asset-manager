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
