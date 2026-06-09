import assert from "node:assert/strict";
import {
  bridgeExecToolAllowedForRole,
  BRIDGE_EXEC_TOOL_READ_ONLY,
} from "../lib/role-gates";

// Codex audit 2026-06-09 round-3 [critical] regression: the previous
// /api/bridge/exec-tool role gate reused bridgeDisallowedToolsForRole()
// which returns Claude CLI PascalCase tool names (Bash, Write, Edit, ...).
// The bridge /exec-tool dispatcher uses lowercase snake_case names
// (bash, write_file, send_email, run_script, ...). The exact-match check
// never fired, so a non-admin POST with tool_name='bash' went through.
//
// These tests pin the new bridgeExecToolAllowedForRole() helper to:
//   - allow owner/admin to call every registered bridge tool
//   - deny every mutating bridge tool for non-owner/admin
//   - allow read-only bridge tools (read_file, list_*, cli_status, load_skill)
//     for any role since they have no side effects
//
// If a future hand re-introduces the PascalCase mistake, these tests
// fail on the actual dispatched namespace.

// ---- Tools DENIED for non-admin roles ----
// Codex round-7 [high] added read_file + load_skill to this list. Both
// are read-only on the local filesystem but the bridge implementation
// allows reads under all registered agent repo roots (Bravo/Atlas/Maven/
// Aura/Hermes). A non-admin SunBiz user must NOT be able to read CC's
// empire code, brain notes, or memory via these tools.
const NON_ADMIN_DENIED_TOOLS = [
  // Round-3 deny list (mutating / dangerous):
  "bash",
  "write_file",
  "send_email",
  "send_sms",
  "run_script",
  "stripe",
  "supabase",
  "n8n",
  "firecrawl",
  "notebooklm",
  "underwriting_run",
  "shop_out_send_batch",
  "install_cli",
  "cli_auth_start",
  // Round-7 confidentiality additions:
  "read_file",
  "load_skill",
];

// ---- Tools ALLOWED for non-admin roles (post round-7) ----
// Only enumerate-without-content + status. No file contents, no
// invocation-able skill bodies.
const NON_ADMIN_ALLOWED_TOOLS = [
  "list_scripts",
  "list_skills",
  "cli_status",
];

// 1. The read-only allowlist matches the documented set verbatim.
assert.deepEqual(
  Array.from(BRIDGE_EXEC_TOOL_READ_ONLY).sort(),
  NON_ADMIN_ALLOWED_TOOLS.slice().sort(),
  "BRIDGE_EXEC_TOOL_READ_ONLY must contain exactly the documented read-only tools",
);

// 2. owner and admin can call every bridge tool (mutating + read-only).
for (const tool of [...NON_ADMIN_DENIED_TOOLS, ...NON_ADMIN_ALLOWED_TOOLS]) {
  assert.ok(
    bridgeExecToolAllowedForRole("owner", tool),
    `owner must be allowed to call '${tool}'`,
  );
  assert.ok(
    bridgeExecToolAllowedForRole("admin", tool),
    `admin must be allowed to call '${tool}'`,
  );
  assert.ok(
    bridgeExecToolAllowedForRole("OWNER", tool),
    `owner role must be case-insensitive ('OWNER' must allow '${tool}')`,
  );
}

// 3. Every other role (read_only, member, loan_officer, processor, null,
// undefined, empty string, garbage) is DENIED every mutating bridge tool.
const NON_ADMIN_ROLES: (string | null | undefined)[] = [
  "read_only",
  "member",
  "loan_officer",
  "processor",
  "viewer",
  "",
  null,
  undefined,
  "garbage_role",
];
for (const role of NON_ADMIN_ROLES) {
  for (const tool of NON_ADMIN_DENIED_TOOLS) {
    assert.equal(
      bridgeExecToolAllowedForRole(role, tool),
      false,
      `role ${JSON.stringify(role)} MUST be denied mutating tool '${tool}' — Codex audit 2026-06-09 round-3 [critical]`,
    );
  }
}

// 4. Non-admin roles can still call the read-only tools (so a read_only
// employee can use the chat to inspect leads / files / status).
for (const role of NON_ADMIN_ROLES) {
  for (const tool of NON_ADMIN_ALLOWED_TOOLS) {
    assert.ok(
      bridgeExecToolAllowedForRole(role, tool),
      `role ${JSON.stringify(role)} should still be allowed read-only tool '${tool}'`,
    );
  }
}

// 5. Unknown tool names are denied for non-admin (allowlist semantics).
for (const role of NON_ADMIN_ROLES) {
  assert.equal(
    bridgeExecToolAllowedForRole(role, "unregistered_future_tool"),
    false,
    `unknown tools must default to denied for non-admin role ${JSON.stringify(role)}`,
  );
}

// 6. owner/admin CAN call unknown tools (the bridge itself will 404 them
// with "unknown_tool: ..." — that's the right rejection point for admins).
assert.ok(
  bridgeExecToolAllowedForRole("owner", "unregistered_future_tool"),
  "owner should be allowed to call unknown tools; bridge rejects on its end",
);

// ---- 7. Round-7 confidentiality regression locks ----
// read_file and load_skill must be DENIED for every non-admin role.
// The bridge tools.py implementation reads under all registered agent
// repo roots (Bravo/Atlas/Maven/Aura/Hermes). A non-admin SunBiz user
// must not be able to read CC's empire code via these tools.
for (const role of NON_ADMIN_ROLES) {
  for (const tool of ["read_file", "load_skill"]) {
    assert.equal(
      bridgeExecToolAllowedForRole(role, tool),
      false,
      `Codex round-7 [high]: ${tool} MUST be denied for non-admin role ${JSON.stringify(role)} (operator-repo confidentiality)`,
    );
  }
}
// But owner/admin DO retain access (they need it for normal operator
// workflows where Bravo / Atlas / Maven legitimately read their own files).
for (const role of ["owner", "admin"]) {
  assert.ok(
    bridgeExecToolAllowedForRole(role, "read_file"),
    `${role} must retain read_file access`,
  );
  assert.ok(
    bridgeExecToolAllowedForRole(role, "load_skill"),
    `${role} must retain load_skill access`,
  );
}

console.log("bridge-exec-tool-role-gate.test.ts: OK");
