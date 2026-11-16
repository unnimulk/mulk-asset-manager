// Control for every company asset in the register.
// Computers, printers, and phones store a decision here. A visible enrollment
// on the device is what applies it. It records the public IP and the city
// and country of that IP. It does not record GPS, keystrokes, or screenshots.

import { store, loadAssets, ctx } from '../data.js';
import { esc, fmtDateTime, modal, toast } from '../ui.js';

const LOCAL_KEY = 'am.laptop-control.v1';

const HONEST = [
  'A plugged-in USB device is reported by its name',
  'Installed software, health, and search text are reported',
  'Files, the screen, and the keyboard are not collected',
];
const POLICIES = {
  baseline: { label: 'Baseline', rules: ['USB storage is blocked', ...HONEST] },
  finance: { label: 'Finance', rules: ['USB storage is blocked', ...HONEST] },
  engineering: { label: 'Engineering', rules: ['USB storage is read only', ...HONEST] },
  legal: { label: 'Legal', rules: ['USB storage is blocked', ...HONEST] },
  executive: { label: 'Executive', rules: ['USB storage is blocked', ...HONEST] },
  field: { label: 'Field', rules: ['USB storage is read only', ...HONEST] },
};

const PRINT_MODES = {
  open: 'Open',
  release: 'Hold for release',
  mono: 'Black and white only',
  stopped: 'Stopped',
};

const KINDS = {
  laptop: 'Laptop',
  desktop: 'Desktop',
  printer: 'Printer',
  mobile: 'Phone',
  other: 'Other',
};

const SETUP_SQL = `create table if not exists public.laptop_controls (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  admin text not null default 'standard' check (admin in ('standard','elevated','standing')),
  elevation_ends_at timestamptz,
  admin_note text,
  policy text not null default 'baseline' check (policy in ('baseline','finance','engineering','legal','executive','field')),
  hold boolean not null default false,
  hold_reason text,
  updated_at timestamptz not null default now(),
  updated_by text default public.current_email()
);
drop trigger if exists laptop_controls_touch on public.laptop_controls;
create trigger laptop_controls_touch before update on public.laptop_controls
for each row execute function public.touch_updated_at();
create table if not exists public.laptop_control_events (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets(id) on delete cascade,
  action text not null,
  detail text,
  performed_by text not null default public.current_email(),
  created_at timestamptz not null default now()
);
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
alter table public.laptop_controls add constraint laptop_controls_connection_check check (connection in ('not_connected','enrolled'));
alter table public.laptop_controls add column if not exists print_mode text not null default 'open';
alter table public.laptop_controls drop constraint if exists laptop_controls_print_mode_check;
alter table public.laptop_controls add constraint laptop_controls_print_mode_check check (print_mode in ('open','release','mono','stopped'));
create table if not exists public.admin_requests (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets(id) on delete cascade,
  requested_by text not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  window_choice text,
  decision_note text,
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint admin_requests_reason_len check (char_length(reason) between 8 and 500),
  constraint admin_requests_window_check check (window_choice is null or window_choice in ('1h','4h','close'))
);
create table if not exists public.copy_activity (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets(id) on delete cascade,
  channel text not null check (channel in ('usb','clipboard','cloud','mail','print')),
  file_name text not null,
  label text,
  action text not null check (action in ('blocked','warned','quarantined')),
  happened_at timestamptz not null default now(),
  reported_by text not null default public.current_email(),
  constraint copy_activity_name_len check (char_length(file_name) between 1 and 180),
  constraint copy_activity_label_len check (label is null or char_length(label) <= 80)
);
alter table public.admin_requests enable row level security;
alter table public.copy_activity enable row level security;
drop policy if exists admins_all on public.admin_requests;
create policy admins_all on public.admin_requests for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admins_all on public.copy_activity;
create policy admins_all on public.copy_activity for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.admin_requests, public.copy_activity from anon;
grant select, insert, update, delete on public.admin_requests, public.copy_activity to authenticated;
grant usage, select on sequence public.admin_requests_id_seq to authenticated;
grant usage, select on sequence public.copy_activity_id_seq to authenticated;`;

const BASE_COLS = 'asset_id,admin,elevation_ends_at,admin_note,policy,hold,hold_reason,updated_at,updated_by';
const WIDE_COLS = BASE_COLS + ',connection,print_mode';
const LOCK_COLS = WIDE_COLS + ',locked,lock_reason';

const CHANNELS = { usb: 'USB copy', clipboard: 'Clipboard', cloud: 'Personal cloud', mail: 'Outside email', print: 'Print' };
const COPY_ACTIONS = { blocked: 'Blocked', warned: 'Warned', quarantined: 'Quarantined' };

const ui = {
  q: '',
  kind: 'all',
  selected: null,
  showPopup: false,
  queueReady: true,
  requests: [],
  activity: [],
  agents: [],
  agentReady: true,
  softwareOpen: [],
  softwareReady: true,
  health: [],
  jobs: [],
  resets: [],
  opsReady: true,
  lockReady: true,
  source: 'db',
  wide: true,
  controls: new Map(),
  events: [],
  assets: [],
};

function kindOf(a) {
  const blob = [a.category, a.description, a.model, a.brand, a.tag].filter(Boolean).join(' ');
  if (/\/LAP\//i.test(a.tag || '') || /laptop|notebook|macbook|thinkpad|latitude|elitebook|probook|chromebook/i.test(blob)) return 'laptop';
  if (/desktop|workstation|\bimac\b|optiplex|thinkcentre|all-in-one/i.test(blob)) return 'desktop';
  if (/printer|plotter|\bmfp\b|multifunction/i.test(blob)) return 'printer';
  if (/phone|mobile|iphone|ipad|tablet/i.test(blob)) return 'mobile';
  return 'other';
}

function enrollable(kind) {
  return kind === 'laptop' || kind === 'desktop' || kind === 'printer' || kind === 'mobile';
}

function suggestPolicy(a) {
  const d = `${a.department || ''} ${a.location || ''}`.toLowerCase();
  if (/financ|account|treasury/.test(d)) return 'finance';
  if (/legal|counsel/.test(d)) return 'legal';
  if (/execut|director|board/.test(d)) return 'executive';
  if (/field|yard|site office/.test(d)) return 'field';
  if (/engineer|software|develop/.test(d)) return 'engineering';
  return 'baseline';
}

function liveAdmin(c) {
  if (!c || c.admin === 'standard') return 'standard';
  if (c.admin === 'standing') return 'standing';
  if (c.admin === 'elevated' && c.elevation_ends_at && new Date(c.elevation_ends_at).getTime() > Date.now()) return 'elevated';
  return 'standard';
}

function adminText(c) {
  const live = liveAdmin(c);
  if (live === 'standing') return 'Standing admin';
  if (live === 'elevated') return 'Temporary until ' + fmtDateTime(c.elevation_ends_at);
  return 'Standard user';
}

function adminClass(c) {
  const live = liveAdmin(c);
  if (live === 'standing') return 'st-broken';
  if (live === 'elevated') return 'st-checked_out';
  return 'st-available';
}

function untilGstClose() {
  const offset = 4 * 60 * 60000;
  const now = Date.now();
  const g = new Date(now + offset);
  let close = Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate(), 18, 0, 0) - offset;
  if (close <= now) close += 86400000;
  return new Date(close).toISOString();
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null') || { controls: {}, events: [] }; }
  catch { return { controls: {}, events: [] }; }
}

function missingTable(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return err?.status === 404 || m.includes('schema cache') || m.includes('does not exist') || m.includes('could not find the table') || (m.includes('relation') && m.includes('does not exist'));
}

