/**
 * Dazos CC — internal app skeleton.
 *
 * What's here (and the house rules it demonstrates):
 *   - Google OAuth login restricted to the access list; roles admin/member/viewer
 *     resolved server-side on EVERY request (promotions apply without re-login).
 *   - Settings panel APIs: access list, role assignment, per-user Jira creds.
 *   - Integration scaffolds mounted under /api/*: Jira, Salesforce, Slack, Claude AI —
 *     each a safe no-op until its env/creds are configured.
 *   - One example module (ideas.js) mounted the house way: a factory that takes
 *     deps and returns { router } — copy it to add your own modules.
 *   - JSON stores in DATA_DIR (Render persistent disk in prod, repo dir locally).
 *
 * Add a module: create yourmodule.js (copy ideas.js), import its factory here,
 * mount it under /api/yourmodule, add a section to public/index.html, and a
 * yourmodule.test.js. Keep module state inside the module; pass deps in.
 */

import "dotenv/config";
import express from "express";
import session from "express-session";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createIdeasRouter } from "./ideas.js";
import { createJiraRouter } from "./jira.js";
import { createSalesforceRouter, sfEnabled } from "./salesforce.js";
import { aiEnabled, createMessage, CLAUDE_MODEL } from "./ai.js";
import { slackDM, slackChannel } from "./slack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Persistent data path ──────────────────────────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET       = process.env.SESSION_SECRET || "dazos-cc-session-secret";
const APP_URL              = process.env.WEB_APP_URL || `http://localhost:${PORT}`;
const ALLOWED_EMAILS       = (process.env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
// LOCAL DEV ONLY: set DEV_NO_AUTH=1 to bypass Google login and run as a fake admin.
// Never set this in production — it disables all authentication.
const DEV_NO_AUTH          = process.env.DEV_NO_AUTH === "1";
const DEV_USER_EMAIL       = (process.env.DEV_USER_EMAIL || "dev@dazos.com").toLowerCase();

// ── Roles & settings store ────────────────────────────────────────────────────
// BOOTSTRAP_ADMINS are always admins and can always log in — set them in env.
// ADMIN_EMAILS is a LIVE array shared by reference with every module router:
// it must be mutated in place (never reassigned) or role changes silently stop
// reaching the modules.
const BOOTSTRAP_ADMINS = (process.env.BOOTSTRAP_ADMINS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS = [...BOOTSTRAP_ADMINS];
const ROLES = ["admin", "member", "viewer"];
const SETTINGS_EMPTY = { allowedEmails: [], roles: {}, jiraUsers: {}, updatedAt: null, updatedBy: null };
let settings = { ...SETTINGS_EMPTY };

function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      settings = { ...SETTINGS_EMPTY, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) };
      console.log(`Loaded settings: ${settings.allowedEmails.length} allowed emails`);
    } else {
      settings.allowedEmails = [...ALLOWED_EMAILS];
      saveSettings("system");
      console.log(`Settings seeded from ALLOWED_EMAILS env (${settings.allowedEmails.length} emails)`);
    }
    syncAdmins();
    const missingAdmins = ADMIN_EMAILS.filter(e => !settings.allowedEmails.includes(e));
    if (missingAdmins.length) { settings.allowedEmails.unshift(...missingAdmins); saveSettings("system"); }
  } catch (e) { console.error("Settings load error:", e.message); }
}
// Rebuild the live ADMIN_EMAILS array from bootstrap admins + assigned admin roles.
function syncAdmins() {
  const next = [...BOOTSTRAP_ADMINS];
  for (const [em, role] of Object.entries(settings.roles || {})) {
    if (role === "admin" && !next.includes(em)) next.push(em);
  }
  ADMIN_EMAILS.length = 0;
  ADMIN_EMAILS.push(...next);
}
// Effective role: bootstrap admins are always admin; an explicit assignment wins;
// anyone on the access list defaults to member. Viewers (any other @dazos.com
// login) have NO pages in the skeleton — add viewer-safe paths to
// VIEWER_ALLOWED when your app grows a public-ish page (see the PM agent's
// /feature-requests and /roadmap for the pattern).
function roleOf(email) {
  if (!email) return null;
  if (BOOTSTRAP_ADMINS.includes(email)) return "admin";
  if (settings.roles?.[email]) return settings.roles[email];
  if (settings.allowedEmails.includes(email)) return "member";
  if (email.endsWith("@dazos.com")) return "viewer";
  return null;
}
function saveSettings(by) {
  try {
    settings.updatedAt = new Date().toISOString();
    settings.updatedBy = by || "system";
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) { console.error("Settings save error:", e.message); }
}
loadSettings();

