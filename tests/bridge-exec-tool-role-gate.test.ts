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
// These tests pin the new bridgeExecToolAllowedForRole() helper to the
// three-tier model (CC directive — admin=technical-write,
// member=business-write, read_only=read-only):
//   - owner/admin    : every registered bridge tool
//   - member         : read-only tools PLUS the business-write tools
//                      (shop_out_send_batch / send_email / send_sms)
//   - read_only/etc  : read-only tools ONLY
//
// 2026-06-11: this file previously asserted member was DENIED the
// business-write tools — it predated the 2026-06-10 member-business
// expansion and was never wired into test:sunbiz, so the stale
// assertion went unnoticed. Rewritten to the live model + added to the
// runner. Same run also fixed bridgeExecToolAllowedForRole, which let
// read_only/unknown roles through to the business tools.

// ---- Technical-write / confidential tools: DENIED for EVERY non-admin
// role, INCLUDING member. They run code, mutate the operator's machine,
// or return operator-repo content. The member-business expansion did
// NOT loosen these.
const NON_MEMBER_DENIED_TOOLS = [
  "bash",
  "write_file",
  "run_script",
  "stripe",
  "supabase",
  "n8n",
  "firecrawl",
  "notebooklm",
  "underwriting_run",
  "install_cli",
  "cli_auth_start",
  // Round-7 confidentiality additions:
  "read_file",
  "load_skill",
  // Round-8 confidentiality additions:
  "list_scripts",
  "list_skills",
];

// ---- Business-write tools: member+ ONLY. Allowed for member; DENIED
// for read_only / unknown / null (they ship real outbound mail).
const MEMBER_BUSINESS_TOOLS = [
  "shop_out_send_batch",
  "send_email",
  "send_sms",
];

// ---- Tools ALLOWED for ANY non-admin role: daemon health only.
const NON_ADMIN_ALLOWED_TOOLS = [
  "cli_status",
];

// Roles below member (or unrecognized) — get read-only tools only.
const READ_ONLY_ROLES: (string | null | undefined)[] = [
  "read_only",
  "loan_officer",
  "processor",
  "viewer",
  "",
  null,
  undefined,
  "garbage_role",
];

// 1. The read-only allowlist matches the documented set verbatim.
assert.deepEqual(
  Array.from(BRIDGE_EXEC_TOOL_READ_ONLY).sort(),
  NON_ADMIN_ALLOWED_TOOLS.slice().sort(),
  "BRIDGE_EXEC_TOOL_READ_ONLY must contain exactly the documented read-only tools (post round-8: cli_status only)",
);

// 2. owner and admin can call every bridge tool (technical + business + read-only).
for (const tool of [...NON_MEMBER_DENIED_TOOLS, ...MEMBER_BUSINESS_TOOLS, ...NON_ADMIN_ALLOWED_TOOLS]) {
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

// 3. member CAN fire the business-write tools (Alex's daily workflow) but
// is DENIED every technical-write / confidential tool.
for (const tool of MEMBER_BUSINESS_TOOLS) {
  assert.ok(
    bridgeExecToolAllowedForRole("member", tool),
    `member MUST be allowed business-write tool '${tool}' — 2026-06-10 CC directive`,
  );
  assert.ok(
    bridgeExecToolAllowedForRole("MEMBER", tool),
    `member role must be case-insensitive for '${tool}'`,
  );
}
for (const tool of NON_MEMBER_DENIED_TOOLS) {
  assert.equal(
    bridgeExecToolAllowedForRole("member", tool),
    false,
    `member MUST be denied technical-write tool '${tool}'`,
  );
}

// 4. read_only / unknown / null roles are DENIED the business-write tools
// AND the technical-write tools — "read_only = read-only".
for (const role of READ_ONLY_ROLES) {
  for (const tool of [...MEMBER_BUSINESS_TOOLS, ...NON_MEMBER_DENIED_TOOLS]) {
    assert.equal(
      bridgeExecToolAllowedForRole(role, tool),
      false,
      `role ${JSON.stringify(role)} MUST be denied write tool '${tool}' (read_only = read-only)`,
    );
  }
}

// 5. Every non-admin role (member included) can still call the read-only tools.
for (const role of [...READ_ONLY_ROLES, "member"]) {
  for (const tool of NON_ADMIN_ALLOWED_TOOLS) {
    assert.ok(
      bridgeExecToolAllowedForRole(role, tool),
      `role ${JSON.stringify(role)} should still be allowed read-only tool '${tool}'`,
    );
  }
}

// 6. Unknown tool names are denied for non-admin (allowlist semantics).
for (const role of [...READ_ONLY_ROLES, "member"]) {
  assert.equal(
    bridgeExecToolAllowedForRole(role, "unregistered_future_tool"),
    false,
    `unknown tools must default to denied for non-admin role ${JSON.stringify(role)}`,
  );
}

// 7. owner/admin CAN call unknown tools (the bridge itself will 404 them
// with "unknown_tool: ..." — that's the right rejection point for admins).
assert.ok(
  bridgeExecToolAllowedForRole("owner", "unregistered_future_tool"),
  "owner should be allowed to call unknown tools; bridge rejects on its end",
);

// ---- 8. Round-7/8 confidentiality regression locks ----
// read_file, load_skill, list_scripts, list_skills must ALL be DENIED
// for every non-admin role — INCLUDING member. The bridge implementations
// reach into operator repo roots and return either content (read_file,
// load_skill) or repo-derived metadata (list_scripts docstrings,
// list_skills frontmatter). No non-admin SunBiz user (member included)
// may harvest CC's empire authored content via these tools.
const CONFIDENTIALITY_DENIED_TOOLS = ["read_file", "load_skill", "list_scripts", "list_skills"];
for (const role of [...READ_ONLY_ROLES, "member"]) {
  for (const tool of CONFIDENTIALITY_DENIED_TOOLS) {
    assert.equal(
      bridgeExecToolAllowedForRole(role, tool),
      false,
      `Codex round-7/8: ${tool} MUST be denied for non-admin role ${JSON.stringify(role)} (operator-repo confidentiality)`,
    );
  }
}
// But owner/admin DO retain access (they need it for normal operator
// workflows where Bravo / Atlas / Maven legitimately read their own files).
for (const role of ["owner", "admin"]) {
  for (const tool of CONFIDENTIALITY_DENIED_TOOLS) {
    assert.ok(
      bridgeExecToolAllowedForRole(role, tool),
      `${role} must retain ${tool} access`,
    );
  }
}

console.log("bridge-exec-tool-role-gate.test.ts: OK");
