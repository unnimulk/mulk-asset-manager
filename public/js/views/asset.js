import { esc, icon, toast, modal, fmtDate, fmtDateTime, fmtMoney, today, datalist, qrSvg, $ } from '../ui.js';
import { store, loadAssets, invalidate, distinct, suggestTag, STATUS, ACTIONS_FOR, ACTION_BUTTON, ACTION_LABEL } from '../data.js';
import { setLabelSelection } from './assets.js';

export const assetUrl = (id) => `${location.origin}/#/asset/${id}`;

function actionForm(action, a) {
  const people = datalist('dl-people', distinct('assigned_to'));
  const depts = datalist('dl-dept', distinct('department'));
  const sites = datalist('dl-site', distinct('site'));
  const locs = datalist('dl-loc', distinct('location'));
  const vendors = datalist('dl-vendor', distinct('vendor'));
  const date = `<label class="f">Date<input type="date" name="p_event_date" value="${today()}" required></label>`;
  const notes = (label = 'Notes', req = false) => `<label class="f wide">${label}${req ? ' <span class="req">*</span>' : ''}<textarea name="p_notes" ${req ? 'required' : ''}></textarea></label>`;
  const site = `<label class="f">Site<input name="p_site" list="dl-site" value="${esc(a.site || '')}"></label>`;
  const loc = `<label class="f">Location<input name="p_location" list="dl-loc" value="${esc(a.location || '')}"></label>`;
  const dept = (v) => `<label class="f">Department<input name="p_department" list="dl-dept" value="${esc(v || '')}"></label>`;
  const vendor = `<label class="f">Repair vendor<input name="p_vendor" list="dl-vendor"></label>`;
  const cost = (l) => `<label class="f">${l}<input type="number" step="0.01" min="0" name="p_cost"></label>`;
  const g = (inner) => `<div class="form-grid">${inner}</div>${people}${depts}${sites}${locs}${vendors}`;
  switch (action) {
    case 'check_out': return g(`<label class="f wide">Assign to (employee) <span class="req">*</span><input name="p_assigned_to" list="dl-people" required autocomplete="off"></label>${dept(a.department)}${date}${site}${loc}${notes()}`);
    case 'check_in': return `<p class="note" style="margin:0">Returning from <b>${esc(a.assigned_to || '—')}</b>.</p>` + g(`${date}${site}${loc}${notes('Condition / notes')}`);
    case 'repair': return g(`${date}${vendor}${cost('Estimated cost')}${notes('Problem description', true)}`);
    case 'repair_done': return `<p class="note" style="margin:0">${a.assigned_to ? `Goes back to <b>${esc(a.assigned_to)}</b> as checked out.` : 'Becomes available again.'}</p>` + g(`${date}${vendor}${cost('Final repair cost')}${notes('Work done')}`);
    case 'broken': case 'lost': return g(`${date}${notes('What happened', true)}`);
    case 'dispose': return g(`${date}<label class="f">Method<select name="method"><option>Scrapped / e-waste</option><option>Sold</option><option>Donated</option><option>Returned to vendor</option><option>Other</option></select></label>${cost('Sale value (if sold)')}${notes()}`);
    case 'restore': return g(`${date}${notes('Reason')}`);
    case 'move': return g(`${site}${loc}${dept(a.department)}${date}${notes()}`);
    case 'note': return g(`${date}${notes('Note', true)}`);
    default: return '';
  }
}

async function runAction(action, a) {
  return modal({
    title: `${ACTION_BUTTON[action]} — ${a.tag}`,
    body: actionForm(action, a),
    submit: ACTION_BUTTON[action],
    danger: action === 'dispose',
    onSubmit: async (form) => {
      if (!form.reportValidity()) throw new Error('Please fill in the required fields.');
      const fd = Object.fromEntries(new FormData(form));
      const args = { p_asset_id: a.id, p_action: action };
      for (const k of ['p_event_date', 'p_assigned_to', 'p_department', 'p_site', 'p_location', 'p_vendor', 'p_notes']) if (k in fd) args[k] = fd[k] || null;
      if (fd.p_cost) args.p_cost = Number(fd.p_cost);
      if (action === 'dispose') args.p_notes = [fd.method, fd.p_notes].filter(Boolean).join(' — ');
      await store.db.rpc('asset_action', args);
    },
  });
}