// Resolve Jira credentials: per-user first, then env fallback (crons).
function getJiraCreds(userEmail) {
  const userCreds = settings.jiraUsers?.[userEmail];
  if (userCreds?.jiraEmail && userCreds?.jiraToken) return userCreds;
  if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
    return { jiraEmail: process.env.JIRA_EMAIL, jiraToken: process.env.JIRA_API_TOKEN };
  }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.set("trust proxy", 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: APP_URL.startsWith("https"), httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// Paths a logged-out visit may round-trip through Google OAuth back to.
// An allowlist, never arbitrary input — the state param can't become an open redirect.
const SAFE_RETURN = (p) => ["/"].includes(p);
// Pages/APIs a viewer (non-allowlisted @dazos.com login) may use. Empty in the
// skeleton — viewers see an access page until you add viewer-safe paths.
const VIEWER_ALLOWED = [];

function requireAuth(req, res, next) {
  if (DEV_NO_AUTH) {
    if (!req.session.user) req.session.user = { email: DEV_USER_EMAIL, name: "Local Dev", picture: "" };
    if (!ADMIN_EMAILS.includes(DEV_USER_EMAIL)) { ADMIN_EMAILS.push(DEV_USER_EMAIL); }
    return next();
  }
  const pub = ["/auth/google", "/auth/google/callback", "/auth/logout", "/auth/error", "/health", "/landing.html"];
  if (pub.some(p => req.path.startsWith(p))) return next();
  if (req.session?.user) {
    // Role is resolved live on every request, so promotions/demotions in the
    // Settings panel apply immediately without a re-login.
    const role = roleOf(req.session.user.email);
    if (!role) { // access revoked since login
      req.session.destroy(() => {});
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
      return res.redirect("/");
    }
    if (role === "viewer" && !VIEWER_ALLOWED.includes(req.path)) {
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: "viewer account — this requires a member or admin role" });
      return res.redirect(`/auth/error?reason=viewer&email=${encodeURIComponent(req.session.user.email)}`);
    }
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  if (req.path === "/" || req.path === "") return res.sendFile(join(__dirname, "public", "landing.html"));
  res.redirect("/");
}
app.use(requireAuth);

function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.session?.user?.email)) return res.status(403).json({ error: "Admin access required" });
  next();
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.send("GOOGLE_CLIENT_ID not configured.");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_URL}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  if (SAFE_RETURN(req.query.return)) params.set("state", req.query.return);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/auth/google");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_URL}/auth/google/callback`, grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect("/auth/error?reason=token");
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();
    const email = user.email?.toLowerCase();
    // Role resolved HERE, server-side, from the Google-confirmed email.
    const role = roleOf(email);
    if (!role) return res.redirect(`/auth/error?reason=unauthorized&email=${encodeURIComponent(email || "")}`);
    if (role === "viewer") {
      // No viewer pages in the skeleton — explain instead of a blank redirect loop.
      return res.redirect(`/auth/error?reason=viewer&email=${encodeURIComponent(email)}`);
    }
    req.session.user = { email, name: user.name, picture: user.picture };
    console.log(`[AUTH] ${email} logged in (${role})`);
    res.redirect(SAFE_RETURN(req.query.state) ? req.query.state : "/");
  } catch (e) { console.error("OAuth error:", e); res.redirect("/auth/error?reason=exception"); }
});

app.get("/auth/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.get("/auth/error", (req, res) => {
  const { reason, email = "" } = req.query;
  const msg = reason === "unauthorized"
    ? `<strong style="color:#fff">${email}</strong> is not on the access list. Ask an admin to add you.`
    : reason === "viewer"
      ? `<strong style="color:#fff">${email}</strong> has viewer access only — this app has no viewer pages yet. Ask an admin for member access.`
      : "Authentication failed. Please try again.";
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b1929">
    <div style="text-align:center;max-width:420px;padding:40px;background:#132840;border:1px solid #1e3d5c;border-radius:16px">
      <div style="font-size:48px;margin-bottom:16px">🔒</div>
      <h2 style="color:#fff;margin-bottom:8px">Access Denied</h2>
      <p style="color:#8aaccc;margin-bottom:24px">${msg}</p>
      <a href="/auth/google" style="background:#00aaff;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600">Try Again</a>
    </div></body></html>`);
});

// ── Session info ──────────────────────────────────────────────────────────────
app.get("/api/me", (req, res) => {
  const u = req.session.user;
  res.json({ email: u.email, name: u.name || u.email, picture: u.picture || "", role: roleOf(u.email) || (DEV_NO_AUTH ? "admin" : null), isAdmin: ADMIN_EMAILS.includes(u.email) });
});

// ── Settings API (admin only) ─────────────────────────────────────────────────
app.get("/api/settings", requireAdmin, (req, res) => {
  const users = settings.allowedEmails.map(em => {
    const creds = settings.jiraUsers?.[em];
    return {
      email: em, role: roleOf(em), bootstrap: BOOTSTRAP_ADMINS.includes(em),
      jiraEmail: creds?.jiraEmail || "", hasJiraCreds: !!(creds?.jiraEmail && creds?.jiraToken),
    };
  });
  res.json({ allowedEmails: settings.allowedEmails, users, roles: ROLES });
});

app.post("/api/settings/emails/add", requireAdmin, (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
  if (settings.allowedEmails.includes(email)) return res.status(400).json({ error: "Email already in the access list" });
  settings.allowedEmails.push(email);
  const role = req.body.role;
  if (ROLES.includes(role) && role !== "member") {
    if (!settings.roles) settings.roles = {};
    settings.roles[email] = role;
    syncAdmins();
  }
  saveSettings(req.session?.user?.email);
  res.json({ ok: true, allowedEmails: settings.allowedEmails });
});

app.delete("/api/settings/emails/:email", requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  if (BOOTSTRAP_ADMINS.includes(email)) return res.status(400).json({ error: "Cannot remove a bootstrap admin" });
  const idx = settings.allowedEmails.indexOf(email);
  if (idx === -1) return res.status(404).json({ error: "Email not found" });
  settings.allowedEmails.splice(idx, 1);
  if (settings.roles?.[email]) { delete settings.roles[email]; syncAdmins(); }
  saveSettings(req.session?.user?.email);
  res.json({ ok: true, allowedEmails: settings.allowedEmails });
});

app.post("/api/settings/roles/:email", requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const role = req.body.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(", ")}` });
  if (BOOTSTRAP_ADMINS.includes(email)) return res.status(400).json({ error: "Bootstrap admins are always admins" });
  if (!settings.allowedEmails.includes(email)) return res.status(404).json({ error: "Email is not on the access list" });
  if (!settings.roles) settings.roles = {};
  if (role === "member") delete settings.roles[email]; // member is the default for listed emails
  else settings.roles[email] = role;
  syncAdmins();
  saveSettings(req.session?.user?.email);
  res.json({ ok: true, email, role });
});

