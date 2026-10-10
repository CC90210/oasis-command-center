/**
 * tests/describe-automation-flow-bridge-proxy.test.ts
 *
 * BUG 1 (2026-10-10): "Draft with AI" (components/automations/
 * DescribeAutomationFlow.tsx) persisted its generated script by POSTing
 * from the BROWSER straight to `${BRIDGE_CHAT_BASE}/exec-tool` (defaults to
 * http://127.0.0.1:9100) — i.e. whatever computer the VIEWER's browser
 * happens to be running on. Only CC's PC runs that local bridge, so for
 * Adon (or anyone else on the shared OASIS workspace) the save half of the
 * flow failed every time, with no way to fix it from his own machine.
 *
 * The fix routes the write through the same-origin, authenticated server
 * proxy that already exists for exactly this (app/api/bridge/exec-tool/
 * route.ts): the SERVER holds the bridge bearer and reaches the paired
 * machine, so it works the same way for every signed-in owner.
 *
 * This pins, source-level (the component is a "use client" module; this
 * repo's convention for those is a source-text check, not execution —
 * see tests/settings-bridge-consistency.test.ts):
 *   1. the component posts to "/api/bridge/exec-tool", not a direct bridge URL;
 *   2. no direct BRIDGE_CHAT_BASE / 127.0.0.1 fetch remains in the file;
 *   3. the proxy it now calls still gates every tool_name (including
 *      write_file, the exact tool this flow calls) through the same
 *      role allowlist a non-admin cannot pass (lib/role-gates.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/describe-automation-flow-bridge-proxy.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeExecToolAllowedForRole } from "../lib/role-gates";

const ROOT = join(__dirname, "..");

const src = readFileSync(
  join(ROOT, "components", "automations", "DescribeAutomationFlow.tsx"),
  "utf8",
);

assert.ok(
  src.includes('fetch("/api/bridge/exec-tool"'),
  "DescribeAutomationFlow must POST the authenticated same-origin bridge proxy",
);
assert.ok(
  !/\bBRIDGE_CHAT_BASE\b/.test(src),
  "DescribeAutomationFlow must not import or read BRIDGE_CHAT_BASE — that resolves to whichever " +
    "computer the VIEWER's browser is running on, not the paired machine",
);
assert.ok(
  !/127\.0\.0\.1/.test(src),
  "DescribeAutomationFlow must not fetch a loopback bridge address directly from the browser",
);
// "New automations land switched off" must survive the fix untouched.
assert.match(src, /New automations land switched off/);

// The proxy must still enforce its role gate on the exact tool this flow
// calls. write_file is a technical-write tool (bridge-registry name) —
// admin+ only — so a member / read_only / unknown role must never be able
// to write an arbitrary file path to the operator's paired machine through
// this save flow.
const routeSrc = readFileSync(
  join(ROOT, "app", "api", "bridge", "exec-tool", "route.ts"),
  "utf8",
);
assert.ok(
  routeSrc.includes("bridgeExecToolAllowedForRole(auth.teamRole, toolName)"),
  "the exec-tool proxy must still gate every tool_name through the role allowlist",
);

for (const role of ["member", "read_only", "loan_officer", "processor", "", null, undefined, "garbage_role"]) {
  assert.equal(
    bridgeExecToolAllowedForRole(role as string | null | undefined, "write_file"),
    false,
    `role ${JSON.stringify(role)} must be denied write_file through /api/bridge/exec-tool`,
  );
}
assert.ok(
  bridgeExecToolAllowedForRole("owner", "write_file") && bridgeExecToolAllowedForRole("admin", "write_file"),
  "owner/admin must retain write_file so Draft with AI can still save",
);

console.log("describe-automation-flow-bridge-proxy.test.ts: OK");
