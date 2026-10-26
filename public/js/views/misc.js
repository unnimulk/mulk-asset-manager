import { esc, icon, toast, modal, fmtDate, fmtDateTime, fmtMoney, today, datalist, qrSvg, $, $$ } from '../ui.js';
import { store, ctx, loadAssets, distinct, STATUS, ACTION_LABEL, exportXlsx, exportSheets } from '../data.js';
import { assetUrl } from './asset.js';
import { setLabelSelection } from './assets.js';

const stamp = () => new Date().toISOString().slice(0, 10);

// ---------------- Activity ----------------
export async function activityView(main, params) {
  const f = { action: params.action || '', from: params.from || '', to: params.to || '', q: params.q || '' };
  main.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Every check-out, check-in, repair, disposal and edit.</p></div>
      <button class="btn" id="exp">${icon('download')} Export</button></div>
    <div class="card">
      <div class="filters" style="grid-template-columns:minmax(200px,2fr) repeat(3,minmax(130px,1fr))">
        <input type="search" class="search" id="q" placeholder="Search tag, person, notes…" value="${esc(f.q)}">
        <select id="action"><option value="">All actions</option>${Object.entries(ACTION_LABEL).map(([k, l]) => `<option value="${k}" ${f.action === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="date" id="from" value="${esc(f.from)}" aria-label="From date">
        <input type="date" id="to" value="${esc(f.to)}" aria-label="To date">
      </div>
      <div id="list"><div class="empty">Loading…</div></div>
    </div>`;

  let rows = [];
  async function load() {
    const query = { select: '*,assets(id,tag,description)', order: 'created_at.desc', limit: '1000' };
    if (f.action) query.action = 'eq.' + f.action;
    const and = [];
    if (f.from) and.push('event_date.gte.' + f.from);
    if (f.to) and.push('event_date.lte.' + f.to);
    if (and.length) query.and = `(${and.join(',')})`;
    rows = await store.db.select('asset_events', query);
    render();
  }
  function filtered() {
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(e => {
      if (!words.length) return true;
      const hay = [e.assets?.tag, e.assets?.description, e.assigned_to, e.department, e.notes, e.performed_by, e.vendor, e.site, e.location].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  function render() {
    const list = filtered();
    $('#list').innerHTML = list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Asset</th><th>Action</th><th>Person / dept</th><th>Details</th><th>By</th></tr></thead><tbody>
      ${list.map(e => `<tr class="clickable" data-href="#/asset/${e.asset_id}">
        <td>${fmtDate(e.event_date)}<div class="sub">${fmtDateTime(e.created_at)}</div></td>
        <td><span class="tag">${esc(e.assets?.tag || '')}</span><div class="sub">${esc(e.assets?.description || '')}</div></td>
        <td>${esc(ACTION_LABEL[e.action] || e.action)}${e.to_status && e.from_status !== e.to_status ? `<div class="sub">→ ${STATUS[e.to_status]?.label || e.to_status}</div>` : ''}</td>
        <td>${esc(e.assigned_to || '')}<div class="sub">${esc(e.department || '')}</div></td>
        <td style="max-width:320px">${esc([e.vendor, e.cost != null ? fmtMoney(e.cost) : '', e.notes].filter(Boolean).join(' · ')).slice(0, 220)}</td>
        <td class="sub">${esc(e.performed_by)}</td></tr>`).join('')}</tbody></table></div>
      <div class="tbl-foot"><span>${list.length} events${rows.length === 1000 ? ' (latest 1000 — narrow the dates to see older)' : ''}</span></div>`
      : '<div class="empty">No activity matches.</div>';
    $$('#list tr[data-href]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.href; });
  }
  const sync = () => { const p = Object.fromEntries(Object.entries(f).filter(([, v]) => v)); history.replaceState(null, '', '#/activity' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); };
  let t;
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); sync(); render(); }, 150); };
  for (const k of ['action', 'from', 'to']) $('#' + k).onchange = (e) => { f[k] = e.target.value; sync(); load(); };
  $('#exp').onclick = () => exportSheets([{ name: 'Activity', rows: filtered().map(eventRow) }], `activity-${stamp()}.xlsx`);
  await load();
}

const eventRow = (e) => ({
  'Event Date': e.event_date, 'Asset Tag ID': e.assets?.tag || '', 'Description': e.assets?.description || '',
  'Action': ACTION_LABEL[e.action] || e.action, 'From Status': STATUS[e.from_status]?.label || e.from_status || '',
  'To Status': STATUS[e.to_status]?.label || e.to_status || '', 'Person': e.assigned_to || '', 'Department': e.department || '',
  'Site': e.site || '', 'Location': e.location || '', 'Vendor': e.vendor || '', 'Cost': e.cost ?? '', 'Notes': e.notes || '',
  'Recorded By': e.performed_by, 'Recorded At': e.created_at ? String(e.created_at).replace('T', ' ').slice(0, 16) : '',
});

// ---------------- Reports ----------------
function pivot(rows, rowKey, colKey, colLabels) {
  const cols = colLabels || distinct(colKey, rows);
  const m = new Map();
  for (const r of rows) {
    const k = String(r[rowKey] || '').trim() || '(blank)';
    if (!m.has(k)) m.set(k, {});
    const c = String(r[colKey] || '').trim() || '(blank)';
    m.get(k)[c] = (m.get(k)[c] || 0) + 1;
  }
  const allCols = [...new Set([...cols, ...[...m.values()].flatMap(o => Object.keys(o))])];
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, o]) => {
    const row = { [rowKey === 'assigned_to' ? 'Employee' : rowKey[0].toUpperCase() + rowKey.slice(1)]: k };
    let total = 0;
    for (const c of allCols) { row[colKey === 'status' ? (STATUS[c]?.label || c) : c] = o[c] || 0; total += o[c] || 0; }
    row.Total = total;
    return row;
  });
}

export async function reportsView(main) {
  const assets = await loadAssets(true);
  const active = assets.filter(a => a.status !== 'disposed');
  const reports = [
    ['Full asset register', 'Every asset with all fields, including disposed items.', () => exportXlsx(assets, `asset-register-${stamp()}.xlsx`)],
    ['Assets by employee', 'Checked-out assets grouped by person, with a count per employee.', () => {
      const out = assets.filter(a => a.status === 'checked_out').sort((a, b) => String(a.assigned_to).localeCompare(String(b.assigned_to)));
      const per = pivot(out, 'assigned_to', 'category');
      exportSheets([{ name: 'Summary', rows: per }, { name: 'Detail', rows: out.map(a => ({ 'Employee': a.assigned_to, 'Department': a.department || '', 'Asset Tag ID': a.tag, 'Description': a.description || '', 'Category': a.category || '', 'Brand': a.brand || '', 'Model': a.model || '', 'Serial No': a.serial_no || '', 'Since': a.last_event_date || '' })) }], `assets-by-employee-${stamp()}.xlsx`);
    }],
    ['Department summary', 'Count of active assets per department and category.', () => exportSheets([{ name: 'By department', rows: pivot(active, 'department', 'category') }], `department-summary-${stamp()}.xlsx`)],
    ['Category & status', 'How many of each category are available, checked out, in repair…', () => exportSheets([{ name: 'Category x status', rows: pivot(assets, 'category', 'status', Object.keys(STATUS)) }, { name: 'Site x status', rows: pivot(assets, 'site', 'status', Object.keys(STATUS)) }], `category-status-${stamp()}.xlsx`)],
    ['Repairs & faults', 'Assets under repair, broken or lost now, plus full repair history with costs.', async () => {
      const ev = await store.db.selectAll('asset_events', { select: '*,assets(tag,description)', action: 'in.(repair,repair_done,broken,lost)', order: 'event_date.desc' });
      exportSheets([{ name: 'Current', rows: assets.filter(a => ['under_repair', 'broken', 'lost'].includes(a.status)).map(a => ({ 'Asset Tag ID': a.tag, 'Description': a.description || '', 'Status': STATUS[a.status].label, 'Since': a.last_event_date || '', 'Assigned to': a.assigned_to || '', 'Department': a.department || '' })) }, { name: 'History', rows: ev.map(eventRow) }], `repairs-${stamp()}.xlsx`);
    }],
    ['Disposed assets', 'Everything disposed, with date, method and value.', async () => {
      const ev = await store.db.selectAll('asset_events', { select: '*,assets(tag,description,category,serial_no)', action: 'eq.dispose', order: 'event_date.desc' });
      exportSheets([{ name: 'Disposed', rows: ev.map(e => ({ 'Disposal Date': e.event_date, 'Asset Tag ID': e.assets?.tag || '', 'Description': e.assets?.description || '', 'Category': e.assets?.category || '', 'Serial No': e.assets?.serial_no || '', 'Last User': e.assigned_to || '', 'Method / Notes': e.notes || '', 'Value': e.cost ?? '', 'Recorded By': e.performed_by })) }], `disposed-${stamp()}.xlsx`);
    }],
  ];

  main.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>Each report downloads as an Excel file.</p></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Employee lookup</h2><span class="muted">e.g. for joiners & leavers</span></div>
        <div class="card-b stack">
          <div class="row" style="flex-wrap:nowrap"><input id="person" list="dl-p" placeholder="Type an employee name…" autocomplete="off">${datalist('dl-p', distinct('assigned_to', assets))}</div>
          <div id="person-out" class="muted">Pick a person to see everything checked out to them.</div>
        </div></div>
      <div class="report-list">${reports.map(([t, d], i) => `<div class="card report"><h2>${esc(t)}</h2><p>${esc(d)}</p><button class="btn" data-r="${i}">${icon('download')} Download</button></div>`).join('')}
        <div class="card report"><h2>Activity for a period</h2><p>All events between two dates.</p>
          <div class="row" style="flex-wrap:nowrap"><input type="date" id="rf" aria-label="From"><input type="date" id="rt" value="${today()}" aria-label="To"></div>
          <button class="btn" id="rp">${icon('download')} Download</button></div>
      </div>
    </div>`;

  $$('[data-r]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await reports[+b.dataset.r][2](); } catch (e) { toast(e.message, true); }
    b.disabled = false;
  });
  $('#rp').onclick = async () => {
    const q = { select: '*,assets(tag,description)', order: 'event_date.asc' };
    const and = []; if ($('#rf').value) and.push('event_date.gte.' + $('#rf').value); if ($('#rt').value) and.push('event_date.lte.' + $('#rt').value);
    if (and.length) q.and = `(${and.join(',')})`;
    const ev = await store.db.selectAll('asset_events', q);
    exportSheets([{ name: 'Activity', rows: ev.map(eventRow) }], `activity-${$('#rf').value || 'start'}-to-${$('#rt').value || stamp()}.xlsx`);
  };
  const showPerson = () => {
    const name = $('#person').value.trim().toLowerCase();
    const out = $('#person-out');
    if (!name) { out.className = 'muted'; out.textContent = 'Pick a person to see everything checked out to them.'; return; }
    const list = assets.filter(a => String(a.assigned_to || '').toLowerCase().includes(name) && a.status !== 'disposed');
    out.className = '';
    out.innerHTML = list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tag</th><th>Description</th><th>Assigned to</th><th>Serial</th><th>Status</th><th>Since</th></tr></thead><tbody>
      ${list.map(a => `<tr class="clickable" data-href="#/asset/${a.id}"><td class="tag">${esc(a.tag)}</td><td>${esc(a.description || '')}<div class="sub">${esc([a.brand, a.model].filter(Boolean).join(' '))}</div></td><td>${esc(a.assigned_to)}</td><td class="mono">${esc(a.serial_no || '')}</td><td><span class="badge st-${a.status}">${STATUS[a.status].label}</span></td><td>${fmtDate(a.last_event_date)}</td></tr>`).join('')}
      </tbody></table></div>` : '<span class="muted">Nothing assigned to that name.</span>';
    $$('#person-out tr[data-href]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.href; });
  };
  $('#person').oninput = showPerson;
}

// ---------------- QR labels ----------------
const SIZES = {
  s: { name: 'Small 50 × 25 mm', w: 50, h: 25, fs: 2.6 },
  m: { name: 'Medium 62 × 29 mm (Brother DK)', w: 62, h: 29, fs: 3 },
  l: { name: 'Large 70 × 37 mm (A4, 24 per sheet)', w: 70, h: 37, fs: 3.4 },
};

export async function labelsView(main) {
  const assets = await loadAssets();
  let ids = store.labelIds;
  if (!ids) { try { ids = JSON.parse(sessionStorage.getItem('am.labels') || 'null'); } catch { ids = null; } }
  const byId = new Map(assets.map(a => [a.id, a]));
  let list = (ids || []).map(id => byId.get(id)).filter(Boolean);
  let size = 'm', showDesc = true;

  function render() {
    const s = SIZES[size];
    main.innerHTML = `
      <div class="page-head no-print"><div><h1>QR labels</h1><p>${list.length ? `${list.length} label${list.length > 1 ? 's' : ''} ready. Scanning a label opens the asset page.` : 'No assets selected yet.'}</p></div>
        <div class="row">
          <select id="size">${Object.entries(SIZES).map(([k, v]) => `<option value="${k}" ${k === size ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" id="desc" ${showDesc ? 'checked' : ''}> Description</label>
          <button class="btn primary" id="print" ${list.length ? '' : 'disabled'}>${icon('print')} Print</button>
        </div></div>
      ${list.length ? '' : `<div class="card no-print"><div class="card-b stack">
          <p style="margin:0">Select assets on the <a href="#/assets">Assets</a> page (tick the boxes, then <b>Print QR labels</b>), or enter tags here, one per line:</p>
          <textarea id="tags" rows="5" class="mono" placeholder="MH/LAP/2026/HZF/112"></textarea>
          <div class="row"><button class="btn" id="usetags">Make labels</button><button class="btn" id="useall">All ${assets.filter(a => a.status !== 'disposed').length} active assets</button></div>
        </div></div>`}
      <style>@page { margin: 8mm; }</style>
      <div class="labels-sheet" style="--lw:${s.w}mm;--lh:${s.h}mm;--fs:${s.fs}mm" ${list.length ? '' : 'hidden'}>
        ${list.map(a => `<div class="label">${qrSvg(assetUrl(a.id), 2)}<div class="lt">
          <div class="l-co">${esc(ctx.company)} · IT</div>
          <div class="l-tag">${esc(a.tag)}</div>
          ${showDesc ? `<div class="l-desc">${esc([a.description, a.serial_no ? 'S/N ' + a.serial_no : ''].filter(Boolean).join(' · '))}</div>` : ''}
        </div></div>`).join('')}
      </div>`;
    $('#size').onchange = (e) => { size = e.target.value; render(); };
    $('#desc').onchange = (e) => { showDesc = e.target.checked; render(); };
    $('#print').onclick = () => window.print();
    $('#usetags')?.addEventListener('click', () => {
      const want = $('#tags').value.split(/\n|,/).map(s => s.trim().toLowerCase()).filter(Boolean);
      const byTag = new Map(assets.map(a => [a.tag.toLowerCase(), a]));
      const found = want.map(t => byTag.get(t)).filter(Boolean);
      if (found.length < want.length) toast(`${want.length - found.length} tag(s) not found`, true);
      list = found; setLabelSelection(found.map(a => a.id)); render();
    });
    $('#useall')?.addEventListener('click', () => { list = assets.filter(a => a.status !== 'disposed'); setLabelSelection(list.map(a => a.id)); render(); });
  }
  render();
}

// ---------------- Admins ----------------
export async function settingsView(main) {
  const admins = await store.db.select('app_admins', { select: '*', order: 'email.asc' });
  const me = String(ctx.user?.email || '').toLowerCase();
  main.innerHTML = `
    <div class="page-head"><div><h1>Admins</h1><p>People allowed to use this app.</p></div>
      <button class="btn primary" id="add">${icon('plus')} Add admin</button></div>
    <div class="grid-3">
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>E-mail</th><th>Added</th><th></th></tr></thead><tbody>
        ${admins.map(a => `<tr><td>${esc(a.email)}${a.email.toLowerCase() === me ? ' <span class="muted">(you)</span>' : ''}</td><td class="sub">${fmtDate(a.added_at)}</td>
          <td style="text-align:right">${a.email.toLowerCase() === me ? '' : `<button class="btn sm danger" data-rm="${esc(a.email)}">Remove</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="card"><div class="card-h"><h2>Adding a new admin</h2></div><div class="card-b stack" style="font-size:13px">
        <div>1. Add their e-mail here with <b>Add admin</b>.</div>
        <div>2. In Supabase, open <b>Authentication → Users → Add user → Send invitation</b> and enter the same e-mail.</div>
        <div>3. They click the link in the invitation e-mail and choose a password.</div>
        <div class="muted">Removing someone here blocks them immediately, even if their login still exists in Supabase.</div>
      </div></div>
    </div>`;
  $('#add').onclick = async () => {
    const ok = await modal({
      title: 'Add admin', submit: 'Add',
      body: '<label class="f">Work e-mail<input name="email" type="email" required autocomplete="off"></label>',
      onSubmit: async (form) => {
        const email = form.email.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid e-mail address.');
        try { await store.db.insert('app_admins', [{ email }]); }
        catch (e) { throw new Error(/duplicate key/.test(e.message) ? `${email} is already an admin.` : e.message); }
      },
    });
    if (ok) { toast('Admin added'); settingsView(main); }
  };
  $$('[data-rm]').forEach(b => b.onclick = async () => {
    const ok = await modal({ title: 'Remove admin?', body: `<p style="margin:0">${esc(b.dataset.rm)} will lose access immediately.</p>`, submit: 'Remove', danger: true,
      onSubmit: () => store.db.remove('app_admins', { email: 'eq.' + b.dataset.rm }) });
    if (ok) { toast('Admin removed'); settingsView(main); }
  });
}
