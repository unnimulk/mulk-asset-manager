// Data layer: status/action definitions, cached asset list, tag suggestions, Excel import/export.

export const STATUS = {
  available:    { label: 'Available',    color: 'var(--s-available)' },
  checked_out:  { label: 'Checked out',  color: 'var(--s-checked_out)' },
  under_repair: { label: 'Under repair', color: 'var(--s-under_repair)' },
  broken:       { label: 'Broken',       color: 'var(--s-broken)' },
  lost:         { label: 'Lost / missing', color: 'var(--s-lost)' },
  disposed:     { label: 'Disposed',     color: 'var(--s-disposed)' },
};

export const ACTION_LABEL = {
  created: 'Created', imported: 'Imported', updated: 'Updated (import)', edited: 'Edited',
  check_out: 'Checked out', check_in: 'Checked in', repair: 'Sent for repair', repair_done: 'Returned from repair',
  broken: 'Marked broken', lost: 'Marked lost', dispose: 'Disposed', restore: 'Restored', move: 'Moved', note: 'Note',
};

// Which actions are offered for each status
export const ACTIONS_FOR = {
  available:    ['check_out', 'move', 'repair', 'broken', 'lost', 'dispose', 'note'],
  checked_out:  ['check_in', 'move', 'repair', 'broken', 'lost', 'dispose', 'note'],
  under_repair: ['repair_done', 'broken', 'dispose', 'note'],
  broken:       ['repair', 'restore', 'dispose', 'note'],
  lost:         ['restore', 'dispose', 'note'],
  disposed:     ['restore', 'note'],
};

export const ACTION_BUTTON = {
  check_out: 'Check out', check_in: 'Check in', repair: 'Send for repair', repair_done: 'Repair complete',
  broken: 'Mark broken', lost: 'Mark lost', dispose: 'Dispose', restore: 'Restore', move: 'Move', note: 'Add note',
};

export const FIELDS = [
  ['tag', 'Asset Tag ID'], ['description', 'Description'], ['category', 'Category'], ['brand', 'Brand'],
  ['model', 'Model'], ['serial_no', 'Serial No'], ['configuration', 'Configuration'], ['status', 'Status'],
  ['assigned_to', 'Assigned to'], ['department', 'Department'], ['site', 'Site'], ['location', 'Location'],
  ['purchase_date', 'Purchase date'], ['purchase_cost', 'Purchase cost'], ['vendor', 'Vendor'],
  ['warranty_expiry', 'Warranty expiry'], ['notes', 'Notes'], ['last_event_date', 'Event Date'], ['created_at', 'Date Created'],
];

export const store = { db: null, assets: null, loading: null };
export const ctx = { company: 'Mulk Holdings', user: null };

export async function loadAssets(force = false) {
  if (store.assets && !force) return store.assets;
  if (!store.loading) {
    store.loading = store.db.selectAll('assets', { select: '*', order: 'tag.asc' })
      .then(rows => { store.assets = rows; return rows; })
      .finally(() => { store.loading = null; });
  }
  return store.loading;
}
export const invalidate = () => { store.assets = null; };

export function distinct(field, rows = store.assets || []) {
  const m = new Map();
  for (const r of rows) {
    const v = (r[field] ?? '').toString().trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!m.has(k)) m.set(k, v);
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}

