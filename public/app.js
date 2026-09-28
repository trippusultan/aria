// Aria SPA. Plain DOM, hash router, no dependencies.
// Rule: server data only ever reaches the DOM through text nodes / textContent (never innerHTML).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false || k === 'value') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (a.value != null) el.value = a.value;
  return el;
}
const mount = (el, ...kids) => { el.replaceChildren(); append(el, kids); };
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

const ICONS = {
  meeting: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5z M15 10.5l6-3.5v10l-6-3.5',
  email: 'M3 6h18v12H3z M3 7l9 6 9-6',
  manual: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  open: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};
const logo = () => h('span', { class: 'logo', 'aria-hidden': 'true' });
function icon(name, label) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'icon');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); }
  else s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.manual);
  s.append(p);
  return s;
}

// ---------- constants ----------
const STATUSES = [['open', 'Open'], ['in_progress', 'In progress'], ['waiting', 'Waiting'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const DEFAULT_STATUS = ['open', 'in_progress', 'waiting'];
const DIRS = [['i_owe', 'I owe'], ['they_owe', 'They owe'], ['unclear', 'Unclear']];
const DIR_LABEL = Object.fromEntries(DIRS);
const SOURCE_TYPES = [['meeting', 'Meeting'], ['email', 'Email'], ['manual', 'Manual']];
const SOURCE_LABEL = { meeting: 'Zoom meeting', email: 'Mail', manual: 'Manual' };
const DUE_WINDOWS = [['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['none', 'No due date']];
const TASK_PARAMS = ['status', 'person', 'source_type', 'due', 'tag', 'direction', 'q'];
const PROMPTS = ['What is pending?', 'What is overdue?', 'What is due this week?', 'What did I close last week?'];
const CONSENT = 'Aria only reads meetings and mail you connect. It drafts action items for you to confirm. It does not share transcripts with your manager. You can disconnect or delete a source at any time. Official recordings follow your company’s recording policy — invite Aria only to calls you are allowed to capture.';
const BOT_NOTICE = 'When invited, the bot joins as “Aria Notetaker” and posts in the meeting chat: “This call is being transcribed by Aria to capture action items for the person who invited it. Tell the host if you do not consent.” The host can remove it at any time.';

// ---------- state ----------
let me = null;            // GET /api/me payload
let settingsCache = null;
let notifs = [];
let viewKeys = null;      // per-view keyboard handler; returns true when it handled the key
let gPending = false;
let pollDown = false;     // FM6: one offline toast until the next successful poll
let nextFocus = null;     // data-fk to focus after the next render, when the focused control is about to vanish
const chat = { thread_id: null, msgs: [], busy: false };

// ---------- utils ----------
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
  } catch { return null; }
}
const toDate = s => new Date(typeof s === 'string' && /^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
const todayISO = () => new Date().toLocaleDateString('en-CA');
function fmtDue(d) {
  const [y, m, dd] = String(d).split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
// T-minus countdown: T-3d ahead, T-0 today, T+2d overdue
function tminus(d) {
  const [y, m, dd] = String(d).split('-').map(Number);
  const now = new Date(); const n = Math.round((new Date(y, m - 1, dd) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  return n > 0 ? `T-${n}d` : n === 0 ? 'T-0' : `T+${-n}d`;
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function rel(iso) {
  if (!iso) return '';
  const s = (toDate(iso) - Date.now()) / 1000, a = Math.abs(s);
  if (Number.isNaN(s)) return '';
  const [v, u] = a < 60 ? [s, 'second'] : a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour']
    : a < 2592000 ? [s / 86400, 'day'] : a < 31536000 ? [s / 2592000, 'month'] : [s / 31536000, 'year'];
  return rtf.format(Math.round(v), u);
}
const fmtTime = iso => iso ? toDate(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const isOverdue = t => t.due_at && t.due_at < todayISO() && !['completed', 'cancelled'].includes(t.status);
const splitList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let uid = 0;
const nextId = p => `${p}-${++uid}`;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw { error: 'Network error. Is the server running?' }; }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    resetSession();
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw { error: 'Signed out', silent: true };
  }
  if (!res.ok) throw { error: (data && data.error) || `${res.status} ${res.statusText}` };
  return data;
}
// Everything tied to the signed-in user; cleared on sign out, account delete and any 401.
function resetSession() {
  me = null; settingsCache = null; notifs = []; pollDown = false;
  chat.thread_id = null; chat.msgs = []; chat.busy = false; chatEl = null;
}
function fail(e) { if (!e || !e.silent) toast((e && e.error) || String(e), { error: true }); }
const act = fn => async ev => { try { await fn(ev); } catch (e) { fail(e); } };
const soft = (p, fallback) => p.catch(e => { fail(e); return fallback; });
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

// Errors go to the assertive region and stay until dismissed; undo toasts last 8s; plain ones 5s.
function toast(text, { undo, error } = {}) {
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, h('span', null, text));
  if (undo) t.append(h('button', { type: 'button', class: 'link', onclick: act(async () => { t.remove(); await undo(); }) }, 'Undo'));
  if (error) t.append(h('button', { type: 'button', class: 'link', 'aria-label': 'Dismiss error', onclick: () => t.remove() }, 'Dismiss'));
  $(error ? '#alerts' : '#toasts').append(t);
  if (!error) setTimeout(() => t.remove(), undo ? 8000 : 5000);
}

// Downloads go through fetch so a 4xx/5xx shows as a toast instead of a broken file.
async function download(path, fallbackName) {
  let res;
  try { res = await fetch(path, { credentials: 'same-origin' }); } catch { throw { error: 'Network error. Is the server running?' }; }
  if (res.status === 401) { resetSession(); location.hash = '#/login'; throw { error: 'Signed out', silent: true }; }
  if (!res.ok) { const d = await res.json().catch(() => null); throw { error: (d && d.error) || `${res.status} ${res.statusText}` }; }
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: m ? m[1] : fallbackName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const dlButton = (label, path, name) => h('button', { type: 'button', class: 'btn', onclick: act(e => busy(e.currentTarget, () => download(path, name))) }, label);

// Save-on-change selects: commit on mouse pick, Enter or blur, not on every arrow key while browsing.
function settleSelect(sel, commit) {
  let kb = false, last = sel.value;
  const fire = () => { kb = false; if (sel.value !== last) { last = sel.value; commit(sel.value); } };
  sel.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fire(); } else if (/^(Arrow|Home|End|Page)/.test(e.key) || e.key.length === 1) kb = true;
  });
  sel.addEventListener('change', () => { if (!kb) fire(); });
  sel.addEventListener('blur', () => { if (kb) fire(); });
  return sel;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed. Select the text and copy it manually.', { error: true }); }
}

function ask(title, body, { yes = 'Confirm', danger = false, password = false } = {}) {
  return new Promise(resolve => {
    const pw = password && h('input', { type: 'password', id: 'dlg-pw', required: true, autocomplete: 'current-password', autofocus: true });
    const d = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-t' },
      h('form', { method: 'dialog' },
        h('h2', { id: 'dlg-t' }, title),
        h('p', null, body),
        pw && h('label', { for: 'dlg-pw', class: 'field' }, 'Password'), pw,
        h('div', { class: 'dialog-acts' },
          h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok' }, yes))));
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); if (d.open) d.close(); d.remove(); };
    $('form', d).addEventListener('submit', e => { e.preventDefault(); finish(e.submitter && e.submitter.value === 'ok' ? (pw ? pw.value : true) : false); });
    d.addEventListener('close', () => finish(false)); // Esc
    document.body.append(d);
    d.showModal();
  });
}

function showHelp() {
  if ($('dialog.help')) return;
  const rows = [
    ['/', 'Focus search'], ['g h / g i / g p / g s / g a', 'Go to Home, Inbox, People, Sources, Assistant'],
    ['j / k', 'Next / previous row'], ['Enter', 'Open task'], ['1 - 5', 'Status: open, in progress, waiting, completed, cancelled'],
    ['n', 'Add note'], ['a / e / r / m / z', 'Inbox: accept, edit, reject, merge, snooze'],
    ['Ctrl/Cmd + K', 'Assistant'], ['Esc', 'Close panel'], ['?', 'This help'],
  ];
  const d = h('dialog', { class: 'dialog help', 'aria-labelledby': 'help-t' },
    h('form', { method: 'dialog' },
      h('h2', { id: 'help-t' }, 'Keyboard shortcuts'),
      h('table', { class: 'keys' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, h('kbd', null, k)), h('td', null, v))))),
      h('div', { class: 'dialog-acts' }, h('button', { class: 'btn primary', value: 'ok' }, 'Close'))));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

// ---------- theme ----------
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const currentTheme = () => THEMES.includes(store('aria.theme')) ? store('aria.theme') : 'system';
applyTheme(currentTheme());

// ---------- router ----------
function parseHash() {
  const raw = location.hash.slice(1) || '/home';
  const [p, qs = ''] = raw.split('?');
  const parts = p.split('/').filter(Boolean);
  return { parts: parts.length ? parts : ['home'], q: new URLSearchParams(qs) };
}
function go(hash, replace) {
  if (replace) { history.replaceState(null, '', hash); route(); }
  else if (location.hash === hash) route();
  else location.hash = hash;
}
const rerender = () => route();

let navToken = 0, lastPath = '';
async function route() {
  const tok = ++navToken, alive = () => tok === navToken;
  const { parts, q } = parseHash();
  closeOverlays(false);
  viewKeys = null;
  if (parts[0] === 'login') { lastPath = 'login'; renderAuth(); return; }
  if (!me) {
    try { await loadMe(); } catch (e) { fail(e); return; }
    if (!alive()) return;
  }
  ensureShell();
  const path = parts.join('/');
  const samePath = path === lastPath;
  lastPath = path;
  const active = document.activeElement;
  const fk = nextFocus || (samePath && active && active.dataset && active.dataset.fk);
  nextFocus = null;
  let fkIdx = -1;
  if (fk) { const pre = fk.split('-')[0] + '-'; fkIdx = $$(`[data-fk^="${pre}"]`).indexOf(active); }

  markNav(parts[0]);
  document.body.classList.toggle('on-assistant', parts[0] === 'assistant');
  if (parts[0] !== 'assistant') $('#rail-body').append(assistantPanel());
  // FM9: the search box is Home's q filter. It mirrors q on Home and is cleared elsewhere; Enter anywhere routes to Home with q.
  if (document.activeElement !== $('#search')) $('#search').value = parts[0] === 'home' ? q.get('q') || '' : '';

  const main = $('#main');
  if (!samePath) { window.scrollTo(0, 0); mount(main, h('div', { class: 'skel', 'aria-busy': 'true', 'aria-label': 'Loading' }, [0, 1, 2, 3, 4].map(() => h('div', { class: 'skel-row' })))); }
  const view = VIEWS[parts[0]] || viewNotFound;
  try { await view(main, parts, q, alive); }
  catch (e) {
    if (!alive()) return;
    fail(e);
    if (!e.silent) mount(main, h('h1', { tabindex: '-1' }, 'Could not load this page'), h('p', { class: 'error-text' }, e.error || String(e)),
      h('button', { class: 'btn', type: 'button', onclick: rerender }, 'Try again'));
  }
  if (!alive()) return;
  let target = fk && $(`[data-fk="${CSS.escape(fk)}"]`);
  if (fk && !target && fkIdx >= 0) { const all = $$(`[data-fk^="${fk.split('-')[0]}-"]`); target = all[Math.min(fkIdx, all.length - 1)]; }
  if (target) target.focus({ preventScroll: false });
  else if (!samePath) { const h1 = $('h1', main); if (h1) h1.focus({ preventScroll: true }); }
  const h1 = $('h1', main);
  document.title = (h1 ? h1.textContent : 'Aria') + ' · Aria';
}

async function loadMe() {
  me = await api('GET', '/api/me');
  updateCounts();
}
async function refreshCounts() {
  try { me = { ...me, ...(await api('GET', '/api/me')) }; updateCounts(); } catch (e) { fail(e); }
}
function updateCounts() {
  if (!me) return;
  const c = me.counts || {};
  const b = $('#inbox-badge');
  if (b) { b.textContent = c.suggested || ''; b.hidden = !c.suggested; }
  const strip = $('#strip');
  if (strip) strip.replaceWith(summaryStrip());
  const tag = $('#demo-tag');
  if (tag) tag.hidden = !me.demo;
}

