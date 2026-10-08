// Autotask MCP admin console — no framework, no build step. Every value from
// the server is inserted as text (never as HTML).
'use strict';

const app = document.getElementById('app');
let me = null;
let refreshTimer = null;

// ── tiny DOM helper ───────────────────────────────────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, so the strict CSP (no inline style attributes) allows it
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
}
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// ── API ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Atmcp': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me/password') { me = null; render(); throw new Error(data.error || 'Signed out.'); }
  if (res.status === 403 && data.code === 'password_change_required') { me = { ...(me || {}), mustChangePassword: true }; render(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ── shell ─────────────────────────────────────────────────────────────────
const ROUTES = [
  { hash: '#/', label: 'Dashboard', view: dashboard },
  { hash: '#/calls', label: 'Calls', view: calls },
  { hash: '#/settings', label: 'Settings', view: settings },
  { hash: '#/users', label: 'Users', view: users, admin: true },
  { hash: '#/activity', label: 'Activity', view: activity, admin: true },
  { hash: '#/account', label: 'Account', view: account },
];

function shell(active, content) {
  return h('div', null,
    h('header', { class: 'top' }, h('div', { class: 'top-inner' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Autotask MCP'),
      h('nav', null, ROUTES.filter((r) => !r.admin || me.role === 'admin').map((r) =>
        h('a', { href: r.hash, class: r.hash === active ? 'active' : null }, r.label))),
      h('div', { class: 'who' },
        h('span', { class: 'name muted' }, me.username),
        h('span', { class: `badge ${me.role === 'admin' ? 'accent' : ''}` }, me.role === 'admin' ? 'Admin' : 'Read-only'),
        h('button', { class: 'small', onclick: logout }, 'Sign out')))),
    h('main', null, content));
}

async function render() {
  clearInterval(refreshTimer);
  if (!me) return loginView();
  if (me.mustChangePassword) return changePasswordView(true);
  const route = ROUTES.find((r) => r.hash === (location.hash || '#/')) || ROUTES[0];
  if (route.admin && me.role !== 'admin') { location.hash = '#/'; return; }
  const body = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  app.replaceChildren(shell(route.hash, body));
  try { await route.view(body); } catch (e) { body.replaceChildren(h('div', { class: 'banner bad' }, e.message)); }
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  me = null;
  location.hash = '#/';
  render();
}

// ── sign in / password ────────────────────────────────────────────────────
function loginView() {
  const err = h('p', { class: 'error', role: 'alert' });
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'panel card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try { me = (await api('POST', '/api/login', { username: user.value.trim(), password: pass.value })).user; render(); }
    catch (x) { err.textContent = x.message; pass.value = ''; pass.focus(); }
    finally { btn.disabled = false; }
  } },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Autotask MCP Admin'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
    btn, err);
  app.replaceChildren(h('div', { class: 'center' }, form));
  user.focus();
}

function passwordForm(onDone, forced) {
  const err = h('p', { class: 'error', role: 'alert' });
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', id: 'new', autocomplete: 'new-password', required: true, minlength: 12 });
  const nw2 = h('input', { type: 'password', id: 'new2', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Change password');
  return h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (nw.value !== nw2.value) { err.textContent = 'The new passwords do not match.'; return; }
    btn.disabled = true;
    try { me = (await api('POST', '/api/me/password', { currentPassword: cur.value, newPassword: nw.value })).user; onDone(); }
    catch (x) { err.textContent = x.message; }
    finally { btn.disabled = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'cur' }, forced ? 'Temporary password' : 'Current password'), cur),
    h('div', { class: 'field' }, h('label', { for: 'new' }, 'New password'), nw, h('div', { class: 'muted' }, 'At least 12 characters. A passphrase works well.')),
    h('div', { class: 'field' }, h('label', { for: 'new2' }, 'Repeat new password'), nw2),
    h('div', { class: 'row' }, btn, forced ? h('button', { type: 'button', onclick: logout }, 'Sign out') : null), err);
}

function changePasswordView() {
  app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'panel card' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Choose your password'),
    h('p', { class: 'muted' }, `Signed in as ${me.username}. Replace the temporary password before continuing.`),
    passwordForm(() => { toast('Password changed.'); render(); }, true))));
}