export function countBy(rows, field) {
  const m = new Map();
  for (const r of rows) {
    const v = (r[field] ?? '').toString().trim() || '—';
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ---- Tag suggestion, following the existing pattern e.g. MH/LAP/2026/HZF/112 ----
export function suggestTag({ category, location, site }, rows = store.assets || []) {
  const parse = (t) => {
    const p = String(t || '').split('/');
    return p.length === 5 ? { prefix: p[0], code: p[1], year: p[2], loc: p[3], num: p[4] } : null;
  };
  const parsed = rows.map(r => ({ r, p: parse(r.tag) })).filter(x => x.p);
  const newest = (list) => list.sort((a, b) => String(b.r.created_at).localeCompare(String(a.r.created_at)))[0];
  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  const prefix = (newest([...parsed]) || {}).p?.prefix || 'MH';
  const byCat = newest(parsed.filter(x => category && eq(x.r.category, category)));
  const code = byCat ? byCat.p.code : (String(category || 'AST').replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase() || 'AST');
  const byLoc = newest(parsed.filter(x => location && eq(x.r.location, location)))
             || newest(parsed.filter(x => site && eq(x.r.site, site)));
  const loc = byLoc ? byLoc.p.loc : (String(location || site || 'HO').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'HO');
  // running serial is shared across categories (…/109, …/110, …/111)
  const nums = parsed.map(x => parseInt(x.p.num, 10)).filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const width = Math.max(3, String(next).length);
  let tag;
  let n = next;
  const taken = new Set(rows.map(r => String(r.tag).toLowerCase()));
  do { tag = `${prefix}/${code}/${new Date().getFullYear()}/${loc}/${String(n).padStart(width, '0')}`; n++; }
  while (taken.has(tag.toLowerCase()));
  return tag;
}

// ---------------- Excel import ----------------
const HEADER_MAP = {
  assettagid: 'tag', assettag: 'tag', tag: 'tag', tagid: 'tag', assetid: 'tag',
  description: 'description', name: 'description', assetname: 'description',
  brand: 'brand', make: 'brand', manufacturer: 'brand',
  model: 'model', status: 'status',
  serialno: 'serial_no', serialnumber: 'serial_no', serial: 'serial_no',
  site: 'site', location: 'location', category: 'category', department: 'department',
  assignedto: 'assigned_to', checkedoutto: 'assigned_to', assignee: 'assigned_to', employee: 'assigned_to',
  configuration: 'configuration', config: 'configuration', specs: 'configuration', specification: 'configuration',
  datecreated: 'created_at', createdat: 'created_at',
  eventdate: 'last_event_date', lasteventdate: 'last_event_date',
  purchasedate: 'purchase_date', dateacquired: 'purchase_date',
  cost: 'purchase_cost', purchasecost: 'purchase_cost', price: 'purchase_cost',
  purchasedfrom: 'vendor', vendor: 'vendor', supplier: 'vendor',
  warrantyexpiry: 'warranty_expiry', warrantyexpires: 'warranty_expiry', warranty: 'warranty_expiry',
  notes: 'notes', note: 'notes', remarks: 'notes',
};
const DATE_FIELDS = new Set(['created_at', 'last_event_date', 'purchase_date', 'warranty_expiry']);

export function mapStatus(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 'available';
  if (s.startsWith('checkedout') || s === 'inuse' || s === 'assigned' || s.startsWith('leased')) return 'checked_out';
  if (s.startsWith('available') || s === 'instock' || s === 'checkedin') return 'available';
  if (s.includes('repair') || s.includes('maintenance')) return 'under_repair';
  if (s.includes('broken') || s.includes('damaged') || s.includes('faulty')) return 'broken';
  if (s.includes('lost') || s.includes('missing') || s.includes('stolen')) return 'lost';
  if (s.includes('dispos') || s.includes('sold') || s.includes('scrap') || s.includes('donated') || s.includes('retired')) return 'disposed';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
function toISODate(v, withTime = false) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {                       // Excel serial date
    const d = window.XLSX.SSF.parse_date_code(v);
    if (!d) return '';
    const date = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    return withTime ? `${date}T${pad(d.H)}:${pad(d.M)}:00` : date;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?)?$/i); // dd/mm/yyyy [hh:mm AM]
  if (m) {
    const date = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    if (!withTime || !m[4]) return date;
    let h = parseInt(m[4], 10);
    if (m[6]) { const pm = m[6].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return `${date}T${pad(h)}:${m[5]}:00`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return withTime ? s : `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

// Returns { rows, warnings, columns, unmapped }
export function parseWorkbook(buffer) {
  const wb = window.XLSX.read(buffer, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const headerIdx = raw.findIndex(r => r.some(c => HEADER_MAP[String(c).toLowerCase().replace(/[^a-z]/g, '')] === 'tag'));
  if (headerIdx < 0) throw new Error('Could not find an "Asset Tag ID" column in the first sheet.');
  const header = raw[headerIdx].map(h => String(h).trim());
  const keys = header.map(h => HEADER_MAP[h.toLowerCase().replace(/[^a-z]/g, '')] || null);
  const unmapped = header.filter((h, i) => h && !keys[i]);
  const warnings = [];
  const seen = new Map();
  const rows = [];
  raw.slice(headerIdx + 1).forEach((r, i) => {
    const line = headerIdx + i + 2;
    const o = {};
    keys.forEach((k, j) => {
      if (!k) return;
      let v = r[j];
      if (DATE_FIELDS.has(k)) v = toISODate(v, k === 'created_at');
      else if (k === 'purchase_cost') { const n = parseFloat(String(v).replace(/[^0-9.-]/g, '')); v = isNaN(n) ? '' : n; }
      else v = String(v ?? '').replace(/\s+/g, ' ').trim();
      o[k] = v;
    });
    if (!o.tag) { if (Object.values(o).some(Boolean)) warnings.push(`Row ${line}: no Asset Tag ID — skipped`); return; }
    const st = mapStatus(o.status);
    if (st === null) { warnings.push(`Row ${line} (${o.tag}): unknown status "${o.status}" — set to Available`); o.status = 'available'; }
    else o.status = st;
    if (o.status !== 'checked_out' && o.assigned_to) { /* keep: AssetTiger sometimes keeps last user */ }
    let k = o.tag.toLowerCase();
    if (seen.has(k)) {
      const first = rows.find(x => x.tag.toLowerCase() === k);
      if (JSON.stringify(first) === JSON.stringify(o)) { warnings.push(`Row ${line}: exact duplicate of row ${seen.get(k)} — skipped`); return; }
      // Two different assets share a tag in the source system: keep both, give the second a suffix
      let n = 2, t;
      do { t = `${o.tag}-${n++}`; } while (seen.has(t.toLowerCase()));
      warnings.push(`Row ${line}: tag ${o.tag} is also used by row ${seen.get(k)} for a different item — imported as ${t}, please re-tag it`);
      o.tag = t; k = t.toLowerCase();
    }
    seen.set(k, line);
    rows.push(o);
  });
  return { rows, warnings, columns: header.filter(Boolean), unmapped };
}

// ---------------- Excel export ----------------
export function exportXlsx(rows, filename, sheetName = 'Assets') {
  const data = rows.map(a => ({
    'Asset Tag ID': a.tag, 'Description': a.description || '', 'Category': a.category || '',
    'Brand': a.brand || '', 'Model': a.model || '', 'Serial No': a.serial_no || '',
    'Status': STATUS[a.status]?.label || a.status, 'Assigned to': a.assigned_to || '',
    'Department': a.department || '', 'Site': a.site || '', 'Location': a.location || '',
    'Configuration': a.configuration || '', 'Purchase Date': a.purchase_date || '',
    'Purchase Cost': a.purchase_cost ?? '', 'Vendor': a.vendor || '', 'Warranty Expiry': a.warranty_expiry || '',
    'Event Date': a.last_event_date || '', 'Notes': a.notes || '',
    'Date Created': a.created_at ? String(a.created_at).slice(0, 10) : '',
  }));
  exportSheets([{ name: sheetName, rows: data }], filename);
}

export function exportSheets(sheets, filename) {
  const X = window.XLSX;
  const wb = X.utils.book_new();
  for (const s of sheets) {
    const ws = X.utils.json_to_sheet(s.rows.length ? s.rows : [{ '': 'No records' }]);
    const cols = Object.keys(s.rows[0] || {});
    ws['!cols'] = cols.map(c => ({ wch: Math.min(45, Math.max(c.length + 2, ...s.rows.slice(0, 300).map(r => String(r[c] ?? '').length + 1))) }));
    X.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  X.writeFile(wb, filename);
}
