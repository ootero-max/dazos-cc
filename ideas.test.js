/**
 * Ideas module — behavioral tests (node --test). This is the house test
 * pattern: boot the router on a real HTTP port with a fake session user,
 * mock only what's external (the LLM), assert behavior through the API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createIdeasRouter } from "./ideas.js";

const ADMIN = "admin@dazos.com";
const MEMBER = "member@dazos.com";

function makeApp(deps = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-ideas-"));
  const current = { email: MEMBER };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: current.email } }; next(); });
  app.use("/api/ideas", createIdeasRouter({ dataDir, adminEmails: [ADMIN], ...deps }).router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/ideas`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  return { api, current, cleanup: () => { server.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("ideas: create, search, vote toggle, admin-only delete + audit", async (t) => {
  const { api, current, cleanup } = makeApp();
  t.after(cleanup);

  // create (members can)
  assert.equal((await api("POST", "/", {})).status, 400); // title required
  const made = await api("POST", "/", { title: "Dark mode", details: "Night shift asked for it" });
  assert.equal(made.status, 200);
  const ideaId = made.data.idea.id;
  await api("POST", "/", { title: "Faster exports" });

  // list + search
  assert.equal((await api("GET", "/")).data.total, 2);
  const hit = await api("GET", "/?q=dark");
  assert.equal(hit.data.total, 1);
  assert.equal(hit.data.ideas[0].title, "Dark mode");

  // vote toggles per user
  assert.equal((await api("POST", `/${ideaId}/vote`)).data.votes, 1);
  assert.equal((await api("POST", `/${ideaId}/vote`)).data.votes, 0);
  await api("POST", `/${ideaId}/vote`);
  current.email = ADMIN;
  assert.equal((await api("POST", `/${ideaId}/vote`)).data.votes, 2);

  // delete: members 403, admins ok; audit records it
  current.email = MEMBER;
  assert.equal((await api("DELETE", `/${ideaId}`)).status, 403);
  assert.equal((await api("GET", "/audit")).status, 403);
  current.email = ADMIN;
  assert.equal((await api("DELETE", `/${ideaId}`)).status, 200);
  assert.equal((await api("GET", "/")).data.total, 1);
  const audit = (await api("GET", "/audit")).data;
  assert.equal(audit[0].action, "idea_deleted");
  assert.equal(audit[0].by, ADMIN);
});

test("ideas: AI assist rewrites via createMessage; 503 when AI not configured", async (t) => {
  const prompts = [];
  const fakeLLM = async (params) => {
    prompts.push(params.messages[0].content);
    return { content: [{ type: "text", text: JSON.stringify({ title: "Dark mode for night-shift users", details: "Care teams work overnight; a dark theme reduces eye strain." }) }] };
  };
  const { api, cleanup } = makeApp({ createMessage: fakeLLM, model: "test-model" });
  t.after(cleanup);

  const made = await api("POST", "/", { title: "dark mode???", details: "pls" });
  const improved = await api("POST", `/${made.data.idea.id}/improve`);
  assert.equal(improved.status, 200);
  assert.equal(improved.data.idea.title, "Dark mode for night-shift users");
  assert.ok(improved.data.idea.ai_improved_at);
  assert.match(prompts[0], /dark mode\?\?\?/);

  // without AI: clean 503, not a crash
  const noAi = makeApp();
  t.after(noAi.cleanup);
  const m2 = await noAi.api("POST", "/", { title: "x" });
  assert.equal((await noAi.api("POST", `/${m2.data.idea.id}/improve`)).status, 503);
});
