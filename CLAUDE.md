# Dazos CC — working rules for AI-assisted development

This repo is the Dazos internal-app skeleton. Read README.md first — it explains
the architecture. These are the rules to follow when changing code here:

- **Follow the house pattern.** New modules are factories (`createXRouter(deps)`
  → `{ router }`) in their own file, mounted in server.js, persisted as one JSON
  file in DATA_DIR, with a `x.test.js` behavioral test. Copy ideas.js; don't invent
  a new structure.
- **Never reassign `ADMIN_EMAILS`** — it's a live array shared by reference with
  every module. Mutate in place. `server-guards.test.js` enforces this.
- **Roles are server-side.** Gate every mutation in the module (`adminEmails`
  includes / module-level roles), never trust the client.
- **Integrations degrade safely.** Unconfigured = clear message / grey dot, never
  a crash or an unhandled rejection.
- **Tests before PR.** `npm test` must pass. Tests boot routers on real ports,
  fake the session with middleware, and mock `globalThis.fetch` / the LLM. A
  mocked `fetch` must pass through non-matching URLs to the real fetch.
- **Don't widen server.js carelessly** — auth middleware ordering matters
  (requireAuth is global; public paths are allowlisted inside it).
- **Secrets stay in env.** Never commit .env or the JSON stores (gitignored);
  never log tokens.
- **UI**: one SPA (public/index.html), Alpine.js, the Dazos palette in `:root`.
  New sections follow the Ideas section's shape (tab + `<main x-show>` + state in
  `app()`).
