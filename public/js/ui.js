// Small UI helpers: escaping, icons, toasts, modals, formatting.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = {
  dash: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-6"/>',
  qr: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  out: '<path d="M14 4h6v16h-6M10 8l-4 4 4 4M6 12h11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><path d="M7 14h10v7H7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
};
export const icon = (name) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

let toastTimer;
export function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2600);
}

// Opens a modal. `body` is HTML; onSubmit(form) may throw to show an error. Resolves true when submitted.
export function modal({ title, body, submit = 'Save', danger = false, cancel = 'Cancel', onSubmit }) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <form class="modal" novalidate>
        <div class="card-h"><h2>${esc(title)}</h2><button type="button" class="btn ghost icon-btn" data-x aria-label="Close">✕</button></div>
        <div class="card-b stack">${body}<div class="err" hidden></div></div>
        <div class="card-f">
          <button type="button" class="btn" data-x>${esc(cancel)}</button>
          <button type="submit" class="btn ${danger ? 'danger solid' : 'primary'}">${esc(submit)}</button>
        </div>
      </form>`;
    const form = bg.querySelector('form');
    const errBox = bg.querySelector('.err');
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(false); });
    bg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => close(false));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; errBox.hidden = true;
      try { if (onSubmit) await onSubmit(form); close(true); }
      catch (err) { errBox.textContent = err.message || String(err); errBox.hidden = false; btn.disabled = false; }
    };
    document.body.appendChild(bg);
    const first = form.querySelector('.card-b input, .card-b select, .card-b textarea');
    (first || form.querySelector('[type=submit]')).focus();
  });
}

export const confirmBox = (title, text, submit = 'Confirm', danger = true) =>
  modal({ title, body: `<p style="margin:0">${esc(text)}</p>`, submit, danger });

export function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  if (isNaN(dt)) return s;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const fmtMoney = (n) => n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function datalist(id, values) {
  return `<datalist id="${esc(id)}">${values.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
}

export function qrSvg(text, cell = 4) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: cell, margin: 0, scalable: true });
}