function missingColumn(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return m.includes('connection') || m.includes('print_mode') || m.includes('locked') || m.includes('lock_reason');
}

function who() {
  return ctx.user?.email || 'admin';
}

function blank(asset) {
  return {
    asset_id: asset.id,
    admin: 'standard',
    elevation_ends_at: null,
    admin_note: null,
    policy: suggestPolicy(asset),
    hold: false,
    hold_reason: null,
    locked: false,
    lock_reason: null,
    connection: 'not_connected',
    print_mode: 'open',
    _saved: false,
  };
}

function current(asset) {
  return ui.controls.get(asset.id) || blank(asset);
}

function normalise(row) {
  return {
    ...row,
    hold: !!row.hold,
    locked: !!row.locked,
    connection: row.connection === 'enrolled' ? 'enrolled' : 'not_connected',
    print_mode: PRINT_MODES[row.print_mode] ? row.print_mode : 'open',
    policy: POLICIES[row.policy] ? row.policy : 'baseline',
    _saved: true,
  };
}

async function uploadLocalIfEmpty() {
  const local = readLocal();
  const pending = Object.values(local.controls || {});
  if (!pending.length || ui.controls.size) return;
  for (const row of pending) {
    await store.db.insert('laptop_controls', dbBody(row));
    ui.controls.set(row.asset_id, normalise({ ...row, ...dbBody(row) }));
  }
  for (const ev of [...(local.events || [])].reverse()) {
    await store.db.insert('laptop_control_events', { asset_id: ev.asset_id, action: ev.action || 'note', detail: ev.detail || '' });
  }
  localStorage.removeItem(LOCAL_KEY);
  ui.events = await store.db.select('laptop_control_events', { select: 'id,asset_id,action,detail,performed_by,created_at', order: 'created_at.desc', limit: '40' });
}

function dbBody(next) {
  const body = {
    asset_id: next.asset_id,
    admin: next.admin || 'standard',
    elevation_ends_at: next.elevation_ends_at || null,
    admin_note: next.admin_note || null,
    policy: POLICIES[next.policy] ? next.policy : 'baseline',
    hold: !!next.hold,
    hold_reason: next.hold_reason || null,
  };
  if (ui.lockReady) {
    body.locked = !!next.locked;
    body.lock_reason = next.lock_reason || null;
  }
  if (ui.wide) {
    body.connection = next.connection === 'enrolled' ? 'enrolled' : 'not_connected';
    body.print_mode = PRINT_MODES[next.print_mode] ? next.print_mode : 'open';
  }
  return body;
}

async function loadControls() {
  try {
    let rows;
    try {
      try {
        rows = await store.db.selectAll('laptop_controls', { select: LOCK_COLS });
        ui.wide = true;
        ui.lockReady = true;
      } catch (err) {
        ui.lockReady = false;
        if (!missingColumn(err)) throw err;
        try {
          rows = await store.db.selectAll('laptop_controls', { select: WIDE_COLS });
          ui.wide = true;
        } catch (err2) {
          if (!missingColumn(err2)) throw err2;
          ui.wide = false;
          rows = await store.db.selectAll('laptop_controls', { select: BASE_COLS });
        }
      }
    } catch (err) {
      if (!missingColumn(err)) throw err;
      ui.wide = false;
      ui.lockReady = false;
      rows = await store.db.selectAll('laptop_controls', { select: BASE_COLS });
    }
    const events = await store.db.select('laptop_control_events', { select: 'id,asset_id,action,detail,performed_by,created_at', order: 'created_at.desc', limit: '40' });
    ui.source = 'db';
    ui.controls = new Map(rows.map(r => [r.asset_id, normalise(r)]));
    ui.events = events;
    await uploadLocalIfEmpty();
  } catch (err) {
    if (!missingTable(err)) throw err;
    const local = readLocal();
    ui.source = 'local';
    ui.wide = true;
    ui.lockReady = true;
    ui.controls = new Map(Object.values(local.controls || {}).map(r => [r.asset_id, normalise(r)]));
    ui.events = local.events || [];
  }
}

async function persist(asset, next, action, detail) {
  const full = { ...blank(asset), ...next, asset_id: asset.id };
  const event = { asset_id: asset.id, action, detail, performed_by: who(), created_at: new Date().toISOString() };
  if (ui.source === 'db') {
    const write = async () => {
      const body = dbBody(full);
      delete body.asset_id;
      if (ui.controls.get(asset.id)?._saved) await store.db.update('laptop_controls', { asset_id: `eq.${asset.id}` }, body);
      else await store.db.insert('laptop_controls', { asset_id: asset.id, ...body });
    };
    try {
      await write();
    } catch (err) {
      const message = String(err?.message || '').toLowerCase();
      if (message.includes('locked') || message.includes('lock_reason')) {
        throw new Error('Lock is not stored yet. Run supabase/asset-lock.sql once in the Supabase SQL editor.');
      }
      if (!ui.wide || !missingColumn(err)) throw err;
      ui.wide = false;
      await write();
    }
    await store.db.insert('laptop_control_events', { asset_id: asset.id, action, detail });
    ui.controls.set(asset.id, normalise(full));
    ui.events = [{ ...event, id: 'new-' + Date.now() }, ...ui.events].slice(0, 40);
  } else {
    const local = readLocal();
    local.controls[asset.id] = full;
    local.events = [{ ...event, id: 'local-' + Date.now() }, ...(local.events || [])].slice(0, 200);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    ui.controls.set(asset.id, normalise(full));
    ui.events = local.events;
  }
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return ui.assets.filter(a => {
    if (ui.kind !== 'all' && kindOf(a) !== ui.kind) return false;
    if (!q) return true;
    return [a.tag, a.description, a.category, a.assigned_to, a.site, a.department, a.serial_no, a.model].join(' ').toLowerCase().includes(q);
  });
}

function controlSummary(asset, c) {
  if (c.locked) return 'Locked';
  const kind = kindOf(asset);
  if (kind === 'laptop' || kind === 'desktop') return adminText(c);
  if (kind === 'printer') return PRINT_MODES[c.print_mode] || 'Open';
  if (kind === 'mobile') return c.connection === 'enrolled' ? 'Company profile' : 'Not enrolled';
  return 'Register only';
}

function connectionText(asset, c) {
  if (!enrollable(kindOf(asset))) return 'In the register';
  return c.connection === 'enrolled' ? 'Enrolled' : 'Not enrolled';
}

async function loadAgents() {
  ui.agents = [];
  ui.agentReady = true;
  if (ui.source !== 'db') { ui.agentReady = false; return; }
  try {
    const wide = 'asset_id,hostname,windows_user,last_seen,created_at,public_ip,local_ip,country_code,country_name,city,outside_uae,location_at';
    try {
      ui.agents = await store.db.selectAll('agent_devices', { select: wide, order: 'last_seen.desc' });
    } catch (err) {
      if (missingTable(err) || /column/i.test(String(err?.message || ''))) {
        ui.agents = await store.db.selectAll('agent_devices', { select: 'asset_id,hostname,windows_user,last_seen,created_at', order: 'last_seen.desc' });
      } else throw err;
    }
  } catch (err) {
    if (!missingTable(err)) throw err;
    ui.agentReady = false;
  }
}

function agentFor(assetId) {
  return (ui.agents || []).find(a => a.asset_id === assetId) || null;
}

