// Admin inbox for installed software and data-leaving reports.
// Program rows are name, version, and publisher. A removable drive is reported
// by its letter and volume name. Documents are not stored.

import { store, loadAssets, ctx } from '../data.js';
import { esc, fmtDate, fmtDateTime, toast } from '../ui.js';

const CHANNELS = { usb: 'USB', clipboard: 'Clipboard', cloud: 'Personal cloud', mail: 'Outside email', print: 'Print' };
const COPY_ACTIONS = { blocked: 'Blocked', warned: 'Warned', quarantined: 'Quarantined', plugged: 'Plugged' };

const COMPLIANCE = {
  bitlocker: 'BitLocker',
  defender: 'Defender',
  firewall: 'Firewall',
  disk: 'Disk space',
  serial: 'Serial number',
  local_admin: 'Local administrators',
  startup: 'Startup programs',
  banned: 'Banned program',
};

const ui = {
  ready: true,
  openOnly: true,
  assetId: '',
  programs: [],
  software: [],
  copies: [],
  places: [],
  compliance: [],
  devices: [],
  banned: [],
  assets: [],
};

function missingTable(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return err?.status === 404 || m.includes('schema cache') || m.includes('does not exist') || m.includes('could not find');
}

function who() {
  return ctx.user?.email || 'admin';
}

function assetOf(id) {
  return ui.assets.find(a => a.id === id);
}

function tagOf(id) {
  const a = assetOf(id);
  return a ? `<span class="tag">${esc(a.tag)}</span>` : '<span class="muted">Removed asset</span>';
}

async function load() {
  ui.assets = (await loadAssets()).filter(a => a.status !== 'disposed');
  try {
    const softwareQuery = { select: 'id,asset_id,name,version,publisher,kind,happened_at,acknowledged_at', order: 'happened_at.desc', limit: '200' };
    const copyQuery = { select: 'id,asset_id,channel,file_name,label,action,happened_at,acknowledged_at', order: 'happened_at.desc', limit: '200' };
    if (ui.openOnly) {
      softwareQuery.acknowledged_at = 'is.null';
      copyQuery.acknowledged_at = 'is.null';
    }
    const placeQuery = { select: 'id,asset_id,public_ip,local_ip,country_code,country_name,region_name,city,outside_uae,happened_at,acknowledged_at', outside_uae: 'eq.true', order: 'happened_at.desc', limit: '100' };
    if (ui.openOnly) placeQuery.acknowledged_at = 'is.null';
    const [software, copies, places] = await Promise.all([
      store.db.select('software_events', softwareQuery),
      store.db.select('copy_activity', copyQuery),
      store.db.select('location_events', placeQuery),
    ]);
    ui.software = software || [];
    ui.copies = copies || [];
    ui.places = places || [];
    ui.ready = true;
  } catch (err) {
    if (!missingTable(err)) throw err;
    ui.software = [];
    ui.copies = [];
    ui.places = [];
    ui.ready = false;
  }
  await loadPrograms();
  await loadOps();
}

