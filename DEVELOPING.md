# Developing Aria

How the code fits together and how to change it safely. For running and configuring the app, see
[README.md](README.md). For every HTTP endpoint and payload shape, see [CONTRACT.md](CONTRACT.md), which is the
binding API spec. Change it first, in the same commit as the code.

## Ground rules

- **No npm dependencies.** Use Node 22.13+ built-ins only: `node:http`, `node:sqlite` (`DatabaseSync`),
  `node:crypto` and `node:test`. If you're about to add a package, write the ~20 lines instead.
- **Every content row is keyed by `user_id`, and every query filters on it.** There is no org-wide content query.
  The one org-level view (admin) returns metadata only.
- **Suggestions never become tasks on their own.** The only exception is the user's `auto_promote` setting. The assistant proposes; only
  `POST /api/assistant/confirm` changes anything.
- **Precision over recall.** When the extractor is unsure, it drops the item or marks the owner `unclear`. Excerpts must be verbatim.
- Deliberate shortcuts are marked `// ponytail: <ceiling>, <upgrade path>`. Run `grep -rn "ponytail:" *.js` for the list.

## Layout

| File | Lines | Role |
|---|---|---|
| `server.js` | ~1000 | `createServer()`: HTTP, static files, auth/sessions, every `/api/*` route, the processing pipeline, background timers |
| `db.js` | ~145 | `open(dataDir)`: SQLite schema, master key, per-user AES-256-GCM `enc`/`dec` |
| `connectors.js` | ~230 | Zoom / Gmail / Outlook / Google & MS Calendar: demo (fixtures) or OAuth, plus `sync()` |
| `engine.js` | ~615 | `extract()` (rules or Claude), `resolveStakeholder()`, `assistant()`, `parseDue()` |
| `public/` | ~2000 | Plain JS SPA: `index.html`, `app.js` (hash router + `h()` DOM helper), `app.css` |
| `fixtures/` | | Demo meetings, mail and calendar. `{{USER_NAME}}`, `{{USER_EMAIL}}` and `{{USER_FIRST}}` are filled per user |
| `test/` | | `api.test.js` (HTTP, real engine) and `engine.test.js` (extraction + assistant with fake tools) |

## Data flow

```
connector sync ──► source row (text encrypted) ──► processSource()
   (connectors.js)                                 │  engine.extract(input, {floor, rejected, hint})
                                                   │  resolve stakeholders → people rows
                                                   ▼
                                     suggestions (pending) + excerpts + notification
                                                   │  user: accept / edit / reject / merge / snooze
                                                   ▼
                                     task + task_people + activity + notes
                                                   ▲
      assistant(): read-only tools ──► proposals ──┘ applied only by /api/assistant/confirm
```

1. **Ingest.** `sync(app, uid, type)` in `connectors.js` fetches items (fixtures in demo mode, provider APIs in OAuth
   mode). Before each write it re-checks that the connector is still connected, so a revoke stops ingest immediately.
   Items are idempotent on `(user_id, type, external_id)`. Deleted sources are kept as tombstones so they never come back.
   Newsletters, excluded labels and excluded calendars are skipped here.
2. **Process.** `processSource()` in `server.js` decrypts the text and calls `engine.extract()` with the user's
   `low_floor`, previously rejected titles (for personal "not an action" learning) and the user's timezone. Each
   stakeholder is matched to a `people` row by email, then by name; otherwise a new person marked unverified is created. Candidates
   whose title was already accepted, merged or rejected are dropped. Status becomes `done`, `failed` (with `last_error`)
   or `no_transcript`.
3. **Triage.** `planAccept()` validates first, including the rule that at least one stakeholder is required, then
   `acceptSuggestion()` writes the task inside one `tx()`. Bulk accept does the whole batch in a single
   transaction and skips invalid items.
4. **Assistant.** The server builds read-only `tools` (`listTasks`, `getTask`, `searchSources`, `listPeople`), already
   scoped to the user. It passes them to `engine.assistant()` and stores the returned proposals on the thread. Confirm applies one
   proposal exactly once; a second confirm returns 409.

## Data model

Tables are in `db.js`: `users`, `settings`, `sessions`, `connectors`, `people`, `sources`, `excerpts`, `suggestions`,
`tasks`, `task_people`, `notes`, `activity`, `chat_threads`, `notifications` and `audit_events`. They follow PRD §12.

Encrypted at rest (`BLOB` columns or encrypted JSON): source text, connector tokens and cached data, excerpt text,
suggestion payloads, note bodies and chat messages. Each user's key is derived with HKDF from the master key and a random per-user
`key_salt`. Deleting the account deletes the salt, which makes any leftover ciphertext unreadable.

**Migrations.** There are none. Schema is `CREATE TABLE IF NOT EXISTS`, so any schema change means deleting `data/`
locally. Before real users, add a `PRAGMA user_version` step in `db.js open()`.

## Security model (what not to break)

