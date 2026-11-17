/**
 * Guard: the skeleton's sharp edges in server.js (source-level, no boot).
 * ADMIN_EMAILS is a LIVE array shared by reference with module routers — it
 * must be mutated in place (never reassigned) or role changes silently stop
 * reaching the modules. Auth wiring and module mounts must stay intact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("server.js auth & mount plumbing stays intact", () => {
  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");

  // Live admin list: mutated in place, never reassigned
  assert.ok(src.includes("ADMIN_EMAILS.length = 0"), "syncAdmins must clear ADMIN_EMAILS in place");
  assert.ok(src.includes("ADMIN_EMAILS.push("), "syncAdmins must refill ADMIN_EMAILS in place");
  assert.ok(!/\bADMIN_EMAILS\s*=(?!=)/.test(src.replace("const ADMIN_EMAILS =", "")),
    "ADMIN_EMAILS must never be reassigned — modules hold a reference to the array");

  // Auth essentials
  assert.ok(src.includes("function roleOf("), "roleOf missing");
  assert.ok(src.includes("app.use(requireAuth)"), "requireAuth must be applied globally");
  assert.ok(src.includes("const SAFE_RETURN"), "SAFE_RETURN open-redirect guard missing");
  assert.ok(src.includes('role === "viewer"'), "viewer confinement missing");
  assert.ok(src.includes('"/api/settings/roles/:email"'), "role assignment route missing");

  // Integration + module mounts
  for (const mount of ['app.use("/api/jira"', 'app.use("/api/salesforce"', 'app.use("/api/ideas"', '"/api/integrations/status"']) {
    assert.ok(src.includes(mount), `mount missing: ${mount}`);
  }
  // Modules receive the live array itself
  assert.ok(src.includes("adminEmails: ADMIN_EMAILS"), "modules must receive adminEmails: ADMIN_EMAILS");
});
