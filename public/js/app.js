import { createClient } from './supa.js';
import { esc, icon, toast, $ } from './ui.js';
import { store, invalidate, ctx } from './data.js';
import { dashboardView } from './views/dashboard.js';
import { assetsView } from './views/assets.js';
import { assetView, assetFormView } from './views/asset.js';
import { importView } from './views/import.js';
import { activityView, reportsView, labelsView, settingsView } from './views/misc.js';

const app = document.getElementById('app');

const NAV = [
  ['/', 'Dashboard', 'dash'],
  ['/assets', 'Assets', 'box'],
  ['/assets/new', 'Add asset', 'plus'],
  ['/activity', 'Activity', 'clock'],
  ['/reports', 'Reports', 'chart'],
  ['/import', 'Import', 'upload'],
  ['/labels', 'QR labels', 'qr'],
  ['/settings', 'Admins', 'users'],
];

const ROUTES = [
  [/^\/$/, dashboardView],
  [/^\/assets$/, assetsView],
  [/^\/assets\/new$/, (m, p) => assetFormView(m, p, null)],
  [/^\/asset\/([^/]+)\/edit$/, (m, p, id) => assetFormView(m, p, id)],
  [/^\/asset\/([^/]+)$/, (m, p, id) => assetView(m, p, id)],
  [/^\/import$/, importView],
  [/^\/activity$/, activityView],
  [/^\/reports$/, reportsView],
  [/^\/labels$/, labelsView],
  [/^\/settings$/, settingsView],
];

export function go(path) { location.hash = '#' + path; }

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function loadConfig() {
  let cfg = { ...(window.APP_CONFIG || {}) };
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      for (const k of Object.keys(j)) if (j[k]) cfg[k] = j[k];
    }
  } catch { /* running without the Vercel function */ }
  return cfg;
}

function brand() {
  return `<div class="brand"><img src="/favicon.svg" alt=""><div>IT Assets<small>${esc(ctx.company)}</small></div></div>`;
}