// ── dashboard ─────────────────────────────────────────────────────────────
function usageBar(pct) {
  const cls = pct == null ? '' : pct >= 75 ? 'bad' : pct >= 50 ? 'warn' : '';
  return h('div', { class: `bar ${cls}` }, h('span', { style: `width:${Math.min(100, pct || 0)}%` }));
}

async function dashboard(body) {
  const draw = async () => {
    const s = await api('GET', '/api/status');
    const at = s.api && s.api.autotask && !s.api.autotask.error ? s.api.autotask : null;
    const srv = s.api && s.api.server;
    const noApi = s.authMode === 'gateway' ? 'Not available in gateway mode (many tenants).' : 'No Autotask API user is configured.';
    const banners = [];
    if (!s.tools.writesEnabled) banners.push(h('div', { class: 'banner warn' }, 'Read-only mode: write tools are switched off for every agent.'));
    if (s.tools.disabledCategories.length) banners.push(h('div', { class: 'banner warn' }, `Disabled tool groups: ${s.tools.disabledCategories.join(', ')}.`));
    if (s.autotaskAuth) {
      const a = s.autotaskAuth;
      const retry = me.role === 'admin' ? h('button', { class: 'small', style: 'margin-left:10px', onclick: async (e) => {
        e.target.disabled = true;
        try { toast((await api('POST', '/api/actions/auth-retry', {})).message); await draw(); } catch (x) { toast(x.message); e.target.disabled = false; }
      } }, 'Retry now') : null;
      banners.push(a.blockedUntil
        ? h('div', { class: 'banner bad' }, h('strong', null, 'Autotask rejected the API credentials. '),
            `Autotask calls are paused until ${new Date(a.blockedUntil).toLocaleTimeString()} (failure ${a.failures} since ${new Date(a.since).toLocaleTimeString()}) so repeated failed logins don't lock the API user. Fix the user in Autotask (unlock it, or update the secret in the env file), then retry.`, retry,
            h('div', { class: 'mono', style: 'margin-top:6px;font-size:12px' }, a.lastError))
        : h('div', { class: 'banner warn' }, 'Autotask rejected the credentials earlier; the next Autotask call will test them again.', retry));
    }
    if (s.postgres.enabled && !s.postgres.ok) banners.push(h('div', { class: 'banner bad' }, `Postgres is unreachable: ${s.postgres.error || 'unknown error'}`));
    if (at && at.usedPct >= 75) banners.push(h('div', { class: 'banner bad' }, `Autotask API usage is at ${at.usedPct}% — Autotask is adding a 1 s delay to every call.`));
    else if (at && at.usedPct >= 50) banners.push(h('div', { class: 'banner warn' }, `Autotask API usage is at ${at.usedPct}% — Autotask is adding a 0.5 s delay to every call.`));

    const cards = h('div', { class: 'grid' },
      h('section', { class: 'panel' }, h('h2', null, 'Server'),
        h('div', { class: 'stat' }, s.version),
        h('dl', { class: 'kv' },
          h('dt', null, 'Up for'), h('dd', null, duration(s.uptimeSeconds)),
          h('dt', null, 'Started'), h('dd', null, when(s.startedAt)),
          h('dt', null, 'Mode'), h('dd', null, s.authMode === 'env' ? 'Single tenant' : 'Gateway'),
          h('dt', null, 'Node'), h('dd', null, s.node))),
      h('section', { class: 'panel' }, h('h2', null, 'Autotask API (whole tenant)'),
        at ? [h('div', { class: 'stat' }, `${at.usedPct ?? '—'}%`, h('small', null, ` of ${fmt(at.limit)} / h`)), usageBar(at.usedPct),
          h('div', { class: 'muted' }, `${fmt(at.used)} calls this hour · checked ${ago(s.api.autotaskCheckedAt)}`)]
          : h('p', { class: 'muted' }, s.autotaskAuth ? 'Paused: Autotask rejected the credentials (see above).' : s.api && s.api.autotask && s.api.autotask.error ? `Unavailable: ${s.api.autotask.error}` : noApi)),
      h('section', { class: 'panel' }, h('h2', null, 'This MCP’s calls'),
        srv ? [h('div', { class: 'stat' }, fmt(srv.upstreamLastHour), h('small', null, ' last hour')),
          h('dl', { class: 'kv' },
            h('dt', null, 'Last 5 minutes'), h('dd', null, fmt(srv.upstreamLastFiveMinutes)),
            h('dt', null, 'Answered from cache'), h('dd', null, srv.savedPct == null ? '—' : `${srv.savedPct}%`),
            h('dt', null, 'Read cache'), h('dd', null, srv.cacheEnabled ? 'On' : 'Off'),
            h('dt', null, 'Rate-limited (429)'), h('dd', null, fmt(srv.rateLimited)))]
          : h('p', { class: 'muted' }, noApi)),
      h('section', { class: 'panel' }, h('h2', null, 'Tools'),
        h('div', { class: 'stat' }, fmt(s.tools.enabled), h('small', null, ` of ${fmt(s.tools.total)} enabled`)),
        h('dl', { class: 'kv' },
          h('dt', null, 'Write tools'), h('dd', null, s.tools.writesEnabled ? h('span', { class: 'badge ok' }, 'Allowed') : h('span', { class: 'badge warn' }, 'Off')),
          h('dt', null, 'Autotask credentials'), h('dd', null, s.secrets.autotaskCredentials ? h('span', { class: 'badge ok' }, 'Set') : h('span', { class: 'badge bad' }, 'Missing')),
          h('dt', null, 'Webhook secret'), h('dd', null, s.secrets.webhookSecret ? h('span', { class: 'badge ok' }, 'Set') : h('span', { class: 'badge' }, 'Not set')),
          h('dt', null, 'Postgres'), h('dd', null, !s.postgres.enabled ? 'Off' : s.postgres.ok ? h('span', { class: 'badge ok' }, `OK · ${s.postgres.latencyMs} ms`) : h('span', { class: 'badge bad' }, 'Down')))));

    const shadow = s.shadow.enabled
      ? h('section', { class: 'panel' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('h2', null, 'Postgres shadow'),
            h('div', { class: 'row' },
              h('span', { class: `badge ${s.shadow.syncEnabled ? 'ok' : 'warn'}` }, s.shadow.syncEnabled ? 'Sync on' : 'Sync paused'),
              h('span', { class: `badge ${s.shadow.serveReads ? 'ok' : ''}` }, s.shadow.serveReads ? 'Serving reads' : 'Not serving reads'),
              me.role === 'admin' ? h('button', { class: 'small', onclick: async (e) => {
                e.target.disabled = true;
                try { toast((await api('POST', '/api/actions/shadow-sync', {})).message); } catch (x) { toast(x.message); }
                setTimeout(() => { e.target.disabled = false; }, 5000);
              } }, 'Sync now') : null)),
          h('p', { class: 'muted' }, s.shadow.lastRun
            ? `Last run ${ago(s.shadow.lastRun.at)}: ${s.shadow.lastRun.skipped || `${s.shadow.lastRun.calls} Autotask call(s)`}. Max age ${s.shadow.maxAgeSeconds}s · pauses at ${s.shadow.pauseAtPct}% API usage · ${s.shadow.pendingRowRefreshes} row(s) queued for refresh.`
            : 'No sync run since this server started.'),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Entity'), h('th', { class: 'num' }, 'Rows'), h('th', null, 'State'), h('th', null, 'Last sync'), h('th', null, 'History from'), h('th', { class: 'num' }, 'API calls (total)'), h('th', null, 'Last error'))),
            h('tbody', null, s.shadow.entities.map((e) => h('tr', null,
              h('td', null, e.entity), h('td', { class: 'num' }, fmt(e.rows)),
              h('td', null, e.ready ? (e.ageSeconds != null && e.ageSeconds > s.shadow.maxAgeSeconds ? h('span', { class: 'badge warn' }, 'Stale') : h('span', { class: 'badge ok' }, 'Ready')) : h('span', { class: 'badge warn' }, 'Backfilling')),
              h('td', null, ago(e.lastSyncedAt)), h('td', null, e.windowFrom || 'all'),
              h('td', { class: 'num' }, fmt(e.apiCallsTotal)),
              h('td', { class: e.lastError ? '' : 'muted' }, e.lastError ? `${e.lastError} (${ago(e.lastErrorAt)})` : '—')))))))
      : h('section', { class: 'panel' }, h('h2', null, 'Postgres shadow'), h('p', { class: 'muted' }, 'Not running on this server (MCP_PG_SHADOW_ENABLED is off).'));

    const top = srv && srv.topUpstream.length
      ? h('section', { class: 'panel' }, h('h2', null, 'Busiest Autotask calls since start'),
          h('p', { class: 'muted' }, `Since ${when(srv.since)} · ${fmt(srv.upstreamCalls)} upstream calls in total.`),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Call'), h('th', { class: 'num' }, 'Count'))),
            h('tbody', null, srv.topUpstream.map((t) => h('tr', null, h('td', { class: 'mono' }, t.call), h('td', { class: 'num' }, fmt(t.count))))))))
      : null;

    const audit = s.audit
      ? h('section', { class: 'panel' }, h('h2', null, 'Audit ledger (last 24 h)'),
          Object.keys(s.audit.last24h).length
            ? h('dl', { class: 'kv' }, Object.entries(s.audit.last24h).map(([k, v]) => [h('dt', null, k), h('dd', null, fmt(v))]))
            : h('p', { class: 'muted' }, 'No events recorded in the last 24 hours.'))
      : null;

    body.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', null, 'Dashboard'), h('span', { class: 'muted' }, `Updated ${new Date().toLocaleTimeString()} · refreshes every 30 s`)),
      ...[...banners, cards, shadow, top, audit].filter(Boolean));
  };
  await draw();
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') draw().catch(() => undefined); }, 30_000);
}