// ---------- shell ----------
function ensureShell() {
  if ($('#main')) return;
  const navItems = [['home', 'Home'], ['inbox', 'Inbox'], ['people', 'People'], ['sources', 'Sources'], ['assistant', 'Assistant'], ['settings', 'Settings']];
  if (me.user && me.user.role === 'admin') navItems.push(['admin', 'Admin']);

  const search = h('input', { id: 'search', type: 'search', placeholder: 'Search tasks  /', 'aria-label': 'Search tasks, notes, people, sources', autocomplete: 'off' });
  let searchT;
  search.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { if (parseHash().parts[0] === 'home') setHomeParam('q', search.value.trim(), true); }, 250);
  });
  search.addEventListener('keydown', e => { if (e.key === 'Escape') { search.blur(); e.stopPropagation(); } });

  const themeBtn = h('button', { type: 'button', class: 'btn ghost small', id: 'theme-btn' });
  const setThemeLabel = () => { const t = currentTheme(); themeBtn.textContent = 'Theme: ' + t[0].toUpperCase() + t.slice(1); themeBtn.setAttribute('aria-label', `Theme: ${t}. Change theme`); };
  themeBtn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    store('aria.theme', next === 'system' ? null : next);
    applyTheme(next); setThemeLabel();
  });
  setThemeLabel();

  const bellBadge = h('span', { class: 'badge', id: 'bell-badge', hidden: true });
  const bell = h('button', { type: 'button', class: 'btn ghost icon-btn', id: 'bell', 'aria-expanded': 'false', 'aria-controls': 'notif-pop', 'aria-label': 'Notifications' }, icon('bell'), bellBadge);
  const pop = h('div', { class: 'popover', id: 'notif-pop', role: 'region', 'aria-label': 'Notifications', hidden: true });
  bell.addEventListener('click', act(toggleNotifs));

  mount($('#app'), h('div', { class: 'shell' },
    h('button', { type: 'button', class: 'skip', onclick: () => $('#main').focus() }, 'Skip to content'),
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/home' }, logo(), 'Aria'),
      h('span', { class: 'tag demo', id: 'demo-tag', hidden: !me.demo, title: 'Showing sample data. Remove it in Settings.' }, 'Sample data'),
      h('form', { role: 'search', class: 'search', onsubmit: e => { e.preventDefault(); setHomeParam('q', search.value.trim()); } }, search),
      h('div', { class: 'top-acts' },
        h('button', { type: 'button', class: 'btn ghost small rail-toggle', onclick: openAssistant, 'aria-label': 'Open assistant (Ctrl+K)' }, 'Ask Aria'),
        themeBtn,
        h('div', { class: 'bell-wrap' }, bell, pop),
        h('a', { href: '/docs/', class: 'btn ghost small hide-sm', target: '_blank', rel: 'noopener' }, 'Docs'),
        h('a', { href: 'https://github.com/trippusultan', class: 'gh hide-sm', target: '_blank', rel: 'noopener', title: 'Built by trippusultan on GitHub' },
          h('span', { class: 'gh-mark', 'aria-hidden': 'true' }), h('span', null, 'Built by '), h('strong', null, '@trippusultan')),
        h('button', { type: 'button', class: 'btn ghost small hide-sm', onclick: showHelp, 'aria-label': 'Keyboard shortcuts' }, '?'))),
    h('nav', { class: 'nav', 'aria-label': 'Primary' },
      h('ul', null, navItems.map(([k, label]) => h('li', { class: k === 'admin' ? 'hide-sm' : null },
        h('a', { href: '#/' + k, 'data-nav': k }, label, k === 'inbox' && h('span', { class: 'badge', id: 'inbox-badge', hidden: true }))))),
      h('button', { type: 'button', class: 'btn ghost small signout', onclick: act(signOut) }, 'Sign out')),
    h('main', { id: 'main', tabindex: '-1' }),
    h('aside', { id: 'rail', 'aria-label': 'Assistant panel' },
      h('button', { type: 'button', class: 'btn ghost small rail-close', onclick: () => closeOverlays() }, 'Close'),
      h('div', { id: 'rail-body' })),
    h('div', { class: 'scrim', onclick: () => closeOverlays() })));
  updateCounts();
  loadNotifs();
}

function markNav(k) {
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === k || (k === 'task' && a.dataset.nav === 'home')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function signOut() {
  await api('POST', '/api/auth/logout').catch(() => {}); // signing out locally regardless is the point
  resetSession();
  go('#/login');
}

function safeHash(link) {
  if (typeof link !== 'string') return null;
  if (link.startsWith('#/')) return link;
  if (link.startsWith('/#/')) return link.slice(1);
  return null;
}
async function loadNotifs(quiet) {
  try { notifs = await api('GET', '/api/notifications') || []; } catch (e) { if (quiet) throw e; fail(e); return; }
  const n = notifs.filter(x => !x.read).length;
  const b = $('#bell-badge');
  if (b) { b.textContent = n || ''; b.hidden = !n; $('#bell').setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications'); }
}
async function toggleNotifs() {
  const pop = $('#notif-pop'), bell = $('#bell');
  if (!pop.hidden) { closeOverlays(); return; }
  await loadNotifs();
  mount(pop, h('h2', { class: 'pop-h' }, 'Notifications'),
    notifs.length ? h('ul', { class: 'notif-list' }, notifs.map(n => {
      const href = safeHash(n.link);
      const body = [h('span', { class: 'notif-text' }, n.text), h('span', { class: 'muted small' }, rel(n.created_at))];
      return h('li', { class: n.read ? '' : 'unread' }, href ? h('a', { href, onclick: () => closeOverlays(false) }, body) : h('div', null, body));
    })) : h('p', { class: 'muted pad' }, 'No notifications.'),
    h('p', { class: 'pop-foot' }, h('a', { href: '#/home', onclick: () => closeOverlays(false) }, 'Open today’s digest on Home')));
  pop.hidden = false;
  bell.setAttribute('aria-expanded', 'true');
  if (notifs.some(n => !n.read)) {
    api('POST', '/api/notifications/read').then(() => { notifs.forEach(n => { n.read = true; }); const b = $('#bell-badge'); b.hidden = true; }).catch(fail);
  }
}

let railReturnFocus = null;
const shellParts = () => ['.topbar', '.nav', '#main', '.skip'].map(s => $(s)).filter(Boolean);
function openAssistant() {
  // The assistant lives only on its own page now.
  if (parseHash().parts[0] !== 'assistant') { go('#/assistant'); setTimeout(() => $('#chat-input')?.focus(), 450); return; }
  if (parseHash().parts[0] === 'assistant' || matchMedia('(min-width: 1200px)').matches) { $('#chat-input')?.focus(); return; }
  railReturnFocus = document.activeElement;
  document.body.classList.add('rail-open');
  const rail = $('#rail');
  rail.setAttribute('role', 'dialog'); rail.setAttribute('aria-modal', 'true');
  for (const el of shellParts()) el.inert = true; // FI7: overlay is modal
  $('#chat-input')?.focus();
}
// Closes the rail overlay / notification popover. focusBack: return focus to the control that opened it (Esc, Close).
function closeOverlays(focusBack = true) {
  let closed = false;
  if (document.body.classList.contains('rail-open')) {
    document.body.classList.remove('rail-open'); closed = true;
    const rail = $('#rail');
    rail.removeAttribute('role'); rail.removeAttribute('aria-modal');
    for (const el of shellParts()) el.inert = false;
    if (focusBack && railReturnFocus && railReturnFocus.isConnected) railReturnFocus.focus();
  }
  const pop = $('#notif-pop');
  if (pop && !pop.hidden) {
    pop.hidden = true; $('#bell').setAttribute('aria-expanded', 'false'); closed = true;
    if (focusBack && pop.contains(document.activeElement)) $('#bell').focus();
  }
  return closed;
}
document.addEventListener('click', e => { // FM8: outside click closes the popover
  const pop = $('#notif-pop');
  if (pop && !pop.hidden && !e.target.closest('.bell-wrap')) closeOverlays(false);
});

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { if (me) { e.preventDefault(); openAssistant(); } return; }
  if (e.key === 'Escape') {
    const popOpen = $('#notif-pop') && !$('#notif-pop').hidden;
    if (closeOverlays()) { e.preventDefault(); if (popOpen) $('#bell').focus(); }
    return;
  }
  const t = e.target;
  if (e.ctrlKey || e.metaKey || e.altKey || (t.closest && t.closest('input, textarea, select, [contenteditable], dialog'))) return;
  if (!me || !$('#main')) return;
  if (gPending) {
    gPending = false;
    const dest = { h: '#/home', i: '#/inbox', p: '#/people', s: '#/sources', a: '#/assistant' }[e.key];
    if (dest) { e.preventDefault(); go(dest); }
    return;
  }
  if (e.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1200); return; }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === '?') { e.preventDefault(); showHelp(); return; }
  if (viewKeys && viewKeys(e)) e.preventDefault();
});

function focusItem(items, el) {
  for (const i of items) i.tabIndex = -1;
  el.tabIndex = 0;
  el.focus();
}
// j/k over items matching sel inside main; other keys go to map[key](item) or map.digit(item, key).
function listNav(e, sel, map) {
  const items = $$(sel, $('#main'));
  if (!items.length) return false;
  const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest(sel) : null;
  const i = items.indexOf(cur);
  if (e.key === 'j' || e.key === 'k') {
    const n = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'j' ? 1 : -1)));
    focusItem(items, items[n]);
    return true;
  }
  if (!cur) return false;
  if (e.key === 'Enter' && e.target !== cur) return false;
  const f = map[e.key] || (/^[1-5]$/.test(e.key) && map.digit);
  if (!f) return false;
  f(cur, e.key);
  return true;
}

// ---------- shared pieces ----------
function summaryStrip() {
  const c = (me && me.counts) || {};
  const cell = (href, n, label, cls) => h('a', { href, class: 'stat ' + (cls || '') }, h('span', { class: 'num' }, n ?? 0), h('span', { class: 'lbl' }, label));
  return h('nav', { id: 'strip', class: 'strip', 'aria-label': 'Summary' },
    cell('#/home?status=open', c.open, 'Open'),
    cell('#/home?status=waiting', c.waiting, 'Waiting'),
    cell('#/home?due=overdue', c.overdue, 'Overdue', c.overdue ? 'warn' : ''),
    cell('#/inbox', c.suggested, 'Suggested', 'suggested'));
}

function personChip(s, { clickable = true } = {}) {
  const name = s.display_name || s.name || 'Unknown';
  const kids = [name, s.unverified && h('span', { class: 'unv' }, ' (unverified)')];
  if (clickable && s.id != null) {
    return h('button', { type: 'button', class: 'chip person' + (s.unverified ? ' unverified' : ''), title: `Show tasks with ${name}`, onclick: () => go('#/home?person=' + encodeURIComponent(s.id)) }, kids);
  }
  return h('span', { class: 'chip person' + (s.unverified ? ' unverified' : '') }, kids);
}
const dirPill = d => h('span', { class: 'pill dir-' + (d || 'unclear') }, DIR_LABEL[d] || 'Unclear');
function srcMeta(src) {
  if (!src) return h('span', { class: 'src muted' }, icon('manual'), h('span', null, 'Manual'));
  return h('span', { class: 'src', title: `${SOURCE_LABEL[src.type] || src.type}: ${src.title} · ${fmtTime(src.started_at)}` },
    icon(src.type, SOURCE_LABEL[src.type] || src.type), h('span', { class: 'src-t' }, src.title), h('span', { class: 'muted' }, rel(src.started_at)));
}
function quote(text, speaker) {
  return h('blockquote', { class: 'excerpt' }, h('p', null, '“', text, '”'), speaker && h('footer', null, '— ', h('cite', null, speaker)));
}
const statusBadge = s => h('span', { class: 'pill st-' + s }, STATUS_LABEL[s] || s);
function empty(title, text, ...acts) {
  return h('div', { class: 'empty' }, h('span', { class: 'cat', 'aria-hidden': 'true' }), h('h2', null, title), text && h('p', { class: 'muted' }, text), acts.length && h('div', { class: 'row-acts' }, acts));
}
function sourceLink(t) {
  if (!t.source) return null;
  let href = '#/sources/' + t.source.id;
  if (t.excerpt && Number.isFinite(t.excerpt.start_offset)) href += `?at=${t.excerpt.start_offset}&len=${(t.excerpt.text || '').length}`;
  return href;
}

async function setStatus(t, status, refresh) {
  if (!status || status === t.status) return;
  const prev = t.status;
  await api('PATCH', `/api/tasks/${t.id}`, { status });
  toast(`Marked ${STATUS_LABEL[status].toLowerCase()}`, {
    undo: async () => { await api('PATCH', `/api/tasks/${t.id}`, { status: prev }); toast(`Restored to ${STATUS_LABEL[prev].toLowerCase()}`); refreshCounts(); refresh(); },
  });
  refreshCounts();
  refresh();
}

