// Search log, active hours, and time in each app.
// Search text and app name only. No page contents, passwords, or document titles.

import { store, loadAssets } from '../data.js';
import { esc, fmtDate, fmtDateTime } from '../ui.js';

const ui = { assetId: '', day: '', ready: true, days: [], apps: [], searches: [], assets: [] };

function missingTable(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return err?.status === 404 || m.includes('schema cache') || m.includes('does not exist') || m.includes('could not find');
}

function hours(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function assetOf(id) {
  return ui.assets.find(a => a.id === id);
}

export async function usageView(main, params) {
  if (params?.asset) ui.assetId = params.asset;
  main.innerHTML = '<div class="boot">Loading usage…</div>';
  try {
    ui.assets = (await loadAssets()).filter(a => a.status !== 'disposed');
    await load();
  } catch (err) {
    main.innerHTML = `<div class="page-head"><div><h1>Usage</h1></div></div><div class="err">${esc(err.message || String(err))}</div>`;
    return;
  }
  paint(main);
}

async function load() {
  ui.ready = true;
  const dayQuery = { select: 'asset_id,activity_date,active_seconds,first_active,last_active', order: 'activity_date.desc', limit: '200' };
  const searchQuery = { select: 'id,asset_id,query,engine,searched_at', order: 'searched_at.desc', limit: '200' };
  if (ui.assetId) {
    dayQuery.asset_id = 'eq.' + ui.assetId;
    searchQuery.asset_id = 'eq.' + ui.assetId;
  }
  try {
    const [days, searches] = await Promise.all([
      store.db.select('device_days', dayQuery),
      store.db.select('web_searches', searchQuery),
    ]);
    ui.days = days || [];
    ui.searches = searches || [];
    if (!ui.day && ui.days[0]) ui.day = ui.days[0].activity_date;
    await loadApps();
  } catch (err) {
    if (!missingTable(err)) throw err;
    ui.days = [];
    ui.searches = [];
    ui.apps = [];
    ui.ready = false;
  }
}

async function loadApps() {
  ui.apps = [];
  if (!ui.ready || !ui.day) return;
  const query = { activity_date: 'eq.' + ui.day, select: 'asset_id,app_name,active_seconds', order: 'active_seconds.desc', limit: '100' };
  if (ui.assetId) query.asset_id = 'eq.' + ui.assetId;
  ui.apps = await store.db.select('app_usage', query) || [];
}

function paint(main) {
  const options = [...ui.assets].sort((a, b) => (a.tag || '').localeCompare(b.tag || ''))
    .map(a => `<option value="${esc(a.id)}" ${a.id === ui.assetId ? 'selected' : ''}>${esc(a.tag)} · ${esc(a.assigned_to || a.description || '')}</option>`).join('');
  const dayOptions = [...new Set(ui.days.map(d => d.activity_date))].map(d => `<option value="${esc(d)}" ${d === ui.day ? 'selected' : ''}>${esc(d)}</option>`).join('');
  const todaySeconds = ui.days.filter(d => d.activity_date === ui.day).reduce((n, d) => n + Number(d.active_seconds || 0), 0);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Usage</h1>
        <p>Active time, time in each app, and web searches. Searches already in the browser before Mulk Agent starts watching are not imported. Page contents and passwords are not stored.</p>
      </div>
    </div>
    ${ui.ready ? '' : '<div class="err" style="margin-bottom:16px"><strong>Usage is not stored yet.</strong> Run <span class="mono">supabase/usage.sql</span> once in the Supabase SQL editor.</div>'}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Active ${ui.day ? esc(ui.day) : 'today'}</div><div class="k-val">${hours(todaySeconds)}</div></div>
      <div class="card kpi"><div class="k-label">Apps</div><div class="k-val">${ui.apps.length}</div></div>
      <div class="card kpi"><div class="k-label">Searches shown</div><div class="k-val">${ui.searches.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-b row">
        <label class="f" style="max-width:360px">Asset
          <select id="use-asset"><option value="">All enrolled computers</option>${options}</select>
        </label>
        <label class="f" style="max-width:220px">Day
          <select id="use-day"><option value="">No days yet</option>${dayOptions}</select>
        </label>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-h"><h2>Active hours</h2></div>
        ${ui.days.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th>Asset</th><th>Active</th><th>From</th><th>To</th></tr></thead><tbody>
          ${ui.days.map(d => `<tr>
            <td>${esc(d.activity_date)}</td>
            <td>${assetOf(d.asset_id) ? `<a href="#/asset/${esc(d.asset_id)}"><span class="tag">${esc(assetOf(d.asset_id).tag)}</span></a>` : ''}</td>
            <td>${hours(d.active_seconds)}</td>
            <td class="sub">${fmtDateTime(d.first_active)}</td>
            <td class="sub">${fmtDateTime(d.last_active)}</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No active time yet. Mulk Agent counts a minute when someone is at the computer and a window is in front. The Mulk Agent window, or its one-minute sample, has to be running.</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>App time</h2><span class="muted">${ui.day ? esc(ui.day) : ''}</span></div>
        ${ui.apps.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>App</th>${ui.assetId ? '' : '<th>Asset</th>'}<th>Time</th></tr></thead><tbody>
          ${ui.apps.map(a => `<tr>
            <td>${esc(a.app_name)}</td>
            ${ui.assetId ? '' : `<td>${assetOf(a.asset_id) ? `<span class="tag">${esc(assetOf(a.asset_id).tag)}</span>` : ''}</td>`}
            <td>${hours(a.active_seconds)}</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No app time for this day.</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Web searches</h2><span class="muted">Query text only</span></div>
      ${ui.searches.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Engine</th><th>Search</th></tr></thead><tbody>
        ${ui.searches.map(s => `<tr>
          <td>${fmtDateTime(s.searched_at)}<div class="sub">${fmtDate(s.searched_at)}</div></td>
          <td>${assetOf(s.asset_id) ? `<a href="#/asset/${esc(s.asset_id)}"><span class="tag">${esc(assetOf(s.asset_id).tag)}</span></a>` : ''}</td>
          <td>${esc(s.engine)}</td>
          <td>${esc(s.query)}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No searches yet. Google, Bing, DuckDuckGo, Yahoo, and YouTube searches made after the agent starts watching appear here.</div>'}
    </div>`;

  const sync = () => {
    const path = '#/usage' + (ui.assetId ? '?asset=' + encodeURIComponent(ui.assetId) : '');
    history.replaceState(null, '', path);
  };
  document.getElementById('use-asset').onchange = async (e) => {
    ui.assetId = e.target.value;
    ui.day = '';
    sync();
    try { await load(); paint(main); } catch (err) { main.innerHTML = `<div class="err">${esc(err.message || String(err))}</div>`; }
  };
  document.getElementById('use-day').onchange = async (e) => {
    ui.day = e.target.value;
    try { await loadApps(); paint(main); } catch (err) { main.innerHTML = `<div class="err">${esc(err.message || String(err))}</div>`; }
  };
}