async function loadSoftwareAlerts() {
  ui.softwareOpen = [];
  ui.softwareReady = true;
  if (ui.source !== 'db') { ui.softwareReady = false; return; }
  try {
    ui.softwareOpen = await store.db.select('software_events', {
      select: 'id,asset_id,name,kind,happened_at',
      acknowledged_at: 'is.null',
      order: 'happened_at.desc',
      limit: '50',
    }) || [];
  } catch (err) {
    if (!missingTable(err)) throw err;
    ui.softwareReady = false;
  }
}

async function loadOps() {
  ui.health = [];
  ui.jobs = [];
  ui.resets = [];
  ui.opsReady = ui.source === 'db';
  if (ui.source !== 'db') return;
  try {
    const [health, jobs, resets] = await Promise.all([
      store.db.selectAll('device_health', { select: 'asset_id,manufacturer,model,serial_number,ram_gb,disk_gb,disk_free_gb,bitlocker,defender,firewall,defender_age_hours,pending_reboot,local_admins,startup_names,reported_at' }),
      store.db.select('install_jobs', { select: 'id,asset_id,name,status,detail,requested_at,finished_at', order: 'requested_at.desc', limit: '100' }),
      store.db.selectAll('local_admin_resets', { select: 'asset_id,password,requested_at,applied_at,result' }),
    ]);
    ui.health = health || [];
    ui.jobs = jobs || [];
    ui.resets = (resets || []).map(r => ({
      asset_id: r.asset_id,
      requested_at: r.requested_at,
      applied_at: r.applied_at,
      result: r.result,
      pending: Boolean(r.password),
    }));
  } catch (err) {
    if (!missingTable(err)) throw err;
    ui.opsReady = false;
  }
}

function pending() {
  return ui.requests.filter(r => r.status === 'pending');
}

function assetTag(id) {
  return ui.assets.find(a => a.id === id);
}

async function loadQueues() {
  if (ui.source !== 'db') {
    const local = readLocal();
    ui.requests = local.requests || [];
    ui.activity = local.activity || [];
    ui.queueReady = true;
    return;
  }
  try {
    const [requests, activity] = await Promise.all([
      store.db.select('admin_requests', { select: 'id,asset_id,requested_by,reason,status,window_choice,decision_note,created_at,decided_at', order: 'created_at.desc', limit: '40' }),
      store.db.select('copy_activity', { select: 'id,asset_id,channel,file_name,label,action,happened_at', order: 'happened_at.desc', limit: '40' }),
    ]);
    ui.requests = requests || [];
    ui.activity = activity || [];
    ui.queueReady = true;
  } catch (err) {
    if (!missingTable(err)) throw err;
    const local = readLocal();
    ui.requests = local.requests || [];
    ui.activity = local.activity || [];
    ui.queueReady = false;
  }
}

function writeLocalQueues() {
  const local = readLocal();
  local.requests = ui.requests;
  local.activity = ui.activity;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
}

async function createRequest(asset, requestedBy, reason) {
  if (ui.source === 'db' && ui.queueReady) {
    const saved = await store.db.insert('admin_requests', { asset_id: asset.id, requested_by: requestedBy, reason, status: 'pending' });
    ui.requests.unshift(saved[0]);
  } else {
    ui.requests.unshift({ id: 'local-' + Date.now(), asset_id: asset.id, requested_by: requestedBy, reason, status: 'pending', created_at: new Date().toISOString() });
    writeLocalQueues();
  }
  ui.showPopup = true;
}

async function decideRequest(req, status, extra) {
  const patch = { status, decided_at: new Date().toISOString(), window_choice: extra.window_choice || null, decision_note: extra.decision_note || null };
  if (ui.source === 'db' && ui.queueReady && !String(req.id).startsWith('local')) {
    const saved = await store.db.update('admin_requests', { id: `eq.${req.id}`, status: 'eq.pending' }, { ...patch, decided_by: who() });
    if (!saved?.length) throw new Error('That request was already decided.');
  }
  ui.requests = ui.requests.map(r => r.id === req.id ? { ...r, ...patch, decided_by: who() } : r);
  if (!(ui.source === 'db' && ui.queueReady)) writeLocalQueues();
}

async function recordCopy(asset, row) {
  const body = { asset_id: asset.id, channel: row.channel, file_name: row.file_name, label: row.label || null, action: row.action };
  if (ui.source === 'db' && ui.queueReady) {
    const saved = await store.db.insert('copy_activity', body);
    ui.activity.unshift(saved[0]);
  } else {
    ui.activity.unshift({ ...body, id: 'local-' + Date.now(), happened_at: new Date().toISOString(), reported_by: who() });
    writeLocalQueues();
  }
}

let pollTimer = 0;
let pollGen = 0;
function watchRequests(main) {
  clearInterval(pollTimer);
  const gen = ++pollGen;
  const seenSoftware = new Set(ui.softwareOpen.map(r => String(r.id)));
  let opsStamp = JSON.stringify([ui.jobs, ui.resets, ui.health]);
  pollTimer = setInterval(async () => {
    if (gen !== pollGen || !main.querySelector('#control-live') || document.querySelector('.modal-bg')) return;
    const seen = new Set(pending().map(r => String(r.id)));
    try { await loadQueues(); await loadAgents(); await loadSoftwareAlerts(); await loadOps(); } catch { return; }
    const newSoftware = ui.softwareOpen.filter(r => !seenSoftware.has(String(r.id)));
    newSoftware.forEach(r => seenSoftware.add(String(r.id)));
    const newRequest = pending().some(r => !seen.has(String(r.id)));
    const nextOps = JSON.stringify([ui.jobs, ui.resets, ui.health]);
    const opsChanged = nextOps !== opsStamp;
    opsStamp = nextOps;
    if (newSoftware.length) toast(newSoftware.length === 1 ? `New program: ${newSoftware[0].name}` : `${newSoftware.length} program changes reported`);
    if (newRequest || newSoftware.length || opsChanged) {
      if (newRequest) ui.showPopup = true;
      paint(main);
    }
  }, 15000);
}

export async function controlView(main) {
  main.innerHTML = `<div class="boot">Loading assets…</div>`;
  try {
    const assets = await loadAssets();
    ui.assets = assets.filter(a => a.status !== 'disposed').sort((a, b) => (a.tag || '').localeCompare(b.tag || ''));
    await loadControls();
    await loadQueues();
    await loadAgents();
    await loadSoftwareAlerts();
    await loadOps();
    if (pending().length) ui.showPopup = true;
  } catch (err) {
    main.innerHTML = `<div class="page-head"><div><h1>Control</h1></div></div><div class="err">${esc(err.message || String(err))}</div>`;
    return;
  }
  paint(main);
  watchRequests(main);
}

