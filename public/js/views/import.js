import { esc, icon, toast, $ } from '../ui.js';
import { store, loadAssets, invalidate, parseWorkbook, STATUS, exportSheets } from '../data.js';

const CHUNK = 200;

export async function importView(main) {
  const assets = await loadAssets(true);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Import assets</h1><p>Upload an Excel export from AssetTiger (or any sheet with an <span class="mono">Asset Tag ID</span> column).</p></div>
      <button class="btn" id="tpl">${icon('download')} Download blank template</button>
    </div>
    <div class="stack">
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
        <div style="font-weight:600;color:var(--ink)">Choose a file or drop it here</div>
        <div style="margin-top:4px">.xlsx, .xls or .csv — rows are matched on Asset Tag ID: new tags are added, existing tags are updated.</div>
      </label>
      <div id="preview"></div>
    </div>`;

  $('#tpl').onclick = () => exportSheets([{ name: 'Assets', rows: [{
    'Asset Tag ID': 'MH/LAP/2026/HZF/114', 'Description': 'Laptop', 'Brand': 'Lenovo', 'Status': 'Available', 'Model': 'ThinkPad E14',
    'Serial No': 'PF123456', 'Site': 'HO', 'Assigned to': '', 'Location': 'Hamariyah', 'Category': 'Laptop', 'Department': '',
    'Configuration': 'i7/16GB/512GB', 'Purchase Date': '2026-10-01', 'Purchase Cost': 3200, 'Vendor': '', 'Warranty Expiry': '2029-10-01', 'Notes': '',
  }] }], 'asset-import-template.xlsx');

  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  $('#file').onchange = (e) => e.target.files[0] && handle(e.target.files[0]);

  async function handle(file) {
    const box = $('#preview');
    let parsed;
    try { parsed = parseWorkbook(await file.arrayBuffer()); }
    catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const { rows, warnings, unmapped } = parsed;
    const existing = new Set(assets.map(a => a.tag.toLowerCase()));
    const nNew = rows.filter(r => !existing.has(r.tag.toLowerCase())).length;
    const nUpd = rows.length - nNew;
    const byStatus = {};
    rows.forEach(r => byStatus[r.status] = (byStatus[r.status] || 0) + 1);

    box.innerHTML = `
      <div class="card">
        <div class="card-h"><h2>${esc(file.name)}</h2><span class="muted">${rows.length} rows ready</span></div>
        <div class="card-b stack">
          <div class="stats">
            <div><b>${nNew}</b><span>new assets</span></div>
            <div><b>${nUpd}</b><span>existing (will be updated)</span></div>
            ${Object.entries(byStatus).map(([s, n]) => `<div><b>${n}</b><span>${STATUS[s]?.label || s}</span></div>`).join('')}
          </div>
          ${unmapped.length ? `<div class="note">Columns not imported: ${unmapped.map(esc).join(', ')}</div>` : ''}
          ${warnings.length ? `<details class="note" ${warnings.length <= 5 ? 'open' : ''}><summary>${warnings.length} warning${warnings.length > 1 ? 's' : ''}</summary><ul style="margin:8px 0 0;padding-left:18px">${warnings.slice(0, 100).map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
          ${nUpd ? `<div class="note">For existing tags, status, assignment, site, location and department are replaced with the spreadsheet values; other fields are only filled in where the sheet has a value.</div>` : ''}
          <div class="tbl-wrap" style="max-height:340px;border:1px solid var(--line-2);border-radius:6px"><table class="tbl">
            <thead><tr><th></th><th>Tag</th><th>Description</th><th>Category</th><th>Brand / model</th><th>Serial</th><th>Status</th><th>Assigned to</th><th>Department</th><th>Site / location</th></tr></thead>
            <tbody>${rows.slice(0, 50).map(r => `<tr>
              <td>${existing.has(r.tag.toLowerCase()) ? '<span class="badge st-disposed">update</span>' : '<span class="badge st-available">new</span>'}</td>
              <td class="tag">${esc(r.tag)}</td><td>${esc(r.description)}</td><td>${esc(r.category)}</td>
              <td>${esc(r.brand)}<div class="sub">${esc(r.model)}</div></td><td class="mono">${esc(r.serial_no)}</td>
              <td><span class="badge st-${r.status}">${STATUS[r.status].label}</span></td><td>${esc(r.assigned_to)}</td>
              <td>${esc(r.department)}</td><td>${esc(r.site)}<div class="sub">${esc(r.location)}</div></td></tr>`).join('')}</tbody>
          </table></div>
          ${rows.length > 50 ? `<div class="muted">Showing first 50 of ${rows.length} rows.</div>` : ''}
          <div class="progress" hidden><div></div></div>
          <div class="err" hidden></div>
          <div class="row"><button class="btn primary" id="go" ${rows.length ? '' : 'disabled'}>Import ${rows.length} assets</button><button class="btn" id="cancel">Cancel</button></div>
        </div>
      </div>`;

    $('#cancel').onclick = () => { box.innerHTML = ''; $('#file').value = ''; };
    $('#go').onclick = async () => {
      const btn = $('#go'); btn.disabled = true; $('#cancel').disabled = true;
      const bar = box.querySelector('.progress'); bar.hidden = false;
      const err = box.querySelector('.err');
      let ins = 0, upd = 0;
      try {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const res = await store.db.rpc('import_assets_wrapper', { p_rows: rows.slice(i, i + CHUNK) });
          ins += res.inserted; upd += res.updated;
          bar.firstElementChild.style.width = `${Math.min(100, ((i + CHUNK) / rows.length) * 100)}%`;
        }
        invalidate();
        toast(`Imported: ${ins} new, ${upd} updated`);
        box.innerHTML = `<div class="card"><div class="card-b stack">
          <div class="stats"><div><b>${ins}</b><span>added</span></div><div><b>${upd}</b><span>updated</span></div></div>
          <div class="row"><a class="btn primary" href="#/assets">View assets</a><a class="btn" href="#/">Dashboard</a></div></div></div>`;
      } catch (e) {
        err.textContent = `Import stopped: ${e.message}. ${ins + upd} rows were saved before the error.`;
        err.hidden = false; btn.disabled = false; $('#cancel').disabled = false;
        invalidate();
      }
    };
  }
}
