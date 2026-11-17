/**
 * Salesforce helper — OAuth2 client-credentials flow against a Connected App.
 *
 * Setup (Salesforce admin):
 *   Setup → App Manager → New Connected App → enable OAuth, check
 *   "Enable Client Credentials Flow", set a run-as integration user,
 *   then copy the Consumer Key/Secret into SALESFORCE_CLIENT_ID/SECRET
 *   and the org's My Domain URL into SALESFORCE_INSTANCE_URL.
 *
 * Safe when unconfigured: sfEnabled() is false, soql() throws a clear error.
 */
import express from "express";

const API_VERSION = "v62.0";
const cfg = () => ({
  instance: (process.env.SALESFORCE_INSTANCE_URL || "").replace(/\/$/, ""),
  clientId: process.env.SALESFORCE_CLIENT_ID || "",
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET || "",
});

export function sfEnabled() {
  const c = cfg();
  return !!(c.instance && c.clientId && c.clientSecret);
}

// Access-token cache: Salesforce tokens live for a session; refresh on 401.
let cached = null; // { token, instanceUrl, at }

async function getToken(force = false) {
  const c = cfg();
  if (!sfEnabled()) throw new Error("Salesforce not configured (set SALESFORCE_INSTANCE_URL / CLIENT_ID / CLIENT_SECRET)");
  if (cached && !force && Date.now() - cached.at < 30 * 60 * 1000) return cached;
  const r = await fetch(`${c.instance}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Salesforce auth failed (${r.status}): ${data.error_description || data.error || "no token"}`);
  cached = { token: data.access_token, instanceUrl: (data.instance_url || c.instance).replace(/\/$/, ""), at: Date.now() };
  return cached;
}

/** Authenticated GET against the REST API (path starts with /services/…). Retries once on 401. */
export async function sfGet(path) {
  let t = await getToken();
  let r = await fetch(`${t.instanceUrl}${path}`, { headers: { Authorization: `Bearer ${t.token}` } });
  if (r.status === 401) { t = await getToken(true); r = await fetch(`${t.instanceUrl}${path}`, { headers: { Authorization: `Bearer ${t.token}` } }); }
  if (!r.ok) throw new Error(`Salesforce ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** Run a SOQL query; follows nextRecordsUrl pagination. Returns all records. */
export async function soql(query, maxPages = 5) {
  let data = await sfGet(`/services/data/${API_VERSION}/query?q=${encodeURIComponent(query)}`);
  const records = [...(data.records || [])];
  let pages = 0;
  while (!data.done && data.nextRecordsUrl && ++pages < maxPages) {
    data = await sfGet(data.nextRecordsUrl);
    records.push(...(data.records || []));
  }
  return records;
}

/** Router: /api/salesforce/status (live connection test) and /api/salesforce/soql?q= (sample query). */
export function createSalesforceRouter() {
  const router = express.Router();

  router.get("/status", async (req, res) => {
    if (!sfEnabled()) return res.json({ configured: false });
    try {
      const versions = await sfGet("/services/data/");
      res.json({ configured: true, ok: true, apiVersions: versions.length, instance: cfg().instance });
    } catch (e) { res.json({ configured: true, ok: false, error: e.message }); }
  });

  router.get("/soql", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "q query parameter required (a SOQL query)" });
    if (!/^select\s/i.test(q)) return res.status(400).json({ error: "only SELECT queries are allowed here" });
    try {
      const records = await soql(q);
      res.json({ total: records.length, records: records.slice(0, 200) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return { router };
}