function paint(main) {
  const focusId = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  const rows = filtered();
  const counts = { computers: 0, printers: 0, hold: 0, locked: 0, waiting: 0 };
  for (const a of ui.assets) {
    const kind = kindOf(a);
    const c = current(a);
    if (kind === 'laptop' || kind === 'desktop') counts.computers += 1;
    if (kind === 'printer') counts.printers += 1;
    if (c.hold) counts.hold += 1;
    if (c.locked) counts.locked += 1;
    if (enrollable(kind) && c.connection !== 'enrolled') counts.waiting += 1;
  }
  const selected = ui.assets.find(a => a.id === ui.selected) || null;
  const kindOptions = Object.entries(KINDS).map(([k, label]) => `<option value="${k}" ${ui.kind === k ? 'selected' : ''}>${label}</option>`).join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 id="control-live">Control</h1>
        <p>${ui.assets.length} active asset${ui.assets.length === 1 ? '' : 's'} from the register. One list for laptops, desktops, printers, phones, and everything else.</p>
      </div>
      <div class="row">
        <a class="btn primary" href="/agent/install.ps1" download="MulkAgent-install.ps1">Download Mulk Agent</a>
        <button type="button" class="btn ${pending().length ? 'primary' : ''}" id="open-requests">Admin requests (${pending().length})</button>
      </div>
    </div>
    <div class="note" style="margin-bottom:16px">
      <strong>How a computer gets connected.</strong>
      Install <a href="/agent/">Mulk Agent</a> on the Windows laptop or desktop. It is a separate program, and Intune is not required. The person sees a window named Mulk Agent.
      A printer is connected when you add its queue on the company print server.
      A phone stays on the company management profile if you use one later.
      Monitors and other items stay under this register: who has them, where they are, and whether they are on hold.
      This page records the public IP and the city and country of that IP, and alerts when the country is outside the UAE, a USB device is plugged in, or health is off. It does not read files, capture the screen, record the keyboard, or use GPS. Mail, printing, and personal cloud contents are not inspected.
    </div>
    ${ui.source === 'local' ? `
      <div class="err" style="margin-bottom:16px">
        <strong>Shared storage is not set up yet.</strong> Decisions stay in this browser until you run <span class="mono">supabase/laptop-control.sql</span> once in the Supabase SQL editor.
        <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-copy-sql>Copy the SQL</button></div>
      </div>` : ''}
    ${ui.source === 'db' && !ui.queueReady ? `
      <div class="err" style="margin-bottom:16px">
        <strong>Admin requests are not shared yet.</strong> Run <span class="mono">supabase/laptop-control.sql</span> again so a request pops up for every admin, not only in this browser.
        <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-copy-sql>Copy the SQL</button></div>
      </div>` : ''}
    ${ui.source === 'db' && !ui.wide ? `
      <div class="err" style="margin-bottom:16px">
        <strong>Connection and printer settings are not stored for every admin yet.</strong> Run <span class="mono">supabase/laptop-control.sql</span> again so the new columns are added. Until then, those two fields stay in this browser.
        <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-copy-sql>Copy the SQL</button></div>
      </div>` : ''}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Assets</div><div class="k-val">${ui.assets.length}</div></div>
      <div class="card kpi"><div class="k-label">Computers</div><div class="k-val">${counts.computers}</div></div>
      <div class="card kpi"><div class="k-label">Printers</div><div class="k-val">${counts.printers}</div></div>
      <div class="card kpi"><div class="k-label">Not enrolled</div><div class="k-val">${counts.waiting}</div></div>
      <div class="card kpi"><div class="k-label">On hold</div><div class="k-val">${counts.hold}</div></div>
      <div class="card kpi"><div class="k-label">Locked</div><div class="k-val">${counts.locked}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="filters">
        <input id="cq" class="search" placeholder="Search tag, person, serial, site" value="${esc(ui.q)}" />
        <select id="f-kind">
          <option value="all" ${ui.kind === 'all' ? 'selected' : ''}>All kinds</option>
          ${kindOptions}
        </select>
      </div>
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>Tag</th><th>Asset</th><th>Kind</th><th>Person</th><th>Site</th><th>Control</th><th>Connection</th><th>Hold</th>
      </tr></thead><tbody>
        ${rows.map(a => {
          const c = current(a);
          const enrolled = !enrollable(kindOf(a)) || c.connection === 'enrolled';
          return `<tr class="clickable${a.id === ui.selected ? ' on' : ''}" data-id="${esc(a.id)}">
            <td><span class="tag">${esc(a.tag)}</span></td>
            <td class="desc">${esc(a.description || a.model || a.category || '')}</td>
            <td>${esc(KINDS[kindOf(a)])}</td>
            <td>${esc(a.assigned_to || '—')}</td>
            <td>${esc(a.site || '—')}</td>
            <td>${esc(controlSummary(a, c))}</td>
            <td>${enrolled ? esc(connectionText(a, c)) : `<span class="badge st-under_repair">${esc(connectionText(a, c))}</span>`}</td>
            <td>${[c.locked ? '<span class="badge st-broken">Locked</span>' : '', c.hold ? '<span class="badge st-broken">On hold</span>' : ''].filter(Boolean).join(' ') || '<span class="muted">No</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : `<div class="empty">${ui.assets.length ? 'No assets match these filters.' : 'No active assets in the register yet.'}</div>`}
    </div>
    ${selected ? detail(selected) : '<div class="note">Select an asset to see how it connects and to set its control.</div>'}
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Decisions</h2><span class="muted">${ui.source === 'db' ? 'Shared with every admin' : 'This browser only'}</span></div>
      ${ui.events.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Decision</th><th>By</th></tr></thead><tbody>
        ${ui.events.slice(0, 20).map(e => {
          const a = ui.assets.find(x => x.id === e.asset_id);
          return `<tr>
            <td>${fmtDateTime(e.created_at)}</td>
            <td>${a ? `<span class="tag">${esc(a.tag)}</span>` : '<span class="muted">Removed asset</span>'}</td>
            <td>${esc(e.detail || e.action)}</td>
            <td class="sub">${esc(e.performed_by || '')}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : '<div class="empty">No control decisions yet.</div>'}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Copy activity</h2><a href="#/alerts">Open alerts</a></div>
      ${ui.activity.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Channel</th><th>What</th><th>Result</th></tr></thead><tbody>
        ${ui.activity.slice(0, 20).map(e => {
          const a = assetTag(e.asset_id);
          return `<tr>
            <td>${fmtDateTime(e.happened_at)}</td>
            <td>${a ? `<span class="tag">${esc(a.tag)}</span>` : '<span class="muted">Removed asset</span>'}</td>
            <td>${esc(CHANNELS[e.channel] || e.channel)}</td>
            <td>${esc(e.file_name)}${e.label ? `<div class="sub">${esc(e.label)}</div>` : ''}</td>
            <td><span class="badge ${e.action === 'blocked' || e.action === 'quarantined' ? 'st-broken' : 'st-under_repair'}">${esc(COPY_ACTIONS[e.action] || e.action)}</span></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : '<div class="empty">No USB reports yet. A device plugged in after the first scan is listed by its name. Files on the drive are not listed, and the screen and keyboard are not collected.</div>'}
    </div>
    ${ui.showPopup ? requestPopup() : ''}`;

  const qEl = document.getElementById('cq');
  let timer;
  qEl.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ui.q = qEl.value; paint(main); }, 160);
  };
  document.getElementById('f-kind').onchange = (e) => { ui.kind = e.target.value; paint(main); };
  main.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = () => { ui.selected = tr.dataset.id; paint(main); };
  });
  main.querySelectorAll('[data-copy-sql]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SETUP_SQL);
      toast('SQL copied. Paste it in the Supabase SQL editor and run it.');
    } catch {
      toast('Could not copy. Open supabase/laptop-control.sql in the project.', true);
    }
  }));
  document.getElementById('open-requests').onclick = () => { ui.showPopup = true; paint(main); };
  document.getElementById('close-requests')?.addEventListener('click', () => { ui.showPopup = false; paint(main); });
  document.getElementById('request-pop')?.addEventListener('mousedown', (e) => {
    if (e.target.id === 'request-pop') { ui.showPopup = false; paint(main); }
  });
  main.querySelectorAll('[data-approve]').forEach(btn => {
    btn.onclick = () => approveRequest(main, btn.dataset.approve, btn.dataset.window);
  });
  main.querySelectorAll('[data-deny]').forEach(btn => {
    btn.onclick = () => denyRequest(main, btn.dataset.deny);
  });
  if (selected) bindDetail(main, selected);
  if (focusId === 'cq' || focusId === 'f-kind') {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (focusId === 'cq' && caret != null) el.setSelectionRange(caret, caret);
    }
  }
}