// ── calls (diagnostics) ───────────────────────────────────────────────────
const OUTCOME_LABEL = { ok: 'OK', error: 'Error', 'not-found': 'Not found', 'confirmation-required': 'Needs confirm', 'identification-required': 'Needs identity', 'idempotent-replay': 'Replayed', 'permission-denied': 'Denied', running: 'Running' };
function outcomeBadge(o) {
  const cls = o === 'ok' || o === 'idempotent-replay' ? 'ok' : o === 'running' ? '' : o === 'error' || o === 'permission-denied' ? 'bad' : 'warn';
  return h('span', { class: `badge ${cls}` }, OUTCOME_LABEL[o] || o);
}
function statusBadge(s) {
  if (s == null) return h('span', { class: 'badge' }, '…');
  if (s === 0) return h('span', { class: 'badge bad' }, 'No answer');
  return h('span', { class: `badge ${s >= 500 || s === 429 ? 'bad' : s >= 400 ? 'warn' : 'ok'}` }, String(s));
}
const ms = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const timeOf = (iso) => new Date(iso).toLocaleTimeString();
function callerCell(r) {
  return h('div', null,
    h('span', { class: 'badge' }, r.source || 'unknown'),
    r.user ? h('span', { class: 'muted' }, ` ${r.user}`) : null,
    r.ip || r.userAgent ? h('div', { class: 'muted mono' }, [r.ip, r.userAgent].filter(Boolean).join(' · ')) : null);
}

