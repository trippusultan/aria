# Aria MVP — build contract

Source of truth for the three parallel builders. PRD: personal action assistant (meetings + email →
suggested action items → human-confirmed tasks against stakeholders). Decisions (made by Jev):
Node 22 stdlib only (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), vanilla JS SPA,
**zero npm dependencies**; connectors are adapters with a built-in demo/fixture mode plus real OAuth
paths gated on env credentials; extraction uses the Claude API when `ANTHROPIC_API_KEY` is set and a
deterministic rule-based extractor otherwise.

## Files and owners

| File | Owner |
|---|---|
| `package.json`, `CONTRACT.md`, `fixtures/*` | lead (already written, do not rename) |
| `server.js` (http, routing, static, auth, all `/api/*`), `db.js` (schema + crypto), `connectors.js`, `test/api.test.js` | **backend** |
| `engine.js` (extraction, identity resolution, assistant), `test/engine.test.js` | **engine** |
| `public/index.html`, `public/app.js`, `public/app.css` | **frontend** |

Run: `npm start` → `node --no-warnings server.js` on `PORT` (default 4180). Tests: `npm test` →
`node --no-warnings --test test/`. Data lives in `data/` (`ARIA_DATA_DIR` overrides; tests use a temp dir).

## engine.js exports (engine implements, backend calls)

```js
// All async. Never throws on model failure: falls back to rules and sets mode.
extract(input, opts) -> Promise<{ mode: 'llm'|'rules', candidates: Candidate[] }>
  input = { type: 'meeting'|'email'|'manual', title, text, startedAt /* ISO */,
            participants: [{ name, email|null, role?: 'from'|'to'|'cc'|'attendee' }],
            user: { name, email } }
  opts  = { floor = 0.55, rejected: [string] /* titles the user rejected before */, hint?: string /* reprocess "anything I owe Raj" */ }
  Candidate = {
    title,                    // short verb phrase
    owner: 'user'|'counterpart'|'unclear',
    direction: 'i_owe'|'they_owe'|'unclear',   // i_owe = user owes stakeholder
    stakeholders: [{ name, email|null, unverified: boolean }],  // never includes the user
    due: { date: 'YYYY-MM-DD', span: string } | null,           // span = verbatim text that justified it
    excerpt,                  // VERBATIM substring of input.text, <= 400 chars
    offset,                   // index of excerpt in input.text
    speaker: string|null,     // transcript speaker name for the excerpt
    confidence,               // 0..1; candidates below opts.floor are dropped
    rationale                 // one line
  }

resolveStakeholder(name, participants) -> { name, email|null, unverified }
  // roster-first: exact email/full name match; first name linked only if unique in roster; else unverified

assistant(req) -> Promise<{ reply, citations: [{ task_id, title, source_title|null }],
                            proposals: [{ id, action, task_id|null, args, label }] }>
  req = { message, history: [{ role:'user'|'assistant', content }], now /* ISO */, user: { name, email },
          tools: {                       // provided by server, read-only, already scoped to the user
            listTasks(filter)   -> Task[]   // filter: { status?: string[], person?: string /*name substring*/, q?, due?: 'overdue'|'today'|'week', source?: string /*title substring*/, closedSince?: ISO }
            getTask(id)         -> Task|null
            searchSources(q)    -> [{ id, type, title, started_at, excerpt }]
            listPeople()        -> [{ id, display_name, open, waiting, done }]
          } }
  // action ∈ 'set_status' (args {status}) | 'add_note' (args {body}) | 'set_due' (args {due_at|null}) | 'create_task' (args {title, stakeholders:[name], due_at?})
  // Mutations are NEVER applied by engine; they come back as proposals the UI must confirm.
  // Must refuse: other employees' data, inventing commitments, sending mail / joining meetings.
  // "Draft a follow-up to X about Y" -> reply contains the draft text, no proposal (user copies it).
  // "Prep me for my meeting with X" -> open items with X + last source.
  // Every factual line cites a task (title + source). Empty store -> say so, no invented list.
```