function networkNote(asset) {
  const agent = agentFor(asset.id);
  if (!agent || (!agent.public_ip && !agent.city && !agent.country_code)) {
    return '<p class="muted" style="margin:0">No public IP yet. Mulk Agent sends it on its regular check, about every five minutes after the script is updated.</p>';
  }
  const place = [agent.city, agent.country_name || agent.country_code].filter(Boolean).join(', ');
  const away = !agent.country_code
    ? '<span class="badge st-under_repair">Country unknown</span>'
    : agent.outside_uae
      ? '<span class="badge st-broken">Outside UAE</span>'
      : '<span class="badge st-available">Inside UAE</span>';
  return `<p style="margin:0 0 8px">${away} ${esc(place || '')}</p>
    <p class="muted" style="margin:0">Public IP <span class="mono">${esc(agent.public_ip || '')}</span>${agent.local_ip ? ` · local <span class="mono">${esc(agent.local_ip)}</span>` : ''}${agent.location_at ? ` · ${esc(fmtDateTime(agent.location_at))}` : ''}</p>
    <a class="btn sm" href="#/alerts" style="margin-top:10px">Open alerts</a>`;
}

function healthFor(assetId) {
  return (ui.health || []).find(h => h.asset_id === assetId) || null;
}

function healthNote(asset) {
  if (!ui.opsReady) {
    return '<p class="muted" style="margin:0">Run <span class="mono">supabase/it-admin.sql</span> once so health, a one-time local Administrator password, and remote installs can be stored.</p>';
  }
  const h = healthFor(asset.id);
  if (!h) return '<p class="muted" style="margin:0">No health report yet. It arrives on the next Mulk Agent check after that computer updates its script.</p>';
  const flag = (label, value) => {
    const cls = value === 'off' ? 'st-broken' : value === 'on' ? 'st-available' : 'st-under_repair';
    return `<span class="badge ${cls}">${esc(label)} ${value === 'on' ? 'on' : value === 'off' ? 'off' : 'unknown'}</span>`;
  };
  const disk = h.disk_free_gb != null ? `${h.disk_free_gb} GB free${h.disk_gb != null ? ` of ${h.disk_gb} GB` : ''}` : 'Disk size not reported';
  return `<p style="margin:0 0 8px">${flag('BitLocker', h.bitlocker)} ${flag('Defender', h.defender)} ${flag('Firewall', h.firewall)}${h.pending_reboot ? ' <span class="badge st-under_repair">Restart waiting</span>' : ''}</p>
    <p class="muted" style="margin:0">${esc([h.manufacturer, h.model].filter(Boolean).join(' '))}${h.serial_number ? ' · serial ' + esc(h.serial_number) : ''}${h.ram_gb != null ? ' · ' + esc(String(h.ram_gb)) + ' GB RAM' : ''}</p>
    <p class="muted" style="margin:6px 0 0">${esc(disk)}${h.defender_age_hours != null ? ' · signatures ' + esc(String(h.defender_age_hours)) + ' hours old' : ''} · ${esc(fmtDateTime(h.reported_at) || '')}</p>
    <p class="muted" style="margin:6px 0 0">Local administrators: ${esc(h.local_admins || 'not reported')}</p>
    <p class="muted" style="margin:6px 0 0">Startup names: ${esc(h.startup_names || 'none reported')}</p>`;
}

function passwordNote(asset) {
  const row = (ui.resets || []).find(r => r.asset_id === asset.id);
  if (!row) return '<p class="muted" style="margin:8px 0 0">No password is stored. A change is kept only until this computer applies it, then it is deleted.</p>';
  if (row.pending) return '<p class="muted" style="margin:8px 0 0">A password is waiting for the next check. It is not shown here again, and it is deleted after the computer applies it.</p>';
  return `<p class="muted" style="margin:8px 0 0">Last result ${esc(fmtDateTime(row.applied_at) || '')}${row.result ? ': ' + esc(row.result) : ''}. The password is no longer stored.</p>`;
}

function jobsNote(asset) {
  const rows = (ui.jobs || []).filter(j => j.asset_id === asset.id).slice(0, 5);
  if (!rows.length) return '<p class="muted" style="margin:8px 0 0">No installs queued. The agent accepts an HTTPS link that ends in .msi or .exe, then deletes the file.</p>';
  return `<ul class="muted" style="margin:8px 0 0;padding-left:18px">${rows.map(j => `<li>${esc(j.name)} · ${esc(j.status)}${j.detail ? ' · ' + esc(j.detail) : ''}</li>`).join('')}</ul>`;
}

function softwareNote(asset) {
  if (!ui.softwareReady) {
    return '<p class="muted" style="margin:0">Run <span class="mono">supabase/asset-admin.sql</span> once so this computer can report its installed programs.</p>';
  }
  const open = ui.softwareOpen.filter(r => r.asset_id === asset.id);
  const names = open.slice(0, 3).map(r => esc(r.name)).join(', ');
  return `<p class="muted" style="margin:0 0 10px">${open.length
    ? `${open.length} program change${open.length === 1 ? '' : 's'} waiting: ${names}${open.length > 3 ? '…' : ''}.`
    : 'No new programs waiting. The first scan is the baseline. A program installed after that is reported on Alerts.'}</p>
    <a class="btn sm" href="#/alerts?asset=${esc(asset.id)}">Review software</a>`;
}

function steps(kind) {
  if (kind === 'laptop' || kind === 'desktop') {
    return [
      'Match the serial number on the computer to this asset tag.',
      'The person signs in with their company account.',
      'In Control, create a Mulk Agent code for this computer. On the computer, run the install command from the Mulk Agent page as Administrator and enter that code. The Mulk Agent window stays visible.',
      'When the code is accepted, this computer shows as enrolled and Mulk Agent starts applying the rules. Until then, buttons here only save the decision.',
    ];
  }
  if (kind === 'printer') {
    return [
      'Confirm the site and location on this asset match the printer on the floor.',
      'Give the printer a fixed address on the office network.',
      'Add that queue on the company print server and set it to the mode you choose below.',
      'Choose Mark enrolled once the queue exists. Until then this page only stores the mode.',
    ];
  }
  if (kind === 'mobile') {
    return [
      'Match the serial number to this asset tag.',
      'The person installs the company management profile, through Intune Company Portal or Apple Business Manager. They can see the profile.',
      'Choose Mark enrolled after that profile is on the device. This page does not track where the phone is.',
    ];
  }
  return [
    'This asset is controlled from the register. Check it out to a person, and place it on hold when it should not be used.',
    'There is no remote agent for this kind of asset.',
  ];
}