async function calls(body) {
  const state = { tab: 'tools', errors: false, tool: '', source: '', auto: true, open: new Set() };
  const content = h('div');
  const errBox = h('input', { type: 'checkbox', onchange: (e) => { state.errors = e.target.checked; draw(); } });
  const toolBox = h('input', { type: 'text', placeholder: 'Filter by tool or path…', style: 'max-width:260px', oninput: (e) => { state.tool = e.target.value.trim(); clearTimeout(toolBox._t); toolBox._t = setTimeout(draw, 300); } });
  const sourceSel = h('select', { style: 'max-width:180px', onchange: (e) => { state.source = e.target.value; draw(); } }, h('option', { value: '' }, 'All callers'));
  const autoBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => { state.auto = e.target.checked; } });
  const tabBtn = (id, label) => h('button', { class: `small ${state.tab === id ? 'primary' : ''}`, onclick: () => { state.tab = id; draw(); } }, label);

  const qs = () => {
    const p = new URLSearchParams({ limit: '150' });
    if (state.errors) p.set('errors', '1');
    if (state.tool) p.set('tool', state.tool);
    if (state.source && state.tab === 'tools') p.set('source', state.source);
    return p.toString();
  };

  async function apiCallsOf(id, cell) {
    cell.replaceChildren(h('span', { class: 'muted' }, 'Loading…'));
    const r = await api('GET', `/api/calls/api?toolCallId=${id}&limit=200`);
    cell.replaceChildren(r.calls.length
      ? h('table', null, h('tbody', null, r.calls.map((c) => h('tr', null,
          h('td', { class: 'muted' }, timeOf(c.at)), h('td', { class: 'mono' }, `${c.method} ${c.path}`), h('td', null, statusBadge(c.status)), h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', { class: 'muted' }, c.error || '')))))
      : h('span', { class: 'muted' }, 'No Autotask calls: answered from the cache or the Postgres shadow, or the tool made none.'));
  }

  async function draw() {
    const [sum, list] = await Promise.all([
      api('GET', '/api/calls/summary?minutes=60'),
      state.tab === 'logs' ? api('GET', '/api/logs?limit=300').then((r) => ({ calls: r.logs.filter((l) => (!state.errors || l.level === 'error') && (!state.tool || (l.message + (l.meta || '')).toLowerCase().includes(state.tool.toLowerCase()))) }))
        : api('GET', `/api/calls/${state.tab === 'tools' ? 'tools' : 'api'}?${qs()}`),
    ]);
    const sources = [...new Set(sum.callers.map((c) => c.source))].sort();
    if (sourceSel.options.length - 1 !== sources.length) {
      sourceSel.replaceChildren(h('option', { value: '' }, 'All callers'), ...sources.map((s) => h('option', { value: s }, s)));
      sourceSel.value = state.source;
    }

    const callers = h('section', { class: 'panel' },
      h('h2', null, 'Who is calling (last hour)'),
      sum.callers.length || sum.background.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Caller'), h('th', { class: 'num' }, 'Tool calls'), h('th', { class: 'num' }, 'Errors'), h('th', { class: 'num' }, 'Autotask calls'), h('th', null, 'Last seen'))),
            h('tbody', null,
              sum.callers.map((c) => h('tr', null, h('td', null, callerCell(c)), h('td', { class: 'num' }, fmt(c.calls)),
                h('td', { class: 'num' }, c.errors ? h('span', { class: 'badge bad' }, fmt(c.errors)) : '0'), h('td', { class: 'num' }, fmt(c.apiCalls)),
                h('td', null, `${ago(c.lastAt)} · `, h('span', { class: 'mono' }, c.lastTool)))),
              sum.background.map((b) => h('tr', null, h('td', null, h('span', { class: 'badge accent' }, 'background'), ' ', b.job), h('td', { class: 'num muted' }, '—'),
                h('td', { class: 'num' }, b.errors ? h('span', { class: 'badge bad' }, fmt(b.errors)) : '0'), h('td', { class: 'num' }, fmt(b.apiCalls)), h('td', null, ago(b.lastAt)))))))
        : h('p', { class: 'muted' }, 'No calls in the last hour.'));

    let table;
    if (state.tab === 'logs') {
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Level'), h('th', null, 'Message'))),
        h('tbody', null, list.calls.map((l) => h('tr', null,
          h('td', { class: 'muted', style: 'white-space:nowrap' }, `${new Date(l.at).toLocaleDateString()} ${timeOf(l.at)}`),
          h('td', null, h('span', { class: `badge ${l.level === 'error' ? 'bad' : 'warn'}` }, l.level)),
          h('td', null, l.message, l.meta ? h('div', { class: 'mono muted', style: 'word-break:break-all' }, l.meta) : null)))));
    } else if (state.tab === 'tools') {
      const rows = [];
      for (const c of list.calls) {
        const detail = h('td', { colspan: '6' });
        const detailRow = h('tr', { hidden: !state.open.has(c.id) }, detail);
        if (state.open.has(c.id)) apiCallsOf(c.id, detail).catch((e) => detail.replaceChildren(e.message));
        rows.push(h('tr', { style: 'cursor:pointer', title: 'Show the Autotask calls this tool call made', onclick: () => {
          detailRow.hidden = !detailRow.hidden;
          if (detailRow.hidden) state.open.delete(c.id); else { state.open.add(c.id); apiCallsOf(c.id, detail).catch((e) => detail.replaceChildren(e.message)); }
        } },
          h('td', { class: 'muted' }, timeOf(c.at)),
          h('td', null, h('span', { class: 'mono' }, c.tool.replace(/^autotask_/, '')), c.error ? h('div', { class: 'error', style: 'margin:2px 0 0;font-size:12.5px' }, c.error) : null),
          h('td', null, callerCell(c)),
          h('td', null, outcomeBadge(c.outcome)),
          h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', { class: 'num' }, `${c.apiCalls} API`, c.cacheHits ? h('div', { class: 'muted' }, `${c.cacheHits} cached`) : null, c.shadowReads ? h('div', { class: 'muted' }, `${c.shadowReads} shadow`) : null)));
        rows.push(detailRow);
      }
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Tool'), h('th', null, 'Caller'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Took'), h('th', { class: 'num' }, 'Autotask'))),
        h('tbody', null, rows));
    } else {
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Request'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Took'), h('th', null, 'Caused by'))),
        h('tbody', null, list.calls.map((c) => h('tr', null,
          h('td', { class: 'muted' }, timeOf(c.at)),
          h('td', null, h('span', { class: 'mono' }, `${c.method} ${c.path}`), c.error ? h('div', { class: 'error', style: 'margin:2px 0 0;font-size:12.5px' }, c.error) : null),
          h('td', null, statusBadge(c.status)),
          h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', null, c.tool ? h('span', { class: 'mono' }, c.tool.replace(/^autotask_/, '')) : h('span', { class: 'badge accent' }, c.job || 'background'))))));
    }

    content.replaceChildren(callers,
      h('section', { class: 'panel' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
          h('div', { class: 'row' }, tabBtn('tools', 'Tool calls'), tabBtn('api', 'Autotask API calls'), tabBtn('logs', 'Server log')),
          h('div', { class: 'row' }, toolBox, state.tab === 'tools' ? sourceSel : null,
            h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center;margin:0' }, errBox, 'Errors only'))),
        list.calls.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, state.tab === 'logs' ? 'No warnings or errors since the server started.' : 'Nothing matches.'),
        h('p', { class: 'muted', style: 'margin:10px 0 0' }, state.tab === 'logs'
          ? 'Warnings and errors the server logged since it started (last 500). Credential-like fields are redacted.'
          : state.tab === 'tools'
          ? 'Newest first; click a row to see the Autotask calls it made. Arguments are never recorded.'
          : 'Newest first. Calls answered from the read cache or the Postgres shadow never reach Autotask, so they are not listed here.')));
  }

  const dl = (label, q) => h('a', { class: 'button-link', href: `/api/export?${q}`, download: '' }, label);
  const exportPanel = h('section', { class: 'panel' },
    h('h2', null, 'Export for testing and issue tracking'),
    h('p', { class: 'muted' }, 'Downloads what is in memory right now. Never includes credentials, tool arguments or response bodies.'),
    h('div', { class: 'row' },
      dl('Diagnostics bundle (JSON)', 'kind=bundle'),
      dl('Tool calls (CSV)', 'kind=tools&format=csv'),
      dl('Autotask calls (CSV)', 'kind=api&format=csv'),
      dl('Server log (CSV)', 'kind=logs&format=csv')),
    h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'The bundle holds the dashboard status, settings, callers for the last 24 h, every logged tool and Autotask call, the server log' + (me.role === 'admin' ? ', and the console activity log.' : '.')));
  body.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', null, 'Calls'),
      h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, autoBox, 'Refresh every 10 s')),
    h('p', { class: 'muted' }, 'Recent tool calls from n8n, ChatGPT and other clients, and every request this MCP sent to Autotask. Kept in memory: the last 500 tool calls and 2,000 Autotask calls since the server started.'),
    content, exportPanel);
  await draw();
  refreshTimer = setInterval(() => { if (state.auto && document.visibilityState === 'visible') draw().catch(() => undefined); }, 10_000);
}

