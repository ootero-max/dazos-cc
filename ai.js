/**
 * Claude AI helper — one shared Anthropic client + the house retry wrapper.
 * Safe to import when ANTHROPIC_API_KEY is unset: aiEnabled() is false and
 * createMessage throws a clear "AI not configured" error.
 */
import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";

let client = null;
export function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

/**
 * House wrapper around messages.create: streams (so long generations don't hit
 * idle timeouts), retries transient network failures, returns the final message.
 * Usage: const msg = await createMessage({ model: CLAUDE_MODEL, max_tokens: 4000, messages: [...] });
 */
export async function createMessage(params, options) {
  if (!aiEnabled()) throw new Error("AI not configured (set ANTHROPIC_API_KEY)");
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.messages.stream(params, { timeout: 600000, ...options }).finalMessage();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retriable = /premature close|ECONNRESET|socket hang up|terminated|fetch failed|network|aborted|ETIMEDOUT|EPIPE/i.test(msg);
      if (attempt < maxAttempts && retriable) {
        console.warn(`[LLM] attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 120)}); retrying in ${attempt}s…`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

/** Plain text of a model response (ignores tool-use blocks). */
export function llmText(msg) {
  return (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
