/**
 * Jira helper — authenticated fetch with retry/backoff against the Atlassian
 * cloud REST API, plus a tiny router with a connection test and a sample search.
 *
 * Credentials are PER USER: each person connects their own Jira account
 * (email + API token) from the profile menu; the server stores them in
 * settings.json and resolves them via the getJiraCreds dep. Env creds
 * (JIRA_EMAIL / JIRA_API_TOKEN) are only the fallback for crons.
 */
import express from "express";

const JIRA_CLOUD = process.env.JIRA_CLOUD_ID || "ceba56f1-ef80-41bb-b30f-102b42d9b7a0";
export const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "https://dazos.atlassian.net";
export const JIRA_BASE = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD}/rest/api/3`;

export const basicAuth = (creds) => "Basic " + Buffer.from(`${creds.jiraEmail}:${creds.jiraToken}`).toString("base64");

/** Fetch a Jira REST URL with retry/backoff on 429/5xx and network errors. */
export async function fetchJiraWithRetry(url, auth, { attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1000 * (i + 1))); continue; }
    if (r.status === 429 || r.status >= 500) {
      const retryAfter = Number(r.headers?.get?.("retry-after")) || (i + 1) * 2;
      lastErr = new Error(`Jira ${r.status}`);
      await new Promise(res => setTimeout(res, Math.min(retryAfter, 15) * 1000));
      continue;
    }
    return r;
  }
  throw lastErr || new Error("Jira request failed");
}

/** Paginated JQL search (new /search/jql endpoint). Returns raw issues. */
export async function jiraSearch(jql, fields, auth, maxPages = 5) {
  const issues = [];
  let nextPageToken = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ jql, maxResults: "100", fields: fields.join(",") });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const r = await fetchJiraWithRetry(`${JIRA_BASE}/search/jql?${params}`, auth);
    if (!r.ok) throw new Error(`Jira search failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken && ++pages < maxPages);
  return issues;
}

/**
 * Router: /api/jira/status (whoami with the caller's creds) and
 * /api/jira/search?jql= (sample search — summary/status only).
 * deps: { getJiraCreds(email) → {jiraEmail, jiraToken} | null }
 */
export function createJiraRouter({ getJiraCreds }) {
  const router = express.Router();
  const credsFor = (req) => getJiraCreds(req.session?.user?.email);

  router.get("/status", async (req, res) => {
    const creds = credsFor(req);
    if (!creds) return res.json({ configured: false });
    try {
      const r = await fetchJiraWithRetry(`${JIRA_BASE}/myself`, basicAuth(creds), { attempts: 1 });
      if (!r.ok) return res.json({ configured: true, ok: false, error: `Jira says ${r.status} — check the token` });
      const me = await r.json();
      res.json({ configured: true, ok: true, accountName: me.displayName || creds.jiraEmail, site: JIRA_SITE_URL });
    } catch (e) { res.json({ configured: true, ok: false, error: e.message }); }
  });

  router.get("/search", async (req, res) => {
    const creds = credsFor(req);
    if (!creds) return res.status(400).json({ error: "jira_creds_missing", message: "Connect Jira in your profile menu first" });
    const jql = String(req.query.jql || "").trim();
    if (!jql) return res.status(400).json({ error: "jql query parameter required" });
    try {
      const issues = await jiraSearch(jql, ["summary", "status", "issuetype"], basicAuth(creds), 1);
      res.json({ total: issues.length, issues: issues.map(i => ({
        key: i.key, summary: i.fields?.summary || "", status: i.fields?.status?.name || "",
        type: i.fields?.issuetype?.name || "", url: `${JIRA_SITE_URL}/browse/${i.key}`,
      })) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return { router };
}