function taskRow(t, refresh) {
  const stakeholders = t.stakeholders || [];
  const statusSel = settleSelect(h('select', { class: 'status st-' + t.status, 'aria-label': `Status of ${t.title}`, 'data-fk': 'st-' + t.id, value: t.status },
    STATUSES.map(([v, l]) => h('option', { value: v }, l))), v => act(() => setStatus(t, v, refresh))());

  const dateIn = h('input', { type: 'date', class: 'date-hidden', tabindex: '-1', 'aria-hidden': 'true', value: t.due_at || '',
    onchange: act(async e => {
      const v = e.target.value || null;
      await api('PATCH', `/api/tasks/${t.id}`, { due_at: v });
      toast(v ? `Due ${fmtDue(v)}` : 'Due date cleared'); refreshCounts(); refresh();
    }) });
  const over = isOverdue(t);
  const dueBtn = h('button', { type: 'button', class: 'due' + (over ? ' overdue' : '') + (t.due_at ? '' : ' none'), 'data-fk': 'due-' + t.id,
    'aria-label': (t.due_at ? `Due ${fmtDue(t.due_at)}${over ? ', overdue' : ''}` : 'No due date') + '. Set due date',
    onclick: () => { try { dateIn.showPicker(); } catch { dateIn.classList.add('shown'); dateIn.removeAttribute('aria-hidden'); dateIn.tabIndex = 0; dateIn.focus(); } } },
  t.due_at ? tminus(t.due_at) : 'Set due');

  const noteIn = h('input', { type: 'text', 'aria-label': `Note for ${t.title}`, placeholder: 'Add a note, Enter to save', maxlength: '4000' });
  const noteForm = h('form', { class: 'note-form', hidden: true, onsubmit: act(async e => {
    e.preventDefault();
    const body = noteIn.value.trim();
    if (!body) return;
    await busy(e.submitter, () => api('POST', `/api/tasks/${t.id}/notes`, { body }));
    toast('Note added'); nextFocus = 'nt-' + t.id; refresh();
  }) }, noteIn, h('button', { class: 'btn small primary' }, 'Save'), h('button', { type: 'button', class: 'btn small', onclick: () => closeNote() }, 'Cancel'));
  const noteBtn = h('button', { type: 'button', class: 'btn ghost small note-toggle', 'aria-expanded': 'false', 'data-fk': 'nt-' + t.id,
    onclick: () => { noteForm.hidden ? openNote() : closeNote(); } }, 'Note', t.notes_count ? h('span', { class: 'count' }, t.notes_count) : null);
  const openNote = () => { noteForm.hidden = false; noteBtn.setAttribute('aria-expanded', 'true'); noteIn.focus(); };
  const closeNote = () => { noteForm.hidden = true; noteBtn.setAttribute('aria-expanded', 'false'); noteBtn.focus(); };
  noteIn.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeNote(); } });

  const href = sourceLink(t);
  const li = h('li', { class: 'row' + (['completed', 'cancelled'].includes(t.status) ? ' done' : ''), tabindex: '-1', 'data-fk': 'row-' + t.id, 'data-id': t.id },
    statusSel,
    h('div', { class: 'row-main' },
      h('a', { class: 'title', href: '#/task/' + t.id }, t.title),
      t.last_note && h('span', { class: 'last-note muted', title: t.last_note }, t.last_note)),
    dirPill(t.direction),
    h('span', { class: 'people' }, stakeholders.map(s => personChip(s))),
    srcMeta(t.source),
    h('span', { class: 'due-wrap' }, dueBtn, dateIn),
    h('span', { class: 'acts' }, noteBtn,
      href ? h('a', { class: 'btn ghost small', href, 'aria-label': `Open source for ${t.title}` }, icon('open'), h('span', { class: 'hide-md' }, 'Source')) : null),
    noteForm);
  li._task = t;
  li._openNote = openNote;
  return li;
}

function rowKeys(refresh) {
  return e => listNav(e, '.row', {
    Enter: row => go('#/task/' + row.dataset.id),
    n: row => row._openNote(),
    digit: (row, k) => act(() => setStatus(row._task, STATUSES[Number(k) - 1][0], refresh))(),
  });
}

function taskList(tasks, refresh) {
  return DIRS.map(([d, label]) => {
    const g = tasks.filter(t => (t.direction || 'unclear') === d);
    if (!g.length) return null;
    const id = nextId('grp');
    return h('section', { class: 'group', 'aria-labelledby': id },
      h('h2', { class: 'group-h', id }, label, ' ', h('span', { class: 'num muted' }, g.length)),
      h('ul', { class: 'rows' }, g.map(t => taskRow(t, refresh))));
  });
}

function newTaskForm({ source_id, onDone, onCancel } = {}) {
  const f = h('form', { class: 'card new-task', 'aria-label': 'New task' });
  const id = nextId('nt');
  const title = h('input', { id: id + 't', required: true, maxlength: '300', autocomplete: 'off' });
  const people = h('input', { id: id + 'p', placeholder: 'Ananya Shah, Rohan Mehta', autocomplete: 'off' });
  const due = h('input', { id: id + 'd', type: 'date' });
  const dir = h('select', { id: id + 'r', value: 'i_owe' }, DIRS.map(([v, l]) => h('option', { value: v }, l)));
  f.append(
    h('div', { class: 'grid-form' },
      h('label', { class: 'field wide' }, h('span', null, 'Title'), title),
      h('label', { class: 'field wide' }, h('span', null, 'Stakeholders (comma separated)'), people),
      h('label', { class: 'field' }, h('span', null, 'Due'), due),
      h('label', { class: 'field' }, h('span', null, 'Direction'), dir)),
    h('div', { class: 'row-acts' },
      h('button', { class: 'btn primary' }, 'Create task'),
      h('button', { type: 'button', class: 'btn', onclick: () => onCancel && onCancel() }, 'Cancel')));
  f.addEventListener('keydown', e => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } });
  f.addEventListener('submit', act(async e => {
    e.preventDefault();
    const body = { title: title.value.trim(), direction: dir.value, stakeholders: splitList(people.value).map(name => ({ name })) };
    if (due.value) body.due_at = due.value;
    if (source_id) body.source_id = source_id;
    const t = await busy(e.submitter, () => api('POST', '/api/tasks', body));
    toast('Task created');
    refreshCounts();
    if (onDone) onDone(t);
  }));
  setTimeout(() => title.focus());
  return f;
}

// ---------- auth ----------
let authMode = 'login';
function renderAuth() {
  const signup = authMode === 'signup';
  const err = h('p', { class: 'error-text', role: 'alert' });
  const email = h('input', { id: 'au-email', type: 'email', required: true, autocomplete: 'email' });
  const pw = h('input', { id: 'au-pw', type: 'password', required: true, minlength: signup ? '8' : null, autocomplete: signup ? 'new-password' : 'current-password' });
  const name = signup && h('input', { id: 'au-name', required: true, autocomplete: 'name' });
  const form = h('form', { class: 'auth-form' },
    signup && h('label', { class: 'field', for: 'au-name' }, 'Name'), name,
    h('label', { class: 'field', for: 'au-email' }, 'Work email'), email,
    h('label', { class: 'field', for: 'au-pw' }, 'Password', signup && h('span', { class: 'muted small' }, ' (at least 8 characters)')), pw,
    signup && h('div', { class: 'consent' }, h('h2', null, 'Before you start'), h('p', null, CONSENT),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', required: true }), ' I have read this notice')),
    err,
    h('button', { class: 'btn primary block' }, signup ? 'Create account' : 'Sign in'));
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    err.textContent = '';
    try {
      await busy(e.submitter, () => api('POST', signup ? '/api/auth/signup' : '/api/auth/login',
        signup ? { email: email.value.trim(), password: pw.value, name: name.value.trim() } : { email: email.value.trim(), password: pw.value }));
    } catch (x) { err.textContent = x.error || 'Could not sign in'; return; }
    me = null;
    await loadMe();
    go('#/home');
  }));
  mount($('#app'), h('main', { class: 'auth', id: 'auth' },
    h('section', { class: 'auth-brand', 'aria-label': 'About Aria' },
      h('span', { class: 'brand' }, logo(), 'Aria'),
      h('h1', { tabindex: '-1' }, 'Every commitment, kept.'),
      h('p', { class: 'lead' }, 'Aria turns your calls and email into confirmed action items, tracked against the people you owe.'),
      h('figure', { class: 'auth-proof' },
        h('span', { class: 'badge-suggested' }, 'Suggested'), ' ', h('strong', null, 'Send revised term sheet with prepayment cap'),
        h('blockquote', { class: 'excerpt' }, "I'll turn the term sheet around by Thursday with the prepayment cap we discussed."),
        h('figcaption', { class: 'muted small' }, 'Example from a Zoom call. Nothing becomes a task until you accept it.'))),
    h('div', { class: 'auth-side' }, h('div', { class: 'auth-card' },
      h('h2', null, signup ? 'Create your account' : 'Sign in'),
      h('p', { class: 'muted' }, signup ? 'Your ledger is private to you.' : 'Welcome back to your action ledger.'),
      form,
      h('p', { class: 'small' }, signup ? 'Already have an account? ' : 'New here? ',
        h('button', { type: 'button', class: 'link', onclick: () => { authMode = signup ? 'login' : 'signup'; renderAuth(); } }, signup ? 'Sign in' : 'Create an account'))))));
  document.title = (signup ? 'Create account' : 'Sign in') + ' · Aria';
  (signup ? name : email).focus();
}

// ---------- home ----------
function homeQuery() { const { parts, q } = parseHash(); return parts[0] === 'home' ? q : new URLSearchParams(); }
function setHomeParam(key, val, replace) {
  const q = homeQuery();
  if (val) q.set(key, val); else q.delete(key);
  const s = q.toString().replace(/%2C/gi, ','); // FM14: keep status=open,waiting readable
  go('#/home' + (s ? '?' + s : ''), replace);
}
const viewsKey = () => 'aria.views.' + (me && me.user ? me.user.id : 'anon'); // FM15: per user
const loadViews = () => { try { return JSON.parse(store(viewsKey()) || '[]'); } catch { return []; } };

async function viewHome(main, parts, q, alive) {
  const aq = new URLSearchParams();
  for (const k of TASK_PARAMS) if (q.get(k)) aq.set(k, q.get(k));
  const filtered = TASK_PARAMS.some(k => q.get(k));
  const [tasks, people, digest, settings] = await Promise.all([api('GET', '/api/tasks' + (aq.toString() ? '?' + aq : '')), soft(api('GET', '/api/people'), []),
    filtered ? null : soft(api('GET', '/api/digest'), null), soft(getSettings(), {})]);
  if (!alive()) return;

  const statusSel = q.get('status') ? q.get('status').split(',') : DEFAULT_STATUS;
  const toggleStatus = s => {
    const next = statusSel.includes(s) ? statusSel.filter(x => x !== s) : [...statusSel, s];
    const ordered = STATUSES.map(x => x[0]).filter(x => next.includes(x));
    setHomeParam('status', ordered.length && ordered.join(',') !== DEFAULT_STATUS.join(',') ? ordered.join(',') : '');
  };
  const sel = (key, label, opts) => h('label', { class: 'filter' }, h('span', { class: 'sr-only' }, label),
    settleSelect(h('select', { 'data-fk': 'f-' + key, value: q.get(key) || '' },
      h('option', { value: '' }, label + ': any'), opts.map(([v, l]) => h('option', { value: String(v) }, l))), v => setHomeParam(key, v)));

  // saved views (UI-7)
  const views = loadViews();
  const cur = location.hash;
  const savedHere = views.find(v => v.hash === cur);
  const viewName = h('input', { 'aria-label': 'Name for this view', placeholder: 'Waiting on clients', maxlength: '60' });
  const saveForm = h('form', { class: 'inline-form', hidden: true, onsubmit: e => {
    e.preventDefault();
    const name = viewName.value.trim();
    if (!name) return;
    store(viewsKey(), JSON.stringify([...views.filter(v => v.name !== name), { name, hash: cur }]));
    toast(`Saved view “${name}”`); rerender();
  } }, viewName, h('button', { class: 'btn small primary' }, 'Save'));

  const newWrap = h('div', { class: 'new-wrap' });
  const newBtn = h('button', { type: 'button', class: 'btn primary', 'data-fk': 'new-task', 'aria-expanded': 'false',
    onclick: () => openNew() }, 'New task');
  const openNew = () => {
    newBtn.setAttribute('aria-expanded', 'true');
    mount(newWrap, newTaskForm({ onDone: () => { nextFocus = 'new-task'; rerender(); }, onCancel: () => { mount(newWrap); newBtn.setAttribute('aria-expanded', 'false'); newBtn.focus(); } }));
  };

  const filterBar = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filters' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Status' },
      STATUSES.map(([v, l]) => h('button', { type: 'button', class: 'chip toggle', 'aria-pressed': String(statusSel.includes(v)), 'data-fk': 'fs-' + v, onclick: () => toggleStatus(v) }, l))),
    sel('direction', 'Direction', DIRS),
    sel('person', 'Stakeholder', people.map(p => [p.id, p.display_name + (p.unverified ? ' (unverified)' : '')])),
    sel('source_type', 'Source', SOURCE_TYPES),
    sel('due', 'Due', DUE_WINDOWS),
    h('label', { class: 'filter' }, h('span', { class: 'sr-only' }, 'Tag'),
      h('input', { type: 'text', placeholder: 'Tag', value: q.get('tag') || '', 'data-fk': 'f-tag', size: '10', onchange: e => setHomeParam('tag', e.target.value.trim()) })),
    filtered && h('button', { type: 'button', class: 'btn ghost small', onclick: () => { $('#search').value = ''; go('#/home'); } }, 'Clear filters'),
    h('span', { class: 'views' },
      views.length ? settleSelect(h('select', { 'aria-label': 'Saved views', value: savedHere ? savedHere.hash : '' },
        h('option', { value: '' }, 'Saved views'), views.map(v => h('option', { value: v.hash }, v.name))), v => v && go(v)) : null,
      savedHere
        ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => { store(viewsKey(), JSON.stringify(views.filter(v => v !== savedHere))); toast('View removed'); rerender(); } }, 'Remove view')
        : h('button', { type: 'button', class: 'btn ghost small', onclick: () => { saveForm.hidden = false; viewName.focus(); } }, 'Save view'),
      saveForm));

  const c = me.counts || {};
  const dayOne = !tasks.length && !filtered && !c.open && !c.waiting && !c.suggested;
  let body;
  if (dayOne) {
    body = empty('Connect Zoom and mail, or create a task by hand', 'Aria drafts action items from meetings and mail you connect. You confirm each one before it becomes work.',
      h('a', { class: 'btn primary', href: '#/settings' }, 'Connect Zoom and mail'),
      h('button', { type: 'button', class: 'btn', onclick: act(async e => { await loadSample(e); go('#/inbox'); }) }, 'Try with sample data'),
      h('button', { type: 'button', class: 'btn', onclick: () => openNew() }, 'Create a task'));
  } else if (!tasks.length) {
    body = empty(filtered ? 'No tasks match these filters' : 'Nothing open', filtered ? null : (c.suggested ? `${c.suggested} suggestions are waiting in the inbox.` : null),
      filtered ? h('button', { type: 'button', class: 'btn', onclick: () => go('#/home') }, 'Clear filters') : h('a', { class: 'btn', href: '#/inbox' }, 'Open inbox'));
  } else {
    body = h('div', { class: 'list', 'aria-label': `${tasks.length} tasks` }, taskList(tasks, rerender));
  }

  mount(main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Home'), h('span', { class: 'muted small num' }, `${tasks.length} shown`), newBtn),
    summaryStrip(),
    digestCard(digest, settings.waiting_days ?? 5),
    newWrap,
    filterBar,
    body);
  viewKeys = rowKeys(rerender);
}