// ── settings ──────────────────────────────────────────────────────────────
async function settings(body) {
  const isAdmin = me.role === 'admin';
  const draw = (list) => {
    const groups = {};
    for (const s of list) (groups[s.group] = groups[s.group] || []).push(s);
    const save = async (key, payload) => {
      try { draw((await api('PUT', `/api/settings/${encodeURIComponent(key)}`, payload)).settings); toast('Saved.'); }
      catch (x) { toast(x.message); draw((await api('GET', '/api/settings')).settings); }
    };
    const control = (s) => {
      const off = !isAdmin || !s.available;
      if (s.type === 'boolean') {
        return h('label', { class: 'switch', title: s.value ? 'On' : 'Off' },
          h('input', { type: 'checkbox', checked: !!s.value, disabled: off, 'aria-label': s.label, onchange: (e) => {
            if (s.key === 'tools.writesEnabled' && !e.target.checked && !confirm('Switch every agent to read-only? Creates, updates and deletes will be refused until you switch this back on.')) { e.target.checked = true; return; }
            save(s.key, { value: e.target.checked });
          } }), h('span'));
      }
      if (s.type === 'integer') {
        const inp = h('input', { type: 'number', value: String(s.value), min: s.min, max: s.max, disabled: off, 'aria-label': s.label });
        return [inp, isAdmin ? h('button', { class: 'small', disabled: off, onclick: () => save(s.key, { value: Number(inp.value) }) }, 'Save') : null];
      }
      return null;
    };
    const checks = (s) => {
      if (s.type !== 'string[]') return null;
      const boxes = (s.choices || []).map((c) => h('label', null, h('input', { type: 'checkbox', value: c, checked: s.value.includes(c), disabled: !isAdmin }), c.replace(/_/g, ' ')));
      return h('div', { class: 'checks' }, boxes, isAdmin ? h('div', null, h('button', { class: 'small', onclick: () => {
        const v = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        save(s.key, { value: v });
      } }, 'Save groups')) : null);
    };
    body.replaceChildren(
      h('h1', null, 'Settings'),
      isAdmin ? h('p', { class: 'muted' }, 'Changes apply immediately, with no restart, and are recorded in the activity log. The default for each setting comes from the server’s environment file.')
        : h('div', { class: 'banner' }, 'You have read-only access. An administrator can change these.'),
      ...Object.entries(groups).map(([g, items]) => h('section', { class: 'panel' }, h('h2', null, g), items.map((s) =>
        h('div', { class: 'setting' },
          h('div', null,
            h('div', null, h('strong', null, s.label), ' ', !s.available ? h('span', { class: 'badge' }, 'Not running') : s.overridden ? h('span', { class: 'badge accent' }, 'Changed') : null),
            h('div', { class: 'desc' }, s.description),
            h('div', { class: 'meta' }, `Default: ${Array.isArray(s.default) ? (s.default.join(', ') || 'none') : String(s.default)}`,
              s.overridden && isAdmin ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); save(s.key, { reset: true }); } }, 'reset to default')] : null)),
          h('div', { class: 'control' }, control(s)),
          checks(s))))));
  };
  draw((await api('GET', '/api/settings')).settings);
}

