import { esc, icon, $, $$ } from '../ui.js';
import { store, loadAssets, distinct, STATUS, exportXlsx } from '../data.js';

const PAGE = 100;
const FILTERS = ['status', 'category', 'site', 'department', 'location'];
const COLS = [
  ['tag', 'Asset tag'], ['description', 'Description'], ['category', 'Category'], ['brand', 'Brand / model'],
  ['serial_no', 'Serial no'], ['status', 'Status'], ['assigned_to', 'Assigned to'], ['department', 'Department'], ['site', 'Site / location'],
];

export function setLabelSelection(ids) {
  store.labelIds = ids;
  try { sessionStorage.setItem('am.labels', JSON.stringify(ids)); } catch { /* ignore */ }
}

export function filterAssets(assets, f) {
  const words = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  return assets.filter(a => {
    for (const k of FILTERS) {
      if (!f[k]) continue;
      if (f[k] === '__none') { if (String(a[k] || '').trim()) return false; }
      else if (!eq(a[k], f[k])) return false;
    }
    if (!f.status && f.hideDisposed !== '0' && a.status === 'disposed') return false;
    if (words.length) {
      const hay = [a.tag, a.description, a.brand, a.model, a.serial_no, a.assigned_to, a.department, a.site, a.location, a.category, a.configuration, a.notes]
        .join(' ').toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

export async function assetsView(main, params) {
  const assets = await loadAssets();
  const f = { ...params };
  let sort = f.sort || 'tag', dir = f.dir || 'desc', page = 0;
  const selected = new Set();

  const opt = (field, label) => {
    const vals = field === 'status' ? Object.keys(STATUS) : distinct(field, assets);
    return `<select data-f="${field}" aria-label="${label}"><option value="">${label}: all</option>
      ${field !== 'status' ? `<option value="__none" ${f[field] === '__none' ? 'selected' : ''}>(blank)</option>` : ''}
      ${vals.map(v => `<option value="${esc(v)}" ${String(f[field] || '').toLowerCase() === v.toLowerCase() ? 'selected' : ''}>${esc(field === 'status' ? STATUS[v].label : v)}</option>`).join('')}</select>`;
  };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Assets</h1><p id="count"></p></div>
      <div class="row">
        <button class="btn" id="export">${icon('download')} Export Excel</button>
        <a class="btn primary" href="#/assets/new">${icon('plus')} Add asset</a>
      </div>
    </div>
    <div class="card">
      <div class="filters">
        <input class="search" type="search" id="q" placeholder="Search tag, serial, person, model…" value="${esc(f.q || '')}">
        ${opt('status', 'Status')}${opt('category', 'Category')}${opt('site', 'Site')}${opt('department', 'Department')}${opt('location', 'Location')}
      </div>
      <div class="selbar" id="selbar" hidden></div>
      <div class="tbl-wrap"><table class="tbl" id="tbl"></table></div>
      <div class="tbl-foot" id="foot"></div>
    </div>`;

  const syncUrl = () => {
    const p = {};
    for (const k of ['q', ...FILTERS, 'hideDisposed']) if (f[k]) p[k] = f[k];
    if (sort !== 'tag' || dir !== 'desc') { p.sort = sort; p.dir = dir; }
    const qs = new URLSearchParams(p).toString();
    history.replaceState(null, '', '#/assets' + (qs ? '?' + qs : ''));
  };

  const cmpVal = (a) => sort === 'brand' ? `${a.brand || ''} ${a.model || ''}` : sort === 'site' ? `${a.site || ''} ${a.location || ''}` : (a[sort] ?? '');
  const tagNum = (t) => { const m = String(t).match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : -1; };

  function current() {
    const rows = filterAssets(assets, f);
    rows.sort((a, b) => {
      let r;
      if (sort === 'tag') r = tagNum(a.tag) - tagNum(b.tag) || String(a.tag).localeCompare(String(b.tag));
      else r = String(cmpVal(a)).localeCompare(String(cmpVal(b)), undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? r : -r;
    });
    return rows;
  }

  function render() {
    const rows = current();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (page >= pages) page = pages - 1;
    const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
    const disposedHidden = !f.status && f.hideDisposed !== '0' ? assets.filter(a => a.status === 'disposed').length : 0;
    $('#count').innerHTML = `${rows.length} of ${assets.length} assets` +
      (disposedHidden ? ` · <a href="#" id="showdisp">${disposedHidden} disposed hidden — show</a>` : '');
    const allOnPage = slice.length && slice.every(a => selected.has(a.id));
    $('#tbl').innerHTML = `
      <thead><tr><th class="cb"><input type="checkbox" id="all" ${allOnPage ? 'checked' : ''} aria-label="Select page"></th>
        ${COLS.map(([k, l]) => `<th class="sortable" data-sort="${k}">${l}${sort === k ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
      <tbody>${slice.map(a => `
        <tr class="clickable" data-id="${a.id}">
          <td class="cb"><input type="checkbox" data-sel="${a.id}" ${selected.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.tag)}"></td>
          <td><a class="tag" href="#/asset/${a.id}">${esc(a.tag)}</a></td>
          <td>${esc(a.description || '')}<div class="sub">${esc((a.configuration || '').slice(0, 60))}</div></td>
          <td>${esc(a.category || '')}</td>
          <td>${esc(a.brand || '')}<div class="sub">${esc(a.model || '')}</div></td>
          <td class="mono">${esc(a.serial_no || '')}</td>
          <td><span class="badge st-${a.status}">${STATUS[a.status]?.label || esc(a.status)}</span></td>
          <td>${esc(a.assigned_to || '')}</td>
          <td>${esc(a.department || '')}</td>
          <td>${esc(a.site || '')}<div class="sub">${esc(a.location || '')}</div></td>
        </tr>`).join('')}</tbody>`;
    if (!slice.length) $('#tbl').insertAdjacentHTML('beforeend', `<tbody><tr><td colspan="10"><div class="empty">${assets.length ? 'No assets match these filters.' : 'No assets yet — <a href="#/import">import your spreadsheet</a> or <a href="#/assets/new">add one</a>.'}</div></td></tr></tbody>`);

    $('#foot').innerHTML = `<span>Showing ${rows.length ? page * PAGE + 1 : 0}–${page * PAGE + slice.length} of ${rows.length}</span>
      <span class="row">${(f.q || FILTERS.some(k => f[k])) ? '<button class="btn sm" id="clear">Clear filters</button>' : ''}
      <button class="btn sm" id="prev" ${page === 0 ? 'disabled' : ''}>Previous</button>
      <span>Page ${page + 1} / ${pages}</span>
      <button class="btn sm" id="next" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></span>`;
    renderSel();

    $('#showdisp')?.addEventListener('click', e => { e.preventDefault(); f.hideDisposed = '0'; syncUrl(); render(); });
    $('#prev').onclick = () => { page--; render(); };
    $('#next').onclick = () => { page++; render(); };
    $('#clear')?.addEventListener('click', () => { for (const k of ['q', ...FILTERS]) delete f[k]; $('#q').value = ''; $$('[data-f]').forEach(s => s.value = ''); page = 0; syncUrl(); render(); });
    $('#all').onchange = (e) => { slice.forEach(a => e.target.checked ? selected.add(a.id) : selected.delete(a.id)); render(); };
    $$('[data-sort]').forEach(th => th.onclick = () => { const k = th.dataset.sort; if (sort === k) dir = dir === 'asc' ? 'desc' : 'asc'; else { sort = k; dir = 'asc'; } syncUrl(); render(); });
    $$('#tbl tbody tr[data-id]').forEach(tr => tr.onclick = (e) => {
      if (e.target.closest('input,a')) return;
      location.hash = '#/asset/' + tr.dataset.id;
    });
    $$('[data-sel]').forEach(cb => cb.onchange = () => { cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel); renderSel(); $('#all').checked = slice.every(a => selected.has(a.id)); });
  }

  function renderSel() {
    const bar = $('#selbar');
    bar.hidden = selected.size === 0;
    bar.innerHTML = `${selected.size} selected
      <button class="btn sm" id="sel-labels">${icon('print')} Print QR labels</button>
      <button class="btn sm" id="sel-export">${icon('download')} Export selected</button>
      <button class="btn sm ghost" id="sel-clear">Clear selection</button>`;
    if (!selected.size) return;
    $('#sel-labels').onclick = () => { setLabelSelection([...selected]); location.hash = '#/labels'; };
    $('#sel-export').onclick = () => exportXlsx(assets.filter(a => selected.has(a.id)), `assets-selected-${new Date().toISOString().slice(0, 10)}.xlsx`);
    $('#sel-clear').onclick = () => { selected.clear(); render(); };
  }

  let t;
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); page = 0; syncUrl(); render(); }, 150); };
  $$('[data-f]').forEach(s => s.onchange = () => { const k = s.dataset.f; if (s.value) f[k] = s.value; else delete f[k]; page = 0; syncUrl(); render(); });
  $('#export').onclick = () => exportXlsx(current(), `assets-${new Date().toISOString().slice(0, 10)}.xlsx`);
  render();
  $('#q').focus();
}