// FM11: in-app digest (same data as the morning email)
function digestCard(d, days) {
  if (!d) return null;
  const n = d.overdue.length + d.due_today.length + d.waiting_stale.length;
  const sec = (label, list) => list.length ? h('div', { class: 'dg' }, h('h3', null, label, ' ', h('span', { class: 'num muted' }, list.length)),
    h('ul', { class: 'plain' }, list.map(t => h('li', null, h('a', { href: '#/task/' + t.id }, t.title), ' ',
      h('span', { class: 'muted small' }, (t.stakeholders || []).map(x => x.display_name).join(', ')))))) : null;
  return h('details', { class: 'card digest', open: d.overdue.length + d.due_today.length > 0 || null },
    h('summary', null, 'Digest: ', h('span', { class: 'num' }, d.overdue.length), ' overdue · ', h('span', { class: 'num' }, d.due_today.length), ' due today · ',
      h('span', { class: 'num' }, d.waiting_stale.length), ` waiting more than ${days} days`),
    n ? h('div', { class: 'dg-grid' }, sec('Overdue', d.overdue), sec('Due today', d.due_today), sec(`Waiting more than ${days} days`, d.waiting_stale))
      : h('p', { class: 'muted small' }, 'Nothing overdue, due today or waiting too long.'));
}

// ---------- inbox ----------
async function getSettings() {
  if (!settingsCache) settingsCache = await api('GET', '/api/settings');
  return settingsCache;
}

async function viewInbox(main, parts, q, alive) {
  const [list, settings] = await Promise.all([api('GET', '/api/suggestions'), soft(getSettings(), { high_threshold: 0.85 })]);
  if (!alive()) return;
  const bySource = q.get('sort') === 'source';
  const items = [...list].sort(bySource
    ? (a, b) => String(b.source?.started_at || '').localeCompare(String(a.source?.started_at || '')) || b.confidence - a.confidence
    : (a, b) => b.confidence - a.confidence);
  const thr = settings.high_threshold ?? 0.85;
  const nHigh = list.filter(s => s.confidence >= thr).length;
  const bulkLabel = n => `Accept all ≥ ${Math.round(thr * 100)}% (${n})`;
  const bulkBtn = h('button', { type: 'button', class: 'btn primary', hidden: !nHigh, onclick: act(async e => {
    const r = await busy(e.currentTarget, () => api('POST', '/api/suggestions/bulk-accept'));
    toast(`Accepted ${r.accepted}`); refreshCounts(); rerender();
  }) }, bulkLabel(nHigh));
  const countEl = h('span', { class: 'muted small num', id: 'inbox-count' }, `${list.length} pending`);

  const ctx = {
    remove: async card => {
      const cards = $$('.sug', main);
      const i = cards.indexOf(card);
      await slideOut(card);
      const left = $$('.sug', main);
      countEl.textContent = `${left.length} pending`;
      const high = left.filter(c => Number(c.dataset.conf) >= thr).length; // FM1
      bulkBtn.hidden = !high; bulkBtn.textContent = bulkLabel(high);
      refreshCounts();
      if (!left.length) { rerender(); return; }
      focusItem(left, left[Math.max(0, Math.min(i, left.length - 1))]); // FM2: i is -1 if already removed
    },
  };

  let listEl;
  if (!items.length) {
    listEl = empty('Inbox is clear', 'New suggestions appear here after a meeting or email is processed. Nothing becomes a task until you accept it.',
      h('a', { class: 'btn', href: '#/sources' }, 'View sources'), h('a', { class: 'btn', href: '#/home' }, 'Go to Home'));
  } else if (bySource) {
    const groups = new Map();
    for (const s of items) { const k = s.source ? s.source.id : 'none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    listEl = [...groups.values()].map(g => {
      const id = nextId('sg');
      return h('section', { class: 'group', 'aria-labelledby': id },
        h('h2', { class: 'group-h', id }, g[0].source ? g[0].source.title : 'No source', ' ', h('span', { class: 'num muted' }, g.length)),
        h('div', { class: 'sugs' }, g.map(s => sugCard(s, ctx))));
    });
  } else listEl = h('div', { class: 'sugs' }, items.map(s => sugCard(s, ctx)));

  mount(main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Inbox'), countEl,
      bulkBtn),
    h('div', { class: 'toolbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort' },
        h('button', { type: 'button', class: 'chip toggle', 'aria-pressed': String(!bySource), onclick: () => go('#/inbox', true) }, 'By confidence'),
        h('button', { type: 'button', class: 'chip toggle', 'aria-pressed': String(bySource), onclick: () => go('#/inbox?sort=source', true) }, 'By source')),
      h('p', { class: 'muted small hide-sm' }, h('kbd', null, 'j'), '/', h('kbd', null, 'k'), ' move · ', h('kbd', null, 'a'), ' accept · ', h('kbd', null, 'e'), ' edit · ',
        h('kbd', null, 'r'), ' reject · ', h('kbd', null, 'm'), ' merge · ', h('kbd', null, 'z'), ' snooze')),
    listEl);

  viewKeys = e => !document.activeElement.closest('.sug-panel') && listNav(e, '.sug', { // FM16
    a: c => c._act.accept(), e: c => c._act.edit(), r: c => c._act.reject(), m: c => c._act.merge(), z: c => c._act.snooze(),
  });
}

function slideOut(el) {
  return new Promise(res => {
    if (reducedMotion()) { el.remove(); res(); return; }
    const done = () => { el.remove(); res(); };
    el.classList.add('leaving');
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 450);
  });
}