// ── users ─────────────────────────────────────────────────────────────────
function showPassword(title, username, password) {
  const dlg = h('dialog', null,
    h('h2', null, title),
    h('p', null, `Give this temporary password to `, h('strong', null, username), '. It is shown only once; they will choose their own at first sign-in.'),
    h('div', { class: 'secret' }, password),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { try { await navigator.clipboard.writeText(password); toast('Copied.'); } catch { toast('Copy failed — select the text instead.'); } } }, 'Copy'),
      h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Done')));
  document.body.append(dlg);
  dlg.showModal();
}

async function users(body) {
  const draw = async () => {
    const list = (await api('GET', '/api/users')).users;
    const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await draw(); } catch (x) { toast(x.message); } };
    const name = h('input', { type: 'text', id: 'nu', placeholder: 'e.g. jsmith', autocomplete: 'off', required: true });
    const role = h('select', { id: 'nr' }, h('option', { value: 'viewer' }, 'Read-only (metrics)'), h('option', { value: 'admin' }, 'Administrator'));
    const err = h('p', { class: 'error', role: 'alert' });
    const add = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { const r = await api('POST', '/api/users', { username: name.value.trim(), role: role.value }); showPassword('User created', r.user.username, r.password); await draw(); }
      catch (x) { err.textContent = x.message; }
    } },
      h('h2', null, 'Add a user'),
      h('div', { class: 'row', style: 'align-items:flex-end' },
        h('div', { style: 'flex:1;min-width:180px' }, h('label', { for: 'nu' }, 'Username'), name),
        h('div', { style: 'min-width:200px' }, h('label', { for: 'nr' }, 'Access'), role),
        h('button', { class: 'primary', type: 'submit' }, 'Create')),
      h('p', { class: 'muted', style: 'margin-top:8px' }, 'A temporary password is generated and shown once.'), err);

    const rows = list.map((u) => {
      const self = u.id === me.id;
      const roleSel = h('select', { 'aria-label': `Role of ${u.username}`, onchange: (e) => act(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }), 'Role changed.') },
        h('option', { value: 'viewer' }, 'Read-only'), h('option', { value: 'admin' }, 'Administrator'));
      roleSel.value = u.role;
      return h('tr', null,
        h('td', null, h('strong', null, u.username), self ? h('span', { class: 'muted' }, ' (you)') : null),
        h('td', null, roleSel),
        h('td', null, u.disabled ? h('span', { class: 'badge bad' }, 'Disabled') : u.mustChangePassword ? h('span', { class: 'badge warn' }, 'Must set password') : h('span', { class: 'badge ok' }, 'Active')),
        h('td', null, ago(u.lastLoginAt)),
        h('td', { class: 'muted' }, `${when(u.createdAt)}${u.createdBy ? ` by ${u.createdBy}` : ''}`),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: () => confirm(`Reset the password of ${u.username}? They are signed out everywhere.`) && act(async () => { const r = await api('POST', `/api/users/${u.id}/reset-password`, {}); showPassword('Password reset', u.username, r.password); }) }, 'Reset password'),
          self ? null : h('button', { class: 'small', onclick: () => act(() => api('POST', `/api/users/${u.id}/sign-out`, {}), 'Signed out.') }, 'Sign out'),
          self ? null : h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Enabled.' : 'Disabled.') }, u.disabled ? 'Enable' : 'Disable'),
          self ? null : h('button', { class: 'small danger', onclick: () => confirm(`Delete ${u.username}? This cannot be undone.`) && act(() => api('DELETE', `/api/users/${u.id}`), 'Deleted.') }, 'Delete'))));
    });
    body.replaceChildren(h('h1', null, 'Users'), add,
      h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Access'), h('th', null, 'Status'), h('th', null, 'Last sign-in'), h('th', null, 'Created'), h('th', null, ''))),
        h('tbody', null, rows)))));
  };
  await draw();
}

