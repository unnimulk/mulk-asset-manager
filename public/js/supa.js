// Minimal Supabase client (auth + PostgREST) using fetch only — no build step needed.
const SESSION_KEY = 'am.session';

function store(get, value) {
  try {
    if (get) return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch { return null; }
}

export class SupaError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

async function parse(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.msg || body.error_description || body.error)) || res.statusText || 'Request failed';
    throw new SupaError(msg, res.status, body);
  }
  return body;
}

export function createClient(url, anonKey) {
  url = url.replace(/\/$/, '');
  let session = store(true);
  let refreshing = null;
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => fn(session));

  function setSession(s) {
    if (s && s.access_token) {
      session = {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (Number(s.expires_in) || 3600),
        user: s.user || session?.user || null,
      };
    } else session = null;
    store(false, session);
    emit();
  }

  async function authFetch(path, opts = {}) {
    const res = await fetch(url + '/auth/v1' + path, {
      ...opts,
      headers: { apikey: anonKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    return parse(res);
  }

  async function refresh() {
    if (!session?.refresh_token) { setSession(null); return null; }
    if (!refreshing) {
      refreshing = authFetch('/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }),
      }).then(s => { setSession(s); return session; })
        .catch(e => { if (e.status && e.status < 500) setSession(null); throw e; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session?.access_token || null;
  }

  async function rest(method, path, { query, body, headers = {}, prefer } = {}) {
    const t = await token();
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const h = { apikey: anonKey, ...headers };
    if (t) h.Authorization = 'Bearer ' + t;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (prefer) h.Prefer = prefer;
    let res = await fetch(url + '/rest/v1/' + path + qs, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && session) {           // token expired mid-flight
      await refresh();
      if (session?.access_token) h.Authorization = 'Bearer ' + session.access_token; else delete h.Authorization;
      res = await fetch(url + '/rest/v1/' + path + qs, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    return parse(res);
  }

  return {
    get session() { return session; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async signIn(email, password) {
      const s = await authFetch('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
      setSession(s); return session;
    },
    async signOut() {
      try { const t = await token(); if (t) await authFetch('/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); }
      catch { /* ignore */ }
      setSession(null);
    },
    async sendReset(email, redirectTo) {
      return authFetch('/recover' + (redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : ''),
        { method: 'POST', body: JSON.stringify({ email }) });
    },
    async updatePassword(password) {
      const t = await token();
      const user = await authFetch('/user', { method: 'PUT', headers: { Authorization: 'Bearer ' + t }, body: JSON.stringify({ password }) });
      session.user = user; store(false, session); return user;
    },
    // Handles links from Supabase e-mails (invite / password reset): #access_token=...&type=invite
    async consumeUrlSession(hash) {
      const p = new URLSearchParams(hash.replace(/^#/, ''));
      if (!p.get('access_token')) return null;
      const s = { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
        expires_in: p.get('expires_in'), expires_at: Number(p.get('expires_at')) || undefined };
      setSession(s);
      try { session.user = await authFetch('/user', { headers: { Authorization: 'Bearer ' + s.access_token } }); store(false, session); }
      catch { /* ignore */ }
      return p.get('type') || 'magiclink';
    },

    select: (table, query) => rest('GET', table, { query }),
    async selectAll(table, query = {}) {           // pages through PostgREST's 1000-row cap
      const out = []; const size = 1000;
      for (let from = 0; ; from += size) {
        const rows = await rest('GET', table, { query, headers: { Range: `${from}-${from + size - 1}`, 'Range-Unit': 'items' } });
        out.push(...rows);
        if (rows.length < size) break;
      }
      return out;
    },
    insert: (table, rows) => rest('POST', table, { body: rows, prefer: 'return=representation' }),
    update: (table, match, values) => rest('PATCH', table, { query: match, body: values, prefer: 'return=representation' }),
    remove: (table, match) => rest('DELETE', table, { query: match }),
    rpc: (fn, args) => rest('POST', 'rpc/' + fn, { body: args || {} }),
  };
}
