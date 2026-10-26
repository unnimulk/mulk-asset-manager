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
  const a = rows[0];
  if (!a) { main.innerHTML = '<div class="empty">Asset not found. <a href="#/assets">Back to assets</a></div>'; return; }
  loadAssets().catch(() => {});   // for suggestions in action forms

  const acts = ACTIONS_FOR[a.status] || ['note'];
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
    </div>`;

  main.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
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