// ── activity ──────────────────────────────────────────────────────────────
const ACTIONS = {
  'login': 'Signed in', 'login.failed': 'Failed sign-in', 'password.changed': 'Changed own password',
  'setting.changed': 'Changed setting', 'setting.reset': 'Reset setting', 'action.shadow_sync': 'Started shadow sync',
  'user.created': 'Created user', 'user.updated': 'Updated user', 'user.deleted': 'Deleted user',
  'user.password_reset': 'Reset password', 'user.signed_out': 'Signed user out',
};
function describe(ev) {
  const d = ev.details || {};
  if (ev.action.startsWith('setting.')) return `${d.key}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`;
  if (ev.action === 'login.failed') return d.reason || '';
  const parts = [];
  if (d.username) parts.push(d.username);
  if (d.role) parts.push(`role ${d.role}`);
  if (d.disabled !== undefined) parts.push(d.disabled ? 'disabled' : 'enabled');
  if (d.via) parts.push(`via ${d.via}`);
  return parts.join(' · ');
}
async function activity(body) {
  const events = [];
  const tbody = h('tbody');
  const more = h('button', { onclick: () => load() }, 'Load older');
  const load = async () => {
    const before = events.length ? events[events.length - 1].id : undefined;
    const r = await api('GET', `/api/events?limit=100${before ? `&before=${before}` : ''}`);
    events.push(...r.events);
    for (const ev of r.events) tbody.append(h('tr', null,
      h('td', null, when(ev.at)), h('td', null, ev.actor || '—'),
      h('td', null, ev.action === 'login.failed' ? h('span', { class: 'badge warn' }, ACTIONS[ev.action]) : (ACTIONS[ev.action] || ev.action)),
      h('td', null, describe(ev)), h('td', { class: 'mono muted' }, ev.ip || '')));
    more.hidden = r.events.length < 100;
  };
  body.replaceChildren(h('h1', null, 'Activity'), h('p', { class: 'muted' }, 'Sign-ins and every change made in this console or with the admin CLI.'),
    h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Details'), h('th', null, 'IP'))), tbody)),
      h('div', { style: 'margin-top:10px' }, more)));
  await load();
}

// ── account ───────────────────────────────────────────────────────────────
async function account(body) {
  body.replaceChildren(h('h1', null, 'Account'),
    h('section', { class: 'panel', style: 'max-width:460px' },
      h('dl', { class: 'kv', style: 'margin-bottom:16px' },
        h('dt', null, 'Username'), h('dd', null, me.username),
        h('dt', null, 'Access'), h('dd', null, me.role === 'admin' ? 'Administrator' : 'Read-only'),
        h('dt', null, 'Password changed'), h('dd', null, when(me.passwordChangedAt))),
      h('h2', null, 'Change password'),
      passwordForm(() => { toast('Password changed. Other sessions were signed out.'); render(); }, false)));
}

// ── boot ──────────────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
(async () => {
  try { me = (await api('GET', '/api/me')).user; } catch { me = null; }
  render();
})();
