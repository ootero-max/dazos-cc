/**
 * Slack helper — bot-token Web API calls shared by server modules.
 * Every function is a safe no-op (returns false, warns once) when
 * SLACK_BOT_TOKEN is unset, so local dev works without Slack.
 *
 * Required bot scopes: chat:write, im:write, users:read, users:read.email.
 */

let warnedNoToken = false;
const token = () => {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t && !warnedNoToken) { console.warn("[SLACK] SLACK_BOT_TOKEN not set — Slack notifications disabled"); warnedNoToken = true; }
  return t || null;
};

// JSON-body call (chat.postMessage, conversations.open, …).
async function api(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

// users.lookupByEmail is a GET-style method — it rejects JSON bodies.
const emailCache = new Map(); // email → user id (null = confirmed no match)
export async function slackUserByEmail(email) {
  if (!token() || !email) return null;
  if (emailCache.has(email)) return emailCache.get(email);
  try {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const data = await res.json();
    const uid = data.ok ? data.user.id : null;
    if (!data.ok && data.error !== "users_not_found") throw new Error(data.error);
    emailCache.set(email, uid);
    return uid;
  } catch (e) { console.warn(`[SLACK] lookupByEmail(${email}) failed: ${e.message}`); return null; }
}

// DM a workspace member by their (login) email. Returns true if delivered.
export async function slackDM(email, text) {
  if (!token()) return false;
  const uid = await slackUserByEmail(email);
  if (!uid) { console.warn(`[SLACK] no Slack user for ${email} — DM skipped`); return false; }
  const open = await api("conversations.open", { users: uid });
  await api("chat.postMessage", { channel: open.channel.id, text, mrkdwn: true, unfurl_links: false });
  return true;
}

// Post to a channel the bot is a member of. Returns true if delivered.
export async function slackChannel(channelId, text) {
  if (!token() || !channelId) return false;
  await api("chat.postMessage", { channel: channelId, text, mrkdwn: true, unfurl_links: false });
  return true;
}