## HTTP API (backend implements, frontend calls)

JSON in/out. Auth by cookie `aria_sid` (HttpOnly, SameSite=Lax). Unauthed → 401 `{error}`. Errors → `{error: string}` with 4xx/5xx.
Every content row is keyed by `user_id`; no endpoint ever returns another user's content.

**Auth / account**
- `POST /api/auth/signup {email, password, name}` → `{user}` + cookie. Password ≥ 8 chars.
- `POST /api/auth/login {email, password}` → `{user}` + cookie · `POST /api/auth/logout`
- `GET /api/me` → `{ user: {id, email, name, role:'member'|'admin'}, counts: {open, waiting, overdue, suggested}, demo: boolean /* a demo-mode connector is connected */, push: boolean }`
- `GET /api/sessions` → `[{id, user_agent, ip, created_at, last_seen_at, current}]` · `DELETE /api/sessions/:id`
- `DELETE /api/account {password}` → removes every vault row for the user; audit kept (no content).

**Tasks** (status ∈ `open|in_progress|waiting|completed|cancelled`; `suggested` lives only in suggestions)
- `GET /api/tasks?status=open,waiting&person=<id>&source_type=meeting|email|manual&due=overdue|today|week|none&tag=&direction=i_owe|they_owe|unclear&q=` → `Task[]`.
  No `status` param ⇒ everything except completed/cancelled. Sort: direction, then due date (nulls last), then updated desc.
- `POST /api/tasks {title, body?, direction?, due_at?, priority?, tags?, stakeholders?: [{person_id}|{name}], source_id?}` → Task
- `GET /api/tasks/:id` → Task + `notes: [{id, body, created_at}]`, `activity: [{verb, from_value, to_value, at, actor}]`
- `PATCH /api/tasks/:id {title?, body?, status?, direction?, due_at?|null, priority?|null, tags?, stakeholders?}` → Task (logs Activity)
- `POST /api/tasks/:id/notes {body}` → note (append-only) · `POST /api/tasks/:id/duplicate` → Task · `DELETE /api/tasks/:id`

```
Task = { id, title, body, status, direction, due_at /*YYYY-MM-DD|null*/, priority /*low|med|high|null*/, tags: [],
         visibility: 'private', created_at, updated_at,
         stakeholders: [{ id, display_name, unverified, role }],
         source: { id, type, title, started_at } | null,
         excerpt: { text, start_offset } | null,
         notes_count, last_note: string|null }
```