const dd = (label, v, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${v || '<span class="muted">—</span>'}</dd></div>`;

export async function assetView(main, params, id) {
  const [rows, events] = await Promise.all([
    store.db.select('assets', { id: 'eq.' + id, select: '*' }),
    store.db.select('asset_events', { asset_id: 'eq.' + id, select: '*', order: 'created_at.desc' }),
  ]);
  let programs = [];
  let devices = [];
  let usageDays = [];
  let searches = [];
  let health = [];
  let lockRow = null;
  try {
    devices = await store.db.select('agent_devices', {
      asset_id: 'eq.' + id,
      select: 'hostname,public_ip,local_ip,country_code,country_name,city,outside_uae,location_at,last_seen',
      order: 'last_seen.desc',
      limit: '3',
    }) || [];
  } catch { devices = []; }
  try {
    [usageDays, searches] = await Promise.all([
      store.db.select('device_days', { asset_id: 'eq.' + id, select: 'activity_date,active_seconds', order: 'activity_date.desc', limit: '7' }),
      store.db.select('web_searches', { asset_id: 'eq.' + id, select: 'query,engine,searched_at', order: 'searched_at.desc', limit: '8' }),
    ]);
  } catch { usageDays = []; searches = []; }
  try {
    programs = await store.db.select('installed_software', {
      asset_id: 'eq.' + id,
      removed_at: 'is.null',
      select: 'name,version,publisher,installed_on,last_seen',
      order: 'name.asc',
      limit: '500',
    }) || [];
  } catch { programs = []; }
  try {
    health = await store.db.select('device_health', { asset_id: 'eq.' + id, select: '*', limit: '1' }) || [];
  } catch { health = []; }
  try {
    const locks = await store.db.select('laptop_controls', { asset_id: 'eq.' + id, select: 'locked,lock_reason', limit: '1' });
    lockRow = locks?.[0] || null;
  } catch { lockRow = null; }
  const a = rows[0];
  if (!a) { main.innerHTML = '<div class="empty">Asset not found. <a href="#/assets">Back to assets</a></div>'; return; }
  loadAssets().catch(() => {});   // for suggestions in action forms

  const acts = ACTIONS_FOR[a.status] || ['note'];
  const span = (seconds) => {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  main.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/assets" class="muted" style="display:inline-flex;align-items:center;gap:4px">${icon('back')} Assets</a>
        <h1 style="margin-top:6px" class="row"><span class="mono" style="font-size:19px">${esc(a.tag)}</span> <span class="badge st-${a.status}">${STATUS[a.status]?.label}</span></h1>
        <p>${esc([a.description, a.brand, a.model].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="row">
        <a class="btn" href="#/asset/${a.id}/edit">${icon('edit')} Edit</a>
        <button class="btn danger" id="del">${icon('trash')} Delete</button>
      </div>
    </div>
    ${lockRow?.locked ? `<div class="err" style="margin-bottom:16px"><strong>Locked by IT.</strong> ${esc(lockRow.lock_reason || 'This asset should not be used until an admin unlocks it in Control.')}</div>` : ''}
    <div class="grid-3">
      <div class="stack">
        <div class="card"><div class="card-b actions">
          ${acts.map((x, i) => `<button class="btn ${i === 0 && x !== 'note' ? 'primary' : ''} ${x === 'dispose' ? 'danger' : ''}" data-act="${x}">${ACTION_BUTTON[x]}</button>`).join('')}
        </div></div>
        <div class="card"><div class="card-h"><h2>Details</h2></div><div class="card-b"><dl class="dl">
          ${dd('Assigned to', a.assigned_to ? `<b>${esc(a.assigned_to)}</b>` : '')}
          ${dd('Department', esc(a.department))}
          ${dd('Site', esc(a.site))}
          ${dd('Location', esc(a.location))}
          ${dd('Category', esc(a.category))}
          ${dd('Brand', esc(a.brand))}
          ${dd('Model', esc(a.model))}
          ${dd('Serial no', esc(a.serial_no), 'mono')}
          ${dd('Configuration', esc(a.configuration))}
          ${dd('Purchase date', fmtDate(a.purchase_date))}
          ${dd('Purchase cost', fmtMoney(a.purchase_cost))}
          ${dd('Vendor', esc(a.vendor))}
          ${dd('Warranty expiry', fmtDate(a.warranty_expiry))}
          ${dd('Last event', fmtDate(a.last_event_date))}
          ${dd('Created', fmtDateTime(a.created_at))}
          ${a.notes ? `<div style="grid-column:1/-1"><dt>Notes</dt><dd style="white-space:pre-wrap">${esc(a.notes)}</dd></div>` : ''}
        </dl></div></div>
        <div class="card"><div class="card-h"><h2>History</h2><span class="muted">${events.length} events</span></div><div class="card-b">
          ${events.length ? `<ul class="timeline">${events.map(e => `
            <li><span class="tl-dot" style="background:${STATUS[e.to_status]?.color || 'var(--muted)'}"></span><div>
              <div class="tl-title">${esc(ACTION_LABEL[e.action] || e.action)}${e.assigned_to && ['check_out', 'check_in', 'imported', 'created', 'dispose'].includes(e.action) ? ` · ${esc(e.assigned_to)}` : ''}</div>
              <div class="tl-meta">${fmtDate(e.event_date)} · by ${esc(e.performed_by)}${e.from_status && e.to_status && e.from_status !== e.to_status ? ` · ${STATUS[e.from_status]?.label || e.from_status} → ${STATUS[e.to_status]?.label || e.to_status}` : ''}</div>
              ${[e.department && e.action === 'check_out' ? 'Dept: ' + e.department : '', e.vendor ? 'Vendor: ' + e.vendor : '', e.cost != null ? 'Cost: ' + fmtMoney(e.cost) : '', e.action === 'move' ? [e.site, e.location].filter(Boolean).join(' / ') : '']
                .filter(Boolean).map(x => `<div class="tl-meta">${esc(x)}</div>`).join('')}
              ${e.notes ? `<div style="margin-top:2px;white-space:pre-wrap">${esc(e.notes)}</div>` : ''}
            </div></li>`).join('')}</ul>` : '<div class="muted">No history yet.</div>'}
        </div></div>
      </div>
      <div class="card"><div class="card-b qr-box">
        ${qrSvg(assetUrl(a.id))}
        <div class="mono">${esc(a.tag)}</div>
        <div class="muted" style="font-size:12.5px">Scan with a phone camera to open this page.</div>
        <button class="btn" id="label">${icon('print')} Print label</button>
      </div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Usage</h2><a href="#/usage?asset=${esc(a.id)}">Open usage</a></div>
      ${usageDays.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th>Active</th></tr></thead><tbody>
        ${usageDays.map(d => `<tr><td>${esc(d.activity_date)}</td><td>${span(d.active_seconds)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No active time yet.</div>'}
      ${searches.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Engine</th><th>Search</th></tr></thead><tbody>
        ${searches.map(s => `<tr><td>${fmtDateTime(s.searched_at)}</td><td>${esc(s.engine)}</td><td>${esc(s.query)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No searches recorded yet. Only searches made after Mulk Agent starts watching are kept.</div>'}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Network location</h2><a href="#/alerts">Alerts</a></div>
      ${devices.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Computer</th><th>Place</th><th>Public IP</th><th>Local IP</th><th>Checked</th></tr></thead><tbody>
        ${devices.map(d => `<tr>
          <td>${esc(d.hostname || '')}</td>
          <td>${d.country_code ? `<span class="badge ${d.outside_uae ? 'st-broken' : 'st-available'}">${d.outside_uae ? 'Outside UAE' : 'Inside UAE'}</span> ` : ''}${esc([d.city, d.country_name || d.country_code].filter(Boolean).join(', '))}</td>
          <td class="mono">${esc(d.public_ip || '')}</td>
          <td class="mono">${esc(d.local_ip || '')}</td>
          <td class="sub">${fmtDateTime(d.location_at || d.last_seen)}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No agent on this asset yet. On a laptop or desktop, Mulk Agent records the public IP and the city and country of that IP.</div>'}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Health</h2><a href="#/control">Control</a></div>
      ${health.length ? `<div class="card-b"><dl class="dl">
        ${dd('Computer', esc([health[0].manufacturer, health[0].model].filter(Boolean).join(' ')))}
        ${dd('Serial reported', esc(health[0].serial_number), 'mono')}
        ${dd('Memory', health[0].ram_gb != null ? esc(String(health[0].ram_gb)) + ' GB' : '')}
        ${dd('System disk', health[0].disk_free_gb != null ? esc(String(health[0].disk_free_gb)) + ' GB free' + (health[0].disk_gb != null ? ' of ' + esc(String(health[0].disk_gb)) + ' GB' : '') : '')}
        ${dd('BitLocker', esc(health[0].bitlocker))}
        ${dd('Defender', esc(health[0].defender) + (health[0].defender_age_hours != null ? ' · signatures ' + esc(String(health[0].defender_age_hours)) + 'h' : ''))}
        ${dd('Firewall', esc(health[0].firewall))}
        ${dd('Restart waiting', health[0].pending_reboot ? 'Yes' : 'No')}
        ${dd('Local administrators', esc(health[0].local_admins))}
        ${dd('Startup names', esc(health[0].startup_names))}
        ${dd('Reported', fmtDateTime(health[0].reported_at))}
      </dl></div>` : '<div class="empty">No health report yet. Mulk Agent sends encryption, Defender, firewall, disk space, the serial number, local administrator names, and startup program names. It does not read files.</div>'}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Installed software</h2><a href="#/alerts?asset=${esc(a.id)}">${programs.length ? programs.length + ' installed' : 'Alerts'}</a></div>
      ${programs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Program</th><th>Version</th><th>Publisher</th><th>Installed</th><th>Last seen</th></tr></thead><tbody>
        ${programs.map(p => `<tr>
          <td>${esc(p.name)}</td>
          <td class="sub">${esc(p.version || '')}</td>
          <td class="sub">${esc(p.publisher || '')}</td>
          <td class="sub">${fmtDate(p.installed_on)}</td>
          <td class="sub">${fmtDateTime(p.last_seen)}</td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No software list yet. On a laptop or desktop, Mulk Agent sends the Windows uninstall list: program name, version, and publisher. The first report is the baseline. A program installed after that is an alert.</div>'}
    </div>`;

  main.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    if (b.dataset.act === 'check_out' && lockRow?.locked) {
      toast('This asset is locked. Unlock it in Control before checking it out.', true);
      return;
    }
    if (await runAction(b.dataset.act, a)) {
      invalidate();
      toast(`${ACTION_LABEL[b.dataset.act] || 'Saved'} — ${a.tag}`);
      assetView(main, params, id);
    }
  });
  $('#label').onclick = () => { setLabelSelection([a.id]); location.hash = '#/labels'; };
  $('#del').onclick = async () => {
    const ok = await modal({
      title: 'Delete asset?',
      body: `<p style="margin:0">This permanently removes <b class="mono">${esc(a.tag)}</b> and its whole history. If the item has left the company, use <b>Dispose</b> instead so the record is kept.</p>
             <label class="f">Type the asset tag to confirm<input name="confirm" autocomplete="off"></label>`,
      submit: 'Delete permanently', danger: true,
      onSubmit: async (form) => {
        if (form.confirm.value.trim() !== a.tag) throw new Error('The tag does not match.');
        await store.db.remove('assets', { id: 'eq.' + a.id });
      },
    });
    if (ok) { invalidate(); toast('Asset deleted'); location.hash = '#/assets'; }
  };
}

// ---------------- create / edit ----------------
const EDIT_FIELDS = [
  ['tag', 'Asset tag ID', 'text', true], ['description', 'Description', 'text', true],
  ['category', 'Category', 'list'], ['brand', 'Brand', 'list'], ['model', 'Model', 'text'], ['serial_no', 'Serial no', 'text'],
  ['site', 'Site', 'list'], ['location', 'Location', 'list'], ['department', 'Department', 'list'],
  ['purchase_date', 'Purchase date', 'date'], ['purchase_cost', 'Purchase cost', 'number'], ['vendor', 'Vendor', 'list'],
  ['warranty_expiry', 'Warranty expiry', 'date'],
  ['configuration', 'Configuration (specs, IP address…)', 'textarea'], ['notes', 'Notes', 'textarea'],
];

export async function assetFormView(main, params, id) {
  const assets = await loadAssets();
  let a = {};
  if (id) {
    const rows = await store.db.select('assets', { id: 'eq.' + id, select: '*' });
    a = rows[0];
    if (!a) { main.innerHTML = '<div class="empty">Asset not found.</div>'; return; }
  }
  const isNew = !id;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <a href="${isNew ? '#/assets' : '#/asset/' + a.id}" class="muted" style="display:inline-flex;align-items:center;gap:4px">${icon('back')} ${isNew ? 'Assets' : esc(a.tag)}</a>
        <h1 style="margin-top:6px">${isNew ? 'Add asset' : 'Edit asset'}</h1>
        ${isNew ? '<p>New assets start as Available. Use <b>Check out</b> on the next screen to assign it.</p>' : '<p>Status and assignment change through the action buttons on the asset page, so history stays complete.</p>'}
      </div>
    </div>
    <form class="card" id="af" novalidate>
      <div class="card-b stack">
        <div class="form-grid">
          ${EDIT_FIELDS.map(([k, l, type, req]) => {
            const v = a[k] ?? '';
            const r = req ? ' <span class="req">*</span>' : '';
            if (type === 'textarea') return `<label class="f wide">${l}<textarea name="${k}">${esc(v)}</textarea></label>`;
            if (k === 'tag') return `<label class="f">${l}${r}<div class="row" style="flex-wrap:nowrap"><input name="tag" value="${esc(v)}" required class="mono" autocomplete="off"><button type="button" class="btn" id="suggest" title="Suggest the next tag number">Suggest</button></div></label>`;
            if (type === 'list') return `<label class="f">${l}${r}<input name="${k}" list="dl-${k}" value="${esc(v)}" autocomplete="off">${datalist('dl-' + k, distinct(k, assets))}</label>`;
            return `<label class="f">${l}${r}<input name="${k}" type="${type}" ${type === 'number' ? 'step="0.01" min="0"' : ''} value="${esc(v)}" ${req ? 'required' : ''}></label>`;
          }).join('')}
        </div>
        <div class="err" hidden></div>
      </div>
      <div class="card-f" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--line-2)">
        <a class="btn" href="${isNew ? '#/assets' : '#/asset/' + a.id}">Cancel</a>
        <button class="btn primary">${isNew ? 'Create asset' : 'Save changes'}</button>
      </div>
    </form>`;

  const form = $('#af');
  const err = $('.err', form);
  const suggest = () => { form.tag.value = suggestTag({ category: form.category.value, location: form.location.value, site: form.site.value }, assets); };
  $('#suggest').onclick = suggest;
  if (isNew && params.category) form.category.value = params.category;

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = Object.fromEntries(new FormData(form));
    const vals = {};
    for (const [k, , type] of EDIT_FIELDS) {
      let v = String(fd[k] ?? '').trim();
      vals[k] = v === '' ? null : (type === 'number' ? Number(v) : v);
    }
    if (!vals.tag || !vals.description) { err.textContent = 'Asset tag and description are required.'; err.hidden = false; return; }
    const clash = assets.find(x => x.tag.toLowerCase() === vals.tag.toLowerCase() && x.id !== a.id);
    if (clash) { err.textContent = `Tag ${vals.tag} is already used by another asset.`; err.hidden = false; return; }
    const btn = form.querySelector('.primary'); btn.disabled = true;
    try {
      if (isNew) {
        const [row] = await store.db.insert('assets', [{ ...vals, status: 'available' }]);
        invalidate(); toast('Asset created');
        location.hash = '#/asset/' + row.id;
      } else {
        const changes = EDIT_FIELDS.filter(([k]) => String(a[k] ?? '') !== String(vals[k] ?? ''))
          .map(([k, l]) => `${l.replace(/ \(.*/, '')}: ${a[k] ?? '—'} → ${vals[k] ?? '—'}`);
        if (changes.length) {
          await store.db.update('assets', { id: 'eq.' + a.id }, vals);
          await store.db.insert('asset_events', [{ asset_id: a.id, action: 'edited', from_status: a.status, to_status: a.status, notes: changes.join('\n') }]);
        }
        invalidate(); toast(changes.length ? 'Changes saved' : 'No changes');
        location.hash = '#/asset/' + a.id;
      }
    } catch (ex) {
      err.textContent = /duplicate key/.test(ex.message) ? `Tag ${vals.tag} is already used.` : ex.message;
      err.hidden = false; btn.disabled = false;
    }
  };
}
