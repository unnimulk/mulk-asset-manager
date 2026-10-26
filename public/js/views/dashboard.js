import { esc, fmtDate, fmtDateTime } from '../ui.js';
import { store, loadAssets, countBy, STATUS, ACTION_LABEL } from '../data.js';

const q = (o) => '#/assets?' + new URLSearchParams(o).toString();

function bars(entries, field, max = 8) {
  const top = entries.slice(0, max);
  const peak = Math.max(1, ...top.map(e => e[1]));
  if (!top.length) return '<div class="muted">No data yet</div>';
  return `<div class="bars">${top.map(([k, n]) => `
    <a class="bar" href="${q({ [field]: k === '—' ? '__none' : k })}">
      <span class="bar-name" title="${esc(k)}">${esc(k)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(n / peak) * 100}%; display:block"></span></span>
      <span class="bar-n">${n}</span>
    </a>`).join('')}</div>`;
}

export async function dashboardView(main) {
  const [assets, events] = await Promise.all([
    loadAssets(true),
    store.db.select('asset_events', { select: 'id,action,event_date,assigned_to,created_at,performed_by,notes,asset_id,assets(tag,description)', order: 'created_at.desc', limit: '12' }),
  ]);
  const by = Object.fromEntries(countBy(assets, 'status'));
  const kpi = (status, label) => `
    <a class="card kpi" href="${status ? q({ status }) : '#/assets'}">
      <div class="k-label">${status ? `<span class="dot" style="background:${STATUS[status].color}"></span>` : ''}${esc(label)}</div>
      <div class="k-val">${status ? (by[status] || 0) : assets.length}</div>
    </a>`;

  const active = assets.filter(a => a.status !== 'disposed');
  const soon = new Date(); soon.setDate(soon.getDate() + 60);
  const todayIso = new Date().toISOString().slice(0, 10);
  const warranty = active.filter(a => a.warranty_expiry && a.warranty_expiry >= todayIso && a.warranty_expiry <= soon.toISOString().slice(0, 10))
    .sort((a, b) => a.warranty_expiry.localeCompare(b.warranty_expiry));
  const attention = assets.filter(a => a.status === 'under_repair' || a.status === 'broken' || a.status === 'lost');

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${assets.length} assets on record · ${active.length} active</p></div>
      <div class="row"><a class="btn" href="#/import">Import</a><a class="btn primary" href="#/assets/new">+ Add asset</a></div>
    </div>
    <div class="kpis">
      ${kpi(null, 'Total assets')}
      ${kpi('checked_out', 'Checked out')}
      ${kpi('available', 'Available')}
      ${kpi('under_repair', 'Under repair')}
      ${kpi('broken', 'Broken')}
      ${kpi('disposed', 'Disposed')}
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card"><div class="card-h"><h2>By category</h2></div><div class="card-b">${bars(countBy(active, 'category'), 'category')}</div></div>
      <div class="card"><div class="card-h"><h2>By department</h2></div><div class="card-b">${bars(countBy(active, 'department'), 'department')}</div></div>
      <div class="card"><div class="card-h"><h2>By site</h2></div><div class="card-b">${bars(countBy(active, 'site'), 'site')}</div></div>
      <div class="card"><div class="card-h"><h2>Needs attention</h2><span class="muted">${attention.length}</span></div>
        <div class="card-b">${attention.length ? `<div class="bars">${attention.slice(0, 8).map(a => `
          <a class="bar" style="grid-template-columns:1fr auto" href="#/asset/${a.id}">
            <span class="bar-name"><span class="tag">${esc(a.tag)}</span> <span class="muted">${esc(a.description || '')}</span></span>
            <span class="badge st-${a.status}">${STATUS[a.status].label}</span></a>`).join('')}</div>` : '<div class="muted">Nothing under repair, broken or lost.</div>'}
          ${warranty.length ? `<h2 style="margin:18px 0 10px">Warranty ending in 60 days</h2><div class="bars">${warranty.slice(0, 6).map(a => `
            <a class="bar" style="grid-template-columns:1fr auto" href="#/asset/${a.id}"><span class="bar-name"><span class="tag">${esc(a.tag)}</span> <span class="muted">${esc(a.description || '')}</span></span><span class="muted">${fmtDate(a.warranty_expiry)}</span></a>`).join('')}</div>` : ''}
        </div></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Recent activity</h2><a href="#/activity">View all</a></div>
      ${events.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Asset</th><th>Action</th><th>Person</th><th>By</th></tr></thead><tbody>
        ${events.map(e => `<tr class="clickable" data-href="#/asset/${e.asset_id}">
          <td>${fmtDate(e.event_date)}<div class="sub">${fmtDateTime(e.created_at)}</div></td>
          <td><span class="tag">${esc(e.assets?.tag || '')}</span><div class="sub">${esc(e.assets?.description || '')}</div></td>
          <td>${esc(ACTION_LABEL[e.action] || e.action)}</td>
          <td>${esc(e.assigned_to || '')}</td>
          <td class="sub">${esc(e.performed_by || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No activity yet. <a href="#/import">Import your AssetTiger export</a> to get started.</div>'}
    </div>`;
  main.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.href; });
}
