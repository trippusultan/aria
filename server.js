'use strict';
// Aria backend: static SPA + every /api/* route in CONTRACT.md. Node stdlib only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { open } = require('./db');
const connectors = require('./connectors');

const scrypt = promisify(crypto.scrypt);
const DAY = 86400e3;
const IDLE_MS = 12 * 3600e3;
const STATUSES = ['open', 'in_progress', 'waiting', 'completed', 'cancelled'];
const CLOSED = ['completed', 'cancelled'];
const DIRECTIONS = ['i_owe', 'they_owe', 'unclear'];
const PRIORITIES = ['low', 'med', 'high'];
const DEFAULTS = { timezone: 'UTC', digest_time: '08:00', digest_email: true, waiting_days: 5, low_floor: 0.55, high_threshold: 0.85,
  auto_promote: false, lookback_days: 14, excluded_labels: [], excluded_calendars: [], retention_days: 90, bot_auto_invite: false, push_opt_in: false, external_ai: false };
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'zoho.com', 'rediffmail.com']);
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const RAW = Symbol('raw');

const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
const now = () => new Date().toISOString();
const J = (s, d = null) => (s ? JSON.parse(s) : d);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const raw = (body, headers, status = 200) => ({ [RAW]: true, body, headers, status });
const localDate = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const localTime = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// ---- input validation (trust boundary) ----
function str(v, name, { min = 0, max = 500 } = {}) {
  if (typeof v !== 'string') fail(400, `${name} must be a string`);
  v = v.trim();
  if (v.length < min || v.length > max) fail(400, `${name} must be ${min}-${max} characters`);
  return v;
}
function oneOf(v, list, name) { if (!list.includes(v)) fail(400, `${name} must be one of: ${list.join(', ')}`); return v; }
function dateOrNull(v, name = 'due_at') {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z')) ||
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) fail(400, `${name} must be YYYY-MM-DD or null`);
  return v;
}
function strList(v, name, maxItems = 50) {
  if (!Array.isArray(v) || v.length > maxItems) fail(400, `${name} must be an array of at most ${maxItems} strings`);
  return [...new Set(v.map((x) => str(x, name, { min: 1, max: 100 })))];
}
const num = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(400, `${name} must be a number`); return v; };
const bool = (v, name) => { if (typeof v !== 'boolean') fail(400, `${name} must be true or false`); return v; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isEmail = (e) => typeof e === 'string' && e.length <= 320 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e);

// ---- CSV ----
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // formula-injection guard
  return '"' + s.replace(/"/g, '""') + '"';
}