**Suggestions (inbox)**
- `GET /api/suggestions` (pending, not snoozed; sorted confidence desc) → `Suggestion[]`
- `POST /api/suggestions/:id/accept {edits?: {title?, direction?, due_at?, stakeholders?: [{name}|{person_id}], body?}}` → Task
- `POST /api/suggestions/:id/reject {reason?: 'not_action'|'never_happened'}` · `POST /api/suggestions/:id/merge {task_id}` → Task (excerpt appended as note)
- `POST /api/suggestions/:id/snooze {hours}` · `POST /api/suggestions/bulk-accept` (accepts pending ≥ user's `high_threshold`) → `{accepted: n}`

```
Suggestion = { id, confidence, state, created_at, source: { id, type, title, started_at },
               payload: Candidate /* stakeholders carry person_id when resolved */ }
```

**People** — `GET /api/people` → `[{id, display_name, emails, org_name, unverified, open, waiting, done, last_interaction}]` ·
`GET /api/people/:id` → person + `tasks` + `sources` · `PATCH /api/people/:id {display_name?, emails?, org_name?, unverified?}` ·
`POST /api/people/:id/link {target_id}` (merge unverified into target).

**Sources** — `GET /api/sources` → `[{id, type, title, started_at, participants, processing_status /*pending|done|failed|no_transcript*/, last_error, suggestion_count, task_count, mode}]` ·
`GET /api/sources/:id` → source + `text` (decrypted, owner only) + `suggestions` + `tasks` ·
`POST /api/sources {title, text, participants?: [{name,email}], type:'manual'}` (paste / dropped transcript, CAP-6) ·
`POST /api/sources/:id/reprocess {hint?}` · `DELETE /api/sources/:id` (pending suggestions deleted, tasks kept) ·
`GET /api/sources/:id/raw` (download text) · `GET /api/sources/:id/recap` (markdown of accepted items, EXP-2).

**Connectors** (`zoom|gmail|outlook|gcal|mscal`) — `GET /api/connectors` → `[{type, label, status: 'disconnected'|'connected'|'error', mode: 'demo'|'oauth'|null, configured, setup: {env, redirect_uri, console_url, scopes}, scopes, last_sync_at, last_error}]` ·
`POST /api/connectors/:type/connect` → `{redirect}`, or 409 naming the missing `<PROVIDER>_CLIENT_ID`/`_SECRET` env vars (never demo) ·
`POST /api/sample-data {types?}` → `{loaded}` (demo fixtures; 409 if a real account of that type is connected) · `DELETE /api/sample-data` → `{removed}` ·
`GET /oauth/:type/callback` · `POST /api/connectors/:type/sync` · `DELETE /api/connectors/:type` (revoke: tokens wiped, ingest stops immediately).

**Assistant** — `POST /api/assistant {message, thread_id?}` → `{thread_id, reply, citations, proposals}` ·
`POST /api/assistant/confirm {thread_id, proposal_id}` → `{ok, task}` (the only way an assistant mutation happens) · `GET /api/assistant/threads/:id`.

**Settings / notifications / export / audit / admin**
- `GET|PATCH /api/settings` → `{name, timezone, digest_time, digest_email, waiting_days, low_floor, high_threshold, auto_promote, lookback_days, excluded_labels: [], excluded_calendars: [], retention_days, bot_auto_invite, push_opt_in, external_ai}`
  (defaults: 08:00, true, 5, 0.55, 0.85, false, 14 (≤90), [], [], 90 (7–365), false, false, false). `external_ai` gates every Jev/Claude call.
- `GET /api/notifications` → `[{id, kind, text, link, created_at, read}]` · `POST /api/notifications/read` · `GET /api/digest` → `{overdue, due_today, waiting_stale}` (Task[] each)
- `GET /api/export/tasks.csv` · `GET /api/export/all.json` (portable bundle) — both audited, rate-limited.
- `GET /api/audit` → own audit events `[{action, object, at, ip}]`
- Admin (role admin, granted only to emails in `ARIA_ADMIN_EMAILS`): `GET /api/admin/seats` → `[{email, name, connectors, task_count}]`, `GET /api/admin/audit`. **No admin endpoint returns source text, excerpts, task titles or notes.**

## UI contract (frontend)

Hash routes, filters in the query so views are bookmarkable: `#/home?status=open,waiting&person=3&source_type=email&due=week&q=term`,
`#/inbox`, `#/task/12`, `#/people`, `#/people/3`, `#/sources`, `#/sources/7`, `#/assistant`, `#/settings`, `#/login`, `#/admin`.
Summary strip Open · Waiting · Overdue · Suggested. Rows show title, direction, stakeholder chips (click filters home), source glyph
(Zoom / Mail / Manual) + relative time, due date, one-click status. Suggested items visually unmistakable (badge, dashed border).
Excerpts in a serif blockquote. Keyboard: `/` search, `g h|i|p|s` nav, `j/k` move, `1-5` status (open, in progress, waiting, completed, cancelled),
`n` note, `a`/`e`/`r`/`m`/`z` accept/edit/reject/merge/snooze in inbox, `Ctrl/Cmd+K` assistant. Dark mode (prefers-color-scheme + toggle).
Works at 390px. Calm, dense, adult — trading blotter, not pastel to-do. No confetti. Motion only for accept (row slides out).
Consent copy (PRD Appendix D) shown on signup and in Settings → Privacy.