function confBar(c) {
  const pct = Math.round((c || 0) * 100);
  const fill = h('span', { class: 'bar-fill' });
  fill.style.width = pct + '%';
  return h('span', { class: 'conf' + (pct >= 85 ? ' high' : '') }, h('span', { class: 'sr-only' }, 'Confidence '), h('span', { class: 'bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'num' }, pct + '%'));
}

function sugCard(s, ctx) {
  const p = s.payload || {};
  const stake = p.stakeholders || [];
  const tid = 'sug-t-' + s.id;
  const panel = h('div', { class: 'sug-panel', hidden: true });
  const card = h('article', { class: 'sug', tabindex: '-1', 'data-fk': 'sug-' + s.id, 'data-conf': s.confidence, 'aria-labelledby': tid });

  const closePanel = () => { panel.hidden = true; mount(panel); card.focus(); };
  const openPanel = (...kids) => {
    mount(panel, ...kids);
    panel.hidden = false;
    const f = panel.querySelector('input, select, button');
    if (f) f.focus();
  };
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });

  // One request per card at a time (FM2); the clicked/submitting button is disabled while it runs (FM3).
  const run = (fn, msg) => async e => {
    if (card._busy) return;
    card._busy = true;
    const btn = e && (e.submitter || (e.currentTarget && e.currentTarget.tagName === 'BUTTON' ? e.currentTarget : null));
    try { await busy(btn, fn); }
    catch (x) {
      card._busy = false;
      fail(x);
      if (/stakeholder/i.test(x.error || '') && !panel.querySelector('form')) edit(); // accept needs one: open the editor
      return;
    }
    toast(msg);
    await ctx.remove(card);
  };

  const accept = run(() => api('POST', `/api/suggestions/${s.id}/accept`, {}), 'Accepted');
  const edit = () => {
    const id = nextId('ed');
    const title = h('input', { id: id + 't', value: p.title || '', required: true, maxlength: '300' });
    const due = h('input', { id: id + 'd', type: 'date', value: (p.due && p.due.date) || '' });
    const people = h('input', { id: id + 'p', value: stake.map(x => x.name).join(', ') });
    const dir = h('select', { id: id + 'r', value: p.direction || 'unclear' }, DIRS.map(([v, l]) => h('option', { value: v }, l)));
    const f = h('form', { class: 'grid-form', 'aria-label': 'Edit suggestion' },
      h('label', { class: 'field wide' }, h('span', null, 'Title'), title),
      h('label', { class: 'field' }, h('span', null, 'Due'), due),
      h('label', { class: 'field' }, h('span', null, 'Direction'), dir),
      h('label', { class: 'field wide' }, h('span', null, 'Stakeholders (comma separated)'), people),
      h('div', { class: 'row-acts wide' }, h('button', { class: 'btn primary big' }, 'Accept with edits'), h('button', { type: 'button', class: 'btn big', onclick: closePanel }, 'Cancel')));
    f.addEventListener('submit', e => {
      e.preventDefault();
      const edits = {
        title: title.value.trim(), direction: dir.value, due_at: due.value || null,
        stakeholders: splitList(people.value).map(name => {
          const hit = stake.find(x => x.name === name && x.person_id != null);
          return hit ? { person_id: hit.person_id } : { name };
        }),
      };
      run(() => api('POST', `/api/suggestions/${s.id}/accept`, { edits }), 'Accepted with edits')(e);
    });
    openPanel(f);
  };
  const reject = () => openPanel(
    h('p', { class: 'panel-q' }, 'Reject this suggestion? Aria learns from the reason.'),
    h('div', { class: 'row-acts' },
      h('button', { type: 'button', class: 'btn big', onclick: run(() => api('POST', `/api/suggestions/${s.id}/reject`, { reason: 'not_action' }), 'Rejected') }, 'Not an action'),
      h('button', { type: 'button', class: 'btn big danger', onclick: run(() => api('POST', `/api/suggestions/${s.id}/reject`, { reason: 'never_happened' }), 'Rejected: never happened') }, 'This never happened'),
      h('button', { type: 'button', class: 'btn big ghost', onclick: closePanel }, 'Cancel')));
  const merge = async () => {
    const qIn = h('input', { type: 'search', 'aria-label': 'Find a task to merge into', placeholder: 'Find an open task…' });
    const ul = h('ul', { class: 'merge-list', 'aria-label': 'Open tasks' });
    openPanel(h('p', { class: 'panel-q' }, 'Merge into an existing task. The excerpt is added as a note.'), qIn, ul,
      h('div', { class: 'row-acts' }, h('button', { type: 'button', class: 'btn big ghost', onclick: closePanel }, 'Cancel')));
    let tasks = [];
    try { tasks = await api('GET', '/api/tasks'); } catch (e) { fail(e); }
    const draw = () => {
      const needle = qIn.value.trim().toLowerCase();
      const hits = tasks.filter(t => !needle || t.title.toLowerCase().includes(needle)).slice(0, 8);
      mount(ul, ...(hits.length ? hits.map(t => h('li', null, h('button', { type: 'button', class: 'btn block left', onclick: run(() => api('POST', `/api/suggestions/${s.id}/merge`, { task_id: t.id }), `Merged into “${t.title}”`) },
        t.title, h('span', { class: 'muted small' }, ' ', (t.stakeholders || []).map(x => x.display_name).join(', ')))))
        : [h('li', { class: 'muted small pad' }, 'No matching open tasks.')]));
    };
    qIn.addEventListener('input', draw);
    draw();
  };
  const snooze = () => openPanel(
    h('p', { class: 'panel-q' }, 'Snooze until'),
    h('div', { class: 'row-acts' },
      [[4, '4 hours'], [24, '1 day'], [168, '1 week']].map(([hours, l]) => h('button', { type: 'button', class: 'btn big', onclick: run(() => api('POST', `/api/suggestions/${s.id}/snooze`, { hours }), `Snoozed ${l}`) }, l)),
      h('button', { type: 'button', class: 'btn big ghost', onclick: closePanel }, 'Cancel')));
  card._act = { accept, edit, reject, merge: act(merge), snooze };

  const btn = (label, key, fn, cls = '') => h('button', { type: 'button', class: 'btn big ' + cls, onclick: fn, 'aria-keyshortcuts': key }, label, h('kbd', { class: 'hide-sm', 'aria-hidden': 'true' }, key));
  card.append(
    h('div', { class: 'sug-head' },
      h('span', { class: 'badge-suggested' }, 'Suggested'),
      h('h3', { id: tid, class: 'sug-title' }, p.title),
      confBar(s.confidence)),
    h('div', { class: 'sug-meta' },
      p.owner === 'unclear' || p.direction === 'unclear' ? h('span', { class: 'pill unclear-owner' }, 'Owner unclear') : dirPill(p.direction),
      stake.map(x => personChip({ id: x.person_id, display_name: x.name, unverified: x.unverified })),
      p.due && h('span', { class: 'small' }, 'Due ', h('strong', null, fmtDue(p.due.date)), p.due.span && h('span', { class: 'muted' }, ` (“${p.due.span}”)`))),
    p.excerpt && quote(p.excerpt, p.speaker),
    h('div', { class: 'sug-foot' }, srcMeta(s.source), p.rationale && h('span', { class: 'rationale muted' }, p.rationale)),
    h('div', { class: 'sug-acts' },
      btn('Accept', 'a', accept, 'primary'), btn('Edit', 'e', edit), btn('Reject', 'r', reject), btn('Merge', 'm', card._act.merge), btn('Snooze', 'z', snooze)),
    panel);
  return card;
}

// ---------- task detail ----------
async function viewTask(main, parts, q, alive) {
  const id = parts[1];
  const t = await api('GET', '/api/tasks/' + encodeURIComponent(id));
  if (!alive()) return;
  const save = async (patch, msg = 'Saved') => { await api('PATCH', '/api/tasks/' + t.id, patch); toast(msg); refreshCounts(); rerender(); };
  const stake = t.stakeholders || [];

  const h1 = h('h1', { tabindex: '-1', class: 'task-title' }, t.title);
  const titleWrap = h('div', { class: 'title-wrap' }, h1,
    h('button', { type: 'button', class: 'btn ghost small', 'data-fk': 'rename', onclick: () => {
      const inp = h('input', { class: 'title-input', value: t.title, 'aria-label': 'Title', maxlength: '300', required: true });
      const f = h('form', { class: 'inline-form', onsubmit: act(e => { e.preventDefault(); if (inp.value.trim()) { nextFocus = 'rename'; return save({ title: inp.value.trim() }, 'Title saved'); } }) },
        inp, h('button', { class: 'btn small primary' }, 'Save'), h('button', { type: 'button', class: 'btn small', onclick: () => { nextFocus = 'rename'; rerender(); } }, 'Cancel'));
      inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); nextFocus = 'rename'; rerender(); } });
      mount(titleWrap, f); inp.focus(); inp.select();
    } }, 'Rename'));

  const fid = nextId('tf');
  const statusGroup = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' },
    STATUSES.map(([v, l], i) => h('button', { type: 'button', class: 'chip toggle st-btn st-' + v, 'aria-pressed': String(t.status === v), 'data-fk': 'sb-' + v, 'aria-keyshortcuts': String(i + 1),
      onclick: act(() => setStatus(t, v, rerender)) }, l, h('kbd', { class: 'hide-sm', 'aria-hidden': 'true' }, i + 1))));

  const noteBox = h('textarea', { id: fid + 'note', 'data-fk': 'note', rows: '2', required: true, maxlength: '4000', placeholder: 'Private note. Notes are append-only.' });
  const noteForm = h('form', { class: 'note-add', onsubmit: act(async e => {
    e.preventDefault();
    await busy(e.submitter, () => api('POST', `/api/tasks/${t.id}/notes`, { body: noteBox.value.trim() }));
    toast('Note added'); rerender();
  }) }, h('label', { for: fid + 'note', class: 'field' }, 'Add note'), noteBox, h('button', { class: 'btn primary' }, 'Add note'));
  noteBox.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) noteForm.requestSubmit(); });

  const addPerson = h('input', { id: fid + 'ap', 'data-fk': 'addp', placeholder: 'Name', autocomplete: 'off' });
  const href = sourceLink(t);

  mount(main,
    h('p', { class: 'crumbs' }, h('a', { href: '#/home' }, 'Home'), ' / ', h('span', null, 'Task')),
    titleWrap,
    h('p', { class: 'muted small' }, 'Created ', fmtTime(t.created_at), ' · updated ', rel(t.updated_at), ' · Private'),
    statusGroup,
    h('div', { class: 'detail' },
      h('div', { class: 'detail-main' },
        h('section', { class: 'card', 'aria-labelledby': fid + 'dh' },
          h('h2', { id: fid + 'dh' }, 'Details'),
          h('div', { class: 'grid-form' },
            h('label', { class: 'field' }, h('span', null, 'Direction'),
              settleSelect(h('select', { value: t.direction || 'unclear', 'data-fk': 'dir' }, DIRS.map(([v, l]) => h('option', { value: v }, l))), v => act(() => save({ direction: v }))())),
            h('label', { class: 'field' }, h('span', null, 'Due' + (isOverdue(t) ? ' (overdue)' : '')),
              h('span', { class: 'inline' },
                h('input', { type: 'date', value: t.due_at || '', 'data-fk': 'due', class: isOverdue(t) ? 'overdue' : '', onchange: act(e => save({ due_at: e.target.value || null }, e.target.value ? 'Due date set' : 'Due date cleared')) }),
                t.due_at && h('button', { type: 'button', class: 'btn ghost small', onclick: act(() => save({ due_at: null }, 'Due date cleared')) }, 'Clear'))),
            h('label', { class: 'field' }, h('span', null, 'Priority'),
              settleSelect(h('select', { value: t.priority || '', 'data-fk': 'prio' },
                h('option', { value: '' }, 'None'), h('option', { value: 'low' }, 'Low'), h('option', { value: 'med' }, 'Medium'), h('option', { value: 'high' }, 'High')), v => act(() => save({ priority: v || null }))())),
            h('label', { class: 'field' }, h('span', null, 'Tags (comma separated)'),
              h('input', { value: (t.tags || []).join(', '), 'data-fk': 'tags', onchange: act(e => save({ tags: splitList(e.target.value) }, 'Tags saved')) })),
            h('label', { class: 'field wide' }, h('span', null, 'Description'),
              h('textarea', { rows: '3', value: t.body || '', 'data-fk': 'body', onchange: act(e => save({ body: e.target.value }, 'Description saved')) })))),

        h('section', { class: 'card', 'aria-labelledby': fid + 'sh' },
          h('h2', { id: fid + 'sh' }, 'Stakeholders'),
          h('ul', { class: 'chips' }, stake.length ? stake.map(s => h('li', { class: 'chip-x' }, personChip(s),
            h('button', { type: 'button', class: 'x', 'aria-label': `Remove ${s.display_name}`, onclick: act(() => save({ stakeholders: stake.filter(x => x !== s).map(x => ({ person_id: x.id })) }, 'Stakeholder removed')) }, '×')))
            : h('li', { class: 'muted small' }, 'No stakeholders yet.')),
          h('form', { class: 'inline-form', onsubmit: act(e => {
            e.preventDefault();
            const name = addPerson.value.trim();
            if (!name) return;
            return save({ stakeholders: [...stake.map(x => ({ person_id: x.id })), { name }] }, 'Stakeholder added');
          }) }, h('label', { for: fid + 'ap', class: 'sr-only' }, 'Add stakeholder'), addPerson, h('button', { class: 'btn small' }, 'Add')),
          h('p', { class: 'muted small' }, 'A new name is added as unverified until you link it on People.')),

        h('section', { class: 'card', 'aria-labelledby': fid + 'nh' },
          h('h2', { id: fid + 'nh' }, 'Notes'),
          (t.notes || []).length ? h('ol', { class: 'notes' }, t.notes.map(n => h('li', null, h('time', { class: 'muted small num', datetime: n.created_at }, fmtTime(n.created_at)), h('p', { class: 'pre' }, n.body))))
            : h('p', { class: 'muted small' }, 'No notes yet.'),
          noteForm)),

      h('div', { class: 'detail-side' },
        h('section', { class: 'card', 'aria-labelledby': fid + 'src' },
          h('h2', { id: fid + 'src' }, 'Source'),
          t.source ? [srcMeta(t.source), h('p', { class: 'muted small' }, fmtTime(t.source.started_at)),
            t.excerpt && quote(t.excerpt.text),
            h('a', { class: 'btn', href }, icon('open'), ' Open source')]
            : h('p', { class: 'muted small' }, 'Created by hand.')),
        h('section', { class: 'card', 'aria-labelledby': fid + 'ah' },
          h('h2', { id: fid + 'ah' }, 'Activity'),
          (t.activity || []).length ? h('ol', { class: 'activity' }, t.activity.map(a => h('li', null,
            h('span', null, a.actor || 'you', ' ', String(a.verb || '').replace(/_/g, ' '),
              a.from_value != null && a.from_value !== '' ? [' ', h('span', { class: 'muted' }, a.from_value), ' → '] : ' ',
              a.to_value != null ? h('strong', null, a.to_value) : null),
            h('time', { class: 'muted small num', datetime: a.at }, fmtTime(a.at)))))
            : h('p', { class: 'muted small' }, 'No activity yet.')),
        h('div', { class: 'row-acts' },
          h('button', { type: 'button', class: 'btn', onclick: act(async e => { const d = await busy(e.currentTarget, () => api('POST', `/api/tasks/${t.id}/duplicate`)); toast('Duplicated'); go('#/task/' + d.id); }) }, 'Duplicate'),
          h('button', { type: 'button', class: 'btn danger', onclick: act(async () => {
            if (!await ask('Delete this task?', `“${t.title}” and its notes will be removed. This cannot be undone.`, { yes: 'Delete task', danger: true })) return;
            await api('DELETE', '/api/tasks/' + t.id); toast('Task deleted'); refreshCounts(); go('#/home');
          }) }, 'Delete')))));

  viewKeys = e => {
    if (/^[1-5]$/.test(e.key)) { act(() => setStatus(t, STATUSES[Number(e.key) - 1][0], rerender))(); return true; }
    if (e.key === 'n') { noteBox.focus(); return true; }
    return false;
  };
}

// ---------- people ----------
function linkControl(person, people) {
  const targets = people.filter(p => p.id !== person.id && !p.unverified);
  if (!targets.length) return null;
  // FI5: choosing is free; merging only happens on the Link button + confirm.
  const s = h('select', { 'aria-label': `Link ${person.display_name} to`, 'data-fk': 'lk-' + person.id }, h('option', { value: '' }, 'Link to…'), targets.map(p => h('option', { value: String(p.id) }, p.display_name)));
  const btn = h('button', { type: 'button', class: 'btn small', 'data-fk': 'lkb-' + person.id, onclick: act(async () => {
    const target = targets.find(p => String(p.id) === s.value);
    if (!target) { s.focus(); toast('Choose a person to link to first'); return; }
    if (!await ask(`Link ${person.display_name} to ${target.display_name}?`, `Tasks and sources for “${person.display_name}” move to ${target.display_name}, and the unverified entry is removed.`, { yes: 'Link' })) return;
    await api('POST', `/api/people/${person.id}/link`, { target_id: target.id });
    toast(`Linked ${person.display_name} to ${target.display_name}`);
    if (parseHash().parts[1]) go('#/people/' + target.id); else rerender();
  }) }, 'Link');
  return h('span', { class: 'inline' }, s, btn);
}

async function viewPeople(main, parts, q, alive) {
  if (parts[1]) return viewPerson(main, parts, q, alive);
  const people = await api('GET', '/api/people');
  if (!alive()) return;
  const filter = h('input', { type: 'search', placeholder: 'Filter people', 'aria-label': 'Filter people', 'data-fk': 'pf' });
  const tbody = h('tbody');
  const draw = () => {
    const n = filter.value.trim().toLowerCase();
    mount(tbody, ...people.filter(p => !n || `${p.display_name} ${p.org_name || ''} ${(p.emails || []).join(' ')}`.toLowerCase().includes(n)).map(p => h('tr', null,
      h('th', { scope: 'row' }, h('a', { href: '#/people/' + p.id }, p.display_name), p.unverified && h('span', { class: 'tag unv-tag' }, 'Unverified'),
        h('div', { class: 'muted small' }, (p.emails || []).join(', '))),
      h('td', { class: 'hide-sm' }, p.org_name || ''),
      h('td', { class: 'num' }, h('a', { href: `#/home?person=${p.id}&status=open`, 'aria-label': `${p.open} open with ${p.display_name}` }, p.open ?? 0)),
      h('td', { class: 'num' }, h('a', { href: `#/home?person=${p.id}&status=waiting`, 'aria-label': `${p.waiting} waiting with ${p.display_name}` }, p.waiting ?? 0)),
      h('td', { class: 'num hide-sm' }, p.done ?? 0),
      h('td', { class: 'hide-sm small' }, p.last_interaction ? rel(p.last_interaction) : '—'),
      h('td', null, p.unverified ? linkControl(p, people) : null))));
  };
  filter.addEventListener('input', draw);
  draw();
  mount(main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'People'), h('span', { class: 'muted small num' }, `${people.length}`), filter),
    people.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col', class: 'hide-sm' }, 'Organisation'), h('th', { scope: 'col', class: 'num' }, 'Open'),
        h('th', { scope: 'col', class: 'num' }, 'Waiting'), h('th', { scope: 'col', class: 'num hide-sm' }, 'Done'), h('th', { scope: 'col', class: 'hide-sm' }, 'Last interaction'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      tbody))
      : empty('No people yet', 'People appear when a meeting or email is processed, or when you add a stakeholder to a task.'));
}