// ---------------- auth screens ----------------
function loginScreen(message = '') {
  app.innerHTML = `
    <div class="login">
      <form class="card" id="login-form">
        <div class="card-b">
          ${brand()}
          <div><h1>Sign in</h1><p class="muted" style="margin:4px 0 0">IT administrators only.</p></div>
          ${message ? `<div class="note">${esc(message)}</div>` : ''}
          <label class="f">Work e-mail<input name="email" type="email" autocomplete="username" required></label>
          <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
          <div class="err" hidden></div>
          <button class="btn primary" style="justify-content:center">Sign in</button>
          <button type="button" class="btn ghost" id="forgot" style="justify-content:center">Forgot password?</button>
        </div>
      </form>
    </div>`;
  const form = $('#login-form');
  const err = $('.err', form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('.primary'); btn.disabled = true;
    try {
      await store.db.signIn(form.email.value.trim(), form.password.value);
      await start();
    } catch (ex) {
      err.textContent = ex.status === 400 ? 'Wrong e-mail or password.' : ex.message;
      err.hidden = false; btn.disabled = false;
    }
  };
  $('#forgot').onclick = async () => {
    const email = form.email.value.trim();
    if (!email) { err.textContent = 'Type your e-mail first, then click "Forgot password?".'; err.hidden = false; return; }
    try { await store.db.sendReset(email, location.origin + '/'); toast('Password reset e-mail sent'); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

function setPasswordScreen(kind) {
  app.innerHTML = `
    <div class="login">
      <form class="card" id="pw-form">
        <div class="card-b">
          ${brand()}
          <div><h1>${kind === 'invite' ? 'Welcome — set your password' : 'Choose a new password'}</h1>
          <p class="muted" style="margin:4px 0 0">${esc(store.db.session?.user?.email || '')}</p></div>
          <label class="f">New password<input name="p1" type="password" minlength="8" autocomplete="new-password" required></label>
          <label class="f">Repeat password<input name="p2" type="password" minlength="8" autocomplete="new-password" required></label>
          <div class="err" hidden></div>
          <button class="btn primary" style="justify-content:center">Save password</button>
        </div>
      </form>
    </div>`;
  const form = $('#pw-form'); const err = $('.err', form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.p1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; err.hidden = false; return; }
    if (form.p1.value !== form.p2.value) { err.textContent = 'The passwords do not match.'; err.hidden = false; return; }
    try { await store.db.updatePassword(form.p1.value); toast('Password saved'); history.replaceState(null, '', '/#/'); await start(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

function notAdminScreen() {
  app.innerHTML = `
    <div class="login"><div class="card"><div class="card-b">
      ${brand()}
      <h1>No access</h1>
      <p class="muted" style="margin:0">${esc(store.db.session?.user?.email || 'This account')} is signed in but is not on the IT admin list. Ask an existing admin to add you under <b>Admins</b>.</p>
      <button class="btn" id="so">Sign out</button>
    </div></div></div>`;
  $('#so').onclick = async () => { await store.db.signOut(); loginScreen(); };
}

function setupScreen() {
  app.innerHTML = `
    <div class="login"><div class="card"><div class="card-b">
      ${brand()}
      <h1>Almost there</h1>
      <p class="muted" style="margin:0">The app is not connected to Supabase yet. In Vercel, add the environment variables
      <span class="mono">SUPABASE_URL</span> and <span class="mono">SUPABASE_ANON_KEY</span>, then redeploy.
      See README.md for the step-by-step guide.</p>
    </div></div></div>`;
}

// ---------------- shell + router ----------------
function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        ${brand()}
        <nav class="nav">${NAV.map(([p, l, i]) => `<a href="#${p}" data-path="${p}">${icon(i)}<span>${l}</span></a>`).join('')}</nav>
        <div class="foot">${esc(ctx.user?.email || '')}<br><button class="btn sm" id="signout">${icon('out')} Sign out</button></div>
      </aside>
      <div>
        <div class="topbar"><button class="btn icon-btn" id="menu" aria-label="Menu">${icon('menu')}</button><span>IT Assets</span></div>
        <main class="main" id="main"></main>
      </div>
    </div>`;
  $('#signout').onclick = async () => { await store.db.signOut(); invalidate(); loginScreen('You have been signed out.'); };
  $('#menu').onclick = () => $('.shell').classList.toggle('menu-open');
}

let routeSeq = 0;
async function route() {
  if (!$('#main')) return;
  const { path, params } = parseHash();
  $('.shell')?.classList.remove('menu-open');
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  document.querySelectorAll('.nav a').forEach(a => {
    const p = a.dataset.path;
    a.classList.toggle('on', p === path || (p === '/assets' && path.startsWith('/asset') && path !== '/assets/new'));
  });
  const main = $('#main');
  const seq = ++routeSeq;
  for (const [re, view] of ROUTES) {
    const m = path.match(re);
    if (m) {
      main.innerHTML = '<div class="muted" style="padding:20px 0">Loading…</div>';
      try {
        await view(main, params, ...m.slice(1).map(decodeURIComponent));
      } catch (e) {
        if (seq !== routeSeq) return;
        console.error(e);
        if (e.status === 401) { loginScreen('Your session expired. Please sign in again.'); return; }
        main.innerHTML = `<div class="err">Something went wrong: ${esc(e.message)}</div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = '<div class="empty">Page not found. <a href="#/">Go to dashboard</a></div>';
}

let routed = false;
async function start() {
  ctx.user = store.db.session?.user || null;
  let ok = false;
  try { ok = await store.db.rpc('is_admin'); }
  catch (e) { if (e.status === 401) { await store.db.signOut(); return loginScreen('Please sign in again.'); } throw e; }
  if (!ok) return notAdminScreen();
  renderShell();
  if (!routed) { window.addEventListener('hashchange', route); routed = true; }
  let pending = null;
  try { pending = sessionStorage.getItem('am.after'); sessionStorage.removeItem('am.after'); } catch { /* ignore */ }
  if (pending) location.hash = pending;
  route();
}

(async function boot() {
  const cfg = await loadConfig();
  if (cfg.companyName) ctx.company = cfg.companyName;
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return setupScreen();
  store.db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Links from Supabase e-mails arrive as #access_token=…&type=invite|recovery
  if (/access_token=/.test(location.hash)) {
    const type = await store.db.consumeUrlSession(location.hash);
    history.replaceState(null, '', '/#/');
    if (type === 'invite' || type === 'recovery') return setPasswordScreen(type);
  }
  if (/error_description=/.test(location.hash)) {
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', '/#/');
    return loginScreen(p.get('error_description') || 'That link is invalid or has expired.');
  }

  if (!store.db.session) {
    // remember where a scanned QR code wanted to go
    if (location.hash && location.hash !== '#/' ) { try { sessionStorage.setItem('am.after', location.hash); } catch { /* ignore */ } }
    return loginScreen();
  }
  try { await start(); }
  catch (e) { loginScreen(e.message); }
})();
