/**
 * Ideas — the EXAMPLE module. Copy this file (and ideas.test.js) to start a
 * new module; it demonstrates every house pattern:
 *
 *   - Factory `createIdeasRouter(deps)` returning { router, ...accessors } —
 *     the module never imports server state; everything arrives as deps.
 *   - JSON store in DATA_DIR (one file per module), loaded at boot, saved on
 *     every mutation. No database.
 *   - Role gating inside the module: admins (live adminEmails array from
 *     server.js) can do everything; members create/vote; destructive actions
 *     are admin-only.
 *   - An AI endpoint that degrades cleanly when AI isn't configured.
 *   - An audit trail on mutations (who/when/what).
 *
 * Mounted at /api/ideas by server.js.
 */
import express from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const id = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const nowISO = () => new Date().toISOString();

export function createIdeasRouter(deps) {
  const { dataDir, adminEmails, createMessage, model } = deps;
  const FILE = join(dataDir, "ideas.json");
  const router = express.Router();

  let store;
  try {
    store = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { ideas: [], audit: [] };
    if (!Array.isArray(store.ideas)) store.ideas = [];
    if (!Array.isArray(store.audit)) store.audit = [];
  } catch (e) { console.warn(`[IDEAS] store load failed, seeding fresh: ${e.message}`); store = { ideas: [], audit: [] }; }
  const save = () => { try { writeFileSync(FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error(`[IDEAS] save failed: ${e.message}`); } };

  const userEmail = (req) => req.session?.user?.email || "";
  const isAdmin = (req) => adminEmails.includes(userEmail(req));
  const audit = (req, action, extra = {}) => {
    store.audit.unshift({ id: id("aud_"), at: nowISO(), by: userEmail(req), action, ...extra });
    store.audit = store.audit.slice(0, 500);
  };
  const find = (req, res) => {
    const it = store.ideas.find(x => x.id === req.params.id);
    if (!it) { res.status(404).json({ error: "idea not found" }); return null; }
    return it;
  };

  // List, newest first, optional text search.
  router.get("/", (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    let rows = store.ideas;
    if (q) rows = rows.filter(i => [i.title, i.details, i.created_by].some(v => String(v || "").toLowerCase().includes(q)));
    res.json({ ideas: rows, total: rows.length });
  });

  router.post("/", (req, res) => {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "title required" });
    const idea = {
      id: id("idea_"), title: title.slice(0, 200),
      details: String(req.body?.details || "").trim().slice(0, 4000),
      votes: [], created_by: userEmail(req), created_at: nowISO(),
    };
    store.ideas.unshift(idea);
    audit(req, "idea_created", { idea: idea.id, detail: idea.title });
    save(); res.json({ ok: true, idea });
  });

  // Vote toggles: one vote per user, voting again removes it.
  router.post("/:id/vote", (req, res) => {
    const it = find(req, res); if (!it) return;
    const who = userEmail(req);
    it.votes = it.votes.includes(who) ? it.votes.filter(v => v !== who) : [...it.votes, who];
    save(); res.json({ ok: true, votes: it.votes.length, my_vote: it.votes.includes(who) });
  });

  // Destructive → admin only, with an audit record.
  router.delete("/:id", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    const it = find(req, res); if (!it) return;
    store.ideas = store.ideas.filter(x => x.id !== it.id);
    audit(req, "idea_deleted", { idea: it.id, detail: it.title });
    save(); res.json({ ok: true });
  });

  // AI assist: sharpen the pitch. Degrades to 503 when AI isn't configured.
  router.post("/:id/improve", async (req, res) => {
    const it = find(req, res); if (!it) return;
    if (typeof createMessage !== "function") return res.status(503).json({ error: "AI not configured" });
    try {
      const msg = await createMessage({
        model, max_tokens: 1000,
        messages: [{ role: "user", content:
`Rewrite this internal product idea as a crisp pitch. Respond with ONLY a JSON object, no markdown fences:
{"title": "sharper title, max 12 words", "details": "2-4 sentences: the problem, the idea, who benefits"}

IDEA TITLE: ${it.title}
DETAILS: ${it.details || "(none)"}` }],
      });
      const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      it.title = String(parsed.title || it.title).slice(0, 200);
      it.details = String(parsed.details || it.details).slice(0, 4000);
      it.ai_improved_at = nowISO();
      audit(req, "idea_improved", { idea: it.id, detail: it.title });
      save(); res.json({ ok: true, idea: it });
    } catch (e) { res.status(502).json({ error: `AI assist failed: ${e.message}` }); }
  });

  router.get("/audit", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    res.json(store.audit);
  });

  return { router, count: () => store.ideas.length };
}