| Concern | Where |
|---|---|
| Passwords | scrypt + salt, timing-safe compare, dummy hash for unknown emails |
| Sessions | random token in the `aria_sid` cookie (HttpOnly, SameSite=Lax); only its sha256 is stored; 12h idle timeout, refreshed on activity |
| CSRF | SameSite, plus an `Origin` check, plus bodies must be `Content-Type: application/json` |
| Isolation | `taskRow`, `sugRow`, `srcRow`, `personRow` and `threadRow` look rows up by `id AND user_id`. Use them; never `SELECT ... WHERE id=?` alone |
| Admin | `/api/admin/*` returns seats, connector status, counts and `admin.%` audit only. Never titles, notes, excerpts or text |
| Headers | CSP `script-src 'self'`, nosniff, `frame-ancestors 'none'`. The SPA never uses `innerHTML` with data |
| Export | CSV cells starting with `= + - @` get a `'` prefix; exports are rate-limited and audited |
| Secrets | `ARIA_MASTER_KEY` belongs outside `data/` in production; tokens and keys never go into logs |

## Common changes

### Add an API route

In `createServer()`:

```js
route('GET', '/api/things/:id', (c) => {
  const t = taskRow(c.uid, id(c));        // user-scoped lookup, 404s for other users
  return { id: t.id };                    // returned value is sent as JSON
}, { auth: true });                        // default; { auth: false } for public routes
```

`c` gives you `c.uid`, `c.body` (parsed JSON), `c.query` (query string), `c.p` (path params) and `c.ip`. Validate input with the helpers
at the top of `server.js` (`str`, `oneOf`, `dateOrNull`, `strList`, `num`, `bool`). To fail, call `fail(status, message)`, which
throws `{error}`. Add the route to `CONTRACT.md` and a test to `test/api.test.js`.

### Add a connector

1. Add an entry to `TYPES` (label, `kind`: meeting, email or calendar, `provider`, minimal **read-only** scopes) and,
   if needed, to `PROVIDERS` (auth and token URLs, env prefix for `<PREFIX>_CLIENT_ID` / `_SECRET`).
2. Teach `fetchItems()` to return the common item shape used by `demoItems()`: `external_id`, `title` or
   `subject`, a timestamp, participants and text.
3. Add fixtures so demo mode and the tests exercise it. The frontend picks up new connectors from
   `GET /api/connectors` automatically.

### Change extraction

- **Rules mode** is `rulesExtract()`, with `units()`, `sentences()` and `classify()`, then `finish()`, which applies the floor,
  rejected titles, hint and stakeholder resolution. Commitment phrasings and action verbs are deliberately narrow lists.
  Extend them with a fixture sentence and an `engine.test.js` assertion first.
- **LLM mode** (`ANTHROPIC_API_KEY` set) uses `callClaude()` with a forced tool schema. `validateLLM()` then drops any
  excerpt that isn't a verbatim substring of 20 or more characters and any due date that doesn't round-trip or whose span isn't in the text. Any error falls back to rules.
- Dates: `parseDue(text, baseISO, tz)` resolves relative days against the source's local day in the user's timezone.

### Change the assistant

`assistantRules()` works by intent matching, in order: guard (refusals) → mutations → follow-up draft → prep → "did I
promise" → listings. Every task line goes through `line()` and `cite()` so citations stay grounded. Mutations **must**
return proposals, never call a write. `assistantLLM()` gets the same tools as Anthropic tool definitions, at most 5 rounds,
and drops citations of task ids no tool returned.

### Frontend

`public/app.js` has no build step. It uses `h(tag, attrs, ...kids)` to build elements with text content only, `api(method, path, body)`
for every request (errors become toasts; a 401 resets the session), and a hash router where filters live in the query
so views can be bookmarked. Keyboard handlers ignore keys while you type in inputs. Give re-rendered controls a `data-fk` so focus
survives a re-render. The CSP forbids inline scripts, so use no inline handlers.

## Testing

```bash
npm test                                         # all (42 tests, ~1.5 s)
node --no-warnings --test test/engine.test.js    # engine only
node --no-warnings --test --test-name-pattern "revoke" test/api.test.js
```

- The API tests start `createServer({dataDir: <temp>, rateLimits})` on port 0 with background timers off. Each test
  signs up its own users, so tests don't share state. Keep it that way.
- The engine tests run with `ANTHROPIC_API_KEY` unset. The LLM path is covered by swapping `fetch` for a fake.
- Write the failing test before the fix. Every review fix so far has a regression test.

## Debugging

- To reset data, stop the server and delete `data/`, or point `ARIA_DATA_DIR` at a temp dir.
- To inspect the DB: `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/aria.db');console.table(d.prepare('select id,title,processing_status,last_error from sources').all())"`.
  Encrypted columns show as blobs by design.
- A source stuck in `failed`: read `last_error` on the Sources page, then use **Retry** (`POST /api/sources/:id/reprocess`).
- Set `ARIA_NO_BACKGROUND=1` to stop the 60 s sync, digest and retention timers while you debug.
