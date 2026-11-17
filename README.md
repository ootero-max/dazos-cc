# Dazos CC

The Dazos internal-app skeleton. Clone it, rename it, and you start with the whole
boring-but-critical layer already working: **Google login restricted to @dazos.com**,
the **Dazos look & feel**, an **admin-managed access list with roles**, **integration
scaffolds** (Jira, Salesforce, Slack, Claude AI), JSON persistence, tests, and one
**example module** that shows the house pattern to copy.

## Run it locally

```bash
npm install
cp .env.example .env            # fill in what you have; everything optional degrades safely
DEV_NO_AUTH=1 npm run dev       # skips Google login, runs as a local admin
# → http://localhost:3000
npm test
```

`DEV_NO_AUTH=1` is for local dev only — it disables authentication entirely.
For real login you need a Google OAuth client (see `.env.example`).

## What's inside

| File | What it is |
|---|---|
| `server.js` | Express app: OAuth, sessions, roles, settings APIs, integration + module mounts |
| `public/landing.html` | Pre-login page (Dazos branding) |
| `public/index.html` | The SPA: header, hub, example-module UI, settings & profile panels — all house styles live in its `<style>` block |
| `ideas.js` + `ideas.test.js` | **The example module.** Copy these two files to start a new module |
| `jira.js` | Per-user Jira credentials, fetch-with-retry, JQL search, `/api/jira/status` |
| `salesforce.js` | Connected-app client-credentials OAuth, `soql()`, `/api/salesforce/status` |
| `slack.js` | Bot-token channel posts + DMs (safe no-op without `SLACK_BOT_TOKEN`) |
| `ai.js` | Anthropic client + the house `createMessage` retry wrapper |
| `server-guards.test.js` | Guard test for the auth plumbing's sharp edges |
| `render.yaml` | Render deploy blueprint (web service + persistent disk) |

## The house architecture (read before adding code)

- **Modules are factories.** A module is one file exporting
  `createXRouter(deps) → { router, ...accessors }`. It never imports server
  state — everything (data dir, the live `ADMIN_EMAILS` array, `createMessage`,
  Jira creds resolver) arrives as deps. `server.js` mounts it at `/api/x`.
- **Persistence is JSON files in `DATA_DIR`** (Render persistent disk in prod,
  the repo dir locally). One store file per module, loaded at boot, saved on
  every mutation. No database until you genuinely need one.
- **Roles are resolved server-side on every request.** `roleOf(email)`:
  bootstrap admins (env) are always admins; explicit assignments win; access-list
  emails default to member; other @dazos.com logins are viewers (no pages in the
  skeleton — see `VIEWER_ALLOWED`). Never trust a role sent by the client.
- **`ADMIN_EMAILS` is a live array** shared by reference with every module.
  Mutate it in place; never reassign it (a guard test enforces this).
- **Integrations degrade safely.** Unconfigured means a grey dot and a clear
  error message, never a crash. Keep that property in anything you add.
- **Tests are behavioral**: boot the router on a real port, fake the session
  user with middleware, mock only external calls (`globalThis.fetch`, the LLM),
  and assert through the API. `node --test` runs everything.

## Adding a module (the recipe)

1. `cp ideas.js yourmodule.js` — rename the factory, keep the shape.
2. In `server.js`: import it, mount it under `/api/yourmodule` passing deps.
3. In `public/index.html`: add a tab + a `<main x-show="section==='yourmodule'">`
   section + its state/functions in `app()`. Copy the Ideas section.
4. `cp ideas.test.js yourmodule.test.js` and make it test *your* behavior.
5. Add a line to this README.

## Integrations

| Integration | Configure | Then |
|---|---|---|
| **Jira** | Each user connects their own account in the profile menu (Atlassian email + API token). Env `JIRA_EMAIL`/`JIRA_API_TOKEN` is only the cron fallback. | `jiraSearch(jql, fields, basicAuth(creds))`, `GET /api/jira/status`, `GET /api/jira/search?jql=…` |
| **Salesforce** | Connected App with the client-credentials flow + run-as user; set `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`. | `soql("SELECT Id FROM Account LIMIT 5")`, `GET /api/salesforce/status`, `GET /api/salesforce/soql?q=…` |
| **Slack** | Bot token with `chat:write`, `im:write`, `users:read`, `users:read.email`; set `SLACK_BOT_TOKEN`. | `slackDM(email, text)`, `slackChannel(channelId, text)` |
| **Claude AI** | Set `ANTHROPIC_API_KEY` (+ optional `CLAUDE_MODEL`). | `createMessage({ model, max_tokens, messages })` — streams + retries; see the Ideas "✨ improve" endpoint |

The hub's Integrations card shows a live green/grey dot per integration.

## Deploy (Render)

`render.yaml` defines a web service with a persistent disk mounted at `/data`
(`DATA_DIR=/data`). Set the env vars from `.env.example` in the Render dashboard
— at minimum `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
`BOOTSTRAP_ADMINS`, and `WEB_APP_URL` (the public URL, also added as an
authorized redirect URI in Google Cloud Console).
