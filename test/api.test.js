'use strict';
// PRD §20 acceptance, end to end over HTTP. Real engine (rules mode unless ANTHROPIC_API_KEY is set).
// Every test creates its own users, so a failure never cascades into later tests.
process.env.ARIA_NO_BACKGROUND = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HAS_ENGINE = fs.existsSync(path.join(__dirname, '..', 'engine.js'));
const { createServer, csvCell } = require('../server');
const needsEngine = { skip: !HAS_ENGINE && 'engine.js missing' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
async function start(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-test-'));
  const server = createServer({ dataDir, rateLimits: { auth: 10000, export: 10000 }, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const s = { server, dataDir, base: `http://127.0.0.1:${server.address().port}` };
  servers.push(s);
  return s;
}
let main;
before(async () => { main = await start(HAS_ENGINE ? {} : { engine: stubEngine() }); });
after(async () => {
  for (const s of servers) {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
    fs.rmSync(s.dataDir, { recursive: true, force: true });
  }
});

function stubEngine() { // only used when engine.js is absent
  return {
    async extract(input) {
      const i = input.text.search(/I'll|please|can you/i);
      if (i < 0) return { mode: 'rules', candidates: [] };
      const end = input.text.indexOf('\n', i);
      const excerpt = input.text.slice(i, end < 0 ? undefined : end);
      const others = input.participants.filter((p) => p.email !== input.user.email);
      return { mode: 'rules', candidates: [{ title: excerpt.slice(0, 60), owner: 'user', direction: 'i_owe', due: null, excerpt, offset: i, speaker: null,
        confidence: 0.9, rationale: 'stub', stakeholders: others.slice(0, 1).map((p) => ({ name: p.name, email: p.email, unverified: false })) }] };
    },
    resolveStakeholder: (name) => ({ name, email: null, unverified: true }),
    async assistant({ tools }) { const t = await tools.listTasks({}); return { reply: `${t.length} open`, citations: [], proposals: [] }; },
  };
}

function client(srv = main) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.base + url, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { call, get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${r.text}`); return r.json; };
let seq = 0;
async function newUser({ domain, name = 'Alice Moreau', srv = main, email: fixed } = {}) {
  const n = ++seq;
  const c = client(srv);
  const email = fixed || `user${n}@${domain || `org${n}.test`}`;
  const password = `password-${n}`;
  c.user = ok(await c.post('/api/auth/signup', { email, password, name })).user;
  c.password = password;
  return c;
}
async function seedDemo(c, types = ['zoom', 'gmail']) {
  ok(await c.post('/api/sample-data', { types }));
  for (const t of types) ok(await c.post(`/api/connectors/${t}/sync`));
  return { sources: ok(await c.get('/api/sources')), sugs: ok(await c.get('/api/suggestions')) };
}
const ALL = '/api/tasks?status=open,in_progress,waiting,completed,cancelled';

test('signup / login / me / sessions / cookie refresh / oauth callback without session', async () => {
  const a = client();
  assert.equal((await a.get('/api/me')).status, 401);
  assert.deepEqual(ok(await a.get('/api/healthz')), { ok: true }, 'health check is public');
  assert.equal((await a.post('/api/auth/signup', { email: 'alice@acme.test', password: 'short', name: 'Alice' })).status, 400);
  const s = ok(await a.post('/api/auth/signup', { email: 'Alice@acme.test', password: 'correct horse', name: 'Alice Moreau' }));
  assert.equal(s.user.email, 'alice@acme.test');
  assert.equal(s.user.role, 'member', 'first signup of a domain must NOT become admin (squatting)');
  assert.equal((await a.post('/api/auth/signup', { email: 'alice@acme.test', password: 'correct horse', name: 'x' })).status, 409);
  assert.equal((await a.post('/api/auth/login', { email: 'alice@acme.test', password: 'wrong pass' })).status, 401);
  ok(await a.post('/api/auth/login', { email: 'alice@acme.test', password: 'correct horse' }));
  const meRes = await a.get('/api/me');
  const me = ok(meRes);
  assert.match(meRes.headers.get('set-cookie'), /aria_sid=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200/, 'idle window slides on activity');
  assert.deepEqual(Object.keys(me.counts).sort(), ['open', 'overdue', 'suggested', 'waiting']);
  assert.equal(me.demo, false, 'no sample data until asked for');
  const sessions = ok(await a.get('/api/sessions'));
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((x) => x.current).length, 1);
  ok(await a.del(`/api/sessions/${sessions.find((x) => !x.current).id}`));
  assert.equal(ok(await a.get('/api/sessions')).length, 1);
  assert.equal(ok(await (await newUser({ domain: 'acme.test' })).get('/api/me')).user.role, 'member');

  const cb = await client().get('/oauth/gmail/callback?code=x&state=y');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/#/login');
  const cb2 = await a.get('/oauth/gmail/callback?code=x&state=forged');
  assert.equal(cb2.status, 302);
  assert.match(cb2.headers.get('location'), /connector_error=state/);
  ok(await a.post('/api/auth/logout'));
  assert.equal((await a.get('/api/me')).status, 401);
});

test('security: CSRF content-type, cross-origin, path traversal, headers, body limit', async () => {
  const a = await newUser();
  const form = await fetch(main.base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(form.status, 415);
  assert.equal((await a.call('POST', '/api/tasks', { title: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/server.js', '/..%5c..%5cserver.js']) assert.equal((await fetch(main.base + p)).status, 404, p);
  const root = await fetch(main.base + '/');
  assert.match(root.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await a.post('/api/sources', { title: 't', text: 'x'.repeat(1.1 * 1024 * 1024) })).status, 413);
});

test('connect zoom + gmail (demo) → suggestions with verbatim excerpts and stakeholders', needsEngine, async () => {
  const a = await newUser();
  const cons = ok(await a.get('/api/connectors'));
  assert.deepEqual(cons.map((c) => c.type), ['zoom', 'gmail', 'outlook', 'gcal', 'mscal']);
  assert.ok(cons.every((c) => c.status === 'disconnected' && c.mode === null), 'no connector is demo until sample data is asked for');
  ok(await a.patch('/api/settings', { bot_auto_invite: true }));
  const { sources, sugs } = await seedDemo(a);
  const titles = sources.map((s) => s.title);
  assert.equal(titles.filter((t) => t === 'Northwind weekly').length, 1, 'ingest is idempotent');
  assert.ok(!titles.includes('Your weekly fintech digest'), 'newsletter skipped');
  assert.equal(sources.find((s) => s.title === 'Treasury sync').processing_status, 'no_transcript');
  const northwind = sources.find((s) => s.title === 'Northwind weekly');
  assert.equal(northwind.processing_status, 'done');
  assert.match(northwind.notice, /Aria notetaker joined at Alice Moreau's invitation/);

  const detail = ok(await a.get(`/api/sources/${northwind.id}`));
  assert.match(detail.text, /Alice Moreau: Understood/, 'placeholders replaced with the signed-in user');
  assert.ok(sugs.length >= 3);
  for (let i = 1; i < sugs.length; i++) assert.ok(sugs[i - 1].confidence >= sugs[i].confidence, 'sorted by confidence desc');
  const meeting = sugs.filter((s) => s.source.id === northwind.id);
  for (const s of meeting) assert.equal(detail.text.slice(s.payload.offset, s.payload.offset + s.payload.excerpt.length), s.payload.excerpt, 'verbatim excerpt');
  const ananya = meeting.find((s) => s.payload.stakeholders.some((p) => p.name === 'Ananya Shah'));
  assert.ok(ananya && ananya.payload.stakeholders.find((p) => p.name === 'Ananya Shah').person_id, 'attendee stakeholder resolved');
  assert.ok(!meeting.some((s) => s.payload.stakeholders.some((p) => p.name === 'Alice Moreau')), 'user is never a stakeholder');
  const mail = sugs.find((s) => s.source.title === 'SAR policy for the Northwind file');
  assert.ok(mail && mail.payload.stakeholders.some((p) => p.email === 'kavita.rao@example-bank.com'), 'email attributed to sender');
  assert.ok(ok(await a.get('/api/notifications')).some((n) => /suggested actions? from Northwind weekly/.test(n.text)));
  assert.ok(ok(await a.get('/api/me')).counts.suggested >= 3);
});

test('accept / edit / reject / merge / snooze; stakeholder required; rejected never becomes a task', needsEngine, async () => {
  const a = await newUser();
  const { sugs } = await seedDemo(a);
  const ananya = sugs.find((s) => s.payload.stakeholders.some((p) => p.name === 'Ananya Shah'));
  const mail = sugs.find((s) => s.source.type === 'email');

  const noOne = await a.post(`/api/suggestions/${ananya.id}/accept`, { edits: { stakeholders: [] } });
  assert.equal(noOne.status, 400);
  assert.equal(noOne.json.error, 'At least one stakeholder is required');
  const t1 = ok(await a.post(`/api/suggestions/${ananya.id}/accept`));
  assert.equal(t1.status, 'open');
  assert.equal(t1.source.title, 'Northwind weekly');
  assert.equal(t1.excerpt.text, ananya.payload.excerpt);
  assert.ok(t1.stakeholders.some((p) => p.display_name === 'Ananya Shah'));
  assert.equal((await a.post(`/api/suggestions/${ananya.id}/accept`)).status, 409, 'no double accept');
  assert.equal(ok(await a.get(`/api/tasks/${t1.id}`)).activity[0].verb, 'created from suggestion');

  const t2 = ok(await a.post(`/api/suggestions/${mail.id}/accept`, { edits: { title: 'Attach SAR policy to Northwind credit file', due_at: '2026-10-02', stakeholders: [{ name: 'Kavita Rao' }] } }));
  assert.equal(t2.title, 'Attach SAR policy to Northwind credit file');
  assert.equal(t2.due_at, '2026-10-02');

  const [rej, mrg, snz] = sugs.filter((s) => s.id !== ananya.id && s.id !== mail.id);
  ok(await a.post(`/api/suggestions/${rej.id}/reject`, { reason: 'not_action' }));
  const merged = ok(await a.post(`/api/suggestions/${mrg.id}/merge`, { task_id: t1.id }));
  assert.equal(merged.notes_count, 1);
  assert.ok(merged.last_note.includes(mrg.payload.excerpt));
  ok(await a.post(`/api/suggestions/${snz.id}/snooze`, { hours: 2 }));
  const pending = ok(await a.get('/api/suggestions'));
  assert.ok(!pending.some((s) => [rej.id, mrg.id, ananya.id, snz.id].includes(s.id)), 'decided and snoozed hidden');

  ok(await a.post(`/api/sources/${rej.source.id}/reprocess`, {}));
  assert.ok(!ok(await a.get('/api/suggestions')).some((s) => s.payload.title === rej.payload.title), 'rejected not re-suggested');
  assert.ok(!ok(await a.get(ALL)).some((t) => t.title === rej.payload.title), 'rejected never a task');
});

test('bulk accept is atomic, only >= high_threshold, skips items without a stakeholder', needsEngine, async () => {
  const a = await newUser();
  const { sugs } = await seedDemo(a);
  const { one, run, enc } = main.server.aria.db;
  const src = sugs[0].source.id;
  const bad = { title: 'Orphan action with nobody attached', owner: 'user', direction: 'i_owe', stakeholders: [], due: null, excerpt: 'x', offset: 0, speaker: null, confidence: 0.99, rationale: '' };
  const badId = Number(run('INSERT INTO suggestions (user_id, source_id, payload, confidence, state, created_at) VALUES (?,?,?,?,?,?)',
    a.user.id, src, enc(a.user.id, JSON.stringify(bad)), 0.99, 'pending', new Date().toISOString()).lastInsertRowid);
  const high = sugs.filter((s) => s.confidence >= 0.85).length;
  assert.equal(ok(await a.post('/api/suggestions/bulk-accept')).accepted, high);
  assert.equal(one('SELECT state FROM suggestions WHERE id=?', badId).state, 'pending', 'skipped, not aborted');
  assert.ok(ok(await a.get('/api/suggestions')).every((s) => s.confidence < 0.85 || s.id === badId));
});

test('tasks: create, filters, note, status change with activity, duplicate, delete', async () => {
  const a = await newUser();
  const manual = ok(await a.post('/api/tasks', { title: 'Call Raj about limits', direction: 'i_owe', due_at: '2020-01-01', tags: ['kestrel'], stakeholders: [{ name: 'Raj Patel' }] }));
  assert.equal(manual.source, null);
  assert.equal((await a.post('/api/tasks', { title: '' })).status, 400);
  assert.equal((await a.post('/api/tasks', { title: 'x', due_at: '2026-02-30' })).status, 400);
  const note = ok(await a.post(`/api/tasks/${manual.id}/notes`, { body: 'Left a voicemail' }));
  assert.ok(note.id && note.created_at);
  assert.equal(ok(await a.patch(`/api/tasks/${manual.id}`, { status: 'waiting', priority: 'high' })).status, 'waiting');
  const d = ok(await a.get(`/api/tasks/${manual.id}`));
  assert.equal(d.notes[0].body, 'Left a voicemail');
  assert.ok(d.activity.some((x) => x.verb === 'status' && x.from_value === 'open' && x.to_value === 'waiting'));
  assert.ok(d.activity.some((x) => x.verb === 'priority' && x.to_value === 'high'));
  assert.ok(!d.activity.some((x) => (x.to_value || '').includes('voicemail')), 'note text not copied into activity');

  const ids = async (q) => ok(await a.get(`/api/tasks?${q}`)).map((t) => t.id);
  assert.deepEqual(await ids('status=waiting'), [manual.id]);
  assert.deepEqual(await ids('source_type=manual&status=waiting'), [manual.id]);
  assert.deepEqual(await ids('due=overdue'), [manual.id]);
  assert.deepEqual(await ids('q=voicemail'), [manual.id], 'q searches notes');
  assert.deepEqual(await ids('q=raj'), [manual.id], 'q searches stakeholder names');
  assert.deepEqual(await ids('tag=kestrel'), [manual.id]);
  assert.equal((await a.get('/api/tasks?status=bogus')).status, 400);

  ok(await a.patch(`/api/tasks/${manual.id}`, { status: 'completed' }));
  assert.ok(!(await ids('')).includes(manual.id), 'default hides completed');
  assert.ok((await ids('status=completed')).includes(manual.id));
  const dup = ok(await a.post(`/api/tasks/${manual.id}/duplicate`));
  assert.equal(dup.title, manual.title);
  assert.equal(dup.status, 'open');
  ok(await a.del(`/api/tasks/${dup.id}`));
  assert.equal((await a.get(`/api/tasks/${dup.id}`)).status, 404);
});

test('filters on stakeholder and source type over captured tasks', needsEngine, async () => {
  const a = await newUser();
  const { sugs } = await seedDemo(a);
  const mail = sugs.find((s) => s.source.type === 'email');
  const meet = sugs.find((s) => s.source.type === 'meeting');
  ok(await a.post(`/api/suggestions/${mail.id}/accept`));
  ok(await a.post(`/api/suggestions/${meet.id}/accept`));
  const kavita = ok(await a.get('/api/people')).find((p) => p.display_name === 'Kavita Rao');
  const email = ok(await a.get('/api/tasks?source_type=email'));
  assert.equal(email.length, 1);
  assert.equal(email[0].source.type, 'email');
  assert.ok(ok(await a.get('/api/tasks?source_type=meeting')).every((t) => t.source.type === 'meeting'));
  const byKavita = ok(await a.get(`/api/tasks?person=${kavita.id}`));
  assert.ok(byKavita.length === 1 && byKavita[0].stakeholders.some((p) => p.id === kavita.id));
  const person = ok(await a.get(`/api/people/${kavita.id}`));
  assert.equal(person.open, 1);
  assert.ok(person.tasks.length === 1 && person.sources.length >= 1);
});

test('manual source (paste) + recap + raw download', async () => {
  const a = await newUser();
  const src = ok(await a.post('/api/sources', { title: 'Hallway chat', type: 'manual', participants: [{ name: 'Meera Iyer', email: 'meera.iyer@example-bank.com' }],
    text: 'Meera Iyer: Can you send me the liquidity report by Friday?\nAlice Moreau: Sure, I will send the liquidity report by Friday.' }));
  assert.equal(src.type, 'manual');
  assert.ok(['done', 'failed'].includes(src.processing_status));
  const raw = await a.get(`/api/sources/${src.id}/raw`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-disposition'), /attachment/);
  assert.match(raw.text, /liquidity report/);
  const recap = await a.get(`/api/sources/${src.id}/recap`);
  assert.match(recap.text, /^# Recap: Hallway chat/);
});

test('deleted source never comes back: resync and reconnect do not re-ingest or re-suggest', needsEngine, async () => {
  const a = await newUser();
  const { sources, sugs } = await seedDemo(a, ['zoom']);
  const nw = sources.find((s) => s.title === 'Northwind weekly');
  const acc = sugs.find((s) => s.source.id === nw.id);
  const task = ok(await a.post(`/api/suggestions/${acc.id}/accept`));
  const before = ok(await a.get('/api/sources')).length;

  ok(await a.del(`/api/sources/${nw.id}`));
  assert.equal((await a.get(`/api/sources/${nw.id}`)).status, 404);
  const t = ok(await a.get(`/api/tasks/${task.id}`));
  assert.equal(t.source, null, 'task survives source deletion');
  assert.equal(t.excerpt.text, acc.payload.excerpt, 'accepted task keeps its excerpt');
  assert.ok(!ok(await a.get('/api/suggestions')).some((s) => !s.source || s.source.id === nw.id), 'pending suggestions of the source gone');

  ok(await a.post('/api/connectors/zoom/sync'));
  ok(await a.del('/api/connectors/zoom'));
  ok(await a.post('/api/sample-data', { types: ['zoom'] }));
  ok(await a.post('/api/connectors/zoom/sync'));
  const after = ok(await a.get('/api/sources'));
  assert.equal(after.length, before - 1);
  assert.ok(!after.some((s) => s.title === 'Northwind weekly'), 'tombstone blocks re-ingest');
  assert.ok(!ok(await a.get('/api/suggestions')).some((s) => s.payload.title === acc.payload.title), 'accepted title not re-suggested');
  const { one } = main.server.aria.db;
  const row = one('SELECT deleted, text_enc, participants, title FROM sources WHERE id=?', nw.id);
  assert.deepEqual({ ...row }, { deleted: 1, text_enc: null, participants: '[]', title: '(deleted)' }, 'tombstone keeps no content');
  assert.equal(one('SELECT COUNT(*) n FROM excerpts WHERE source_id=? AND id != ?', nw.id, one('SELECT excerpt_id FROM tasks WHERE id=?', task.id).excerpt_id).n, 0, 'unreferenced excerpts deleted');
});

test('revoke zoom stops ingest; sync after revoke adds nothing', needsEngine, async () => {
  const a = await newUser();
  await seedDemo(a, ['zoom']);
  const before = ok(await a.get('/api/sources')).length;
  assert.equal(ok(await a.del('/api/connectors/zoom')).status, 'disconnected');
  const z = ok(await a.get('/api/connectors')).find((c) => c.type === 'zoom');
  assert.equal(z.status, 'disconnected');
  assert.deepEqual(z.scopes, []);
  assert.equal((await a.post('/api/connectors/zoom/sync')).status, 409);
  assert.equal((await main.server.aria.runSync(a.user.id, 'zoom')).ingested, 0, 'background sync is a no-op after revoke');
  assert.equal(ok(await a.get('/api/sources')).length, before);
});

test('revoke mid-sync stops ingest before the next item (ACC-4); extract receives user tz', needsEngine, async () => {
  const real = require('../engine');
  const inputs = [];
  const slow = await start({ engine: { ...real, extract: async (input, opts) => { inputs.push(input); await sleep(150); return real.extract(input, opts); } } });
  const a = await newUser({ srv: slow });
  ok(await a.patch('/api/settings', { timezone: 'Asia/Kolkata' }));
  const loading = a.post('/api/sample-data', { types: ['zoom'] }); // sync runs inside the request; first extract takes 150ms
  await sleep(30);
  ok(await a.del('/api/connectors/zoom'));
  ok(await loading);
  await slow.server.aria.runSync(a.user.id, 'zoom'); // waits for the in-flight sync to finish
  const meetings = ok(await a.get('/api/sources'));
  assert.equal(meetings.length, 1, 'only the item already being processed was written');
  assert.equal(inputs[0].tz, 'Asia/Kolkata');
});

test('excluded calendar: meetings on it are not ingested', needsEngine, async () => {
  const a = await newUser();
  ok(await a.patch('/api/settings', { excluded_calendars: ['Work'] }));
  await seedDemo(a, ['gcal', 'zoom']);
  assert.equal(ok(await a.get('/api/sources')).filter((s) => s.type === 'meeting').length, 0);
  const b = await newUser(); // control: same flow without the exclusion ingests all three meetings
  await seedDemo(b, ['gcal', 'zoom']);
  assert.equal(ok(await b.get('/api/sources')).filter((s) => s.type === 'meeting').length, 3);
});

test('assistant: grounded reply, proposals only applied via confirm, no double apply, odd person names', needsEngine, async () => {
  const a = await newUser();
  const { sugs } = await seedDemo(a, ['zoom']);
  ok(await a.post(`/api/suggestions/${sugs[0].id}/accept`));
  const r = ok(await a.post('/api/assistant', { message: 'What is pending?' }));
  assert.ok(r.thread_id && typeof r.reply === 'string' && Array.isArray(r.citations) && Array.isArray(r.proposals));
  const target = ok(await a.get('/api/tasks'))[0];
  const r2 = ok(await a.post('/api/assistant', { message: `Mark "${target.title}" complete`, thread_id: r.thread_id }));
  assert.equal(ok(await a.get(`/api/assistant/threads/${r.thread_id}`)).messages.length, 4);
  assert.equal(ok(await a.get(`/api/tasks/${target.id}`)).status, target.status, 'nothing applied without confirm');
  const prop = r2.proposals[0];
  assert.equal(prop && prop.action, 'set_status', r2.reply);
  assert.equal(ok(await a.post('/api/assistant/confirm', { thread_id: r.thread_id, proposal_id: prop.id })).ok, true);
  assert.equal((await a.post('/api/assistant/confirm', { thread_id: r.thread_id, proposal_id: prop.id })).status, 409);
  assert.equal((await (await newUser()).get(`/api/assistant/threads/${r.thread_id}`)).status, 404, 'threads are per user');

  // concurrent turns on one thread both persist
  await Promise.all([a.post('/api/assistant', { message: 'What is overdue?', thread_id: r.thread_id }), a.post('/api/assistant', { message: 'What is due this week?', thread_id: r.thread_id })]);
  assert.equal(ok(await a.get(`/api/assistant/threads/${r.thread_id}`)).messages.length, 8);

  const p = await newUser();
  ok(await p.post('/api/tasks', { title: 'Return the call', stakeholders: [{ name: '+1 415 555 0100' }] }));
  assert.equal((await p.post('/api/assistant', { message: 'What is pending?' })).status, 200);
});

test('settings validation and clamping', async () => {
  const a = await newUser();
  const s = ok(await a.patch('/api/settings', { lookback_days: 400, retention_days: 1, low_floor: 3, high_threshold: -1, excluded_labels: ['Promotions'], timezone: 'Asia/Kolkata' }));
  assert.equal(s.lookback_days, 90);
  assert.equal(s.retention_days, 7);
  assert.equal(s.low_floor, 1);
  assert.equal(s.high_threshold, 0);
  assert.equal(s.timezone, 'Asia/Kolkata');
  assert.equal((await a.patch('/api/settings', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await a.patch('/api/settings', { digest_time: '25:00' })).status, 400);
  const digest = ok(await a.get('/api/digest'));
  assert.ok(Array.isArray(digest.overdue) && Array.isArray(digest.due_today) && Array.isArray(digest.waiting_stale));
});

test('CSV + JSON export with formula guard, audited', async () => {
  const a = await newUser();
  const t = ok(await a.post('/api/tasks', { title: '=HYPERLINK("http://evil","x")' }));
  ok(await a.post(`/api/tasks/${t.id}/notes`, { body: 'note for export' }));
  const csv = await a.get('/api/export/tasks.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /"id","title","status"/);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'formula injection neutralised, quotes doubled');
  assert.ok(csv.text.includes('note for export'), 'notes decrypted into export');
  assert.equal(csvCell('-1+2'), `"'-1+2"`);
  assert.equal(csvCell('a,b\nc'), '"a,b\nc"');
  const json = ok(await a.get('/api/export/all.json'));
  assert.equal(json.tasks[0].notes[0].body, 'note for export');
  const audit = ok(await a.get('/api/audit'));
  for (const x of ['signup', 'export.csv', 'export.json']) assert.ok(audit.some((e) => e.action === x), x);
});

test('isolation: other users get 404; admin sees metadata only; admin audit shows admin actions only', async () => {
  const srv = await start({ ...(HAS_ENGINE ? {} : { engine: stubEngine() }), adminEmails: ['boss@bank.test'] });
  const member = await newUser({ srv, domain: 'bank.test', name: 'Bob Iyer' }); // signs up first: still not admin
  const admin = await newUser({ srv, email: 'Boss@bank.test' });
  const outsider = await newUser({ srv, domain: 'else.test' });
  assert.equal(ok(await admin.get('/api/me')).user.role, 'admin');
  const bt = ok(await member.post('/api/tasks', { title: 'Bob secret task' }));
  const bs = ok(await member.post('/api/sources', { title: 'Bob private call', text: 'Bob: I will send the confidential deck tomorrow.' }));
  for (const c of [admin, outsider]) {
    assert.equal((await c.get(`/api/tasks/${bt.id}`)).status, 404);
    assert.equal((await c.patch(`/api/tasks/${bt.id}`, { status: 'cancelled' })).status, 404);
    assert.equal((await c.post(`/api/tasks/${bt.id}/notes`, { body: 'x' })).status, 404);
    assert.equal((await c.get(`/api/sources/${bs.id}`)).status, 404, 'admin cannot open an employee transcript');
    assert.equal((await c.get(`/api/sources/${bs.id}/raw`)).status, 404);
    assert.equal(ok(await c.get('/api/tasks')).length, 0);
    assert.equal(ok(await c.get('/api/sources')).length, 0);
  }
  assert.equal((await member.get('/api/admin/seats')).status, 403);
  ok(await member.get('/api/export/tasks.csv')); // a member action that must not show in the admin audit
  const seats = await admin.get('/api/admin/seats');
  assert.deepEqual(seats.json.map((x) => x.email).sort(), [admin.user.email, member.user.email].sort());
  assert.ok(!/secret task|confidential|Bob private call/.test(seats.text), 'no titles or text in admin output');
  const aa = ok(await admin.get('/api/admin/audit'));
  assert.ok(aa.length >= 1 && aa.every((e) => e.action.startsWith('admin.')), 'admin audit = admin actions only');
});

test('delete account removes every vault row, keeps audit, user id not reused', async () => {
  const a = await newUser();
  const t = ok(await a.post('/api/tasks', { title: 'Something to delete', stakeholders: [{ name: 'Zed' }] }));
  ok(await a.post(`/api/tasks/${t.id}/notes`, { body: 'n' }));
  const uid = a.user.id;
  const db = main.server.aria.db;
  assert.equal((await a.del('/api/account', { password: 'nope nope' })).status, 403);
  ok(await a.del('/api/account', { password: a.password }));
  for (const tb of db.VAULT_TABLES) assert.equal(db.one(`SELECT COUNT(*) n FROM ${tb} WHERE user_id=?`, uid).n, 0, tb);
  assert.equal(db.one('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 0);
  assert.equal(db.one("SELECT COUNT(*) n FROM audit_events WHERE user_id=? AND action='account.delete'", uid).n, 1);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.throws(() => db.enc(uid, 'x'), /no key/, 'per-user key is gone (crypto-shred)');
  const next = await newUser();
  assert.ok(next.user.id > uid, 'AUTOINCREMENT: id never reused');
  assert.ok(!ok(await next.get('/api/audit')).some((e) => e.action === 'account.delete'), 'new user does not inherit old audit');
});

test('content encrypted at rest; retention wipes raw text (incl. failed sources) and scrubs excerpts', needsEngine, async () => {
  const a = await newUser();
  const { sugs } = await seedDemo(a, ['zoom']);
  const t = ok(await a.post(`/api/suggestions/${sugs[0].id}/accept`));
  ok(await a.post(`/api/tasks/${t.id}/notes`, { body: 'secret-note-body' }));
  ok(await a.post('/api/assistant', { message: 'What is pending with Ananya?' }));
  const { all, run, one } = main.server.aria.db;
  const plain = (rows, col) => rows.map((r) => Buffer.from(r[col]).toString('latin1')).join('\n');
  assert.ok(!plain(all('SELECT text FROM excerpts WHERE user_id=?', a.user.id), 'text').includes(sugs[0].payload.excerpt.slice(0, 20)));
  assert.ok(!plain(all('SELECT payload FROM suggestions WHERE user_id=?', a.user.id), 'payload').includes('stakeholders'));
  assert.ok(!plain(all('SELECT body FROM notes WHERE user_id=?', a.user.id), 'body').includes('secret-note-body'));
  assert.ok(!plain(all('SELECT messages FROM chat_threads WHERE user_id=?', a.user.id), 'messages').includes('Ananya'));

  const failed = ok(await a.post('/api/sources', { title: 'Never processed', text: 'Raw text that must age out.' }));
  run("UPDATE sources SET processed_at=NULL, processing_status='failed', created_at='2000-01-01T00:00:00.000Z' WHERE id=?", failed.id);
  const pendingSug = ok(await a.get('/api/suggestions')).find((s) => s.source.id === sugs[0].source.id);
  run("UPDATE sources SET processed_at='2000-01-01T00:00:00.000Z' WHERE id=?", sugs[0].source.id);
  main.server.aria.retentionSweep();
  assert.equal(ok(await a.get(`/api/sources/${failed.id}`)).text, null, 'failed source ages from created_at');
  const wiped = ok(await a.get(`/api/sources/${sugs[0].source.id}`));
  assert.equal(wiped.text, null);
  assert.equal(wiped.raw_wiped, true);
  assert.equal(wiped.title, sugs[0].source.title, 'metadata kept');
  if (pendingSug) {
    const s = ok(await a.get('/api/suggestions')).find((x) => x.id === pendingSug.id);
    assert.equal(s.payload.excerpt, null, 'excerpt scrubbed from suggestion');
    assert.equal(s.payload.title, pendingSug.payload.title, 'title kept');
  }
  assert.equal(ok(await a.get(`/api/tasks/${t.id}`)).excerpt.text, sugs[0].payload.excerpt, 'accepted task keeps its excerpt');
  assert.ok(one('SELECT COUNT(*) n FROM excerpts WHERE source_id=?', sugs[0].source.id).n <= 1);
});

test('external_ai: off by default, audited, and passed to the engine', async () => {
  const seen = [];
  const spy = await start({ engine: { ...stubEngine(),
    async extract(input, opts) { seen.push(['extract', opts.ai]); return { mode: 'rules', candidates: [] }; },
    async assistant(req) { seen.push(['assistant', req.ai]); return { reply: 'ok', citations: [], proposals: [] }; } } });
  const a = await newUser({ srv: spy });
  assert.equal(ok(await a.get('/api/settings')).external_ai, false);
  const me = ok(await a.get('/api/me'));
  assert.equal(me.demo, false);
  assert.equal(me.push, false);
  ok(await a.post('/api/sources', { title: 'note', text: 'Sam: I will send it tomorrow.' }));
  ok(await a.post('/api/assistant', { message: 'hi' }));
  ok(await a.patch('/api/settings', { external_ai: true }));
  ok(await a.post('/api/assistant', { message: 'hi' }));
  await sleep(50);
  assert.ok(seen.some(([k, v]) => k === 'extract' && v === false));
  assert.deepEqual(seen.filter(([k]) => k === 'assistant').map(([, v]) => v), [false, true]);
  assert.ok(ok(await a.get('/api/audit')).some((e) => e.action === 'settings.external_ai' && e.object === 'true'));
});

test('unconfigured connectors show setup and never fall back to demo; sample data is explicit and removable', needsEngine, async () => {
  const a = await newUser();
  const z = ok(await a.get('/api/connectors')).find((c) => c.type === 'zoom');
  assert.equal(z.configured, false);
  assert.equal(z.mode, null);
  assert.deepEqual(z.setup.env, ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']);
  assert.match(z.setup.redirect_uri, /\/oauth\/zoom\/callback$/);
  assert.ok(z.setup.console_url.startsWith('https://'));
  const r = await a.post('/api/connectors/zoom/connect');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /ZOOM_CLIENT_ID/);
  assert.equal(ok(await a.get('/api/sources')).length, 0);
  assert.equal(ok(await a.get('/api/me')).demo, false);

  ok(await a.post('/api/sample-data', {}));
  assert.equal(ok(await a.get('/api/me')).demo, true);
  const srcs = ok(await a.get('/api/sources'));
  assert.ok(srcs.length >= 4 && srcs.every((s) => s.mode === 'demo'));
  const sug = ok(await a.get('/api/suggestions'))[0];
  const task = ok(await a.post(`/api/suggestions/${sug.id}/accept`, {}));

  ok(await a.del('/api/sample-data'));
  assert.equal(ok(await a.get('/api/me')).demo, false);
  assert.equal(ok(await a.get('/api/sources')).length, 0);
  assert.equal(ok(await a.get('/api/suggestions')).length, 0);
  assert.equal(ok(await a.get(`/api/tasks/${task.id}`)).title, task.title, 'accepted tasks survive sample-data removal');
  ok(await a.post('/api/sample-data', {}));
  assert.ok(ok(await a.get('/api/sources')).length >= 4, 'sample data can be loaded again');
  assert.equal((await a.post('/api/sample-data', { types: ['nope'] })).status, 404);
});

function fakeProviders(t) {
  const real = globalThis.fetch, seen = [], down = new Set();
  const hour = new Date(Date.now() - 3600e3).toISOString();
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return real(url, opts);
    const h = opts.headers || {};
    seen.push({ host: u.host, path: u.pathname, search: u.search, auth: h.Authorization || h.authorization || '', body: String(opts.body || '') });
    if (down.has(u.host)) return json({ error: 'boom' }, 500);
    if (u.pathname.endsWith('/token')) return json({ access_token: `at-${seen.length}`, refresh_token: 'rt-1', expires_in: 30, scope: 'read' });
    switch (u.host + u.pathname) {
      case 'api.zoom.us/v2/users/me/recordings':
        return json({ meetings: [{ uuid: 'zm-1', topic: 'Board prep', start_time: hour, recording_files: [{ file_type: 'TRANSCRIPT', download_url: 'https://zoom.us/rec/download/t1' }] }] });
      case 'zoom.us/rec/download/t1':
        return new Response('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nPriya Nair: Sam, please send the board pack by Friday.\n\n2\n00:00:05.000 --> 00:00:08.000\nSam Carter: I will send the board pack by Friday.\n');
      case 'gmail.googleapis.com/gmail/v1/users/me/messages':
        return json({ messages: [{ id: 'g1' }] });
      case 'gmail.googleapis.com/gmail/v1/users/me/messages/g1':
        return json({ id: 'g1', threadId: 'th1', internalDate: String(Date.now() - 3600e3), labelIds: ['INBOX'], payload: { mimeType: 'text/plain',
          headers: [{ name: 'From', value: 'Kavita Rao <kavita@bank.test>' }, { name: 'To', value: 'Sam Carter <sam@bank.test>' }, { name: 'Subject', value: 'Policy' }],
          body: { data: Buffer.from('Please attach the SAR policy to the credit file before Friday.').toString('base64url') } } });
      case 'graph.microsoft.com/v1.0/me/messages':
        return json({ value: [{ id: 'o1', conversationId: 'c1', subject: 'Limits', receivedDateTime: hour, parentFolderId: 'inbox',
          from: { emailAddress: { name: 'Daniel Osei', address: 'daniel@kestrel.test' } }, toRecipients: [{ emailAddress: { name: 'Sam Carter', address: 'sam@bank.test' } }],
          ccRecipients: [], body: { content: 'Could you send the limits sheet by Monday?' } }] });
      case 'www.googleapis.com/calendar/v3/calendars/primary/events':
        return json({ items: [{ id: 'e1', summary: 'Board prep', start: { dateTime: hour }, attendees: [{ email: 'priya@bank.test', displayName: 'Priya Nair' }] }] });
      case 'graph.microsoft.com/v1.0/me/events':
        return json({ value: [{ id: 'm1', subject: 'Board prep', start: { dateTime: hour.replace('Z', '') }, attendees: [{ emailAddress: { name: 'Priya Nair', address: 'priya@bank.test' } }] }] });
      default: return json({ error: `unexpected ${u.host}${u.pathname}` }, 404);
    }
  };
  t.after(() => { globalThis.fetch = real; });
  return { seen, down };
}

test('OAuth end to end against fake providers: connect, consent, callback, sync, refresh, error, revoke', needsEngine, async (t) => {
  for (const e of ['ZOOM', 'GOOGLE', 'MS']) { process.env[`${e}_CLIENT_ID`] = `${e.toLowerCase()}-id`; process.env[`${e}_CLIENT_SECRET`] = `${e.toLowerCase()}-secret`; }
  t.after(() => { for (const e of ['ZOOM', 'GOOGLE', 'MS']) { delete process.env[`${e}_CLIENT_ID`]; delete process.env[`${e}_CLIENT_SECRET`]; } });
  const fake = fakeProviders(t);
  const a = await newUser({ name: 'Sam Carter', email: 'sam@bank.test' });
  assert.ok(ok(await a.get('/api/connectors')).every((c) => c.configured));

  // consent denied: back to settings with an error, nothing connected
  const d = ok(await a.post('/api/connectors/gmail/connect'));
  const denied = await a.get(`/oauth/gmail/callback?error=access_denied&state=${new URL(d.redirect).searchParams.get('state')}`);
  assert.match(denied.headers.get('location'), /connector_error=access_denied/);
  assert.equal(ok(await a.get('/api/connectors')).find((c) => c.type === 'gmail').status, 'disconnected');

  for (const type of ['gcal', 'mscal', 'zoom', 'gmail', 'outlook']) { // calendars first so meetings get attendees
    const { redirect } = ok(await a.post(`/api/connectors/${type}/connect`));
    const u = new URL(redirect);
    const state = u.searchParams.get('state');
    assert.ok(state && u.searchParams.get('client_id').endsWith('-id'), type);
    assert.match(u.searchParams.get('redirect_uri'), new RegExp(`/oauth/${type}/callback$`));
    if (type !== 'zoom') assert.ok(u.searchParams.get('scope'), `${type} requests scopes`);
    const cb = await a.get(`/oauth/${type}/callback?code=code-${type}&state=${state}`);
    assert.equal(cb.status, 302);
    assert.doesNotMatch(cb.headers.get('location'), /connector_error/, type);
    await main.server.aria.runSync(a.user.id, type); // waits for the sync the callback started
    const c = ok(await a.get('/api/connectors')).find((x) => x.type === type);
    assert.equal(c.status, 'connected', `${type}: ${c.last_error}`);
    assert.equal(c.mode, 'oauth');
  }
  assert.ok(fake.seen.some((s) => s.host === 'zoom.us' && s.path === '/oauth/token' && /^Basic /.test(s.auth)), 'Zoom token call uses Basic auth');
  assert.ok(fake.seen.some((s) => /grant_type=refresh_token/.test(s.body)), 'short-lived tokens are refreshed');

  const srcs = ok(await a.get('/api/sources'));
  const board = srcs.find((s) => s.title === 'Board prep');
  assert.ok(board && board.participants.some((p) => p.email === 'priya@bank.test'), 'calendar attendees merged into the Zoom meeting');
  assert.ok(srcs.some((s) => s.title === 'Policy' && s.participants.some((p) => p.role === 'from' && p.email === 'kavita@bank.test')));
  assert.ok(srcs.some((s) => s.title === 'Limits' && s.mode === 'oauth'));
  assert.ok(ok(await a.get('/api/suggestions')).some((s) => /board pack/i.test(s.payload.excerpt || '')), 'Zoom VTT transcript was extracted');
  const { one } = main.server.aria.db;
  assert.ok(!String(one("SELECT tokens_enc FROM connectors WHERE user_id=? AND type='zoom'", a.user.id).tokens_enc).includes('at-'), 'tokens encrypted at rest');

  assert.equal((await a.post('/api/sample-data', { types: ['gmail'] })).status, 409, 'sample data never overwrites a real account');
  assert.equal(ok(await a.get('/api/connectors')).find((c) => c.type === 'gmail').mode, 'oauth');

  fake.down.add('graph.microsoft.com');
  ok(await a.post('/api/connectors/outlook/sync'));
  const o = ok(await a.get('/api/connectors')).find((x) => x.type === 'outlook');
  assert.equal(o.status, 'error');
  assert.match(o.last_error, /graph\.microsoft\.com returned 500/);

  ok(await a.del('/api/connectors/gmail'));
  assert.equal(one("SELECT tokens_enc FROM connectors WHERE user_id=? AND type='gmail'", a.user.id).tokens_enc, null, 'revoke wipes tokens');
});

test('legacy sources whose mode was overwritten get their connector mode back on startup, so sample data can be removed', needsEngine, async () => {
  const a = await newUser();
  ok(await a.post('/api/sample-data', { types: ['zoom'] }));
  const { run } = main.server.aria.db;
  run("UPDATE sources SET mode='rules' WHERE user_id=?", a.user.id); // what processSource did before the fix
  require('../db').open(main.dataDir).close(); // reopening the database runs the repair
  ok(await a.del('/api/sample-data'));
  assert.equal(ok(await a.get('/api/sources')).length, 0);
});

test('C1: sample data then a real account: the first real sync uses the full lookback', needsEngine, async (t) => {
  for (const e of ['GOOGLE']) { process.env[`${e}_CLIENT_ID`] = 'g-id'; process.env[`${e}_CLIENT_SECRET`] = 'g-secret'; }
  t.after(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; });
  const fake = fakeProviders(t);
  const a = await newUser({ name: 'Sam Carter', email: 'sam2@bank.test' });
  ok(await a.post('/api/sample-data', { types: ['gmail'] }));
  ok(await a.del('/api/sample-data'));
  const { redirect } = ok(await a.post('/api/connectors/gmail/connect'));
  await a.get(`/oauth/gmail/callback?code=c&state=${new URL(redirect).searchParams.get('state')}`);
  await main.server.aria.runSync(a.user.id, 'gmail');
  const list = fake.seen.find((x) => x.path === '/gmail/v1/users/me/messages');
  const after = Number(/after:(\d+)/.exec(decodeURIComponent(list.search))[1]) * 1000;
  assert.ok(Date.now() - after > 13 * 86400e3, `first real sync must look back 14 days, got ${((Date.now() - after) / 86400e3).toFixed(1)}`);
});

test('M1/M3: sample-data flag follows leftover sources; removal deletes only fixture sources', needsEngine, async () => {
  const a = await newUser();
  ok(await a.post('/api/sample-data', { types: ['zoom'] }));
  ok(await a.del('/api/connectors/zoom'));
  assert.equal(ok(await a.get('/api/me')).demo, true, 'demo sources still listed, so Remove must stay available');
  const { run, one } = main.server.aria.db;
  run(`INSERT INTO sources (user_id, type, connector, mode, external_id, title, participants, processing_status, created_at)
    VALUES (?, 'meeting', 'zoom', 'demo', 'real-meeting-1', 'Mislabelled real call', '[]', 'done', ?)`, a.user.id, new Date().toISOString());
  ok(await a.del('/api/sample-data'));
  assert.equal(ok(await a.get('/api/me')).demo, true, 'the mislabelled real source is kept, so the flag stays');
  assert.ok(one("SELECT id FROM sources WHERE user_id=? AND external_id='real-meeting-1'", a.user.id), 'non-fixture source never hard-deleted');
  assert.deepEqual(ok(await a.get('/api/sources')).map((s) => s.title), ['Mislabelled real call']);
});

test('admin pastes provider credentials in-app: stored encrypted, secret never returned, users then connect in one click', async () => {
  const srv = await start({ ...(HAS_ENGINE ? {} : { engine: stubEngine() }), adminEmails: ['ops@setup.test'] });
  const admin = await newUser({ srv, email: 'ops@setup.test' });
  const user = await newUser({ srv, domain: 'setup.test' });
  assert.equal((await user.put('/api/admin/providers/google', { client_id: 'x', client_secret: 'y' })).status, 403);
  const before = ok(await admin.get('/api/admin/providers')).find((p) => p.provider === 'google');
  assert.equal(before.configured, false);
  assert.ok(before.steps.length >= 5 && before.redirect_uris.some((u) => u.endsWith('/oauth/gmail/callback')));
  ok(await admin.put('/api/admin/providers/google', { client_id: 'goog-id-123.apps.googleusercontent.com', client_secret: 'goog-secret-xyz' }));
  const after = ok(await admin.get('/api/admin/providers')).find((p) => p.provider === 'google');
  assert.equal(after.configured, true);
  assert.equal(after.source, 'app');
  assert.ok(!JSON.stringify(after).includes('goog-secret-xyz'), 'secret never returned');
  const { one } = srv.server.aria.db;
  assert.ok(!String(one("SELECT v FROM app_config WHERE k='google'").v).includes('goog-secret-xyz'), 'stored encrypted');
  const { redirect } = ok(await user.post('/api/connectors/gmail/connect'));
  assert.equal(new URL(redirect).searchParams.get('client_id'), 'goog-id-123.apps.googleusercontent.com');
  ok(await admin.del('/api/admin/providers/google'));
  assert.equal((await user.post('/api/connectors/gmail/connect')).status, 409);
});

test('no admins configured: the local operator can set up providers; with admins, members cannot', async () => {
  const a = await newUser(); // main server: no ARIA_ADMIN_EMAILS, requests come from 127.0.0.1
  assert.equal(ok(await a.get('/api/me')).can_setup, true);
  ok(await a.put('/api/admin/providers/zoom', { client_id: 'zoom-id', client_secret: 'zoom-secret' }));
  assert.equal(ok(await a.get('/api/connectors')).find((c) => c.type === 'zoom').configured, true);
  ok(await a.del('/api/admin/providers/zoom'));
  const srv = await start({ ...(HAS_ENGINE ? {} : { engine: stubEngine() }), adminEmails: ['boss@x.test'] });
  const m = await newUser({ srv });
  assert.equal(ok(await m.get('/api/me')).can_setup, false);
});