function createServer({ dataDir = process.env.ARIA_DATA_DIR || path.join(__dirname, 'data'), engine, background = process.env.ARIA_NO_BACKGROUND !== '1',
  publicDir = path.join(__dirname, 'public'), fixturesDir = path.join(__dirname, 'fixtures'), baseUrl, rateLimits = {},
  adminEmails = (process.env.ARIA_ADMIN_EMAILS || '').split(',') } = {}) {
  const ADMINS = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const LIMITS = { auth: 20, export: 20, ...rateLimits };
  // ponytail: in-memory per-IP buckets; reset on restart, not shared across processes. Move to the DB if we run >1 instance.
  const hits = new Map(); // key -> { windowMs, ts: [] }
  function pruneHits() {
    const t = Date.now();
    for (const [k, h] of hits) { h.ts = h.ts.filter((x) => t - x < h.windowMs); if (!h.ts.length) hits.delete(k); }
  }
  function rateLimit(key, max, windowMs) {
    if (hits.size > 1000) pruneHits();
    const t = Date.now();
    const h = hits.get(key) || { windowMs, ts: [] };
    h.ts = h.ts.filter((x) => t - x < windowMs);
    if (h.ts.length >= max) fail(429, 'too many requests, try again later');
    h.ts.push(t); hits.set(key, h);
  }
  engine = engine || require('./engine');
  publicDir = path.resolve(publicDir);
  const D = open(dataDir);
  const { all, one, run, tx, enc, dec } = D;
  const encJ = (uid, v) => enc(uid, JSON.stringify(v));
  const decJ = (uid, blob, d = null) => (blob == null ? d : JSON.parse(dec(uid, blob)));
  const payloadOf = (row) => decJ(row.user_id, row.payload);

  // ---------- core helpers ----------
  function settingsOf(uid) {
    const r = one('SELECT json FROM settings WHERE user_id=?', uid);
    return { ...DEFAULTS, ...J(r && r.json, {}) };
  }
  const todayOf = (uid) => localDate(settingsOf(uid).timezone);
  const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
  function audit(user, action, object, ip) {
    run('INSERT INTO audit_events (user_id, org_id, actor, action, object, at, ip) VALUES (?,?,?,?,?,?,?)',
      user && user.id, user && user.org_id, user && user.email, action, object || null, now(), ip || null);
  }
  function notify(uid, kind, text, link) {
    run('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?,?,?,?,?)', uid, kind, text, link || null, now());
  }
  const logAct = (uid, taskId, actor, verb, from, to) => run('INSERT INTO activity (user_id, task_id, actor, verb, from_value, to_value, at) VALUES (?,?,?,?,?,?,?)',
    uid, taskId, actor, verb, from == null ? null : String(from), to == null ? null : String(to), now());

  // ---------- people ----------
  function findOrCreatePerson(uid, { name, email, unverified }) {
    name = String(name || '').trim().slice(0, 200);
    email = email ? String(email).trim().toLowerCase().slice(0, 320) : null;
    if (!name && !email) return null;
    const people = all('SELECT * FROM people WHERE user_id=?', uid);
    if (email) { const p = people.find((x) => J(x.emails, []).includes(email)); if (p) return p.id; }
    if (name) {
      const n = name.toLowerCase();
      const p = people.find((x) => x.display_name.toLowerCase() === n || J(x.aliases, []).some((a) => a.toLowerCase() === n));
      if (p) {
        if (email) run('UPDATE people SET emails=?, unverified=? WHERE id=?', JSON.stringify([...J(p.emails, []), email]), unverified ? p.unverified : 0, p.id);
        return p.id;
      }
    }
    return Number(run('INSERT INTO people (user_id, display_name, emails, aliases, unverified, created_at) VALUES (?,?,?,?,?,?)',
      uid, name || email, JSON.stringify(email ? [email] : []), '[]', unverified || !email ? 1 : 0, now()).lastInsertRowid);
  }
  function peopleOf(uid, list) { // [{person_id}|{name, email?}] -> person ids
    if (!Array.isArray(list) || list.length > 50) fail(400, 'stakeholders must be an array of at most 50');
    const ids = list.map((s) => {
      if (s && s.person_id != null) {
        if (!one('SELECT id FROM people WHERE id=? AND user_id=?', Number(s.person_id), uid)) fail(400, 'unknown person_id');
        return Number(s.person_id);
      }
      if (!s || typeof s.name !== 'string' || !s.name.trim()) fail(400, 'stakeholder needs person_id or name');
      return findOrCreatePerson(uid, { name: str(s.name, 'stakeholder name', { min: 1, max: 200 }), email: isEmail(s.email) ? s.email : null, unverified: true });
    });
    return [...new Set(ids)];
  }
  function peopleList(uid) {
    const counts = all(`SELECT tp.person_id, t.status, COUNT(*) n, MAX(COALESCE(s.started_at, t.updated_at)) last FROM task_people tp
      JOIN tasks t ON t.id=tp.task_id AND t.user_id=? LEFT JOIN sources s ON s.id=t.source_id AND s.user_id=? WHERE tp.user_id=? GROUP BY tp.person_id, t.status`, uid, uid, uid);
    return all('SELECT * FROM people WHERE user_id=? ORDER BY display_name COLLATE NOCASE', uid).map((p) => {
      const mine = counts.filter((c) => c.person_id === p.id);
      const sum = (sts) => mine.filter((c) => sts.includes(c.status)).reduce((a, c) => a + c.n, 0);
      return { id: p.id, display_name: p.display_name, emails: J(p.emails, []), org_name: p.org_name, unverified: !!p.unverified,
        open: sum(['open', 'in_progress']), waiting: sum(['waiting']), done: sum(['completed']),
        last_interaction: mine.reduce((a, c) => (c.last > (a || '') ? c.last : a), null) };
    });
  }

  // ---------- tasks ----------
  function taskOut(r) {
    const st = all('SELECT p.id, p.display_name, p.unverified, tp.role FROM task_people tp JOIN people p ON p.id=tp.person_id AND p.user_id=tp.user_id WHERE tp.task_id=? AND tp.user_id=?', r.id, r.user_id)
      .map((x) => ({ id: x.id, display_name: x.display_name, unverified: !!x.unverified, role: x.role }));
    const src = r.source_id ? one('SELECT id, type, title, started_at FROM sources WHERE id=? AND user_id=? AND deleted=0', r.source_id, r.user_id) : null;
    const exRow = r.excerpt_id ? one('SELECT text, start_offset FROM excerpts WHERE id=? AND user_id=?', r.excerpt_id, r.user_id) : null;
    const ex = exRow ? { text: dec(r.user_id, exRow.text), start_offset: exRow.start_offset } : null;
    const n = one('SELECT COUNT(*) n FROM notes WHERE task_id=? AND user_id=?', r.id, r.user_id).n;
    const lastRow = one('SELECT body FROM notes WHERE task_id=? AND user_id=? ORDER BY id DESC LIMIT 1', r.id, r.user_id);
    const last = lastRow ? { body: dec(r.user_id, lastRow.body) } : null;
    return { id: r.id, title: r.title, body: r.body, status: r.status, direction: r.direction, due_at: r.due_at, priority: r.priority,
      tags: J(r.tags, []), visibility: r.visibility, created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at,
      stakeholders: st, source: src ? { ...src } : null, excerpt: ex ? { ...ex } : null, notes_count: n, last_note: last ? last.body : null };
  }
  const taskRow = (uid, id) => one('SELECT * FROM tasks WHERE id=? AND user_id=?', id, uid) || fail(404, 'task not found');
  function taskDetail(uid, id) {
    return { ...taskOut(taskRow(uid, id)),
      notes: all('SELECT id, body, created_at FROM notes WHERE task_id=? AND user_id=? ORDER BY id', id, uid).map((x) => ({ id: x.id, body: dec(uid, x.body), created_at: x.created_at })),
      activity: all('SELECT verb, from_value, to_value, at, actor FROM activity WHERE task_id=? AND user_id=? ORDER BY id', id, uid).map((x) => ({ ...x })) };
  }
  function taskFields(uid, b, partial) {
    const f = {};
    if (!partial || b.title !== undefined) f.title = str(b.title, 'title', { min: 1, max: 300 });
    if (b.body !== undefined) f.body = str(b.body ?? '', 'body', { max: 20000 });
    if (b.status !== undefined) f.status = oneOf(b.status, STATUSES, 'status');
    if (b.direction !== undefined) f.direction = oneOf(b.direction, DIRECTIONS, 'direction');
    if (b.due_at !== undefined) f.due_at = dateOrNull(b.due_at);
    if (b.priority !== undefined) f.priority = b.priority === null ? null : oneOf(b.priority, PRIORITIES, 'priority');
    if (b.tags !== undefined) f.tags = strList(b.tags, 'tags');
    if (b.stakeholders !== undefined) f.people = peopleOf(uid, b.stakeholders);
    return f;
  }
  function setTaskPeople(uid, taskId, ids) {
    run('DELETE FROM task_people WHERE task_id=? AND user_id=?', taskId, uid);
    for (const pid of ids) run('INSERT OR IGNORE INTO task_people (user_id, task_id, person_id, role) VALUES (?,?,?,?)', uid, taskId, pid, 'counterparty');
  }
  function createTask(uid, f, actor, verb) {
    return tx(() => {
      const t = now();
      const id = Number(run(`INSERT INTO tasks (user_id, title, body, status, direction, due_at, owner_user_id, priority, tags, source_id, excerpt_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, f.title, f.body || '', f.status || 'open', f.direction || 'unclear', f.due_at || null, uid,
      f.priority || null, JSON.stringify(f.tags || []), f.source_id || null, f.excerpt_id || null, t, t).lastInsertRowid);
      setTaskPeople(uid, id, f.people || []);
      logAct(uid, id, actor, verb, null, f.title);
      return id;
    });
  }
  function updateTask(uid, id, f, actor) {
    return tx(() => {
      const r = taskRow(uid, id);
      const sets = {};
      for (const k of ['title', 'body', 'status', 'direction', 'due_at', 'priority']) {
        if (f[k] !== undefined && f[k] !== r[k]) { sets[k] = f[k]; logAct(uid, id, actor, k, r[k], f[k]); }
      }
      if (f.tags && JSON.stringify(f.tags) !== r.tags) { sets.tags = JSON.stringify(f.tags); logAct(uid, id, actor, 'tags', J(r.tags, []).join(', '), f.tags.join(', ')); }
      if (sets.status) sets.closed_at = CLOSED.includes(sets.status) ? now() : null;
      if (f.people) {
        const names = (ids) => ids.map((pid) => one('SELECT display_name FROM people WHERE id=? AND user_id=?', pid, uid)?.display_name).join(', ');
        const before = all('SELECT person_id FROM task_people WHERE task_id=? AND user_id=? ORDER BY person_id', id, uid).map((x) => x.person_id);
        if (JSON.stringify(before) !== JSON.stringify([...f.people].sort((a, b) => a - b))) {
          setTaskPeople(uid, id, f.people); logAct(uid, id, actor, 'stakeholders', names(before), names(f.people)); sets.updated_at = now();
        }
      }
      const keys = Object.keys(sets);
      if (keys.length) {
        sets.updated_at = now();
        run(`UPDATE tasks SET ${Object.keys(sets).map((k) => `${k}=?`).join(', ')} WHERE id=? AND user_id=?`, ...Object.values(sets), id, uid);
      }
      return taskOut(taskRow(uid, id));
    });
  }
  function addNote(uid, taskId, body, actor = 'user') {
    taskRow(uid, taskId);
    body = str(body, 'body', { min: 1, max: 20000 });
    const t = now();
    const id = Number(run('INSERT INTO notes (user_id, task_id, author_user_id, body, created_at) VALUES (?,?,?,?,?)', uid, taskId, uid, enc(uid, body), t).lastInsertRowid);
    run('UPDATE tasks SET updated_at=? WHERE id=? AND user_id=?', t, taskId, uid);
    logAct(uid, taskId, actor, 'note', null, `note #${id}`); // body stays encrypted; activity only references it
    return { id, body, created_at: t };
  }
  // ponytail: filters run in JS over the user's whole task list; move to SQL/FTS past ~10k tasks per user.
  function queryTasks(uid, f = {}) {
    const today = todayOf(uid), week = addDays(today, 6);
    const statuses = f.status && f.status.length ? f.status : f.closedSince ? CLOSED : STATUSES.filter((s) => !CLOSED.includes(s));
    let rows = all(`SELECT * FROM tasks WHERE user_id=? AND status IN (${statuses.map(() => '?').join(',')})`, uid, ...statuses);
    if (f.closedSince) rows = rows.filter((r) => r.closed_at && r.closed_at >= f.closedSince);
    if (f.due) rows = rows.filter((r) => (f.due === 'none' ? !r.due_at : r.due_at && (f.due === 'overdue' ? r.due_at < today && !CLOSED.includes(r.status)
      : f.due === 'today' ? r.due_at === today : r.due_at >= today && r.due_at <= week)));
    if (f.direction) rows = rows.filter((r) => r.direction === f.direction);
    if (f.tag) rows = rows.filter((r) => J(r.tags, []).includes(f.tag));
    let out = rows.map(taskOut);
    if (f.person) out = out.filter((t) => t.stakeholders.some((p) => p.id === f.person));
    if (f.personName) out = out.filter((t) => t.stakeholders.some((p) => p.display_name.toLowerCase().includes(f.personName)));
    if (f.source_type) out = out.filter((t) => (t.source ? t.source.type : 'manual') === f.source_type);
    if (f.sourceTitle) out = out.filter((t) => t.source && t.source.title.toLowerCase().includes(f.sourceTitle));
    if (f.q) {
      const q = f.q.toLowerCase();
      const notes = all('SELECT task_id, body FROM notes WHERE user_id=?', uid).map((n) => ({ task_id: n.task_id, body: dec(uid, n.body) }));
      out = out.filter((t) => [t.title, t.body, t.source && t.source.title, ...t.stakeholders.map((p) => p.display_name),
        ...notes.filter((n) => n.task_id === t.id).map((n) => n.body)].some((x) => x && x.toLowerCase().includes(q)));
    }
    return out.sort((a, b) => DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction)
      || (a.due_at || '9999') .localeCompare(b.due_at || '9999') || b.updated_at.localeCompare(a.updated_at));
  }
  function counts(uid) {
    const today = todayOf(uid);
    const c = (sql, ...p) => one(sql, uid, ...p).n;
    return {
      open: c("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND status IN ('open','in_progress')"),
      waiting: c("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND status='waiting'"),
      overdue: c("SELECT COUNT(*) n FROM tasks WHERE user_id=? AND due_at < ? AND status NOT IN ('completed','cancelled')", today),
      suggested: c("SELECT COUNT(*) n FROM suggestions WHERE user_id=? AND state='pending' AND (snooze_until IS NULL OR snooze_until <= ?)", now()),
    };
  }

  // ---------- suggestions + processing pipeline ----------
  function suggestionOut(s) {
    const src = one('SELECT id, type, title, started_at FROM sources WHERE id=? AND user_id=? AND deleted=0', s.source_id, s.user_id);
    return { id: s.id, confidence: s.confidence, state: s.state, created_at: s.created_at, source: src ? { ...src } : null, payload: payloadOf(s) };
  }
  const sugRow = (uid, id) => {
    const s = one('SELECT * FROM suggestions WHERE id=? AND user_id=?', id, uid) || fail(404, 'suggestion not found');
    if (s.state !== 'pending') fail(409, `suggestion already ${s.state}`);
    return s;
  };
  // Titles the user already decided on (accepted/merged/rejected) anywhere: never re-suggested; rejected ones also feed the engine.
  const decidedTitles = (uid, states) => all(`SELECT user_id, payload FROM suggestions WHERE user_id=? AND state IN (${states.map(() => '?').join(',')})`, uid, ...states)
    .map((r) => payloadOf(r).title);
  // Validates before any write so bulk accept can skip a bad item instead of aborting half-way.
  function planAccept(uid, s, edits) {
    if (edits != null && (typeof edits !== 'object' || Array.isArray(edits))) fail(400, 'edits must be an object');
    const e = edits || {};
    const p = payloadOf(s);
    const f = taskFields(uid, { title: e.title ?? p.title, body: e.body ?? '', direction: e.direction ?? p.direction,
      due_at: e.due_at !== undefined ? e.due_at : (p.due && p.due.date) || null }, false);
    const people = e.stakeholders !== undefined ? e.stakeholders : (p.stakeholders || []);
    if (!Array.isArray(people) || !people.some((x) => x && (x.person_id != null || (typeof x.name === 'string' && x.name.trim()) || x.email))) {
      fail(400, 'At least one stakeholder is required');
    }
    return { f, e, p };
  }
  function acceptSuggestion(uid, id, edits, actor = 'user') {
    return tx(() => {
      const s = sugRow(uid, id);
      const { f, e, p } = planAccept(uid, s, edits);
      f.people = e.stakeholders !== undefined ? peopleOf(uid, e.stakeholders)
        : [...new Set(p.stakeholders.map((x) => (x.person_id && one('SELECT id FROM people WHERE id=? AND user_id=?', x.person_id, uid)
          ? x.person_id : findOrCreatePerson(uid, x))).filter(Boolean))];
      if (!f.people.length) fail(400, 'At least one stakeholder is required');
      f.source_id = s.source_id; f.excerpt_id = s.excerpt_id;
      const taskId = createTask(uid, f, actor, 'created from suggestion');
      run("UPDATE suggestions SET state='accepted', task_id=? WHERE id=?", taskId, id);
      return taskId;
    });
  }
  const validDate = (d) => { try { return dateOrNull(d) !== null; } catch { return false; } };
  function cleanCandidate(c, text, user) {
    if (!c || typeof c.title !== 'string' || !c.title.trim() || typeof c.excerpt !== 'string' || !c.excerpt) return null;
    const excerpt = c.excerpt.slice(0, 400);
    const off = Number.isInteger(c.offset) && text.slice(c.offset, c.offset + excerpt.length) === excerpt ? c.offset : text.indexOf(excerpt);
    if (off < 0) return null; // excerpt must be verbatim
    const me = (x) => (x.email && x.email.toLowerCase() === user.email) || (x.name && x.name.toLowerCase() === user.name.toLowerCase());
    return { title: c.title.trim().slice(0, 300), owner: ['user', 'counterpart', 'unclear'].includes(c.owner) ? c.owner : 'unclear',
      direction: DIRECTIONS.includes(c.direction) ? c.direction : 'unclear',
      stakeholders: (Array.isArray(c.stakeholders) ? c.stakeholders : []).filter((x) => x && (x.name || x.email) && !me(x)).slice(0, 20)
        .map((x) => ({ name: String(x.name || x.email).slice(0, 200), email: x.email ? String(x.email).toLowerCase().slice(0, 320) : null, unverified: !!x.unverified })),
      due: c.due && validDate(c.due.date) ? { date: c.due.date, span: String(c.due.span || '').slice(0, 200) } : null, // invalid dates nulled at write
      excerpt, offset: off, speaker: typeof c.speaker === 'string' ? c.speaker.slice(0, 200) : null,
      confidence: clamp(Number(c.confidence) || 0, 0, 1), rationale: String(c.rationale || '').slice(0, 500) };
  }
  // Source delete / retention: drop verbatim text from suggestions (title kept for reject-learning) and unreferenced excerpts.
  // Excerpts linked to accepted tasks stay: the task is user-owned and keeps its durable excerpt link (TSK-9, PRD 14.4).
  function scrubSource(uid, sourceId) {
    for (const r of all('SELECT id, user_id, payload FROM suggestions WHERE source_id=? AND user_id=?', sourceId, uid)) {
      const p = payloadOf(r);
      p.excerpt = null; p.offset = null; if (p.due) p.due.span = null;
      run('UPDATE suggestions SET payload=? WHERE id=?', encJ(uid, p), r.id);
    }
    run('DELETE FROM excerpts WHERE source_id=? AND user_id=? AND id NOT IN (SELECT excerpt_id FROM tasks WHERE user_id=? AND excerpt_id IS NOT NULL)', sourceId, uid, uid);
  }
  async function processSource(uid, sourceId, hint) {
    const src = one('SELECT * FROM sources WHERE id=? AND user_id=? AND deleted=0', sourceId, uid);
    if (!src) return;
    const text = src.text_enc ? dec(uid, src.text_enc) : null;
    if (!text) {
      if (src.raw_wiped) run("UPDATE sources SET processing_status='failed', last_error='raw text deleted by retention policy' WHERE id=?", sourceId);
      else run("UPDATE sources SET processing_status='no_transcript', last_error=NULL WHERE id=?", sourceId);
      return;
    }
    run("UPDATE sources SET processing_status='pending', last_error=NULL WHERE id=?", sourceId);
    const u = one('SELECT name, email FROM users WHERE id=?', uid);
    const s = settingsOf(uid);
    const rejected = decidedTitles(uid, ['rejected']);
    try {
      const out = await engine.extract({ type: src.type, title: src.title, text, startedAt: src.started_at, participants: J(src.participants, []),
        user: { name: u.name, email: u.email }, tz: s.timezone }, { floor: s.low_floor, rejected, hint: hint || undefined, ai: !!s.external_ai });
      if (!one('SELECT id FROM sources WHERE id=? AND user_id=? AND deleted=0', sourceId, uid)) return; // deleted while extracting
      tx(() => {
        for (const o of all("SELECT id, excerpt_id FROM suggestions WHERE source_id=? AND user_id=? AND state='pending'", sourceId, uid)) {
          run('DELETE FROM suggestions WHERE id=?', o.id);
          run('DELETE FROM excerpts WHERE id=? AND user_id=? AND id NOT IN (SELECT excerpt_id FROM tasks WHERE user_id=? AND excerpt_id IS NOT NULL)', o.excerpt_id, uid, uid);
        }
        const seen = new Set(decidedTitles(uid, ['accepted', 'merged', 'rejected']).map((t) => t.toLowerCase()));
        let n = 0;
        for (const raw of out.candidates || []) {
          const c = cleanCandidate(raw, text, u);
          if (!c || c.confidence < s.low_floor || seen.has(c.title.toLowerCase())) continue;
          seen.add(c.title.toLowerCase());
          for (const st of c.stakeholders) st.person_id = findOrCreatePerson(uid, st);
          const speaker = c.speaker && c.stakeholders.find((x) => x.name.toLowerCase() === c.speaker.toLowerCase());
          const exId = run('INSERT INTO excerpts (user_id, source_id, start_offset, text, speaker_person_id) VALUES (?,?,?,?,?)',
            uid, sourceId, c.offset, enc(uid, c.excerpt), speaker ? speaker.person_id : null).lastInsertRowid;
          const sid = Number(run('INSERT INTO suggestions (user_id, source_id, payload, confidence, state, excerpt_id, created_at) VALUES (?,?,?,?,?,?,?)',
            uid, sourceId, encJ(uid, c), c.confidence, 'pending', exId, now()).lastInsertRowid);
          if (s.auto_promote && c.confidence >= s.high_threshold && c.stakeholders.length) acceptSuggestion(uid, sid, null, 'auto_promote');
          else n++;
        }
        run("UPDATE sources SET processing_status='done', last_error=NULL, mode=COALESCE(mode, ?), processed_at=? WHERE id=?", out.mode || null, now(), sourceId);
        if (n) notify(uid, 'suggestions', `${n} suggested action${n === 1 ? '' : 's'} from ${src.title}`, '#/inbox');
      });
    } catch (e) {
      run("UPDATE sources SET processing_status='failed', last_error=? WHERE id=? AND user_id=?", String(e.message || e).slice(0, 500), sourceId, uid);
    }
  }

  // ---------- sources ----------
  const srcRow = (uid, id) => one('SELECT * FROM sources WHERE id=? AND user_id=? AND deleted=0', id, uid) || fail(404, 'source not found');
  function sourceOut(r) {
    return { id: r.id, type: r.type, connector: r.connector, title: r.title, started_at: r.started_at, participants: J(r.participants, []),
      processing_status: r.processing_status, last_error: r.last_error, mode: r.mode, notice: r.notice, raw_wiped: !!r.raw_wiped,
      suggestion_count: one("SELECT COUNT(*) n FROM suggestions WHERE source_id=? AND user_id=? AND state='pending'", r.id, r.user_id).n,
      task_count: one('SELECT COUNT(*) n FROM tasks WHERE source_id=? AND user_id=?', r.id, r.user_id).n };
  }

  // ---------- connectors ----------
  const lookup = (provider) => { const r = one('SELECT v FROM app_config WHERE k=?', provider); return r ? JSON.parse(dec(0, r.v)) : null; };
  const app = { one, all, run, enc, dec, settingsOf, processSource, fixturesDir, lookup };
  const inflight = new Map();
  function runSync(uid, type) { // chains per (user, type) so a manual sync waits for one already running
    const k = `${uid}:${type}`;
    const p = (inflight.get(k) || Promise.resolve()).catch(() => {}).then(() => connectors.sync(app, uid, type));
    inflight.set(k, p);
    p.finally(() => { if (inflight.get(k) === p) inflight.delete(k); }).catch(() => {});
    return p;
  }
  const redirectUri = (req, type) => `${baseUrl || process.env.ARIA_BASE_URL || `http://${req.headers.host}`}/oauth/${type}/callback`;
  const connType = (t) => (connectors.TYPES[t] ? t : fail(404, 'unknown connector'));

  // ---------- settings ----------
  function patchSettings(uid, b) {
    const s = settingsOf(uid);
    const out = {};
    for (const [k, v] of Object.entries(b)) {
      switch (k) {
        case 'name': run('UPDATE users SET name=? WHERE id=?', str(v, 'name', { min: 1, max: 100 }), uid); break;
        case 'timezone': try { localDate(str(v, 'timezone', { min: 1, max: 64 })); out.timezone = v.trim(); } catch { fail(400, 'unknown timezone'); } break;
        case 'digest_time': if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(400, 'digest_time must be HH:MM'); out[k] = v; break;
        case 'digest_email': case 'auto_promote': case 'bot_auto_invite': case 'push_opt_in': case 'external_ai': out[k] = bool(v, k); break;
        case 'waiting_days': out[k] = clamp(Math.round(num(v, k)), 1, 60); break;
        case 'low_floor': case 'high_threshold': out[k] = clamp(num(v, k), 0, 1); break;
        case 'lookback_days': out[k] = clamp(Math.round(num(v, k)), 1, 90); break;
        case 'retention_days': out[k] = clamp(Math.round(num(v, k)), 7, 365); break;
        case 'excluded_labels': case 'excluded_calendars': out[k] = strList(v, k); break;
        default: break; // unknown keys ignored
      }
    }
    const merged = { ...s, ...out };
    delete merged.name;
    run('INSERT INTO settings (user_id, json) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json', uid, JSON.stringify(merged));
  }
  const settingsOut = (u) => ({ name: one('SELECT name FROM users WHERE id=?', u.id).name, ...settingsOf(u.id) });

  // ---------- digest / retention ----------
  function digest(uid) {
    const s = settingsOf(uid);
    const stale = new Date(Date.now() - s.waiting_days * DAY).toISOString();
    return { overdue: queryTasks(uid, { due: 'overdue' }), due_today: queryTasks(uid, { due: 'today' }),
      waiting_stale: queryTasks(uid, { status: ['waiting'] }).filter((t) => t.updated_at < stale) };
  }
  function digestTick() {
    for (const u of all('SELECT u.id, u.name, s.digest_sent FROM users u LEFT JOIN settings s ON s.user_id=u.id')) {
      const s = settingsOf(u.id);
      const today = localDate(s.timezone);
      if (!s.digest_email || u.digest_sent === today || localTime(s.timezone) < s.digest_time) continue;
      const d = digest(u.id);
      const line = (t) => `- ${t.title}${t.due_at ? ` (due ${t.due_at})` : ''}${t.stakeholders.length ? ` with ${t.stakeholders.map((p) => p.display_name).join(', ')}` : ''}`;
      const text = [`Aria digest for ${u.name}, ${today}`, '', `Overdue (${d.overdue.length})`, ...d.overdue.map(line), '',
        `Due today (${d.due_today.length})`, ...d.due_today.map(line), '', `Waiting more than ${s.waiting_days} days (${d.waiting_stale.length})`, ...d.waiting_stale.map(line), ''].join('\n');
      // ponytail: "email" digest is a file in dataDir/outbox; wire SMTP/provider when real delivery is needed
      fs.mkdirSync(path.join(dataDir, 'outbox'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'outbox', `${u.id}-${today}.txt`), text);
      run('INSERT INTO settings (user_id, digest_sent) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET digest_sent=excluded.digest_sent', u.id, today);
      notify(u.id, 'digest', `Daily digest: ${d.overdue.length} overdue, ${d.due_today.length} due today, ${d.waiting_stale.length} waiting`, '#/home');
    }
  }
  function retentionSweep() {
    for (const u of all('SELECT id FROM users')) {
      const cutoff = new Date(Date.now() - settingsOf(u.id).retention_days * DAY).toISOString();
      // failed / never-processed sources age from created_at so they cannot keep raw text forever
      for (const s of all('SELECT id FROM sources WHERE user_id=? AND deleted=0 AND text_enc IS NOT NULL AND COALESCE(processed_at, created_at) < ?', u.id, cutoff)) {
        tx(() => { run('UPDATE sources SET text_enc=NULL, raw_wiped=1 WHERE id=?', s.id); scrubSource(u.id, s.id); });
      }
    }
  }

  // ---------- auth ----------
  const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  const cookie = (v, maxAge) => `aria_sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.ARIA_SECURE_COOKIE === '1' ? '; Secure' : ''}`;
  function startSession(c, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const t = now();
    // only the hash is stored, so a DB leak does not leak live sessions; the hash doubles as the device-list id
    run('INSERT INTO sessions (id, user_id, user_agent, ip, created_at, last_seen_at) VALUES (?,?,?,?,?,?)',
      sha256(token), user.id, String(c.req.headers['user-agent'] || '').slice(0, 300), c.ip, t, t);
    c.headers['Set-Cookie'] = cookie(token, IDLE_MS / 1000);
  }
  function authenticate(req) {
    const tok = parseCookies(req).aria_sid;
    if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
    const id = sha256(tok);
    const s = one('SELECT * FROM sessions WHERE id=?', id);
    if (!s) return null;
    if (Date.now() - Date.parse(s.last_seen_at) > IDLE_MS) { run('DELETE FROM sessions WHERE id=?', id); return null; }
    const user = one('SELECT * FROM users WHERE id=?', s.user_id);
    if (!user) return null;
    if (ADMINS.has(user.email) && !FREEMAIL.has(user.email.split('@')[1])) user.role = 'admin'; // allowlist applies without re-signup
    run('UPDATE sessions SET last_seen_at=? WHERE id=?', now(), id);
    return { session: s, user, token: tok };
  }
  async function checkPassword(user, pw) {
    const h = await hashPw(typeof pw === 'string' ? pw : '', user ? user.pw_salt : 'x'.repeat(32));
    return !!user && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.pw_hash, 'hex'));
  }

  // ---------- assistant ----------
  function assistantTools(uid) {
    const statusList = (s) => (Array.isArray(s) ? s.filter((x) => STATUSES.includes(x)) : undefined);
    const low = (s) => (typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : undefined);
    return {
      listTasks: (f = {}) => queryTasks(uid, { status: statusList(f.status), personName: low(f.person), q: low(f.q),
        due: ['overdue', 'today', 'week'].includes(f.due) ? f.due : undefined, sourceTitle: low(f.source),
        closedSince: typeof f.closedSince === 'string' ? f.closedSince : undefined }),
      getTask: (id) => { const r = one('SELECT * FROM tasks WHERE id=? AND user_id=?', Number(id), uid); return r ? taskDetail(uid, r.id) : null; },
      searchSources: (q) => {
        q = low(q) || '';
        return all('SELECT * FROM sources WHERE user_id=? AND deleted=0 ORDER BY started_at DESC', uid).map((r) => {
          const text = r.text_enc ? dec(uid, r.text_enc) : '';
          const i = q ? text.toLowerCase().indexOf(q) : 0;
          if (q && i < 0 && !r.title.toLowerCase().includes(q)) return null;
          return { id: r.id, type: r.type, title: r.title, started_at: r.started_at, excerpt: text.slice(Math.max(0, i - 150), Math.max(0, i) + 250) };
        }).filter(Boolean).slice(0, 20);
      },
      listPeople: () => peopleList(uid).map((p) => ({ id: p.id, display_name: p.display_name, open: p.open, waiting: p.waiting, done: p.done })),
    };
  }
  const threadRow = (uid, id) => one('SELECT * FROM chat_threads WHERE id=? AND user_id=?', Number(id), uid) || fail(404, 'thread not found');
  const PROPOSAL_ACTIONS = ['set_status', 'add_note', 'set_due', 'create_task'];

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, fn, auth: opts.auth !== false,
    re: new RegExp('^' + pattern.replace(/:id\b/g, '(?<id>\\d+)').replace(/:type\b/g, '(?<type>[a-z]+)').replace(/:sid\b/g, '(?<sid>[0-9a-f]{64})') + '$') });
  const id = (c) => Number(c.p.id);

  route('GET', '/api/healthz', () => ({ ok: !!one('SELECT 1 AS x') }), { auth: false }); // for load balancers

  // auth / account
  route('POST', '/api/auth/signup', async (c) => {
    rateLimit(`auth:${c.ip}`, LIMITS.auth, 15 * 60e3);
    const b = c.body;
    const email = str(b.email, 'email', { min: 3, max: 320 }).toLowerCase();
    if (!isEmail(email)) fail(400, 'invalid email');
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) fail(400, 'password must be 8-200 characters');
    const name = str(b.name, 'name', { min: 1, max: 100 });
    if (one('SELECT id FROM users WHERE email=?', email)) fail(409, 'an account with this email already exists');
    const domain = email.split('@')[1];
    // Admin is granted only by the operator (ARIA_ADMIN_EMAILS), never by being first: there is no email verification,
    // so "first signup of a domain" would let anyone squat a company's admin seat.
    const org = FREEMAIL.has(domain) ? `personal:${email}` : domain;
    const role = ADMINS.has(email) && !FREEMAIL.has(domain) ? 'admin' : 'member';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPw(b.password, salt);
    if (one('SELECT id FROM users WHERE email=?', email)) fail(409, 'an account with this email already exists');
    const uid = Number(run('INSERT INTO users (org_id, email, name, pw_hash, pw_salt, key_salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)', org, email, name, hash, salt, crypto.randomBytes(16).toString('hex'), role, now()).lastInsertRowid);
    run('INSERT INTO settings (user_id, json) VALUES (?, ?)', uid, '{}');
    const user = one('SELECT * FROM users WHERE id=?', uid);
    startSession(c, user);
    audit(user, 'signup', `user:${uid}`, c.ip);
    return { user: userOut(user) };
  }, { auth: false });
  route('POST', '/api/auth/login', async (c) => {
    rateLimit(`auth:${c.ip}`, LIMITS.auth, 15 * 60e3);
    const email = typeof c.body.email === 'string' ? c.body.email.trim().toLowerCase() : '';
    const user = one('SELECT * FROM users WHERE email=?', email);
    if (!(await checkPassword(user, c.body.password))) fail(401, 'wrong email or password');
    startSession(c, user);
    audit(user, 'login', `user:${user.id}`, c.ip);
    return { user: userOut(user) };
  }, { auth: false });
  route('POST', '/api/auth/logout', (c) => {
    const a = authenticate(c.req);
    if (a) { run('DELETE FROM sessions WHERE id=?', a.session.id); audit(a.user, 'logout', `user:${a.user.id}`, c.ip); }
    c.headers['Set-Cookie'] = cookie('', 0);
    return { ok: true };
  }, { auth: false });
  route('GET', '/api/me', (c) => ({ user: userOut(c.user), counts: counts(c.uid),
    can_setup: canSetup(c),
    demo: !!one("SELECT 1 AS x FROM connectors WHERE user_id=? AND mode='demo' AND status!='disconnected'", c.uid)
      || !!one("SELECT 1 AS x FROM sources WHERE user_id=? AND mode='demo' AND deleted=0 LIMIT 1", c.uid),
    push: !!settingsOf(c.uid).push_opt_in }));
  route('GET', '/api/sessions', (c) => all('SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC', c.uid)
    .map((s) => ({ ...s, current: s.id === c.session.id })));
  route('DELETE', '/api/sessions/:sid', (c) => {
    if (!run('DELETE FROM sessions WHERE id=? AND user_id=?', c.p.sid, c.uid).changes) fail(404, 'session not found');
    return { ok: true };
  });
  route('DELETE', '/api/account', async (c) => {
    if (!(await checkPassword(c.user, c.body.password))) fail(403, 'password is incorrect');
    tx(() => {
      for (const t of D.VAULT_TABLES) run(`DELETE FROM ${t} WHERE user_id=?`, c.uid);
      run('DELETE FROM users WHERE id=?', c.uid); // key_salt goes with it: crypto-shred
      audit(c.user, 'account.delete', `user:${c.uid}`, c.ip);
    });
    const outbox = path.join(dataDir, 'outbox');
    if (fs.existsSync(outbox)) for (const f of fs.readdirSync(outbox)) if (f.startsWith(`${c.uid}-`)) fs.rmSync(path.join(outbox, f), { force: true });
    D.forget(c.uid);
    c.headers['Set-Cookie'] = cookie('', 0);
    return { ok: true };
  });

  // tasks
  route('GET', '/api/tasks', (c) => {
    const q = c.query, f = {};
    if (q.status) f.status = q.status.split(',').filter(Boolean).map((s) => oneOf(s, STATUSES, 'status'));
    if (q.person) { f.person = Number(q.person); if (!Number.isSafeInteger(f.person)) fail(400, 'person must be an id'); }
    if (q.source_type) f.source_type = oneOf(q.source_type, ['meeting', 'email', 'manual'], 'source_type');
    if (q.due) f.due = oneOf(q.due, ['overdue', 'today', 'week', 'none'], 'due');
    if (q.direction) f.direction = oneOf(q.direction, DIRECTIONS, 'direction');
    if (q.tag) f.tag = q.tag.slice(0, 100);
    if (q.q) f.q = q.q.trim().slice(0, 200);
    return queryTasks(c.uid, f);
  });
  route('POST', '/api/tasks', (c) => {
    const f = taskFields(c.uid, c.body, false);
    delete f.status;
    if (c.body.source_id != null) f.source_id = srcRow(c.uid, Number(c.body.source_id)).id;
    return taskOut(taskRow(c.uid, createTask(c.uid, f, 'user', 'created')));
  });
  route('GET', '/api/tasks/:id', (c) => taskDetail(c.uid, id(c)));
  route('PATCH', '/api/tasks/:id', (c) => { taskRow(c.uid, id(c)); return updateTask(c.uid, id(c), taskFields(c.uid, c.body, true), 'user'); });
  route('POST', '/api/tasks/:id/notes', (c) => addNote(c.uid, id(c), c.body.body));
  route('POST', '/api/tasks/:id/duplicate', (c) => {
    const t = taskOut(taskRow(c.uid, id(c)));
    const r = taskRow(c.uid, id(c));
    const nid = createTask(c.uid, { title: t.title, body: t.body, direction: t.direction, due_at: t.due_at, priority: t.priority, tags: t.tags,
      people: t.stakeholders.map((p) => p.id), source_id: r.source_id, excerpt_id: r.excerpt_id }, 'user', `duplicated from #${t.id}`);
    return taskOut(taskRow(c.uid, nid));
  });
  route('DELETE', '/api/tasks/:id', (c) => {
    taskRow(c.uid, id(c));
    tx(() => { for (const t of ['task_people', 'notes', 'activity']) run(`DELETE FROM ${t} WHERE task_id=? AND user_id=?`, id(c), c.uid); run('DELETE FROM tasks WHERE id=? AND user_id=?', id(c), c.uid); });
    return { ok: true };
  });

  // suggestions
  route('GET', '/api/suggestions', (c) => all("SELECT * FROM suggestions WHERE user_id=? AND state='pending' AND (snooze_until IS NULL OR snooze_until <= ?) ORDER BY confidence DESC, id", c.uid, now()).map(suggestionOut));
  route('POST', '/api/suggestions/bulk-accept', (c) => {
    const th = settingsOf(c.uid).high_threshold;
    return tx(() => { // atomic; items that fail validation (e.g. no stakeholder) are skipped, not fatal
      let accepted = 0;
      for (const r of all("SELECT * FROM suggestions WHERE user_id=? AND state='pending' AND confidence >= ? AND (snooze_until IS NULL OR snooze_until <= ?)", c.uid, th, now())) {
        try { planAccept(c.uid, r, null); } catch (e) { if (e.status === 400) continue; throw e; }
        acceptSuggestion(c.uid, r.id, null); accepted++;
      }
      return { accepted };
    });
  });
  route('POST', '/api/suggestions/:id/accept', (c) => taskOut(taskRow(c.uid, acceptSuggestion(c.uid, id(c), c.body.edits))));
  route('POST', '/api/suggestions/:id/reject', (c) => {
    sugRow(c.uid, id(c));
    const reason = c.body.reason == null ? null : oneOf(c.body.reason, ['not_action', 'never_happened'], 'reason');
    run("UPDATE suggestions SET state='rejected', reason=? WHERE id=? AND user_id=?", reason, id(c), c.uid);
    return { ok: true };
  });
  route('POST', '/api/suggestions/:id/merge', (c) => {
    const s = sugRow(c.uid, id(c));
    const taskId = taskRow(c.uid, Number(c.body.task_id)).id;
    const p = payloadOf(s);
    const src = one('SELECT title FROM sources WHERE id=? AND user_id=?', s.source_id, c.uid);
    tx(() => {
      addNote(c.uid, taskId, `Merged from ${src ? src.title : 'source'}${p.speaker ? ` (${p.speaker})` : ''}: "${p.excerpt}"`);
      run("UPDATE suggestions SET state='merged', task_id=? WHERE id=?", taskId, s.id);
    });
    return taskOut(taskRow(c.uid, taskId));
  });
  route('POST', '/api/suggestions/:id/snooze', (c) => {
    sugRow(c.uid, id(c));
    const until = new Date(Date.now() + clamp(num(c.body.hours, 'hours'), 0.25, 24 * 30) * 3600e3).toISOString();
    run('UPDATE suggestions SET snooze_until=? WHERE id=? AND user_id=?', until, id(c), c.uid);
    return { ok: true, snooze_until: until };
  });

  // people
  const personRow = (uid, pid) => one('SELECT * FROM people WHERE id=? AND user_id=?', pid, uid) || fail(404, 'person not found');
  route('GET', '/api/people', (c) => peopleList(c.uid));
  route('GET', '/api/people/:id', (c) => {
    personRow(c.uid, id(c));
    const p = peopleList(c.uid).find((x) => x.id === id(c));
    const tasks = all('SELECT t.* FROM tasks t JOIN task_people tp ON tp.task_id=t.id AND tp.user_id=t.user_id WHERE tp.person_id=? AND t.user_id=? ORDER BY t.updated_at DESC', id(c), c.uid).map(taskOut);
    const sources = all('SELECT * FROM sources WHERE user_id=? AND deleted=0 ORDER BY started_at DESC', c.uid)
      .filter((s) => tasks.some((t) => t.source && t.source.id === s.id) || J(s.participants, []).some((x) => (x.email && p.emails.includes(x.email.toLowerCase())) || (x.name || '').toLowerCase() === p.display_name.toLowerCase()))
      .map((s) => ({ id: s.id, type: s.type, title: s.title, started_at: s.started_at }));
    return { ...p, tasks, sources };
  });
  route('PATCH', '/api/people/:id', (c) => {
    personRow(c.uid, id(c));
    const b = c.body;
    if (b.display_name !== undefined) run('UPDATE people SET display_name=? WHERE id=?', str(b.display_name, 'display_name', { min: 1, max: 200 }), id(c));
    if (b.emails !== undefined) {
      const emails = strList(b.emails, 'emails', 20).map((e) => e.toLowerCase());
      if (emails.some((e) => !isEmail(e))) fail(400, 'invalid email');
      run('UPDATE people SET emails=? WHERE id=?', JSON.stringify(emails), id(c));
    }
    if (b.org_name !== undefined) run('UPDATE people SET org_name=? WHERE id=?', b.org_name === null ? null : str(b.org_name, 'org_name', { max: 200 }), id(c));
    if (b.unverified !== undefined) run('UPDATE people SET unverified=? WHERE id=?', bool(b.unverified, 'unverified'), id(c));
    return peopleList(c.uid).find((x) => x.id === id(c));
  });
  route('POST', '/api/people/:id/link', (c) => {
    const from = personRow(c.uid, id(c));
    const to = personRow(c.uid, Number(c.body.target_id));
    if (from.id === to.id) fail(400, 'cannot link a person to itself');
    tx(() => {
      for (const tp of all('SELECT task_id FROM task_people WHERE person_id=? AND user_id=?', from.id, c.uid)) {
        run('INSERT OR IGNORE INTO task_people (user_id, task_id, person_id, role) VALUES (?,?,?,?)', c.uid, tp.task_id, to.id, 'counterparty');
      }
      run('DELETE FROM task_people WHERE person_id=? AND user_id=?', from.id, c.uid);
      run('UPDATE excerpts SET speaker_person_id=? WHERE speaker_person_id=? AND user_id=?', to.id, from.id, c.uid);
      const emails = [...new Set([...J(to.emails, []), ...J(from.emails, [])])];
      const aliases = [...new Set([...J(to.aliases, []), ...J(from.aliases, []), from.display_name])].filter((a) => a.toLowerCase() !== to.display_name.toLowerCase());
      run('UPDATE people SET emails=?, aliases=? WHERE id=?', JSON.stringify(emails), JSON.stringify(aliases), to.id);
      run('DELETE FROM people WHERE id=? AND user_id=?', from.id, c.uid);
    });
    return peopleList(c.uid).find((x) => x.id === to.id);
  });

  // sources
  route('GET', '/api/sources', (c) => all('SELECT * FROM sources WHERE user_id=? AND deleted=0 ORDER BY started_at DESC, id DESC', c.uid).map(sourceOut));
  route('GET', '/api/sources/:id', (c) => {
    const r = srcRow(c.uid, id(c));
    return { ...sourceOut(r), text: r.text_enc ? dec(c.uid, r.text_enc) : null,
      suggestions: all('SELECT * FROM suggestions WHERE source_id=? AND user_id=? ORDER BY confidence DESC', r.id, c.uid).map(suggestionOut),
      tasks: all('SELECT * FROM tasks WHERE source_id=? AND user_id=?', r.id, c.uid).map(taskOut) };
  });
  route('POST', '/api/sources', async (c) => {
    const b = c.body;
    const title = str(b.title, 'title', { min: 1, max: 300 });
    const text = str(b.text, 'text', { min: 1, max: 900000 });
    if (b.type !== undefined && b.type !== 'manual') fail(400, "type must be 'manual'");
    const participants = b.participants === undefined ? [] : (Array.isArray(b.participants) && b.participants.length <= 100 ? b.participants : fail(400, 'participants must be an array'))
      .map((p) => ({ name: str(p && p.name, 'participant name', { min: 1, max: 200 }), email: p.email && isEmail(p.email) ? p.email.toLowerCase() : null, role: 'attendee' }));
    const sid = Number(run('INSERT INTO sources (user_id, type, connector, title, started_at, participants, processing_status, text_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      c.uid, 'manual', null, title, now(), JSON.stringify(participants), 'pending', enc(c.uid, text), now()).lastInsertRowid);
    await processSource(c.uid, sid);
    return sourceOut(srcRow(c.uid, sid));
  });
  route('POST', '/api/sources/:id/reprocess', async (c) => {
    srcRow(c.uid, id(c));
    const hint = c.body.hint == null || c.body.hint === '' ? undefined : str(c.body.hint, 'hint', { max: 300 });
    await processSource(c.uid, id(c), hint);
    return sourceOut(srcRow(c.uid, id(c)));
  });
  route('DELETE', '/api/sources/:id', (c) => {
    const r = srcRow(c.uid, id(c));
    tx(() => {
      run("DELETE FROM suggestions WHERE source_id=? AND user_id=? AND state='pending'", r.id, c.uid);
      scrubSource(c.uid, r.id);
      run('UPDATE tasks SET source_id=NULL WHERE source_id=? AND user_id=?', r.id, c.uid); // tasks + their excerpts survive
      // Tombstone, not DELETE: the (user, type, external_id) row must stay so the next sync doesn't re-ingest it.
      run("UPDATE sources SET deleted=1, title='(deleted)', text_enc=NULL, participants='[]', notice=NULL, thread_id=NULL, last_error=NULL WHERE id=? AND user_id=?", r.id, c.uid);
      audit(c.user, 'source.delete', `source:${r.id}`, c.ip);
    });
    return { ok: true };
  });
  route('GET', '/api/sources/:id/raw', (c) => {
    const r = srcRow(c.uid, id(c));
    if (!r.text_enc) fail(404, r.raw_wiped ? 'raw text was deleted by your retention policy' : 'this source has no text');
    audit(c.user, 'source.download', `source:${r.id}`, c.ip);
    return raw(dec(c.uid, r.text_enc), { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="source-${r.id}.txt"` });
  });
  route('GET', '/api/sources/:id/recap', (c) => {
    const r = srcRow(c.uid, id(c));
    const tasks = all('SELECT * FROM tasks WHERE source_id=? AND user_id=? ORDER BY id', r.id, c.uid).map(taskOut);
    const who = J(r.participants, []).map((p) => p.name).join(', ');
    const dir = { i_owe: 'I owe', they_owe: 'they owe', unclear: 'owner unclear' };
    const md = [`# Recap: ${r.title}`, '', `${(r.started_at || '').slice(0, 10)}${who ? ` · ${who}` : ''}`, '', '## Action items', '',
      ...(tasks.length ? tasks.map((t) => `- [${CLOSED.includes(t.status) ? 'x' : ' '}] ${t.title} (${dir[t.direction]}${t.due_at ? `, due ${t.due_at}` : ''}${t.stakeholders.length ? `, with ${t.stakeholders.map((p) => p.display_name).join(', ')}` : ''})`) : ['_No accepted items._']), ''].join('\n');
    return raw(md, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="recap-${r.id}.md"` });
  });

  // connectors
  route('GET', '/api/connectors', (c) => Object.entries(connectors.TYPES).map(([type, t]) => {
    const r = one('SELECT * FROM connectors WHERE user_id=? AND type=?', c.uid, type);
    const setup = connectors.setupOf(type, redirectUri(c.req, type), lookup);
    const on = r && r.status !== 'disconnected';
    return { type, label: t.label, status: r ? r.status : 'disconnected', mode: on ? r.mode : null, configured: setup.configured, setup,
      scopes: r ? J(r.scopes, []) : [], last_sync_at: r ? r.last_sync_at : null, last_error: r ? r.last_error : null };
  }));
  route('POST', '/api/connectors/:type/connect', (c) => {
    const type = connType(c.p.type);
    const setup = connectors.setupOf(type, redirectUri(c.req, type), lookup);
    if (!setup.configured) fail(409, `${connectors.TYPES[type].label} is not configured on this server: set ${setup.env.join(' and ')}`);
    const state = crypto.randomBytes(24).toString('hex');
    run('UPDATE sessions SET oauth_state=? WHERE id=?', `${type}.${state}`, c.session.id);
    return { redirect: connectors.authUrl(type, state, redirectUri(c.req, type), lookup) };
  });
  route('GET', '/oauth/:type/callback', async (c) => {
    const a = authenticate(c.req);
    if (!a) return raw('', { Location: '/#/login' }, 302);
    Object.assign(c, { user: a.user, uid: a.user.id, session: a.session });
    const type = connType(c.p.type);
    const back = (err) => raw('', { Location: `/#/settings${err ? `?connector_error=${encodeURIComponent(err)}` : ''}` }, 302);
    const expected = c.session.oauth_state || '';
    const got = `${type}.${c.query.state || ''}`;
    run('UPDATE sessions SET oauth_state=NULL WHERE id=?', c.session.id);
    if (!expected || expected.length !== got.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return back('state mismatch, try connecting again');
    if (c.query.error || !c.query.code) return back(c.query.error || 'no authorization code');
    try {
      const tok = await connectors.exchange(type, { code: c.query.code, redirect_uri: redirectUri(c.req, type) }, lookup);
      run(`INSERT INTO connectors (user_id, type, status, mode, scopes, tokens_enc) VALUES (?,?,'connected','oauth',?,?)
        ON CONFLICT(user_id, type) DO UPDATE SET status='connected', mode='oauth', scopes=excluded.scopes, tokens_enc=excluded.tokens_enc, last_error=NULL, last_sync_at=NULL, data_enc=NULL`, // fresh account: full lookback, no demo cache
      c.uid, type, JSON.stringify(String(tok.scope).split(/[\s,]+/).filter(Boolean)), enc(c.uid, JSON.stringify(tok)));
      audit(c.user, 'connector.connect', type, c.ip);
      runSync(c.uid, type).catch(() => {});
      return back();
    } catch (e) { return back(e.message); }
  }, { auth: false });
  route('POST', '/api/connectors/:type/sync', async (c) => {
    const type = connType(c.p.type);
    const r = one('SELECT status FROM connectors WHERE user_id=? AND type=?', c.uid, type);
    if (!r || r.status === 'disconnected') fail(409, 'connector is not connected');
    const out = await runSync(c.uid, type);
    return { ingested: out.ingested, error: out.error || null, status: one('SELECT status FROM connectors WHERE user_id=? AND type=?', c.uid, type).status };
  });
  route('DELETE', '/api/connectors/:type', (c) => {
    const type = connType(c.p.type);
    // ponytail: tokens are wiped locally; provider-side token revocation not called yet
    run("UPDATE connectors SET status='disconnected', tokens_enc=NULL, data_enc=NULL, scopes='[]', last_error=NULL WHERE user_id=? AND type=?", c.uid, type);
    audit(c.user, 'connector.revoke', type, c.ip);
    return { status: 'disconnected' };
  });

  // sample data: fixtures, only on request, never mixed into a real account
  const SAMPLE_TYPES = ['gcal', 'zoom', 'gmail']; // calendar first so meetings get attendees
  const DEMO_IDS = new Set(['zoom.json', 'mail.json', 'calendar.json']
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')).map((x) => String(x.external_id))));
  route('POST', '/api/sample-data', async (c) => {
    const types = c.body.types === undefined ? [...SAMPLE_TYPES] : strList(c.body.types, 'types', 5).map(connType);
    types.sort((x, y) => (connectors.TYPES[y].kind === 'calendar') - (connectors.TYPES[x].kind === 'calendar'));
    for (const type of types) {
      const r = one('SELECT status, mode FROM connectors WHERE user_id=? AND type=?', c.uid, type);
      if (r && r.status !== 'disconnected' && r.mode === 'oauth') fail(409, `${connectors.TYPES[type].label} is connected to a real account. Disconnect it before loading sample data.`);
    }
    for (const type of types) {
      run(`INSERT INTO connectors (user_id, type, status, mode, scopes) VALUES (?,?,'connected','demo',?)
        ON CONFLICT(user_id, type) DO UPDATE SET status='connected', mode='demo', scopes=excluded.scopes, last_error=NULL, tokens_enc=NULL`,
      c.uid, type, JSON.stringify(connectors.TYPES[type].scopes));
    }
    audit(c.user, 'sample_data.load', types.join(','), c.ip);
    for (const type of types) await runSync(c.uid, type);
    return { loaded: types };
  });
  route('DELETE', '/api/sample-data', (c) => {
    const types = all("SELECT type FROM connectors WHERE user_id=? AND mode='demo'", c.uid).map((r) => r.type);
    tx(() => {
      run("UPDATE connectors SET status='disconnected', data_enc=NULL, scopes='[]', last_error=NULL, last_sync_at=NULL WHERE user_id=? AND mode='demo'", c.uid);
      for (const s of all("SELECT id, external_id FROM sources WHERE user_id=? AND mode='demo'", c.uid).filter((r) => DEMO_IDS.has(r.external_id))) { // fixtures only
        run("DELETE FROM suggestions WHERE source_id=? AND user_id=? AND state='pending'", s.id, c.uid);
        scrubSource(c.uid, s.id);
        run('UPDATE tasks SET source_id=NULL WHERE source_id=? AND user_id=?', s.id, c.uid); // accepted tasks stay
        run('DELETE FROM sources WHERE id=? AND user_id=?', s.id, c.uid); // fixtures: hard delete so they can be reloaded
      }
    });
    audit(c.user, 'sample_data.remove', types.join(','), c.ip);
    return { removed: types };
  });

  // assistant
  route('POST', '/api/assistant', async (c) => {
    const message = str(c.body.message, 'message', { min: 1, max: 4000 });
    const thId = c.body.thread_id != null ? threadRow(c.uid, c.body.thread_id).id
      : Number(run('INSERT INTO chat_threads (user_id, messages, proposals, created_at, updated_at) VALUES (?,?,?,?,?)', c.uid, encJ(c.uid, []), encJ(c.uid, []), now(), now()).lastInsertRowid);
    const history = decJ(c.uid, threadRow(c.uid, thId).messages, []);
    const out = await engine.assistant({ message, history: history.map((m) => ({ role: m.role, content: m.content })), now: now(),
      user: { name: c.user.name, email: c.user.email }, tz: settingsOf(c.uid).timezone, ai: !!settingsOf(c.uid).external_ai, tools: assistantTools(c.uid) });
    const proposals = (out.proposals || []).filter((p) => p && PROPOSAL_ACTIONS.includes(p.action)).map((p) => ({
      id: crypto.randomBytes(6).toString('hex'), action: p.action, task_id: p.task_id == null ? null : Number(p.task_id),
      args: p.args && typeof p.args === 'object' ? p.args : {}, label: String(p.label || p.action).slice(0, 300), applied: false }));
    const citations = Array.isArray(out.citations) ? out.citations : [];
    const reply = String(out.reply || '');
    tx(() => { // re-read so a concurrent turn on the same thread is not overwritten
      const th = threadRow(c.uid, thId);
      const messages = [...decJ(c.uid, th.messages, []), { role: 'user', content: message, at: now() },
        { role: 'assistant', content: reply, citations, proposals: proposals.map((p) => p.id), at: now() }];
      run('UPDATE chat_threads SET messages=?, proposals=?, updated_at=? WHERE id=?', encJ(c.uid, messages), encJ(c.uid, [...decJ(c.uid, th.proposals, []), ...proposals]), now(), thId);
    });
    return { thread_id: thId, reply, citations, proposals: proposals.map(({ applied, ...p }) => p) };
  });
  route('POST', '/api/assistant/confirm', (c) => tx(() => {
    const th = threadRow(c.uid, c.body.thread_id);
    const proposals = decJ(c.uid, th.proposals, []);
    const p = proposals.find((x) => x.id === c.body.proposal_id) || fail(404, 'proposal not found');
    if (p.applied) fail(409, 'proposal already applied');
    const a = p.args || {};
    let taskId = p.task_id;
    if (p.action === 'create_task') {
      const f = taskFields(c.uid, { title: a.title, due_at: a.due_at ?? null, stakeholders: (Array.isArray(a.stakeholders) ? a.stakeholders : []).map((n) => (typeof n === 'string' ? { name: n } : n)) }, false);
      taskId = createTask(c.uid, f, 'assistant (confirmed)', 'created');
    } else {
      taskRow(c.uid, taskId);
      if (p.action === 'set_status') updateTask(c.uid, taskId, { status: oneOf(a.status, STATUSES, 'status') }, 'assistant (confirmed)');
      else if (p.action === 'set_due') updateTask(c.uid, taskId, { due_at: dateOrNull(a.due_at ?? null) }, 'assistant (confirmed)');
      else addNote(c.uid, taskId, a.body, 'assistant (confirmed)');
    }
    p.applied = true;
    run('UPDATE chat_threads SET proposals=?, updated_at=? WHERE id=?', encJ(c.uid, proposals), now(), th.id);
    return { ok: true, task: taskOut(taskRow(c.uid, taskId)) };
  }));
  route('GET', '/api/assistant/threads/:id', (c) => {
    const th = threadRow(c.uid, id(c));
    return { id: th.id, messages: decJ(c.uid, th.messages, []), proposals: decJ(c.uid, th.proposals, []), created_at: th.created_at, updated_at: th.updated_at };
  });

  // settings / notifications / digest
  route('GET', '/api/settings', (c) => settingsOut(c.user));
  route('PATCH', '/api/settings', (c) => {
    patchSettings(c.uid, c.body);
    if (typeof c.body.external_ai === 'boolean') audit(c.user, 'settings.external_ai', String(c.body.external_ai), c.ip);
    return settingsOut(c.user);
  });
  route('GET', '/api/notifications', (c) => all('SELECT id, kind, text, link, created_at, read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', c.uid)
    .map((n) => ({ ...n, read: !!n.read })));
  route('POST', '/api/notifications/read', (c) => {
    if (Array.isArray(c.body.ids)) for (const n of c.body.ids) run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', Number(n), c.uid);
    else run('UPDATE notifications SET read=1 WHERE user_id=?', c.uid);
    return { ok: true };
  });
  route('GET', '/api/digest', (c) => digest(c.uid));

  // export / audit
  route('GET', '/api/export/tasks.csv', (c) => {
    rateLimit(`export:${c.ip}`, LIMITS.export, 3600e3);
    const tasks = queryTasks(c.uid, { status: STATUSES });
    const notes = all('SELECT task_id, body, created_at FROM notes WHERE user_id=? ORDER BY id', c.uid).map((n) => ({ ...n, body: dec(c.uid, n.body) }));
    const cols = ['id', 'title', 'status', 'direction', 'due_at', 'priority', 'tags', 'stakeholders', 'source_type', 'source_title', 'excerpt', 'notes', 'created_at', 'updated_at'];
    const rows = tasks.map((t) => [t.id, t.title, t.status, t.direction, t.due_at, t.priority, t.tags.join('; '), t.stakeholders.map((p) => p.display_name).join('; '),
      t.source && t.source.type, t.source && t.source.title, t.excerpt && t.excerpt.text,
      notes.filter((n) => n.task_id === t.id).map((n) => `[${n.created_at}] ${n.body}`).join(' | '), t.created_at, t.updated_at]);
    audit(c.user, 'export.csv', `tasks:${tasks.length}`, c.ip);
    return raw('﻿' + [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n',
      { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="aria-tasks.csv"' });
  });
  route('GET', '/api/export/all.json', (c) => {
    rateLimit(`export:${c.ip}`, LIMITS.export, 3600e3);
    const u = c.uid;
    const bundle = { exported_at: now(), user: userOut(c.user), settings: settingsOut(c.user), people: peopleList(u),
      tasks: all('SELECT id FROM tasks WHERE user_id=? ORDER BY id', u).map((t) => taskDetail(u, t.id)),
      sources: all('SELECT * FROM sources WHERE user_id=? AND deleted=0 ORDER BY id', u).map((r) => ({ ...sourceOut(r), text: r.text_enc ? dec(u, r.text_enc) : null })),
      suggestions: all('SELECT * FROM suggestions WHERE user_id=? ORDER BY id', u).map(suggestionOut),
      notifications: all('SELECT kind, text, created_at FROM notifications WHERE user_id=? ORDER BY id', u).map((x) => ({ ...x })),
      assistant_threads: all('SELECT id, messages, created_at FROM chat_threads WHERE user_id=? ORDER BY id', u).map((t) => ({ id: t.id, messages: decJ(u, t.messages, []), created_at: t.created_at })) };
    audit(c.user, 'export.json', `user:${u}`, c.ip);
    return raw(JSON.stringify(bundle, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="aria-export.json"' });
  });
  route('GET', '/api/audit', (c) => all('SELECT action, object, at, ip FROM audit_events WHERE user_id=? ORDER BY id DESC LIMIT 500', c.uid).map((x) => ({ ...x })));

  // admin: metadata only — never titles, notes, excerpts or source text
  const requireAdmin = (c) => { if (c.user.role !== 'admin') fail(403, 'admin only'); };
  // Provider setup: admins, or, when no admins are configured, the local operator (request from this machine).
  const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;
  const canSetup = (c) => c.user.role === 'admin' || (!ADMINS.size && LOOPBACK.test(c.ip || ''));
  const requireSetup = (c) => { if (!canSetup(c)) fail(403, 'admin only'); };
  // Provider OAuth apps: an admin pastes the client ID/secret once (encrypted with the server key); every user then connects in one click.
  const PROVIDER_TYPE = { google: 'gmail', ms: 'outlook', zoom: 'zoom' };
  const provType = (p) => PROVIDER_TYPE[p] || fail(404, 'unknown provider');
  route('GET', '/api/admin/providers', (c) => {
    requireSetup(c);
    return Object.entries(PROVIDER_TYPE).map(([provider, type]) => {
      const s = connectors.setupOf(type, redirectUri(c.req, type), lookup);
      return { provider, label: s.provider_label, configured: s.configured, source: s.source, redirect_uris: s.redirect_uris, console_url: s.console_url, steps: s.steps, env: s.env };
    });
  });
  route('PUT', '/api/admin/providers/:type', (c) => {
    requireSetup(c); provType(c.p.type);
    const id = str(c.body.client_id, 'client_id', { min: 4, max: 300 }).trim(), secret = str(c.body.client_secret, 'client_secret', { min: 4, max: 300 }).trim();
    run('INSERT INTO app_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', c.p.type, enc(0, JSON.stringify({ id, secret })));
    audit(c.user, 'admin.provider_set', c.p.type, c.ip);
    return { ok: true };
  });
  route('DELETE', '/api/admin/providers/:type', (c) => {
    requireSetup(c); provType(c.p.type);
    run('DELETE FROM app_config WHERE k=?', c.p.type);
    audit(c.user, 'admin.provider_remove', c.p.type, c.ip);
    return { ok: true };
  });
  route('GET', '/api/admin/seats', (c) => {
    requireAdmin(c);
    audit(c.user, 'admin.seats', `org:${c.user.org_id}`, c.ip);
    return all('SELECT id, email, name FROM users WHERE org_id=? ORDER BY email', c.user.org_id).map((u) => ({ email: u.email, name: u.name,
      connectors: all('SELECT type, status, last_sync_at, last_error FROM connectors WHERE user_id=?', u.id).map((x) => ({ ...x })),
      task_count: one('SELECT COUNT(*) n FROM tasks WHERE user_id=?', u.id).n }));
  });
  route('GET', '/api/admin/audit', (c) => {
    requireAdmin(c);
    audit(c.user, 'admin.audit', `org:${c.user.org_id}`, c.ip);
    return all("SELECT actor, action, object, at, ip FROM audit_events WHERE org_id=? AND action LIKE 'admin.%' ORDER BY id DESC LIMIT 500", c.user.org_id).map((x) => ({ ...x }));
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  }
  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const ch of req) {
      n += ch.length;
      if (n > 1 << 20) fail(413, 'request body too large (1MB max)');
      chunks.push(ch);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  function serveStatic(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    let rel;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.includes('\0')) return send(res, 400, { error: 'bad path' });
    let file = path.resolve(publicDir, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const body = fs.readFileSync(file);
      return send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch { return send(res, 404, 'not found', { 'Content-Type': 'text/plain' }); }
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/') && !p.startsWith('/oauth/')) return serveStatic(req, res, p);
    const c = { req, res, url, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress || '', headers: {}, body: {} };
    try {
      let found, params;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p);
        if (m) { found = r; params = m.groups || {}; break; }
      }
      if (!found) fail(404, 'not found');
      c.p = params;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // CSRF: cookie is SameSite=Lax, cross-origin Origin refused, and any body must be JSON (HTML forms cannot send that)
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) fail(403, 'cross-origin request refused');
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct && ct !== 'application/json') fail(415, 'Content-Type must be application/json');
        const text = await readBody(req);
        if (text.trim()) {
          if (ct !== 'application/json') fail(415, 'Content-Type must be application/json');
          try { c.body = JSON.parse(text); } catch { fail(400, 'invalid JSON'); }
          if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) fail(400, 'body must be a JSON object');
        }
      }
      if (found.auth) {
        const a = authenticate(req);
        if (!a) fail(401, 'not signed in');
        c.user = a.user; c.uid = a.user.id; c.session = a.session;
        c.headers['Set-Cookie'] = cookie(a.token, IDLE_MS / 1000); // sliding idle window, matches last_seen_at bump
      }
      const out = await found.fn(c);
      if (out && out[RAW]) return send(res, out.status, out.body, { ...c.headers, ...out.headers });
      send(res, 200, out === undefined ? { ok: true } : out, c.headers);
    } catch (e) {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' }, e.status === 413 ? { Connection: 'close' } : {});
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.end(); } catch {} }); });
  const timers = [];
  try { retentionSweep(); } catch (e) { console.error('retention sweep failed', e); }
  if (background) {
    timers.push(setInterval(() => {
      for (const r of all("SELECT user_id, type FROM connectors WHERE status!='disconnected'")) runSync(r.user_id, r.type).catch((e) => console.error('sync', e.message));
      pruneHits();
      try { digestTick(); } catch (e) { console.error('digest', e); }
    }, 60e3));
    timers.push(setInterval(() => { try { retentionSweep(); } catch (e) { console.error('retention', e); } }, 3600e3));
    timers.forEach((t) => t.unref());
  }
  server.on('close', () => { timers.forEach(clearInterval); D.close(); });
  server.aria = { runSync, retentionSweep, digestTick, db: D }; // test hooks
  return server;
}

module.exports = { createServer, csvCell };

if (require.main === module) {
  const port = Number(process.env.PORT) || 4180;
  createServer().listen(port, () => console.log(`Aria listening on http://localhost:${port}`));
}