async function viewPerson(main, parts, q, alive) {
  const [p, people] = await Promise.all([api('GET', '/api/people/' + encodeURIComponent(parts[1])), soft(api('GET', '/api/people'), [])]);
  if (!alive()) return;
  const tasks = p.tasks || [];
  const fid = nextId('pp');
  const name = h('input', { id: fid + 'n', value: p.display_name, required: true });
  const emails = h('input', { id: fid + 'e', value: (p.emails || []).join(', ') });
  const org = h('input', { id: fid + 'o', value: p.org_name || '' });
  const verified = h('input', { type: 'checkbox', id: fid + 'v', checked: !p.unverified });
  const editForm = h('form', { class: 'grid-form', onsubmit: act(async e => {
    e.preventDefault();
    await busy(e.submitter, () => api('PATCH', '/api/people/' + p.id, { display_name: name.value.trim(), emails: splitList(emails.value), org_name: org.value.trim() || null, unverified: !verified.checked }));
    toast('Person saved'); rerender();
  }) },
  h('label', { class: 'field', for: fid + 'n' }, h('span', null, 'Name'), name),
  h('label', { class: 'field', for: fid + 'o' }, h('span', null, 'Organisation'), org),
  h('label', { class: 'field wide', for: fid + 'e' }, h('span', null, 'Emails (comma separated)'), emails),
  h('label', { class: 'check wide' }, verified, ' Verified identity'),
  h('div', { class: 'row-acts wide' }, h('button', { class: 'btn primary' }, 'Save')));

  mount(main,
    h('p', { class: 'crumbs' }, h('a', { href: '#/people' }, 'People'), ' / ', h('span', null, p.display_name)),
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, p.display_name), p.unverified && h('span', { class: 'tag unv-tag' }, 'Unverified'),
      p.unverified && linkControl(p, people),
      h('a', { class: 'btn', href: '#/home?person=' + p.id }, 'Show on Home')),
    h('p', { class: 'muted small' }, [p.org_name, (p.emails || []).join(', ')].filter(Boolean).join(' · ') || 'No organisation or email on file.'),
    h('details', { class: 'card' }, h('summary', null, 'Edit person'), editForm),
    tasks.length ? h('div', { class: 'list' }, taskList(tasks, rerender)) : empty('No tasks with this person', null),
    h('section', { class: 'card', 'aria-labelledby': fid + 'sh' },
      h('h2', { id: fid + 'sh' }, 'Sources'),
      (p.sources || []).length ? h('ul', { class: 'plain' }, p.sources.map(s => h('li', null, icon(s.type, SOURCE_LABEL[s.type]), ' ', h('a', { href: '#/sources/' + s.id }, s.title), ' ', h('span', { class: 'muted small' }, rel(s.started_at)))))
        : h('p', { class: 'muted small' }, 'No sources.')));
  viewKeys = rowKeys(rerender);
}

// ---------- sources ----------
function parseParticipants(s) {
  return splitList(s).map(x => {
    const m = x.match(/^(.*?)\s*<([^>]+)>$/);
    if (m) return { name: m[1] || m[2], email: m[2] };
    return x.includes('@') ? { name: x, email: x } : { name: x, email: null };
  });
}
function vttToText(v) {
  if (!/^﻿?WEBVTT/.test(v)) return v;
  const out = [];
  let ts = '';
  for (const line of v.split(/\r?\n/)) {
    const m = line.match(/^(?:(\d{1,2}):)?(\d\d):(\d\d)[.,]\d+\s+-->/);
    if (m) { ts = `${(m[1] || '0').padStart(2, '0')}:${m[2]}:${m[3]}`; continue; }
    const tl = line.trim();
    if (!tl || /^(﻿?WEBVTT|NOTE\b|\d+$)/.test(tl)) continue;
    const text = tl.replace(/<v\s+([^>]+)>/, '$1: ').replace(/<[^>]+>/g, '').trim();
    out.push(ts ? `[${ts}] ${text}` : text);
  }
  return out.join('\n');
}
const procLabel = { pending: 'Processing', done: 'Processed', failed: 'Failed', no_transcript: 'No transcript' };

function addSourceForm() {
  const fid = nextId('as');
  const title = h('input', { id: fid + 't', required: true, maxlength: '200' });
  const parts = h('input', { id: fid + 'p', placeholder: 'Ananya Shah <ananya@northwind.com>, Rohan Mehta' });
  const text = h('textarea', { id: fid + 'x', rows: '8', required: true, class: 'serif drop', placeholder: 'Paste a transcript or email, or drop a .txt / .vtt file here' });
  const readFile = async file => {
    if (!file) return;
    if (!/\.(txt|vtt)$/i.test(file.name) && !/^text\//.test(file.type)) { toast('Only .txt or .vtt files', { error: true }); return; }
    if (file.size > 2e6) { toast('File is larger than 2 MB', { error: true }); return; }
    text.value = vttToText(await file.text());
    if (!title.value) title.value = file.name.replace(/\.(txt|vtt)$/i, '');
    toast(`Loaded ${file.name}`);
  };
  const file = h('input', { id: fid + 'f', type: 'file', accept: '.txt,.vtt,text/plain,text/vtt', onchange: act(e => readFile(e.target.files[0])) });
  text.addEventListener('dragover', e => { e.preventDefault(); text.classList.add('over'); });
  text.addEventListener('dragleave', () => text.classList.remove('over'));
  text.addEventListener('drop', act(e => { e.preventDefault(); text.classList.remove('over'); return readFile(e.dataTransfer.files[0]); }));
  return h('form', { class: 'grid-form', onsubmit: act(async e => {
    e.preventDefault();
    const s = await busy(e.submitter, () => api('POST', '/api/sources', { type: 'manual', title: title.value.trim(), text: text.value, participants: parseParticipants(parts.value) }));
    toast('Source added. Scanning for actions.'); refreshCounts();
    go('#/sources/' + s.id);
  }) },
  h('p', { class: 'notice wide' }, CONSENT),
  h('label', { class: 'field', for: fid + 't' }, h('span', null, 'Title'), title),
  h('label', { class: 'field', for: fid + 'p' }, h('span', null, 'Participants (comma separated)'), parts),
  h('label', { class: 'field wide', for: fid + 'x' }, h('span', null, 'Text'), text),
  h('label', { class: 'field', for: fid + 'f' }, h('span', null, 'Or choose a file'), file),
  h('div', { class: 'row-acts wide' }, h('button', { class: 'btn primary' }, 'Add source')));
}

async function viewSources(main, parts, q, alive) {
  if (parts[1]) return viewSource(main, parts, q, alive);
  const list = await api('GET', '/api/sources');
  if (!alive()) return;
  const retry = s => act(async e => { await busy(e.currentTarget, () => api('POST', `/api/sources/${s.id}/reprocess`, {})); toast('Retry started'); rerender(); });
  const countEl = h('span', { class: 'muted small num' }, `${list.length}`);
  const tableWrap = h('div');
  const draw = l => { countEl.textContent = String(l.length); mount(tableWrap, sourcesTable(l, retry)); };
  draw(list);
  mount(main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Sources'), countEl),
    h('details', { class: 'card', open: !list.length || null }, h('summary', null, 'Add source (paste text or drop a transcript)'), addSourceForm()),
    tableWrap);
  // FM10: refresh only the table (not the add form) every 5s while anything is still processing.
  const tick = async l => {
    if (!l.some(x => x.processing_status === 'pending')) return;
    await new Promise(r => setTimeout(r, 5000));
    if (!alive()) return;
    let next;
    try { next = await api('GET', '/api/sources'); } catch (e) { fail(e); return; }
    if (!alive()) return;
    draw(next);
    if (!next.some(x => x.processing_status === 'pending')) refreshCounts();
    tick(next);
  };
  tick(list);
}

function sourcesTable(list, retry) {
  return list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Source'), h('th', { scope: 'col', class: 'hide-sm' }, 'When'), h('th', { scope: 'col' }, 'Status'),
        h('th', { scope: 'col', class: 'num' }, 'Suggested'), h('th', { scope: 'col', class: 'num' }, 'Tasks'))),
      h('tbody', null, list.map(s => h('tr', null,
        h('th', { scope: 'row' }, h('span', { class: 'src' }, icon(s.type, SOURCE_LABEL[s.type]), h('a', { href: '#/sources/' + s.id, 'data-fk': 'sl-' + s.id }, s.title)),
          h('div', { class: 'muted small' }, (s.participants || []).map(x => x.name || x.email).join(', '), s.mode === 'demo' ? ' · demo data' : '')),
        h('td', { class: 'hide-sm small' }, fmtTime(s.started_at)),
        h('td', null, h('span', { class: 'pill proc-' + s.processing_status }, procLabel[s.processing_status] || s.processing_status),
          s.processing_status === 'failed' && [h('div', { class: 'error-text small' }, s.last_error || 'Unknown error'), h('button', { type: 'button', class: 'btn small', onclick: retry(s) }, 'Retry')],
          s.processing_status === 'no_transcript' && h('div', null, h('a', { class: 'small', href: '#/sources/' + s.id + '?add=1' }, 'No transcript. Add actions by hand'))),
        h('td', { class: 'num' }, s.suggestion_count ? h('a', { href: '#/inbox?sort=source' }, s.suggestion_count) : 0),
        h('td', { class: 'num' }, s.task_count ?? 0))))))
      : empty('No sources yet', 'Connect Zoom or mail in Settings, or add a source above.', h('a', { class: 'btn', href: '#/settings' }, 'Open Settings'));
}

