# Aria

[![test](https://github.com/trippusultan/aria/actions/workflows/test.yml/badge.svg)](https://github.com/trippusultan/aria/actions/workflows/test.yml) ![node](https://img.shields.io/badge/node-%E2%89%A522.13-black) ![deps](https://img.shields.io/badge/npm%20deps-0-black) ![license](https://img.shields.io/badge/license-MIT-black)

Aria reads your meetings and email and suggests the action items in them, each with the exact quote it came from.
Nothing becomes a task until you accept it. Accepted tasks are tracked against the people involved: what you owe
them, what they owe you, and when.

Node 22.13+ with no npm dependencies (`node:http`, `node:sqlite`, `node:crypto`), and a plain JavaScript front end
with no build step.

```bash
npm start      # http://localhost:4180
npm test       # API and engine tests (node:test)
```

Sign up, then choose **Load sample data** to try it with fictional meetings and email. Developer docs are served by
the app at `/docs/`.

## Connecting real accounts

Zoom, Gmail, Outlook and Google/Microsoft Calendar each need an OAuth app, registered once per server:

1. Open **Settings → Connections** as an admin. On a fresh install with no `ARIA_ADMIN_EMAILS`, anyone browsing
   from the server's own machine can do this.
2. Follow the provider's setup steps shown there, and paste the client ID and secret. They are stored encrypted
   and apply without a restart.
3. Every user can then connect that provider in one click.

You can set the `*_CLIENT_ID` / `*_CLIENT_SECRET` env vars below instead. Env vars take precedence.

## Configuration

| Env | Effect |
|---|---|
| `PORT` | HTTP port (default 4180) |
| `ARIA_DATA_DIR` | SQLite DB, master key and digest outbox (default `./data`) |
| `ARIA_MASTER_KEY` | 64-hex master key for encryption at rest. If unset, one is generated into the data dir. In production, supply it from outside the data dir. |
| `ARIA_BASE_URL` | Public origin for OAuth redirect URIs (`<base>/oauth/<type>/callback`) |
| `ARIA_ADMIN_EMAILS` | Comma-separated emails that get the admin role at signup |
| `ARIA_SECURE_COOKIE` | Set when serving over HTTPS |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Zoom OAuth app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail and Google Calendar OAuth app |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Outlook mail and calendar OAuth app (Microsoft Graph) |
| `ANTHROPIC_API_KEY` | Use Claude for extraction and the assistant. Without it, a rule-based extractor runs. |
| `ARIA_MODEL` | Claude model (default `claude-opus-5-5`) |
| `TYPESAFE_API_KEY` | Jev: interprets assistant questions and double-checks suggestions. Falls back to the jev-cli config. |
| `ARIA_JEV_MODEL` | Jev model (default `jev-latest`) |
| `ARIA_NO_BACKGROUND` | Disable the 60 s sync, retention and digest timers (used by tests) |

Claude and Jev are only called for users who turn on **Settings → Assistant and AI**. With it on, Jev receives
questions, task titles, names and excerpts of at most 400 characters; Claude receives full transcripts, email
bodies and notes. Hold a zero-retention agreement with each provider before enabling them.

## Deploy

```bash
docker build -t aria . && docker run -p 4180:4180 -v aria-data:/data \
  -e ARIA_MASTER_KEY=<64 hex> -e ARIA_ADMIN_EMAILS=you@company.com -e ARIA_SECURE_COOKIE=1 aria
```

Serve it behind HTTPS and keep the master key out of the data volume. `GET /api/healthz` returns `{"ok":true}`
for load balancers.

## Limitations

- The OAuth fetchers have not been run against real Zoom, Google or Microsoft accounts yet.
- The morning digest is written to `data/outbox/`. There is no SMTP.
- No bot joins meetings. Aria reads recordings and transcripts after the fact.
- No SSO, SCIM or email verification.
- No schema migrations. Delete `data/` after pulling a schema change.

## Docs

- `/docs/` in the running app: REST API reference and guides
- [DEVELOPING.md](DEVELOPING.md): architecture, data flow and how to make common changes
- [CONTRACT.md](CONTRACT.md): the binding API and module contract

## License

MIT. Built by [@trippusultan](https://github.com/trippusultan).
