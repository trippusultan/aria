# Aria

[![test](https://github.com/trippusultan/aria/actions/workflows/test.yml/badge.svg)](https://github.com/trippusultan/aria/actions/workflows/test.yml) ![node](https://img.shields.io/badge/node-%E2%89%A522.13-black) ![deps](https://img.shields.io/badge/npm%20deps-0-black) ![license](https://img.shields.io/badge/license-MIT-black)

> Every commitment, kept. Launch video: [launch/aria-launch.mp4](launch/aria-launch.mp4) · Built by [@trippusultan](https://github.com/trippusultan)

A personal action assistant. Aria turns your meetings and email into suggested action items. Each one is
tied to the people you spoke with and waits in your inbox until you confirm it. Built from `Aria-PRD-v1.0`.

It runs on Node 22.13+ with no npm dependencies: `node:http`, `node:sqlite` and `node:crypto`, plus a plain JS single-page app.

```bash
npm start      # http://localhost:4180
npm test       # node:test: API acceptance (PRD §20) + extraction/assistant
```

Sign up, open **Settings → Connections** and connect Zoom, Gmail and a calendar. An admin (listed in `ARIA_ADMIN_EMAILS`) sets up each provider once by following the in-app step-by-step guide and pasting its client ID and secret (stored encrypted, no restart); after that everyone connects in one click. Connectors need OAuth apps you
register; Settings shows the exact redirect URI, scopes and env vars for each. To try Aria first, use **Load sample data**. The API contract is in
`CONTRACT.md`; architecture and how-to-change guides are in [DEVELOPING.md](DEVELOPING.md).

## Configuration

| Env | Effect |
|---|---|
| `PORT` | HTTP port (default 4180) |
| `ARIA_DATA_DIR` | SQLite DB, master key and digest outbox (default `./data`) |
| `ARIA_MASTER_KEY` | 64-hex master key for encryption at rest. **In production supply it from outside the data dir.** If unset, it is generated into the data dir. |
| `ANTHROPIC_API_KEY` | Enables LLM extraction and the LLM assistant. Otherwise a deterministic rule-based extractor is used. Use a zero-retention agreement (PRD §13). |
| `ARIA_MODEL` | Model for the above (default `claude-opus-5-5`) |
| `TYPESAFE_API_KEY` | Jev key: routes assistant questions and double-checks suggestions. Falls back to the jev-cli config. Used only for users who turn on Settings → Assistant and AI. |
| `ARIA_JEV_MODEL` | Jev model (default `jev-latest`) |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Switch the Zoom connector from demo to OAuth |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail and Google Calendar OAuth |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Outlook mail and calendar OAuth (Graph) |
| `ARIA_BASE_URL` | Public origin used for OAuth redirect URIs (`<base>/oauth/<type>/callback`) |
| `ARIA_SECURE_COOKIE` | Set when serving over HTTPS |
| `ARIA_ADMIN_EMAILS` | Comma-separated emails that get the org admin role at signup. Nobody else ever does. |
| `ARIA_NO_BACKGROUND` | Disable the 60s sync, retention and digest timers (tests) |

## Deploy

```bash
docker build -t aria . && docker run -p 4180:4180 -v aria-data:/data \
  -e ARIA_MASTER_KEY=<64 hex> -e ARIA_ADMIN_EMAILS=you@company.com -e ARIA_SECURE_COOKIE=1 aria
```

Put it behind HTTPS. `GET /api/healthz` returns `{"ok":true}` for load balancers. Keep the master key out of the data volume.

## Not done yet

- Nothing goes to an external model until a user opts in. Then Jev receives the user's questions, titles, names and excerpts of 400 characters or fewer; Claude (if `ANTHROPIC_API_KEY` is set) receives full transcripts, email bodies and task notes. The operator must hold a zero-retention agreement with each provider (PRD §13).

- The OAuth fetchers for Zoom, Gmail, Graph and Google Calendar are written but have not been run against real accounts.
- The digest email is written to `data/outbox/`. There is no SMTP.
- The meeting bot only records its consent notice. No bot joins meetings.
- SSO/SCIM and email verification are not built. Admin is granted only through `ARIA_ADMIN_EMAILS`.
- Schema changes have no migrations. Delete `data/` after pulling schema changes.

## Launch video

`launch/launch.html` is the motion-graphics source. `node launch/render-launch.mjs` re-renders it (needs Playwright and ffmpeg, which are not dependencies).

## License

MIT