async function viewSource(main, parts, q, alive) {
  const s = await api('GET', '/api/sources/' + encodeURIComponent(parts[1]));
  if (!alive()) return;
  const fid = nextId('sp');
  const text = typeof s.text === 'string' ? s.text : '';
  const at = Number(q.get('at')), len = Number(q.get('len'));
  let mark = null;
  const pre = h('pre', { class: 'serif transcript', tabindex: '0', 'aria-label': 'Source text' });
  if (text && Number.isInteger(at) && at >= 0 && len > 0 && at + len <= text.length && q.get('at') !== null) {
    mark = h('mark', null, text.slice(at, at + len));
    pre.append(text.slice(0, at), mark, text.slice(at + len));
  } else pre.textContent = text || 'No text stored for this source.';

  const hint = h('input', { id: fid + 'h', placeholder: 'look again for anything I owe Raj', maxlength: '300' });
  const addWrap = h('div');
  const openAdd = () => mount(addWrap, newTaskForm({ source_id: s.id, onDone: () => { nextFocus = 'add-hand'; rerender(); }, onCancel: () => { mount(addWrap); $('[data-fk="add-hand"]')?.focus(); } }));
  const tasks = s.tasks || [];
  const sugs = s.suggestions || [];

  mount(main,
    h('p', { class: 'crumbs' }, h('a', { href: '#/sources' }, 'Sources'), ' / ', h('span', null, s.title)),
    h('div', { class: 'page-head' }, icon(s.type, SOURCE_LABEL[s.type]), h('h1', { tabindex: '-1' }, s.title),
      h('span', { class: 'pill proc-' + s.processing_status }, procLabel[s.processing_status] || s.processing_status)),
    h('p', { class: 'muted small' }, SOURCE_LABEL[s.type] || s.type, ' · ', fmtTime(s.started_at), s.mode === 'demo' ? ' · demo data' : ''),
    s.processing_status === 'failed' && h('p', { class: 'error-text' }, 'Processing failed: ', s.last_error || 'unknown error'),
    s.processing_status === 'no_transcript' && h('div', { class: 'card notice' }, h('p', null, 'No transcript. Add actions by hand.'), h('button', { type: 'button', class: 'btn primary', onclick: openAdd }, 'Add an action')),
    h('div', { class: 'chips', 'aria-label': 'Participants' }, (s.participants || []).map(p => h('span', { class: 'chip person' }, p.name || p.email, p.email && p.name ? h('span', { class: 'muted' }, ' ', p.email) : null))),
    h('div', { class: 'toolbar' },
      h('form', { class: 'inline-form', onsubmit: act(async e => {
        e.preventDefault();
        await busy(e.submitter, () => api('POST', `/api/sources/${s.id}/reprocess`, hint.value.trim() ? { hint: hint.value.trim() } : {}));
        toast('Re-scan started. New suggestions go to the inbox.'); refreshCounts(); rerender();
      }) }, h('label', { for: fid + 'h', class: 'sr-only' }, 'Re-scan hint (optional)'), hint, h('button', { class: 'btn' }, 'Re-scan')),
      h('button', { type: 'button', class: 'btn', 'data-fk': 'add-hand', onclick: openAdd }, 'Add action by hand'),
      dlButton('Download raw', `/api/sources/${s.id}/raw`, `source-${s.id}.txt`),
      h('button', { type: 'button', class: 'btn', onclick: act(async () => {
        const r = await api('GET', `/api/sources/${s.id}/recap`);
        await copy(r); // server returns text/markdown
      }) }, 'Copy recap'),
      h('button', { type: 'button', class: 'btn danger', onclick: act(async () => {
        if (!await ask('Delete this source?', 'The stored text and any pending suggestions are deleted. Tasks you already accepted are kept.', { yes: 'Delete source', danger: true })) return;
        await api('DELETE', '/api/sources/' + s.id); toast('Source deleted'); refreshCounts(); go('#/sources');
      }) }, 'Delete source')),
    addWrap,
    h('div', { class: 'detail' },
      h('section', { class: 'detail-main card', 'aria-labelledby': fid + 'tx' }, h('h2', { id: fid + 'tx' }, s.type === 'email' ? 'Email' : 'Transcript'), pre),
      h('div', { class: 'detail-side' },
        h('section', { class: 'card', 'aria-labelledby': fid + 'sg' }, h('h2', { id: fid + 'sg' }, 'Suggestions'),
          sugs.length ? h('ul', { class: 'plain' }, sugs.map(x => h('li', null,
            h('span', { class: 'badge-suggested small' }, x.state === 'pending' ? 'Suggested' : x.state), ' ', (x.payload && x.payload.title) || '', ' ',
            h('span', { class: 'muted small num' }, Math.round((x.confidence || 0) * 100) + '%'),
            x.state === 'pending' && [' ', h('a', { href: '#/inbox?sort=source', class: 'small' }, 'Review')])))
            : h('p', { class: 'muted small' }, 'No suggestions.')),
        h('section', { class: 'card', 'aria-labelledby': fid + 'tk' }, h('h2', { id: fid + 'tk' }, 'Tasks'),
          tasks.length ? h('ul', { class: 'plain' }, tasks.map(t => h('li', null, statusBadge(t.status), ' ', h('a', { href: '#/task/' + t.id }, t.title))))
            : h('p', { class: 'muted small' }, 'No tasks from this source yet.')))));
  if (q.get('add') === '1') openAdd();
  if (mark) requestAnimationFrame(() => mark.scrollIntoView({ block: 'center' }));
  // FM10: while processing, check every 5s; re-render once when the status changes.
  if (s.processing_status === 'pending') {
    const check = async () => {
      if (!alive()) return;
      let now;
      try { now = await api('GET', '/api/sources/' + s.id); } catch (e) { fail(e); return; }
      if (!alive()) return;
      if (now.processing_status !== 'pending') { toast(`${s.title}: ${procLabel[now.processing_status] || now.processing_status}`); refreshCounts(); rerender(); }
      else setTimeout(check, 5000);
    };
    setTimeout(check, 5000);
  }
}

// ---------- assistant ----------
let chatEl = null;
function assistantPanel() {
  if (chatEl) return chatEl;
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('textarea', { id: 'chat-input', rows: '2', 'aria-label': 'Ask Aria about your tasks', placeholder: 'Ask about your tasks…', maxlength: '2000' });
  const form = h('form', { class: 'chat-form', onsubmit: e => { e.preventDefault(); sendChat(input.value); } }, input, h('button', { class: 'btn primary' }, 'Send'));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') { if (closeOverlays()) e.stopPropagation(); }
  });
  chatEl = h('section', { class: 'assistant', 'aria-labelledby': 'chat-h' },
    h('h2', { id: 'chat-h' }, 'Assistant'),
    h('p', { class: 'muted small' }, 'Answers come only from your own tasks and sources. Nothing changes until you confirm.'),
    log,
    h('p', { class: 'chat-status muted small', role: 'status' }),
    h('div', { class: 'chips prompts' }, PROMPTS.map(p => h('button', { type: 'button', class: 'chip', onclick: () => sendChat(p) }, p))),
    form);
  renderChat();
  return chatEl;
}

async function sendChat(text) {
  text = String(text || '').trim();
  if (!text || chat.busy) return;
  chat.msgs.push({ role: 'user', text });
  $('#chat-input').value = '';
  chat.busy = true;
  renderChat();
  try {
    const r = await api('POST', '/api/assistant', chat.thread_id ? { message: text, thread_id: chat.thread_id } : { message: text });
    chat.thread_id = r.thread_id;
    chat.msgs.push({ role: 'assistant', text: r.reply || '', citations: r.citations || [], proposals: (r.proposals || []).map(p => ({ ...p, state: 'pending' })) });
  } catch (e) { fail(e); chat.msgs.push({ role: 'assistant', text: 'I could not answer that just now. ' + (e.error || ''), citations: [], proposals: [] }); }
  finally { chat.busy = false; renderChat(); }
}

function proposalNode(p) {
  const statusText = () => h('p', { class: 'muted small', tabindex: '-1' }, p.state === 'done' ? 'Confirmed.' : 'Dismissed. Nothing changed.');
  const settle = () => { const s = statusText(); acts.replaceWith(s); s.focus(); };
  const acts = p.state !== 'pending' ? statusText() : h('div', { class: 'row-acts' },
    h('button', { type: 'button', class: 'btn primary small', onclick: act(async e => {
      await busy(e.currentTarget, () => api('POST', '/api/assistant/confirm', { thread_id: chat.thread_id, proposal_id: p.id }));
      p.state = 'done'; settle(); toast('Done: ' + p.label); refreshCounts();
      if (['home', 'task', 'people', 'sources'].includes(parseHash().parts[0])) rerender();
    }) }, 'Confirm'),
    h('button', { type: 'button', class: 'btn small', onclick: () => { p.state = 'dismissed'; settle(); } }, 'Dismiss'));
  return h('div', { class: 'proposal', role: 'group', 'aria-label': 'Proposed change' },
    h('p', null, h('span', { class: 'badge-suggested small' }, 'Proposed'), ' ', p.label), acts);
}
function msgNode(m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, h('span', { class: 'sr-only' }, 'You: '), h('p', { class: 'pre' }, m.text));
  return h('div', { class: 'msg bot' },
    h('span', { class: 'sr-only' }, 'Aria: '),
    h('p', { class: 'pre' }, m.text),
    m.citations.length ? h('ul', { class: 'cites', 'aria-label': 'Sources for this answer' }, m.citations.map(c => h('li', null,
      h('a', { href: '#/task/' + c.task_id }, c.title), c.source_title && h('span', { class: 'muted small' }, ' · ', c.source_title)))) : null,
    m.proposals.map(proposalNode),
    m.text && h('button', { type: 'button', class: 'btn ghost small', onclick: () => copy(m.text) }, 'Copy'));
}
// FI6: the role=log region only ever gets new messages appended; status/hint text lives outside it.
function renderChat() {
  const log = chatEl && $('.chat-log', chatEl);
  if (!log) return;
  log._n = log._n || 0;
  for (; log._n < chat.msgs.length; log._n++) log.append(msgNode(chat.msgs[log._n]));
  const st = $('.chat-status', chatEl);
  st.textContent = chat.busy ? 'Aria is checking your tasks…' : chat.msgs.length ? '' : 'Try a prompt below, or ask “What is open with Ananya?”';
  log.scrollTop = log.scrollHeight;
}

async function viewAssistant(main) {
  mount(main, h('h1', { tabindex: '-1', class: 'sr-only' }, 'Assistant'), assistantPanel());
}

// ---------- settings ----------
function settingsForm(title, s, fields, note) {
  const fid = nextId('sf');
  const inputs = {};
  const rows = fields.map(f => {
    const id = fid + f.k;
    let el;
    if (f.type === 'bool') el = h('input', { type: 'checkbox', id, checked: !!s[f.k] });
    else if (f.type === 'tz') {
      const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
      const cur = s[f.k] || Intl.DateTimeFormat().resolvedOptions().timeZone;
      el = zones.length ? h('select', { id, value: cur }, (zones.includes(cur) ? zones : [cur, ...zones]).map(z => h('option', { value: z }, z))) : h('input', { id, value: cur });
    } else el = h('input', { id, type: f.type === 'list' ? 'text' : f.type, value: f.type === 'list' ? (s[f.k] || []).join(', ') : (s[f.k] ?? ''), min: f.min, max: f.max, step: f.step, required: f.type === 'number' || null });
    if (f.onchange) el.addEventListener('change', act(() => f.onchange(el)));
    inputs[f.k] = el;
    const help = f.help && h('span', { class: 'help small' + (f.warn ? ' warn-text' : '') }, f.help);
    return f.type === 'bool'
      ? h('div', { class: 'field wide' }, h('label', { class: 'check', for: id }, el, ' ', f.label), help)
      : h('label', { class: 'field', for: id }, h('span', null, f.label), el, help);
  });
  const hid = fid + 'h';
  return h('section', { class: 'card', 'aria-labelledby': hid },
    h('h2', { id: hid }, title), note,
    h('form', { class: 'grid-form', onsubmit: act(async e => {
      e.preventDefault();
      const patch = {};
      for (const f of fields) {
        const el = inputs[f.k];
        patch[f.k] = f.type === 'bool' ? el.checked : f.type === 'number' ? Number(el.value) : f.type === 'list' ? splitList(el.value) : el.value;
      }
      settingsCache = await busy(e.submitter, () => api('PATCH', '/api/settings', patch)) || null;
      if (settingsCache && typeof settingsCache !== 'object') settingsCache = null;
      toast(`${title} saved`);
    }) }, rows, h('div', { class: 'row-acts wide' }, h('button', { class: 'btn primary' }, 'Save'))));
}

function setupSteps(c) {
  const s = c.setup, admin = !!(me && me.can_setup);
  const idIn = h('input', { type: 'text', autocomplete: 'off', required: true, 'aria-label': 'Client ID' });
  const secIn = h('input', { type: 'password', autocomplete: 'off', required: true, 'aria-label': 'Client secret' });
  const form = admin && h('form', { class: 'setup-form', onsubmit: act(async e => {
    e.preventDefault();
    await busy(e.submitter, () => api('PUT', `/api/admin/providers/${s.provider}`, { client_id: idIn.value.trim(), client_secret: secIn.value.trim() }));
    toast(`${s.provider_label} is set up. Everyone can now connect in one click.`);
    route();
  }) },
    h('label', { class: 'field' }, h('span', null, 'Client ID'), idIn),
    h('label', { class: 'field' }, h('span', null, 'Client secret'), secIn),
    h('button', { class: 'btn primary' }, 'Save and enable one-click connect'));
  return h('details', { class: 'setup', open: admin || null },
    h('summary', null, admin ? `Set up ${s.provider_label} (one time, about 5 minutes)` : `Ask your admin to set up ${s.provider_label}`),
    h('p', { class: 'muted small' }, 'This registers Aria with the provider once. After that, anyone connects with one click.'),
    h('ol', null, s.steps.map(t => h('li', null, t))),
    h('div', { class: 'setup-uris' }, h('strong', { class: 'small' }, 'Redirect URIs to paste'),
      s.redirect_uris.map(u => h('div', { class: 'uri' }, h('code', null, u), h('button', { type: 'button', class: 'btn small ghost', onclick: () => copy(u) }, 'Copy')))),
    h('p', { class: 'small' }, h('a', { href: s.console_url, target: '_blank', rel: 'noopener' }, 'Open the provider console'),
      h('span', { class: 'muted' }, ` · or set ${s.env.join(' and ')} on the server instead`)),
    form);
}
async function loadSample(e) {
  await busy(e.currentTarget, () => api('POST', '/api/sample-data', {}));
  await loadMe();
  toast('Sample data loaded');
}

