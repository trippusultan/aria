'use strict';
// Connector adapters: real OAuth when provider creds are in env; demo (fixtures) mode only for explicit sample data.
// Read-only by construction: no function here ever writes mail or calendar (CON-8).
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400e3;
const TYPES = {
  zoom: { label: 'Zoom', kind: 'meeting', provider: 'zoom', scopes: ['cloud_recording:read', 'user:read'] },
  gmail: { label: 'Gmail', kind: 'email', provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  outlook: { label: 'Outlook mail', kind: 'email', provider: 'ms', scopes: ['offline_access', 'Mail.Read'] },
  gcal: { label: 'Google Calendar', kind: 'calendar', provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
  mscal: { label: 'Outlook Calendar', kind: 'calendar', provider: 'ms', scopes: ['offline_access', 'Calendars.Read'] },
};
const PROVIDERS = {
  zoom: { env: 'ZOOM', auth: 'https://zoom.us/oauth/authorize', token: 'https://zoom.us/oauth/token' },
  google: { env: 'GOOGLE', auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } },
  ms: { env: 'MS', auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' },
};

// Env vars win; otherwise credentials an admin pasted in Settings (lookup(provider) -> {id, secret} | null).
function creds(type, lookup) {
  const prov = TYPES[type].provider, e = PROVIDERS[prov].env;
  const id = process.env[`${e}_CLIENT_ID`], secret = process.env[`${e}_CLIENT_SECRET`];
  if (id && secret) return { id, secret, source: 'env' };
  const s = lookup && lookup(prov);
  return s && s.id && s.secret ? { ...s, source: 'app' } : null;
}
const CONSOLE = { zoom: 'https://marketplace.zoom.us/develop/create', google: 'https://console.cloud.google.com/apis/credentials',
  ms: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' };
const LABELS = { zoom: 'Zoom', google: 'Google (Gmail and Calendar)', ms: 'Microsoft (Outlook mail and calendar)' };
const STEPS = {
  google: [
    'Open console.cloud.google.com and sign in with your Google Workspace admin (or personal) account.',
    'Top bar: click the project picker, then New project. Name it "Aria" and click Create.',
    'Left menu: APIs & Services > Library. Search "Gmail API" and click Enable. Go back, search "Google Calendar API" and click Enable.',
    'APIs & Services > OAuth consent screen. Choose Internal (Workspace) or External, click Create, fill in the app name "Aria" and your support email, then Save.',
    'On Scopes, click Add or remove scopes, tick .../auth/gmail.readonly and .../auth/calendar.readonly, then Save. If you chose External, add yourself under Test users.',
    'APIs & Services > Credentials > Create credentials > OAuth client ID. Application type: Web application.',
    'Under Authorized redirect URIs, click Add URI and paste each redirect URI shown below. Click Create.',
    'Copy the Client ID and Client secret from the dialog and paste them into the form below.',
  ],
  ms: [
    'Open entra.microsoft.com and sign in as an admin (or with your own Microsoft account).',
    'Left menu: Applications > App registrations > New registration. Name it "Aria".',
    'Supported account types: "Accounts in any organizational directory and personal Microsoft accounts".',
    'Redirect URI: choose Web and paste the first redirect URI shown below. Click Register.',
    'Open Authentication > Add URI, paste the second redirect URI, then Save.',
    'API permissions > Add a permission > Microsoft Graph > Delegated: tick Mail.Read, Calendars.Read and offline_access, then Add permissions. Admins: Grant admin consent.',
    'Certificates & secrets > New client secret > Add. Copy the secret Value now; it is only shown once.',
    'Overview: copy the Application (client) ID. Paste the ID and the secret Value into the form below.',
  ],
  zoom: [
    'Open marketplace.zoom.us and sign in. Top right: Develop > Build App.',
    'Choose General App and click Create. Under Basic Information, pick User-managed.',
    'OAuth Redirect URL: paste the redirect URI shown below. Add the same URI to the OAuth allow list.',
    'Scopes > Add scopes: under Cloud Recording, tick the read scopes for listing recordings and viewing recording files; under User, tick view user. Save.',
    'Basic Information: copy the Client ID and Client Secret and paste them into the form below.',
    'Transcripts need Zoom cloud recording with Audio transcript turned on (Zoom web settings > Recording).',
  ],
};
function setupOf(type, redirectUri, lookup) {
  const t = TYPES[type], p = PROVIDERS[t.provider], c = creds(type, lookup);
  const base = redirectUri.replace(/\/oauth\/[a-z]+\/callback$/, '');
  return { configured: !!c, source: c ? c.source : null, provider: t.provider, provider_label: LABELS[t.provider],
    env: [`${p.env}_CLIENT_ID`, `${p.env}_CLIENT_SECRET`], redirect_uri: redirectUri, console_url: CONSOLE[t.provider], scopes: t.scopes,
    redirect_uris: Object.keys(TYPES).filter((k) => TYPES[k].provider === t.provider).map((k) => `${base}/oauth/${k}/callback`), steps: STEPS[t.provider] };
}

function authUrl(type, state, redirectUri, lookup) {
  const p = PROVIDERS[TYPES[type].provider];
  const q = new URLSearchParams({ response_type: 'code', client_id: creds(type, lookup).id, redirect_uri: redirectUri, state, ...(p.extra || {}) });
  if (TYPES[type].provider !== 'zoom') q.set('scope', TYPES[type].scopes.join(' ')); // Zoom scopes are set on the app itself
  return `${p.auth}?${q}`;
}

// params: {code, redirect_uri} for the callback, or {refresh_token} to refresh.
async function exchange(type, params, lookup) {
  const t = TYPES[type], c = creds(type, lookup);
  const body = new URLSearchParams(params.refresh_token
    ? { grant_type: 'refresh_token', refresh_token: params.refresh_token }
    : { grant_type: 'authorization_code', code: params.code, redirect_uri: params.redirect_uri });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (t.provider === 'zoom') headers.Authorization = 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64');
  else { body.set('client_id', c.id); body.set('client_secret', c.secret); }
  if (t.provider === 'ms') body.set('scope', t.scopes.join(' '));
  const r = await fetch(PROVIDERS[t.provider].token, { method: 'POST', headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token exchange failed (${r.status})`);
  return { access_token: j.access_token, refresh_token: j.refresh_token || params.refresh_token || null,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope || t.scopes.join(' ') };
}

// ---- real provider fetchers (not live-tested; kept small) ----
async function get(url, token, headers = {}) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return r;
}
const getJson = async (...a) => (await get(...a)).json();
const addrList = (s) => (s || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = /^"?(.*?)"?\s*<([^>]+)>$/.exec(x);
  return m ? { name: m[1] || m[2], email: m[2].toLowerCase() } : { name: x, email: x.toLowerCase() };
});
const graphAddr = (a) => ({ name: a?.emailAddress?.name || a?.emailAddress?.address || '', email: (a?.emailAddress?.address || '').toLowerCase() || null });
function gmailBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const p of part.parts || []) { const b = gmailBody(p); if (b) return b; }
  return '';
}
function vttToText(vtt) { // "00:00:04.000 --> ..." + "Speaker: text" => "[00:00:04] Speaker: text"
  const out = []; let ts = null;
  for (const line of vtt.split(/\r?\n/)) {
    const m = /^(\d\d:\d\d:\d\d)\.\d+\s+-->/.exec(line);
    if (m) ts = m[1];
    else if (ts && line.trim() && !/^\d+$/.test(line.trim())) { out.push(`[${ts}] ${line.trim()}`); ts = null; }
  }
  return out.join('\n');
}

async function fetchItems(type, token, sinceIso) {
  if (type === 'zoom') {
    const data = await getJson(`https://api.zoom.us/v2/users/me/recordings?page_size=100&from=${sinceIso.slice(0, 10)}`, token);
    const out = [];
    for (const m of data.meetings || []) {
      const f = (m.recording_files || []).find((x) => x.file_type === 'TRANSCRIPT');
      const transcript = f ? vttToText(await (await get(f.download_url, token)).text()) : null;
      out.push({ external_id: String(m.uuid), title: m.topic || 'Zoom meeting', started_at: m.start_time, participants: [], transcript });
    }
    return out;
  }
  if (type === 'gmail') {
    const q = encodeURIComponent(`after:${Math.floor(Date.parse(sinceIso) / 1000)}`);
    const list = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${q}`, token);
    const out = [];
    for (const { id } of list.messages || []) {
      const m = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, token);
      const h = (n) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value || '';
      const labels = m.labelIds || [];
      out.push({ external_id: id, thread_id: m.threadId, subject: h('subject') || '(no subject)', sent_at: new Date(Number(m.internalDate)).toISOString(),
        labels, newsletter: !!h('list-unsubscribe') || labels.includes('CATEGORY_PROMOTIONS'),
        from: addrList(h('from'))[0] || { name: '', email: null }, to: addrList(h('to')), cc: addrList(h('cc')), body: gmailBody(m.payload) });
    }
    return out;
  }
  if (type === 'outlook') {
    const q = new URLSearchParams({ $top: '50', $filter: `receivedDateTime ge ${sinceIso}`,
      $select: 'id,conversationId,subject,receivedDateTime,from,toRecipients,ccRecipients,body,parentFolderId' });
    const data = await getJson(`https://graph.microsoft.com/v1.0/me/messages?${q}`, token, { Prefer: 'outlook.body-content-type="text"' });
    // ponytail: label = folder id and no newsletter heuristic; resolve folder names / List-Unsubscribe when users ask
    return (data.value || []).map((m) => ({ external_id: m.id, thread_id: m.conversationId, subject: m.subject || '(no subject)',
      sent_at: m.receivedDateTime, labels: [m.parentFolderId], newsletter: false, from: graphAddr(m.from),
      to: (m.toRecipients || []).map(graphAddr), cc: (m.ccRecipients || []).map(graphAddr), body: m.body?.content || '' }));
  }
  if (type === 'gcal') {
    const q = new URLSearchParams({ timeMin: sinceIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    const data = await getJson(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, token);
    return (data.items || []).map((e) => ({ external_id: e.id, title: e.summary || '', start: e.start?.dateTime || e.start?.date, calendar: 'primary',
      attendees: (e.attendees || []).map((a) => ({ name: a.displayName || a.email, email: (a.email || '').toLowerCase() || null })) }));
  }
  if (type === 'mscal') {
    const q = new URLSearchParams({ $top: '250', $filter: `start/dateTime ge '${sinceIso}'`, $select: 'id,subject,start,attendees' });
    const data = await getJson(`https://graph.microsoft.com/v1.0/me/events?${q}`, token, { Prefer: 'outlook.timezone="UTC"' });
    return (data.value || []).map((e) => ({ external_id: e.id, title: e.subject || '', start: e.start?.dateTime ? e.start.dateTime.replace(/Z?$/, 'Z') : null,
      calendar: 'primary', attendees: (e.attendees || []).map(graphAddr) }));
  }
  return [];
}

// ---- demo mode: fixtures personalised for the signed-in user, dates rebased so the newest item is ~1 day old ----
const FIXTURE = { zoom: 'zoom.json', gmail: 'mail.json', outlook: 'mail.json', gcal: 'calendar.json', mscal: 'calendar.json' };
const DATE_KEYS = ['started_at', 'sent_at', 'start', 'end'];
function demoItems(type, user, fixturesDir, now = Date.now()) {
  const first = user.name.split(/\s+/)[0];
  const load = (f) => JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'), (k, v) => typeof v === 'string'
    ? v.replaceAll('{{USER_NAME}}', user.name).replaceAll('{{USER_EMAIL}}', user.email).replaceAll('{{USER_FIRST}}', first) : v);
  const latest = Math.max(...['zoom.json', 'mail.json', 'calendar.json'].flatMap((f) => load(f).flatMap((x) => DATE_KEYS.map((k) => Date.parse(x[k]) || 0))));
  const shift = Math.max(0, Math.floor((now - latest) / DAY) - 1) * DAY;
  return load(FIXTURE[type]).map((x) => {
    for (const k of DATE_KEYS) if (x[k]) x[k] = new Date(Date.parse(x[k]) + shift).toISOString();
    return x;
  });
}

// ---- sync orchestration ----
// app = { one, all, run, enc, dec, settingsOf, processSource, fixturesDir }
async function sync(app, uid, type) {
  const conn = app.one('SELECT * FROM connectors WHERE user_id=? AND type=?', uid, type);
  if (!conn || conn.status === 'disconnected') return { ingested: 0 };
  // live = still connected in the same mode: a demo sync in flight must not write into a freshly connected real account
  const live = () => { const r = app.one('SELECT status, mode FROM connectors WHERE user_id=? AND type=?', uid, type); return !!r && r.status !== 'disconnected' && r.mode === conn.mode; };
  const user = app.one('SELECT id, name, email FROM users WHERE id=?', uid);
  const s = app.settingsOf(uid);
  const since = new Date(Math.max(Date.now() - s.lookback_days * DAY, conn.last_sync_at ? Date.parse(conn.last_sync_at) - DAY : 0)).toISOString();
  let items;
  try {
    if (conn.mode === 'oauth') {
      let tok = JSON.parse(app.dec(uid, conn.tokens_enc) || 'null');
      if (!tok) throw new Error('no tokens; reconnect');
      if (tok.expires_at < Date.now() + 60e3 && tok.refresh_token) {
        tok = await exchange(type, { refresh_token: tok.refresh_token }, app.lookup);
        if (!live()) return { ingested: 0 };
        app.run('UPDATE connectors SET tokens_enc=? WHERE user_id=? AND type=?', app.enc(uid, JSON.stringify(tok)), uid, type);
      }
      items = await fetchItems(type, tok.access_token, since);
    } else items = demoItems(type, user, app.fixturesDir);
  } catch (e) {
    if (live()) app.run("UPDATE connectors SET status='error', last_error=? WHERE user_id=? AND type=?", String(e.message).slice(0, 300), uid, type);
    return { ingested: 0, error: e.message };
  }

  const kind = TYPES[type].kind;
  const cutoff = Date.now() - s.lookback_days * DAY;
  let ingested = 0;
  const excludedCal = new Set(s.excluded_calendars.map((x) => x.toLowerCase()));
  const isExcluded = (ev) => !!ev && excludedCal.has(String(ev.calendar || '').toLowerCase());
  if (kind === 'calendar') {
    if (!live()) return { ingested: 0 };
    // cache every event (excluded ones too) so meeting ingest can recognise and skip meetings on excluded calendars
    app.run('UPDATE connectors SET data_enc=? WHERE user_id=? AND type=?', app.enc(uid, JSON.stringify(items)), uid, type);
    for (const src of app.all("SELECT id, title, started_at, participants FROM sources WHERE user_id=? AND type='meeting' AND deleted=0", uid)) {
      const ev = matchEvent(items, src.title, src.started_at);
      const merged = !isExcluded(ev) && withAttendees(JSON.parse(src.participants), ev);
      if (merged) app.run('UPDATE sources SET participants=? WHERE id=? AND user_id=?', JSON.stringify(merged), src.id, uid);
    }
  } else {
    const calEvents = app.all("SELECT data_enc FROM connectors WHERE user_id=? AND type IN ('gcal','mscal') AND status!='disconnected' AND data_enc IS NOT NULL", uid)
      .flatMap((r) => JSON.parse(app.dec(uid, r.data_enc)));
    const excludedLabels = new Set(s.excluded_labels.map((x) => x.toLowerCase()));
    for (const it of items) {
      if (!live()) break; // ACC-4: revoke stops ingest before the next write
      let src;
      if (kind === 'meeting') {
        const ev = matchEvent(calEvents, it.title, it.started_at);
        if (isExcluded(ev)) continue; // CAP-4: meeting sits on an excluded calendar
        const participants = withAttendees(it.participants || [], ev) || it.participants || [];
        src = { type: 'meeting', external_id: it.external_id, title: it.title, started_at: it.started_at, participants, text: it.transcript || null,
          notice: s.bot_auto_invite ? `Aria notetaker joined at ${user.name}'s invitation. Reply 'stop' to remove it.` : null };
      } else {
        const labels = (it.labels || [it.label]).filter(Boolean).map((x) => String(x).toLowerCase());
        if (it.newsletter || labels.some((l) => excludedLabels.has(l)) || !(Date.parse(it.sent_at) >= cutoff)) continue;
        const who = (list, role) => (list || []).filter((p) => p && (p.name || p.email)).map((p) => ({ name: p.name || p.email, email: p.email || null, role }));
        src = { type: 'email', external_id: it.external_id, title: it.subject, started_at: it.sent_at, thread_id: it.thread_id || null,
          participants: [...who([it.from], 'from'), ...who(it.to, 'to'), ...who(it.cc, 'cc')], text: it.body || '' };
      }
      const row = app.one(`INSERT INTO sources (user_id, type, connector, mode, external_id, title, started_at, participants, processing_status, text_enc, thread_id, notice, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id, type, external_id) DO NOTHING RETURNING id`,
      uid, src.type, type, conn.mode, String(src.external_id), String(src.title || '(untitled)').slice(0, 300), src.started_at || null, JSON.stringify(src.participants),
      src.text ? 'pending' : 'no_transcript', app.enc(uid, src.text), src.thread_id || null, src.notice || null, new Date().toISOString());
      if (!row) continue; // already ingested (idempotent on external_id)
      ingested++;
      if (src.text) await app.processSource(uid, row.id);
    }
  }
  if (live()) app.run("UPDATE connectors SET status='connected', last_sync_at=?, last_error=NULL WHERE user_id=? AND type=?", new Date().toISOString(), uid, type);
  return { ingested };
}

function matchEvent(events, title, startedAt) {
  const t = Date.parse(startedAt);
  return events.find((e) => String(e.title).toLowerCase() === String(title).toLowerCase() && Math.abs(Date.parse(e.start) - t) <= 15 * 60e3);
}
function withAttendees(participants, ev) { // returns merged list, or null when nothing new
  if (!ev) return null;
  const have = new Set(participants.map((p) => (p.email || p.name || '').toLowerCase()));
  const add = (ev.attendees || []).filter((a) => a && (a.email || a.name) && !have.has((a.email || a.name).toLowerCase()))
    .map((a) => ({ name: a.name || a.email, email: a.email || null, role: 'attendee' }));
  return add.length ? [...participants, ...add] : null;
}

module.exports = { TYPES, setupOf, authUrl, exchange, fetchItems, demoItems, sync, vttToText };
