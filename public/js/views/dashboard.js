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
  let software = [];
  let copies = [];
  let away = [];
  let compliance = [];
  let devices = [];
  let locked = [];
  try {
    [software, copies, away] = await Promise.all([
      store.db.select('software_events', { select: 'id,asset_id,name,kind,happened_at', acknowledged_at: 'is.null', order: 'happened_at.desc', limit: '6' }),
      store.db.select('copy_activity', { select: 'id,asset_id,channel,file_name,action,happened_at', acknowledged_at: 'is.null', order: 'happened_at.desc', limit: '6' }),
      store.db.select('agent_devices', { select: 'asset_id,public_ip,city,country_name,country_code,location_at', outside_uae: 'eq.true', order: 'location_at.desc', limit: '8' }),
    ]);
  } catch { software = []; copies = []; away = []; }
  try {
    compliance = await store.db.select('compliance_alerts', { select: 'id,asset_id,kind,detail,happened_at', acknowledged_at: 'is.null', order: 'happened_at.desc', limit: '6' }) || [];
  } catch { compliance = []; }
  try {
    devices = await store.db.select('agent_devices', { select: 'asset_id,hostname,last_seen', order: 'last_seen.asc', limit: '200' }) || [];
  } catch { devices = []; }
  try {
    locked = await store.db.select('laptop_controls', { select: 'asset_id,lock_reason', locked: 'eq.true', limit: '8' }) || [];
  } catch { locked = []; }
  const quietCutoff = Date.now() - 24 * 3600 * 1000;
  const offline = devices.filter(d => !d.last_seen || new Date(d.last_seen).getTime() < quietCutoff);
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
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Outside the UAE</h2><a href="#/alerts">${away.length ? away.length + ' now' : 'Alerts'}</a></div>
      ${away.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
        ${away.map(r => {
          const asset = assets.find(a => a.id === r.asset_id);
          const place = [r.city, r.country_name || r.country_code].filter(Boolean).join(', ');
          return `<tr class="clickable" data-href="#/alerts">
            <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(place)}</div></td>
            <td class="mono">${esc(r.public_ip || '')}</td>
            <td class="sub">${fmtDateTime(r.location_at)}</td></tr>`;
        }).join('')}
      </tbody></table></div>` : '<div class="empty">Every enrolled computer last seen in the UAE, or none have reported a public IP yet. This is the city and country of the public IP, not GPS.</div>'}
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-h"><h2>New programs</h2><a href="#/alerts">${software.length ? software.length + ' open' : 'Alerts'}</a></div>
        ${software.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
          ${software.map(r => {
            const asset = assets.find(a => a.id === r.asset_id);
            return `<tr class="clickable" data-href="#/alerts?asset=${esc(r.asset_id)}">
              <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(r.name)}</div></td>
              <td><span class="badge ${r.kind === 'removed' ? 'st-under_repair' : 'st-checked_out'}">${r.kind === 'removed' ? 'Removed' : 'Installed'}</span></td>
              <td class="sub">${fmtDateTime(r.happened_at)}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No new programs. Mulk Agent sends the uninstall list. The first scan is the baseline.</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>Data leaving</h2><a href="#/alerts">${copies.length ? copies.length + ' open' : 'Alerts'}</a></div>
        ${copies.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
          ${copies.map(r => {
            const asset = assets.find(a => a.id === r.asset_id);
            return `<tr class="clickable" data-href="#/alerts">
              <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(r.file_name)}</div></td>
              <td><span class="badge ${r.action === 'warned' ? 'st-under_repair' : 'st-broken'}">${esc(r.action)}</span></td>
              <td class="sub">${fmtDateTime(r.happened_at)}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No open data-leaving reports. A removable drive is reported by its letter and volume name.</div>'}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h2>Locked by IT</h2><a href="#/control">${locked.length ? locked.length + ' locked' : 'Control'}</a></div>
      ${locked.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
        ${locked.map(r => {
          const asset = assets.find(a => a.id === r.asset_id);
          return `<tr class="clickable" data-href="#/control">
            <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(r.lock_reason || '')}</div></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : '<div class="empty">No asset is locked. In Control, Lock asset stops sign-in until you unlock it. Wi-Fi and Ethernet stay connected.</div>'}
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-h"><h2>Health</h2><a href="#/alerts">${compliance.length ? compliance.length + ' open' : 'Alerts'}</a></div>
        ${compliance.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
          ${compliance.map(r => {
            const asset = assets.find(a => a.id === r.asset_id);
            return `<tr class="clickable" data-href="#/alerts">
              <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(r.detail)}</div></td>
              <td class="sub">${fmtDateTime(r.happened_at)}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No open health alerts. Encryption, Defender, the firewall, disk space, and a serial mismatch are checked. Files are not read.</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>Not seen for a day</h2><a href="#/alerts">${offline.length ? offline.length + ' quiet' : 'Alerts'}</a></div>
        ${offline.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>
          ${offline.slice(0, 8).map(d => {
            const asset = assets.find(a => a.id === d.asset_id);
            return `<tr class="clickable" data-href="#/asset/${esc(d.asset_id)}">
              <td>${asset ? `<span class="tag">${esc(asset.tag)}</span>` : ''}<div class="sub">${esc(d.hostname || '')}</div></td>
              <td class="sub">${d.last_seen ? fmtDateTime(d.last_seen) : 'Never'}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">Every enrolled computer has checked in during the last day.</div>'}
      </div>
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