function detail(a) {
  const c = current(a);
  const kind = kindOf(a);
  const policy = POLICIES[c.policy] || POLICIES.baseline;
  const options = Object.entries(POLICIES).map(([k, v]) => `<option value="${k}" ${c.policy === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  const printOptions = Object.entries(PRINT_MODES).map(([k, label]) => `<option value="${k}" ${c.print_mode === k ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const computer = kind === 'laptop' || kind === 'desktop';
  return `<div class="card">
    <div class="card-h">
      <h2><span class="tag">${esc(a.tag)}</span> ${esc(a.description || a.model || KINDS[kind])}</h2>
      <a href="#/asset/${esc(a.id)}">Open asset</a>
    </div>
    <div class="card-b stack">
      <div class="muted">${esc(KINDS[kind])}${a.assigned_to ? ' · ' + esc(a.assigned_to) : ''}${a.department ? ' · ' + esc(a.department) : ''}${a.site ? ' · ' + esc(a.site) : ''}${a.serial_no ? ' · ' + esc(a.serial_no) : ''}</div>
      <div>
        <h2 style="margin-bottom:8px">Connect this ${esc(KINDS[kind].toLowerCase())}</h2>
        <ol class="muted" style="margin:0; padding-left:18px">
          ${steps(kind).map(s => `<li>${esc(s)}</li>`).join('')}
        </ol>
        ${enrollable(kind) ? `<div class="row" style="margin-top:10px">
          <span class="badge ${c.connection === 'enrolled' ? 'st-available' : 'st-under_repair'}">${esc(connectionText(a, c))}</span>
          <button type="button" class="btn sm" data-act="enrolled">Mark enrolled</button>
          <button type="button" class="btn sm" data-act="not-enrolled">Mark not enrolled</button>
        </div>` : ''}
      </div>
      ${computer ? `<div>
        <h2 style="margin-bottom:8px">Mulk Agent</h2>
        <p class="muted" style="margin:0 0 10px">${agentFor(a.id)
          ? `Installed on ${esc(agentFor(a.id).hostname || 'this computer')} for ${esc(agentFor(a.id).windows_user || 'its Windows account')}. Last seen ${esc(fmtDateTime(agentFor(a.id).last_seen) || 'not yet')}.${agentFor(a.id).last_seen && (Date.now() - new Date(agentFor(a.id).last_seen).getTime() > 24 * 3600 * 1000) ? ' Not seen for more than a day.' : ''}`
          : 'Not installed yet. Download a setup file for this computer, or create a code and run the installer as Administrator.'}</p>
        <div class="row">
          <button type="button" class="btn sm primary" data-act="download-setup">Download setup for this computer</button>
          <button type="button" class="btn sm" data-act="agent-code">Create Mulk Agent code</button>
          <a class="btn sm" href="/agent/" target="_blank" rel="noopener">Install steps</a>
        </div>
      </div>
      <div>
        <h2 style="margin-bottom:8px">Health</h2>
        ${healthNote(a)}
      </div>
      <div>
        <h2 style="margin-bottom:8px">Local Administrator password</h2>
        <p class="muted" style="margin:0">Sets the built-in Administrator password on this computer once. The account is not enabled by this change. The password is deleted from the database after it is applied, and it is not written to the agent log.</p>
        ${passwordNote(a)}
        <div class="row" style="margin-top:10px">
          <button type="button" class="btn sm" data-act="local-password" ${ui.opsReady ? '' : 'disabled'}>Change local admin password</button>
        </div>
      </div>
      <div>
        <h2 style="margin-bottom:8px">Remote install</h2>
        <p class="muted" style="margin:0">Queue an HTTPS installer that ends in .msi or .exe. Mulk Agent downloads it, runs it, and deletes the file. This is not a remote command prompt.</p>
        ${jobsNote(a)}
        <div class="row" style="margin-top:10px">
          <button type="button" class="btn sm" data-act="install" ${ui.opsReady ? '' : 'disabled'}>Install software</button>
        </div>
      </div>
      <div>
        <h2 style="margin-bottom:8px">Installed software</h2>
        ${softwareNote(a)}
      </div>
      <div>
        <h2 style="margin-bottom:8px">Network location</h2>
        ${networkNote(a)}
      </div>
      <div>
        <h2 style="margin-bottom:8px">Admin rights</h2>
        <p class="muted" style="margin:0 0 10px">Standard user is the default. A timed window ends on its own. Standing admin needs a written reason and stays until you revoke it. A hold does not wipe the computer.</p>
        <div class="row">
          <span class="badge ${adminClass(c)}">${esc(adminText(c))}</span>
          ${c.admin_note ? `<span class="muted">${esc(c.admin_note)}</span>` : ''}
        </div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="btn sm" data-act="standard">Standard user</button>
          <button type="button" class="btn sm" data-act="1h">Grant 1 hour</button>
          <button type="button" class="btn sm" data-act="4h">Grant 4 hours</button>
          <button type="button" class="btn sm" data-act="close">Until 18:00 GST</button>
          <button type="button" class="btn sm" data-act="standing">Standing admin</button>
          <button type="button" class="btn sm primary" data-act="request">User is requesting admin</button>
        </div>
        <p class="muted" style="margin:10px 0 0">A request opens a popup on this dashboard. Approving it grants a short window. The request alone does not.</p>
        <div class="row" style="margin-top:10px">
          <button type="button" class="btn sm" data-act="copy">Record a copy event</button>
        </div>
      </div>
      <div>
        <h2 style="margin-bottom:8px">Data leaving the computer</h2>
        <label class="f" style="max-width:280px">Rule set
          <select id="policy">${options}</select>
        </label>
        <ul class="muted" style="margin:10px 0 0; padding-left:18px">
          ${policy.rules.map(r => `<li>${esc(r)}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${kind === 'printer' ? `<div>
        <h2 style="margin-bottom:8px">Print queue</h2>
        <label class="f" style="max-width:280px">Mode the print server should apply
          <select id="print-mode">${printOptions}</select>
        </label>
        <p class="muted" style="margin:10px 0 0">Open accepts jobs. Hold for release keeps a job until someone collects it at the printer. Black and white only rejects color. Stopped accepts nothing.</p>
      </div>` : ''}
      <div>
        <h2 style="margin-bottom:8px">Lock</h2>
        ${c.locked
          ? `<p style="margin:0 0 10px">Locked${c.lock_reason ? ': ' + esc(c.lock_reason) : ''}. ${computer ? 'Nobody can sign in to this computer until you unlock it. Wi-Fi and Ethernet stay on so it keeps reaching this dashboard.' : 'This asset should not be used until you unlock it.'} A lock does not wipe the computer.</p><button type="button" class="btn sm" data-act="unlock">Unlock asset</button>`
          : `<p class="muted" style="margin:0 0 10px">A lock stops company use until you unlock it. On a Windows laptop or desktop, nobody can sign in again until you choose Unlock. Wi-Fi and Ethernet are kept on, so turning them off does not drop the dashboard connection. It does not read files, capture the screen, or record the keyboard. A lock does not wipe the computer.</p><button type="button" class="btn sm danger" data-act="lock">Lock asset</button>`}
      </div>
      <div>
        <h2 style="margin-bottom:8px">Hold</h2>
        ${c.hold
          ? `<p style="margin:0 0 10px">On hold${c.hold_reason ? ': ' + esc(c.hold_reason) : ''}. The person should see this reason.</p><button type="button" class="btn sm" data-act="release">Release hold</button>`
          : '<p class="muted" style="margin:0 0 10px">A hold means this asset should not be used until you release it. Write the reason the person will see. A hold does not wipe a computer.</p><button type="button" class="btn sm" data-act="hold">Place on hold</button>'}
      </div>
    </div>
  </div>`;
}

function bindDetail(main, asset) {
  document.getElementById('policy')?.addEventListener('change', async (e) => {
    const policy = e.target.value;
    try {
      await save(main, asset, { ...current(asset), policy }, 'policy', `Data rules set to ${POLICIES[policy].label}`);
    } catch (err) { toast(err.message || String(err), true); }
  });
  document.getElementById('print-mode')?.addEventListener('change', async (e) => {
    const print_mode = e.target.value;
    try {
      await save(main, asset, { ...current(asset), print_mode }, 'printer', `Print queue set to ${PRINT_MODES[print_mode]}`);
    } catch (err) { toast(err.message || String(err), true); }
  });
  main.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => act(main, asset, btn.dataset.act);
  });
}

async function act(main, asset, kind) {
  const c = current(asset);
  const noun = KINDS[kindOf(asset)].toLowerCase();
  try {
    if (kind === 'enrolled') {
      await save(main, asset, { ...c, connection: 'enrolled' }, 'connection', `${KINDS[kindOf(asset)]} marked enrolled`);
    } else if (kind === 'not-enrolled') {
      await save(main, asset, { ...c, connection: 'not_connected' }, 'connection', `${KINDS[kindOf(asset)]} marked not enrolled`);
    } else if (kind === 'standard') {
      await save(main, asset, { ...c, admin: 'standard', elevation_ends_at: null, admin_note: null }, 'admin', 'Admin rights set to standard user');
    } else if (kind === '1h' || kind === '4h') {
      const hours = kind === '1h' ? 1 : 4;
      const ends = new Date(Date.now() + hours * 3600000).toISOString();
      await save(main, asset, { ...c, admin: 'elevated', elevation_ends_at: ends, admin_note: null }, 'admin', `Temporary admin for ${hours} hour${hours === 1 ? '' : 's'}, until ${fmtDateTime(ends)}`);
    } else if (kind === 'close') {
      const ends = untilGstClose();
      await save(main, asset, { ...c, admin: 'elevated', elevation_ends_at: ends, admin_note: null }, 'admin', `Temporary admin until 18:00 GST (${fmtDateTime(ends)})`);
    } else if (kind === 'standing') {
      let reason = '';
      const ok = await modal({
        title: 'Standing admin',
        submit: 'Grant',
        body: `<label class="f">Reason the person and the next admin can read<textarea name="reason" required placeholder="Why this computer needs admin rights that do not expire"></textarea></label>`,
        onSubmit(form) {
          reason = form.reason.value.trim();
          if (reason.length < 8) throw new Error('Write a reason of at least a few words.');
        },
      });
      if (!ok) return;
      await save(main, asset, { ...current(asset), admin: 'standing', elevation_ends_at: null, admin_note: reason }, 'admin', `Standing admin: ${reason}`);
    } else if (kind === 'hold') {
      let reason = '';
      const ok = await modal({
        title: 'Place on hold',
        submit: 'Hold asset',
        danger: true,
        body: `<p style="margin:0">The person should be able to read this reason. A hold does not wipe a computer.</p>
          <label class="f">Reason<textarea name="reason" required placeholder="Why company use of this ${esc(noun)} is paused"></textarea></label>`,
        onSubmit(form) {
          reason = form.reason.value.trim();
          if (reason.length < 8) throw new Error('Write a reason of at least a few words.');
        },
      });
      if (!ok) return;
      await save(main, asset, { ...current(asset), hold: true, hold_reason: reason }, 'hold', `Placed on hold: ${reason}`);
    } else if (kind === 'release') {
      await save(main, asset, { ...c, hold: false, hold_reason: null }, 'hold', 'Hold released');
    } else if (kind === 'lock') {
      let reason = '';
      const ok = await modal({
        title: 'Lock asset',
        submit: 'Lock',
        danger: true,
        body: `<p style="margin:0">The person should be able to read this reason. On a Windows computer, sign-in is blocked until you unlock it. Wi-Fi and Ethernet stay connected so the unlock can reach the computer. A lock does not wipe the computer.</p>
          <label class="f">Reason<textarea name="reason" required placeholder="Why this ${esc(noun)} is locked"></textarea></label>`,
        onSubmit(form) {
          reason = form.reason.value.trim();
          if (reason.length < 8 || reason.length > 300) throw new Error('Write a reason between a sentence and a short paragraph.');
        },
      });
      if (!ok) return;
      await save(main, asset, { ...current(asset), locked: true, lock_reason: reason }, 'lock', `Locked: ${reason}`);
    } else if (kind === 'unlock') {
      await save(main, asset, { ...c, locked: false, lock_reason: null }, 'lock', 'Lock released');
    } else if (kind === 'agent-code') {
      await askForAgentCode(asset);
    } else if (kind === 'download-setup') {
      await downloadSetup(asset);
    } else if (kind === 'local-password') {
      await askLocalPassword(main, asset);
    } else if (kind === 'install') {
      await askInstall(main, asset);
    } else if (kind === 'request') {
      await askForAdmin(main, asset);
    } else if (kind === 'copy') {
      await askForCopy(main, asset);
    }
  } catch (err) {
    toast(err.message || String(err), true);
  }
}

function requestPopup() {
  const rows = pending();
  return `<div class="modal-bg" id="request-pop">
    <div class="pop-card">
      <div class="card-h"><h2>Admin request${rows.length === 1 ? '' : 's'}</h2><button type="button" class="btn ghost icon-btn" id="close-requests" aria-label="Close">✕</button></div>
      <div class="card-b">
        ${rows.length ? rows.map(r => {
          const a = assetTag(r.asset_id);
          return `<div class="req">
            <div><strong>${esc(r.requested_by)}</strong> · ${a ? `<span class="tag">${esc(a.tag)}</span> ${esc(a.description || '')}` : 'Asset not in the active list'}</div>
            <p style="margin:6px 0">${esc(r.reason)}</p>
            <div class="sub">${fmtDateTime(r.created_at)}</div>
            <div class="row" style="margin-top:8px">
              <button type="button" class="btn sm primary" data-approve="${esc(r.id)}" data-window="1h">Approve 1 hour</button>
              <button type="button" class="btn sm primary" data-approve="${esc(r.id)}" data-window="4h">Approve 4 hours</button>
              <button type="button" class="btn sm primary" data-approve="${esc(r.id)}" data-window="close">Until 18:00 GST</button>
              <button type="button" class="btn sm danger" data-deny="${esc(r.id)}">Deny</button>
            </div>
          </div>`;
        }).join('') : '<p class="muted" style="margin:0">No one is waiting. A request appears here when someone asks for admin rights on a company computer.</p>'}
      </div>
    </div>
  </div>`;
}

async function approveRequest(main, id, windowChoice) {
  const req = ui.requests.find(r => String(r.id) === String(id) && r.status === 'pending');
  if (!req) return;
  const asset = assetTag(req.asset_id);
  if (!asset) { toast('That asset is not in the active register.', true); return; }
  try {
    const c = current(asset);
    const hours = windowChoice === '1h' ? 1 : windowChoice === '4h' ? 4 : 0;
    const ends = hours ? new Date(Date.now() + hours * 3600000).toISOString() : untilGstClose();
    const detail = hours
      ? `Approved ${req.requested_by} for ${hours} hour${hours === 1 ? '' : 's'}, until ${fmtDateTime(ends)}`
      : `Approved ${req.requested_by} until 18:00 GST (${fmtDateTime(ends)})`;
    await persist(asset, { ...c, admin: 'elevated', elevation_ends_at: ends, admin_note: null }, 'admin', detail);
    await decideRequest(req, 'approved', { window_choice: windowChoice });
    if (!pending().length) ui.showPopup = false;
    toast('Temporary admin granted');
    paint(main);
  } catch (err) { toast(err.message || String(err), true); }
}

async function denyRequest(main, id) {
  const req = ui.requests.find(r => String(r.id) === String(id) && r.status === 'pending');
  if (!req) return;
  let reason = '';
  const ok = await modal({
    title: 'Deny admin request',
    submit: 'Deny',
    danger: true,
    body: `<p style="margin:0">${esc(req.requested_by)} stays a standard user.</p>
      <label class="f">Reason they can be told<textarea name="reason" required placeholder="Why this request is refused"></textarea></label>`,
    onSubmit(form) {
      reason = form.reason.value.trim();
      if (reason.length < 8) throw new Error('Write a reason of at least a few words.');
    },
  });
  if (!ok) return;
  try {
    await decideRequest(req, 'denied', { decision_note: reason });
    if (!pending().length) ui.showPopup = false;
    toast('Request denied');
    paint(main);
  } catch (err) { toast(err.message || String(err), true); }
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function downloadSetup(asset) {
  const code = await store.db.rpc('agent_create_code', { p_asset_id: asset.id });
  const text = String(code || '').replace(/^"|"$/g, '');
  const safeTag = String(asset.tag || 'computer').replace(/[^\w.-]+/g, '_');
  const body = `# Mulk Agent setup for ${asset.tag}
# Run this file from an Administrator PowerShell. The code works once and expires in 24 hours.
$dest = Join-Path $env:TEMP 'MulkAgent-install.ps1'
Invoke-WebRequest 'https://mulk-asset-manager.vercel.app/agent/install.ps1' -OutFile $dest -UseBasicParsing
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dest -Code '${text.replace(/'/g, '')}'
`;
  downloadText(`MulkAgent-${safeTag}.ps1`, body);
  toast('Setup file downloaded. Run it as Administrator on that computer.');
}

async function askLocalPassword(main, asset) {
  let password = '';
  const ok = await modal({
    title: 'Local Administrator password',
    submit: 'Send once',
    body: `<p style="margin:0">This sets the built-in Administrator password on <b class="mono">${esc(asset.tag)}</b>. The computer applies it on the next check, then the password is deleted from the database. It is not written to the agent log, and this does not enable the account.</p>
      <label class="f">New password<input name="password" type="password" required autocomplete="new-password"></label>
      <label class="f">Confirm<input name="confirm" type="password" required autocomplete="new-password"></label>`,
    onSubmit(form) {
      password = form.password.value;
      if (password !== form.confirm.value) throw new Error('The two passwords do not match.');
      if (password.length < 12 || password.length > 64) throw new Error('Use 12 to 64 characters.');
      if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        throw new Error('Include an upper-case letter, a lower-case letter, and a digit.');
      }
    },
  });
  if (!ok) return;
  try {
    await store.db.rpc('admin_set_local_password', { p_asset_id: asset.id, p_password: password });
    toast('Password will be applied once, then removed from the database');
    await loadOps();
    paint(main);
  } finally {
    password = '';
  }
}

async function askInstall(main, asset) {
  let name = '';
  let url = '';
  let args = '';
  const ok = await modal({
    title: 'Install software',
    submit: 'Queue install',
    body: `<p style="margin:0">Mulk Agent downloads this HTTPS installer on <b class="mono">${esc(asset.tag)}</b> and runs it. Only a link ending in .msi or .exe is accepted. The file is deleted afterwards.</p>
      <label class="f">Name<input name="name" required placeholder="Google Chrome"></label>
      <label class="f">Installer link<input name="url" required placeholder="https://example.com/setup.msi"></label>
      <label class="f">Silent arguments, optional<input name="args" placeholder="/S"></label>
      <p class="muted" style="margin:8px 0 0">An MSI already runs with /qn /norestart. For an EXE, type the vendor silent switch, such as /S or /quiet. Do not paste a script.</p>`,
    onSubmit(form) {
      name = form.name.value.trim();
      url = form.url.value.trim();
      args = form.args.value.trim();
      if (name.length < 1 || name.length > 80) throw new Error('Name the software in 80 characters or fewer.');
      if (!/^https:\/\//i.test(url)) throw new Error('The installer link must start with https://');
      const path = url.split('?')[0].split('#')[0];
      if (!/\.(msi|exe)$/i.test(path)) throw new Error('The link must end in .msi or .exe');
      if (/[;&|`$<>]/.test(args)) throw new Error('Silent arguments cannot contain shell characters.');
    },
  });
  if (!ok) return;
  await store.db.rpc('admin_queue_install', {
    p_asset_id: asset.id,
    p_name: name,
    p_url: url,
    p_silent_args: args || null,
  });
  toast('Install queued. The computer picks it up on the next check.');
  await loadOps();
  paint(main);
}

async function askForAgentCode(asset) {
  const code = await store.db.rpc('agent_create_code', { p_asset_id: asset.id });
  const text = String(code || '').replace(/^"|"$/g, '');
  const command = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://mulk-asset-manager.vercel.app/agent/install.ps1 | iex"';
  await modal({
    title: 'Mulk Agent code',
    submit: 'Copy code and command',
    cancel: 'Close',
    body: `<p style="margin:0">On that Windows computer, open PowerShell as Administrator, run the command, and type this code. It works once and expires in 24 hours.</p>
      <p class="mono" style="font-size:28px;letter-spacing:.18em;margin:12px 0">${esc(text)}</p>
      <p class="mono" style="margin:0">${esc(command)}</p>
      <p class="muted" style="margin:8px 0 0">The installer page is <a href="/agent/" target="_blank" rel="noopener">/agent/</a>. If creating a code fails, run supabase/agent.sql in the Supabase SQL editor. Run supabase/laptop-control.sql first if you have not.</p>`,
    async onSubmit() { await navigator.clipboard.writeText(text + '\n' + command); },
  });
  toast('Install code created');
}

async function askForAdmin(main, asset) {
  let person = asset.assigned_to || '';
  let reason = '';
  const ok = await modal({
    title: 'Admin request',
    submit: 'Send to dashboard',
    body: `<p style="margin:0">This records the person's request. It does not grant admin rights.</p>
      <label class="f">Person<input name="person" required value="${esc(person)}"></label>
      <label class="f">Why they need it<textarea name="reason" required placeholder="What they need to install or change"></textarea></label>`,
    onSubmit(form) {
      person = form.person.value.trim();
      reason = form.reason.value.trim();
      if (person.length < 2) throw new Error('Name the person who is asking.');
      if (reason.length < 8 || reason.length > 500) throw new Error('Write a reason between a sentence and a short paragraph.');
    },
  });
  if (!ok) return;
  await createRequest(asset, person, reason);
  toast('Request is on the dashboard');
  paint(main);
}

async function askForCopy(main, asset) {
  const channelOptions = Object.entries(CHANNELS).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
  const actionOptions = Object.entries(COPY_ACTIONS).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
  let row = null;
  const ok = await modal({
    title: 'Copy activity',
    submit: 'Record',
    body: `<p style="margin:0">Record the channel, the file name, and the result. Do not paste the file.</p>
      <label class="f">Channel<select name="channel">${channelOptions}</select></label>
      <label class="f">File name<input name="file_name" required maxlength="180" placeholder="Q3-payroll.xlsx"></label>
      <label class="f">Label, if it has one<input name="label" maxlength="80" placeholder="Finance"></label>
      <label class="f">Result<select name="action">${actionOptions}</select></label>`,
    onSubmit(form) {
      const file_name = form.file_name.value.trim();
      const label = form.label.value.trim();
      if (file_name.length < 1 || file_name.length > 180) throw new Error('Use the file name only, up to 180 characters.');
      if (label.length > 80) throw new Error('Keep the label short.');
      row = { channel: form.channel.value, file_name, label, action: form.action.value };
    },
  });
  if (!ok || !row) return;
  await recordCopy(asset, row);
  toast('Copy activity recorded');
  paint(main);
}

async function save(main, asset, next, action, detail) {
  await persist(asset, next, action, detail);
  toast('Saved');
  paint(main);
}