async function loadOps() {
  ui.compliance = [];
  ui.devices = [];
  ui.banned = [];
  try {
    const query = { select: 'id,asset_id,kind,detail,happened_at,acknowledged_at', order: 'happened_at.desc', limit: '200' };
    if (ui.openOnly) query.acknowledged_at = 'is.null';
    ui.compliance = await store.db.select('compliance_alerts', query) || [];
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  try {
    ui.devices = await store.db.select('agent_devices', { select: 'asset_id,hostname,last_seen', order: 'last_seen.asc', limit: '300' }) || [];
  } catch { ui.devices = []; }
  try {
    ui.banned = await store.db.select('banned_programs', { select: 'name_key,label,created_at', order: 'label.asc', limit: '200' }) || [];
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
}

async function loadPrograms() {
  ui.programs = [];
  if (!ui.ready || !ui.assetId) return;
  ui.programs = await store.db.select('installed_software', {
    asset_id: 'eq.' + ui.assetId,
    removed_at: 'is.null',
    select: 'name,version,publisher,installed_on,first_seen,last_seen',
    order: 'name.asc',
    limit: '500',
  }) || [];
}

async function acknowledge(table, id) {
  await store.db.update(table, { id: 'eq.' + id }, { acknowledged_at: new Date().toISOString(), acknowledged_by: who() });
}

function assetOptions() {
  return [...ui.assets].sort((a, b) => (a.tag || '').localeCompare(b.tag || ''));
}

export async function alertsView(main, params) {
  if (params?.asset) ui.assetId = params.asset;
  main.innerHTML = '<div class="boot">Loading reports…</div>';
  try {
    await load();
  } catch (err) {
    main.innerHTML = `<div class="page-head"><div><h1>Alerts</h1></div></div><div class="err">${esc(err.message || String(err))}</div>`;
    return;
  }
  paint(main);
  watch(main);
}

function paint(main) {
  const openSoftware = ui.software.filter(r => !r.acknowledged_at).length;
  const openCopies = ui.copies.filter(r => !r.acknowledged_at).length;
  const openPlaces = ui.places.filter(r => !r.acknowledged_at).length;
  const openHealth = ui.compliance.filter(r => !r.acknowledged_at).length;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const offline = ui.devices.filter(d => !d.last_seen || new Date(d.last_seen).getTime() < cutoff);
  const options = assetOptions().map(a => `<option value="${esc(a.id)}" ${a.id === ui.assetId ? 'selected' : ''}>${esc(a.tag)} · ${esc(a.assigned_to || a.description || '')}</option>`).join('');
  const selected = assetOf(ui.assetId);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Alerts</h1>
        <p>New programs, USB devices, computers outside the UAE, and health. Files, the screen, and the keyboard are not collected. The first software, USB, and startup report from a machine is its baseline.</p>
      </div>
      <div class="row">
        <button type="button" class="btn" id="toggle-open">${ui.openOnly ? 'Show history' : 'Open only'}</button>
        ${(openSoftware + openCopies + openPlaces + openHealth) ? '<button type="button" class="btn primary" id="ack-all">Mark open as reviewed</button>' : ''}
      </div>
    </div>
    ${ui.ready ? '' : `<div class="err" style="margin-bottom:16px"><strong>Software reports are not stored yet.</strong> Run <span class="mono">supabase/asset-admin.sql</span> once in the Supabase SQL editor. It is safe to re-run.</div>`}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Outside UAE</div><div class="k-val">${openPlaces}</div></div>
      <div class="card kpi"><div class="k-label">USB and data leaving</div><div class="k-val">${openCopies}</div></div>
      <div class="card kpi"><div class="k-label">New programs</div><div class="k-val">${openSoftware}</div></div>
      <div class="card kpi"><div class="k-label">Health</div><div class="k-val">${openHealth}</div></div>
      <div class="card kpi"><div class="k-label">Quiet for a day</div><div class="k-val">${offline.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Not seen for a day</h2><span class="muted">Live status, from the last check-in</span></div>
      ${offline.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Asset</th><th>Computer</th><th>Last seen</th></tr></thead><tbody>
        ${offline.map(d => `<tr>
          <td><a href="#/asset/${esc(d.asset_id)}">${tagOf(d.asset_id)}</a></td>
          <td>${esc(d.hostname || '')}</td>
          <td>${d.last_seen ? fmtDateTime(d.last_seen) : 'Never'}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Every enrolled computer has checked in during the last day, or none are enrolled yet.</div>'}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Health</h2><span class="muted">Encryption, Defender, firewall, disk, serial, local admins, startup</span></div>
      ${ui.compliance.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Check</th><th>Detail</th><th></th></tr></thead><tbody>
        ${ui.compliance.map(r => `<tr>
          <td>${fmtDateTime(r.happened_at)}</td>
          <td><a href="#/asset/${esc(r.asset_id)}">${tagOf(r.asset_id)}</a></td>
          <td>${esc(COMPLIANCE[r.kind] || r.kind)}</td>
          <td>${esc(r.detail)}</td>
          <td style="text-align:right">${r.acknowledged_at ? '<span class="muted">Reviewed</span>' : `<button type="button" class="btn sm" data-ack="compliance_alerts" data-id="${esc(r.id)}">Mark reviewed</button>`}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No health alerts. BitLocker, Defender, or the firewall being off, low disk, a serial that does not match the asset, a banned program, or a change in local administrators or startup names appears here. A restart waiting is shown on the computer, not as an alert.</div>'}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Banned programs</h2><span class="muted">Matched to the installed name</span></div>
      <div class="card-b">
        <form id="ban-form" class="row">
          <label class="f" style="flex:1;min-width:220px;margin:0">Program name<input name="label" required placeholder="AnyDesk" maxlength="80"></label>
          <button class="btn" type="submit">Ban</button>
        </form>
        ${ui.banned.length ? `<ul class="muted" style="margin:12px 0 0;padding-left:18px">${ui.banned.map(b => `<li>${esc(b.label)} <button type="button" class="btn sm" data-unban="${esc(b.name_key)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted" style="margin:12px 0 0">No names are banned. Type the program name exactly as it appears in the installed list. A computer that has that name is listed under Health after its next check.</p>'}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Outside the UAE</h2><span class="muted">City and country of the public IP</span></div>
      ${ui.places.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Place</th><th>Public IP</th><th></th></tr></thead><tbody>
        ${ui.places.map(r => `<tr>
          <td>${fmtDateTime(r.happened_at)}</td>
          <td><a href="#/asset/${esc(r.asset_id)}">${tagOf(r.asset_id)}</a></td>
          <td>${esc([r.city, r.region_name, r.country_name || r.country_code].filter(Boolean).join(', '))}</td>
          <td class="mono">${esc(r.public_ip || '')}${r.local_ip ? `<div class="sub">Local ${esc(r.local_ip)}</div>` : ''}</td>
          <td style="text-align:right">${r.acknowledged_at ? '<span class="muted">Reviewed</span>' : `<button type="button" class="btn sm" data-ack="location_events" data-id="${esc(r.id)}">Mark reviewed</button>`}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No computer has reported a public IP outside the UAE. Location is the city and country of that IP, not a GPS reading.</div>'}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>New or removed programs</h2><span class="muted">Name, version, and publisher only</span></div>
      ${ui.software.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Program</th><th>Change</th><th></th></tr></thead><tbody>
        ${ui.software.map(r => `<tr>
          <td>${fmtDateTime(r.happened_at)}</td>
          <td><a href="#/asset/${esc(r.asset_id)}">${tagOf(r.asset_id)}</a></td>
          <td>${esc(r.name)}${r.version ? `<div class="sub">${esc(r.version)}</div>` : ''}${r.publisher ? `<div class="sub">${esc(r.publisher)}</div>` : ''}</td>
          <td><span class="badge ${r.kind === 'removed' ? 'st-under_repair' : 'st-checked_out'}">${r.kind === 'removed' ? 'Removed' : 'Installed'}</span></td>
          <td style="text-align:right">${r.acknowledged_at ? '<span class="muted">Reviewed</span>' : `<button type="button" class="btn sm" data-ack="software_events" data-id="${esc(r.id)}">Mark reviewed</button>`}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No program changes yet. After Mulk Agent is installed, its first scan is the baseline and is not an alert. A program the person installs later appears here.</div>'}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Data leaving the computer</h2><span class="muted">No file contents</span></div>
      ${ui.copies.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Channel</th><th>What</th><th>Result</th><th></th></tr></thead><tbody>
        ${ui.copies.map(r => `<tr>
          <td>${fmtDateTime(r.happened_at)}</td>
          <td><a href="#/asset/${esc(r.asset_id)}">${tagOf(r.asset_id)}</a></td>
          <td>${esc(CHANNELS[r.channel] || r.channel)}</td>
          <td>${esc(r.file_name)}${r.label ? `<div class="sub">${esc(r.label)}</div>` : ''}</td>
          <td><span class="badge ${r.action === 'warned' ? 'st-under_repair' : 'st-broken'}">${esc(COPY_ACTIONS[r.action] || r.action)}</span></td>
          <td style="text-align:right">${r.acknowledged_at ? '<span class="muted">Reviewed</span>' : `<button type="button" class="btn sm" data-ack="copy_activity" data-id="${esc(r.id)}">Mark reviewed</button>`}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No USB or data-leaving reports yet. A USB device plugged in after the first scan is listed here. Files on a drive are not listed.</div>'}
    </div>
    <div class="card">
      <div class="card-h"><h2>Installed software</h2><span class="muted">${selected ? esc(selected.tag) : 'Choose a computer'}</span></div>
      <div class="card-b">
        <label class="f" style="max-width:420px">Asset
          <select id="sw-asset"><option value="">Select an asset</option>${options}</select>
        </label>
      </div>
      ${!ui.assetId ? '<div class="empty">Choose a computer to see the programs Mulk Agent last reported.</div>'
        : ui.programs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Program</th><th>Version</th><th>Publisher</th><th>Installed</th><th>Last seen</th></tr></thead><tbody>
          ${ui.programs.map(p => `<tr>
            <td>${esc(p.name)}</td>
            <td class="sub">${esc(p.version || '')}</td>
            <td class="sub">${esc(p.publisher || '')}</td>
            <td class="sub">${fmtDate(p.installed_on)}</td>
            <td class="sub">${fmtDateTime(p.last_seen)}</td>
          </tr>`).join('')}
        </tbody></table></div><div class="tbl-foot"><span>${ui.programs.length} installed</span></div>`
        : '<div class="empty">No software list yet for this computer. It appears after Mulk Agent runs on that machine.</div>'}
    </div>`;

  document.getElementById('toggle-open').onclick = async () => {
    ui.openOnly = !ui.openOnly;
    await refresh(main);
  };
  document.getElementById('ack-all')?.addEventListener('click', async () => {
    try {
      const jobs = [];
      for (const r of ui.software) if (!r.acknowledged_at) jobs.push(acknowledge('software_events', r.id));
      for (const r of ui.copies) if (!r.acknowledged_at) jobs.push(acknowledge('copy_activity', r.id));
      for (const r of ui.places) if (!r.acknowledged_at) jobs.push(acknowledge('location_events', r.id));
      for (const r of ui.compliance) if (!r.acknowledged_at) jobs.push(acknowledge('compliance_alerts', r.id));
      await Promise.all(jobs);
      toast('Marked as reviewed');
      await refresh(main);
    } catch (err) { toast(err.message || String(err), true); }
  });
  main.querySelectorAll('[data-ack]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await acknowledge(btn.dataset.ack, btn.dataset.id);
        toast('Marked as reviewed');
        await refresh(main);
      } catch (err) { toast(err.message || String(err), true); }
    };
  });
  document.getElementById('ban-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = new FormData(e.target).get('label').toString().trim();
    const name_key = label.toLowerCase();
    if (name_key.length < 3) { toast('Use at least 3 characters so a short name does not match too widely.', true); return; }
    if (/[",]/.test(label)) { toast('Leave out commas and quotes. Use the program name as Windows lists it.', true); return; }
    try {
      await store.db.insert('banned_programs', { name_key, label });
      toast('Banned. A computer that has it is reported on the next check.');
      await refresh(main);
    } catch (err) { toast(err.message || String(err), true); }
  });
  main.querySelectorAll('[data-unban]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await store.db.remove('banned_programs', { name_key: 'eq.' + btn.dataset.unban });
        toast('Removed from the banned list');
        await refresh(main);
      } catch (err) { toast(err.message || String(err), true); }
    };
  });
  document.getElementById('sw-asset').onchange = async (e) => {
    ui.assetId = e.target.value;
    const path = '#/alerts' + (ui.assetId ? '?asset=' + encodeURIComponent(ui.assetId) : '');
    history.replaceState(null, '', path);
    try { await loadPrograms(); paint(main); }
    catch (err) { toast(err.message || String(err), true); }
  };
}

async function refresh(main) {
  await load();
  paint(main);
}

let pollTimer = 0;
let pollGen = 0;
function watch(main) {
  clearInterval(pollTimer);
  const gen = ++pollGen;
  const alertKey = (kind, id) => kind + ':' + id;
  const seen = new Set([
    ...ui.software.filter(r => !r.acknowledged_at).map(r => alertKey('s', r.id)),
    ...ui.copies.filter(r => !r.acknowledged_at).map(r => alertKey('c', r.id)),
    ...ui.places.filter(r => !r.acknowledged_at).map(r => alertKey('p', r.id)),
  ]);
  pollTimer = setInterval(async () => {
    if (gen !== pollGen || !main.querySelector('#sw-asset') || document.querySelector('.modal-bg')) return;
    try { await load(); } catch { return; }
    const fresh = [
      ...ui.software.filter(r => !r.acknowledged_at).map(r => alertKey('s', r.id)),
      ...ui.copies.filter(r => !r.acknowledged_at).map(r => alertKey('c', r.id)),
      ...ui.places.filter(r => !r.acknowledged_at).map(r => alertKey('p', r.id)),
    ].filter(key => !seen.has(key));
    if (fresh.length) {
      fresh.forEach(key => seen.add(key));
      toast(fresh.length === 1 ? 'New report from a computer' : `${fresh.length} new reports from computers`);
      paint(main);
    }
  }, 20000);
}