// ── Per-user Jira credentials (self-service, from the profile menu) ──────────
app.get("/api/jira-creds", (req, res) => {
  const email = req.session?.user?.email;
  const creds = getJiraCreds(email);
  const userCreds = settings.jiraUsers?.[email];
  res.json({ hasCredentials: !!creds, jiraEmail: userCreds?.jiraEmail || creds?.jiraEmail || "" });
});

app.post("/api/jira-creds", (req, res) => {
  const email = req.session?.user?.email;
  const { jiraEmail, jiraToken } = req.body;
  if (!jiraEmail?.trim() || !jiraToken?.trim()) return res.status(400).json({ error: "Jira email and API token are required" });
  if (!settings.jiraUsers) settings.jiraUsers = {};
  settings.jiraUsers[email] = { jiraEmail: jiraEmail.trim().toLowerCase(), jiraToken: jiraToken.trim() };
  saveSettings(email);
  res.json({ ok: true });
});

app.delete("/api/jira-creds", (req, res) => {
  const email = req.session?.user?.email;
  if (settings.jiraUsers?.[email]) { delete settings.jiraUsers[email]; saveSettings(email); }
  res.json({ ok: true });
});

// ── Integrations ──────────────────────────────────────────────────────────────
const jira = createJiraRouter({ getJiraCreds });
app.use("/api/jira", jira.router);

const salesforce = createSalesforceRouter();
app.use("/api/salesforce", salesforce.router);

// One glance: which integrations are configured (per-user for Jira).
app.get("/api/integrations/status", (req, res) => {
  res.json({
    jira: { configured: !!getJiraCreds(req.session?.user?.email), site: process.env.JIRA_SITE_URL || "https://dazos.atlassian.net" },
    salesforce: { configured: sfEnabled() },
    slack: { configured: !!process.env.SLACK_BOT_TOKEN },
    ai: { configured: aiEnabled(), model: CLAUDE_MODEL },
  });
});

// ── Modules ───────────────────────────────────────────────────────────────────
// The example module. Copy ideas.js + this mount to add your own.
const ideas = createIdeasRouter({
  dataDir: DATA_DIR,
  adminEmails: ADMIN_EMAILS,          // the LIVE array — never reassign it
  createMessage: aiEnabled() ? createMessage : null,
  model: CLAUDE_MODEL,
});
app.use("/api/ideas", ideas.router);

// slackDM / slackChannel are imported and ready for your modules' notifications:
// e.g. slackDM(userEmail, "Your idea shipped!") — a no-op until SLACK_BOT_TOKEN is set.
void slackDM; void slackChannel;

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.use(express.static(join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dazos CC running on ${APP_URL} (data: ${DATA_DIR})`);
  if (DEV_NO_AUTH) console.log(`⚠️  DEV_NO_AUTH=1 — AUTH DISABLED, running as ${DEV_USER_EMAIL}. LOCAL DEV ONLY — never use in production.`);
  if (!BOOTSTRAP_ADMINS.length && !DEV_NO_AUTH) console.warn("⚠️  BOOTSTRAP_ADMINS is empty — nobody can administer this app.");
});