async function viewSettings(main, parts, q, alive) {
  const [s, connectors, sessions, audit] = await Promise.all([
    api('GET', '/api/settings'), api('GET', '/api/connectors'), soft(api('GET', '/api/sessions'), []), soft(api('GET', '/api/audit'), []),
  ]);
  if (!alive()) return;
  settingsCache = s;
  const connAction = (c, method, suffix, msg) => act(async e => {
    const r = await busy(e.currentTarget, () => api(method, `/api/connectors/${c.type}${suffix}`));
    if (r && r.redirect) {
      let u;
      try { u = new URL(r.redirect, location.href); } catch { throw { error: 'Invalid redirect from server' }; }
      if (!['http:', 'https:'].includes(u.protocol)) throw { error: 'Invalid redirect from server' };
      location.href = u.href;
      return;
    }
    toast(msg); refreshCounts(); loadNotifs(); rerender();
  });
  const fid = nextId('st');

  mount(main,
    h('h1', { tabindex: '-1' }, 'Settings'),
    me.user && me.user.role === 'admin' && h('p', { class: 'show-sm' }, h('a', { href: '#/admin' }, 'Admin console')),
    h('section', { class: 'card', 'aria-labelledby': fid + 'c' },
      h('h2', { id: fid + 'c' }, 'Connections'),
      h('p', { class: 'muted small' }, 'Read-only. Aria never sends mail or writes to your calendar. Disconnecting stops ingest immediately.'),
      h('ul', { class: 'connectors' }, connectors.map(c => h('li', { class: 'conn' },
        h('div', { class: 'conn-main' },
          h('strong', null, c.label), ' ',
          h('span', { class: 'pill conn-' + c.status }, c.status === 'connected' ? 'Connected' : c.status === 'error' ? 'Error' : c.configured ? 'Not connected' : 'Setup needed'), ' ',
          c.mode && h('span', { class: 'tag' + (c.mode === 'demo' ? ' demo' : '') }, c.mode === 'demo' ? 'Sample data' : 'Live'),
          c.status !== 'disconnected' && h('div', { class: 'muted small' }, 'Scopes: ', h('span', { class: 'mono' }, (c.scopes || []).join(', ') || 'none'),
            ' · Last sync: ', c.last_sync_at ? rel(c.last_sync_at) : 'never'),
          c.last_error && h('div', { class: 'error-text small' }, c.last_error),
          !c.configured && c.status === 'disconnected' && connectors.findIndex(x => x.setup.provider === c.setup.provider && !x.configured) === connectors.indexOf(c) && setupSteps(c)), // one guide per provider
        h('div', { class: 'row-acts' },
          c.status === 'connected'
            ? [h('button', { type: 'button', class: 'btn small', onclick: connAction(c, 'POST', '/sync', `${c.label} synced`) }, 'Sync now'),
              h('button', { type: 'button', class: 'btn small danger', onclick: act(async e => {
                if (!await ask(`Disconnect ${c.label}?`, 'Tokens are wiped and ingest stops immediately. Existing tasks are kept.', { yes: 'Disconnect', danger: true })) return;
                await connAction(c, 'DELETE', '', `${c.label} disconnected`)(e);
              }) }, 'Disconnect')]
            : [c.configured && h('button', { type: 'button', class: 'btn small primary', onclick: connAction(c, 'POST', '/connect', `${c.label} connected`) }, c.status === 'error' ? 'Reconnect' : 'Connect'),
              c.status === 'error' && h('button', { type: 'button', class: 'btn small danger', onclick: connAction(c, 'DELETE', '', `${c.label} disconnected`) }, 'Disconnect')])))),
      h('div', { class: 'sample-row' },
        me.demo
          ? h('button', { type: 'button', class: 'btn small', onclick: act(async e => {
              if (!await ask('Remove sample data?', 'Sample meetings, emails and pending suggestions are deleted. Tasks you accepted are kept.', { yes: 'Remove' })) return;
              await busy(e.currentTarget, () => api('DELETE', '/api/sample-data'));
              await loadMe(); toast('Sample data removed'); route();
            }) }, 'Remove sample data')
          : h('button', { type: 'button', class: 'btn small', onclick: act(async e => { await loadSample(e); route(); }) }, 'Load sample data'),
        h('span', { class: 'muted small' }, 'Fictional meetings and email so you can try Aria before connecting real accounts.'))),

    settingsForm('Capture rules', s, [
      { k: 'lookback_days', label: 'Mail lookback on first connect (days)', type: 'number', min: 1, max: 90, step: 1 },
      { k: 'excluded_labels', label: 'Excluded mail labels / folders', type: 'list', help: 'Comma separated, for example Personal, HR' },
      { k: 'excluded_calendars', label: 'Excluded calendars', type: 'list', help: 'Comma separated' },
      { k: 'low_floor', label: 'Low-confidence floor', type: 'number', min: 0, max: 1, step: 0.01, help: 'Suggestions below this are dropped, not shown.' },
      { k: 'high_threshold', label: 'High-confidence threshold', type: 'number', min: 0, max: 1, step: 0.01, help: 'Used by “Accept all” in the inbox.' },
      { k: 'bot_auto_invite', label: 'Auto-invite the Aria meeting bot from my calendar', type: 'bool', help: BOT_NOTICE },
      { k: 'auto_promote', label: 'Auto-promote high-confidence suggestions to Open', type: 'bool', warn: true, help: 'Not recommended. Tasks would be created without your review, and a wrong action item is worse than a missed one.' },
    ]),
    settingsForm('Assistant and AI', s, [
      { k: 'external_ai', label: 'Use Jev (TypeSafe) to understand questions and double-check suggestions', type: 'bool',
        help: 'Off by default. When on, your questions to the assistant, plus task titles, names, meeting and email titles and short excerpts (up to 400 characters), are sent to TypeSafe (Jev). If your admin also set up Anthropic, full meeting transcripts, email bodies and task notes are sent to Anthropic. Nothing is sent while this is off.' },
    ]),
    settingsForm('Notifications', s, [
      { k: 'digest_time', label: 'Morning digest time', type: 'time' },
      { k: 'waiting_days', label: 'Remind me about waiting items after (days)', type: 'number', min: 1, max: 60, step: 1 },
      { k: 'digest_email', label: 'Also send the digest by email', type: 'bool' },
      { k: 'push_opt_in', label: 'Browser notifications', type: 'bool', help: 'Per-meeting suggestion alerts and the daily digest only.',
        onchange: async el => {
          if (!el.checked) return;
          if (!('Notification' in window)) { el.checked = false; toast('This browser does not support notifications', { error: true }); return; }
          const p = await Notification.requestPermission();
          if (p !== 'granted') { el.checked = false; toast('Notifications were not allowed by the browser', { error: true }); }
        } },
    ]),
    settingsForm('Account and data', s, [
      { k: 'name', label: 'Name', type: 'text' },
      { k: 'timezone', label: 'Time zone', type: 'tz' },
      { k: 'retention_days', label: 'Keep raw sources for (days)', type: 'number', min: 7, max: 365, step: 1, help: 'Transcripts and mail bodies are deleted after this. Tasks and notes stay until you delete them.' },
    ]),
    h('section', { class: 'card', 'aria-labelledby': fid + 'p' }, h('h2', { id: fid + 'p' }, 'Privacy'), h('p', { class: 'notice' }, CONSENT),
      h('p', { class: 'muted small' }, 'Your organisation admin sees seats, connector status and counts. Never transcripts, mail, task titles or notes.')),
    h('section', { class: 'card', 'aria-labelledby': fid + 's' }, h('h2', { id: fid + 's' }, 'Signed-in devices'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Device'), h('th', { scope: 'col', class: 'hide-sm' }, 'IP'), h('th', { scope: 'col', class: 'hide-sm' }, 'Signed in'), h('th', { scope: 'col' }, 'Last seen'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', null, sessions.map(x => h('tr', null,
          h('td', { class: 'small ua', title: x.user_agent || '' }, x.user_agent || 'Unknown device'),
          h('td', { class: 'mono small hide-sm' }, x.ip || ''),
          h('td', { class: 'small hide-sm' }, fmtTime(x.created_at)),
          h('td', { class: 'small' }, rel(x.last_seen_at)),
          h('td', null, x.current ? h('span', { class: 'tag' }, 'This device') : h('button', { type: 'button', class: 'btn small', onclick: act(async () => { await api('DELETE', '/api/sessions/' + x.id); toast('Session revoked'); rerender(); }) }, 'Revoke')))))))),
    h('section', { class: 'card', 'aria-labelledby': fid + 'so' }, h('h2', { id: fid + 'so' }, 'Session'),
      h('p', { class: 'small' }, 'Signed in as ', h('strong', null, me.user ? me.user.email : ''), '.'),
      h('button', { type: 'button', class: 'btn', onclick: act(signOut) }, 'Sign out')),
    h('section', { class: 'card', 'aria-labelledby': fid + 'e' }, h('h2', { id: fid + 'e' }, 'Export'),
      h('div', { class: 'row-acts' }, dlButton('Tasks (CSV)', '/api/export/tasks.csv', 'aria-tasks.csv'), dlButton('Everything (JSON)', '/api/export/all.json', 'aria-export.json')),
      h('p', { class: 'muted small' }, 'Exports are logged in your audit trail.')),
    h('details', { class: 'card' }, h('summary', null, `Audit log (${audit.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Action'), h('th', { scope: 'col' }, 'Object'), h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col', class: 'hide-sm' }, 'IP'))),
        h('tbody', null, audit.slice(0, 200).map(a => h('tr', null, h('td', { class: 'mono small' }, a.action), h('td', { class: 'small' }, a.object || ''), h('td', { class: 'small' }, fmtTime(a.at)), h('td', { class: 'mono small hide-sm' }, a.ip || ''))))))),
    h('section', { class: 'card danger-zone', 'aria-labelledby': fid + 'd' }, h('h2', { id: fid + 'd' }, 'Delete account'),
      h('p', { class: 'small' }, 'Removes every task, note, source, person and connector token in your vault. The audit trail keeps a record that this happened, with no content. This cannot be undone.'),
      h('button', { type: 'button', class: 'btn danger', onclick: act(async () => {
        const pw = await ask('Delete your account?', 'Enter your password to permanently delete all your Aria data.', { yes: 'Delete everything', danger: true, password: true });
        if (!pw) return;
        await api('DELETE', '/api/account', { password: pw });
        resetSession();
        go('#/login'); toast('Account deleted');
      }) }, 'Delete account')));
}

// ---------- admin ----------
async function viewAdmin(main, parts, q, alive) {
  const [seats, audit] = await Promise.all([api('GET', '/api/admin/seats'), soft(api('GET', '/api/admin/audit'), [])]);
  if (!alive()) return;
  const conn = list => (list || []).map(x => `${x.type} (${x.status})`).join(', ') || 'None'; // [{type, status, last_sync_at, last_error}]
  mount(main,
    h('h1', { tabindex: '-1' }, 'Admin'),
    h('p', { class: 'muted small' }, 'Seats and admin audit only. Admins never see transcripts, mail, excerpts, task titles or notes.'),
    h('section', { class: 'card', 'aria-labelledby': 'adm-s' }, h('h2', { id: 'adm-s' }, `Seats (${seats.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Email'), h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Connectors'), h('th', { scope: 'col', class: 'num' }, 'Tasks'))),
        h('tbody', null, seats.map(x => h('tr', null, h('td', { class: 'mono small' }, x.email), h('td', null, x.name || ''), h('td', { class: 'small' }, conn(x.connectors)), h('td', { class: 'num' }, x.task_count ?? 0))))))),
    h('section', { class: 'card', 'aria-labelledby': 'adm-a' }, h('h2', { id: 'adm-a' }, 'Admin audit'),
      audit.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Action'), h('th', { scope: 'col' }, 'Object'), h('th', { scope: 'col' }, 'Actor'), h('th', { scope: 'col' }, 'When'))),
        h('tbody', null, audit.map(a => h('tr', null, h('td', { class: 'mono small' }, a.action), h('td', { class: 'small' }, a.object || ''), h('td', { class: 'small' }, a.actor || ''), h('td', { class: 'small' }, fmtTime(a.at)))))))
        : h('p', { class: 'muted small' }, 'No admin events.')));
}

async function viewNotFound(main) {
  mount(main, h('h1', { tabindex: '-1' }, 'Page not found'), h('p', null, h('a', { href: '#/home' }, 'Go to Home')));
}

const VIEWS = { home: viewHome, inbox: viewInbox, task: viewTask, people: viewPeople, sources: viewSources, assistant: viewAssistant, settings: viewSettings, admin: viewAdmin };

// ---------- boot ----------
window.addEventListener('hashchange', route);
// ponytail: page-level Notification API; fires only while an Aria tab is open (no service worker/push server).
let announced = null;
function announce() {
  const ids = new Set(notifs.map(n => n.id));
  const on = me && me.push && 'Notification' in window && Notification.permission === 'granted';
  const fresh = on && announced ? notifs.filter(n => !n.read && !announced.has(n.id) && (n.kind === 'suggestions' || n.kind === 'digest')) : [];
  announced = ids;
  for (const n of fresh) {
    const x = new Notification('Aria', { body: n.text, tag: `aria-${n.id}` });
    x.onclick = () => { window.focus(); const l = safeHash(n.link); if (l) location.hash = l; x.close(); };
  }
}
// FM6: background poll. One toast when it starts failing, one when it recovers.
async function poll() {
  if (!me || !$('#main') || document.visibilityState !== 'visible') return;
  try {
    me = { ...me, ...(await api('GET', '/api/me')) }; updateCounts();
    await loadNotifs(true); announce();
  } catch (e) {
    if (e.silent || pollDown) return;
    pollDown = true;
    toast(`Cannot reach Aria (${e.error || 'error'}). Retrying every minute.`, { error: true });
    return;
  }
  if (pollDown) { pollDown = false; toast('Reconnected'); }
}
setInterval(poll, 60000);
route();
