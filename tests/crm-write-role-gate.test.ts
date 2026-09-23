import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canWriteCrm, READ_ONLY_DENIED_TOOLS } from "../lib/role-gates";

/**
 * CC directive 2026-07-07 (the "Alex can't be assigned / can't self-assign"
 * bug): any RESOLVED non-read_only team role may perform CRM DATA actions —
 * assign / transfer, collaborators, set-stage, promote, notes, documents,
 * e-sign, generate PDFs, create-application, import, bulk stage / assign — on
 * ANY lead in their tenant. This pins the ROLE dimension only; tenant isolation
 * + compliance (CASL/TCPA) gates are enforced separately and unchanged.
 *
 * Automation / agentic (create automations, background workers, drip
 * sequences, per-lead AI) and technical-write bridge tools stay owner/admin —
 * those are NOT governed by canWriteCrm (see isAdmin gates +
 * bridgeExecToolAllowedForRole; locked by bridge-exec-tool-role-gate.test.ts).
 */

// 1. Every resolved non-read_only role can do CRM data actions — the daily job
//    of members (Alex), agents, and admins alike. Case- and space-insensitive.
const WRITABLE_ROLES = [
  "owner", "admin", "member", "loan_officer", "processor",
  "MEMBER", "Owner", " member ", "Loan_Officer",
];
for (const role of WRITABLE_ROLES) {
  assert.ok(
    canWriteCrm(role),
    `role ${JSON.stringify(role)} MUST be allowed CRM write (CC 2026-07-07 member full-CRM-access directive)`,
  );
}

// 2. read_only is read-only; an UNRESOLVED identity (null / undefined / "") OR
//    any UNRECOGNIZED role fails closed (allowlist semantics — Codex adversarial
//    review 2026-07-07). These must never get CRM write.
const DENIED_ROLES: (string | null | undefined)[] = [
  "read_only", "READ_ONLY", " read_only ", "", null, undefined,
  // Unrecognized / future / typo'd roles default to DENIED (allowlist):
  "viewer", "guest", "garbage_role", "administrator", "super_admin",
];
for (const role of DENIED_ROLES) {
  assert.equal(
    canWriteCrm(role),
    false,
    `role ${JSON.stringify(role)} MUST be denied CRM write (read_only = read-only; unresolved = fail-closed)`,
  );
}

assert.equal(
  READ_ONLY_DENIED_TOOLS.has("import_leads_from_attachment"),
  true,
  "a read-only chat user must not receive the lead-import mutation tool",
);

const importRoute = readFileSync("app/api/leads/import/route.ts", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
assert.match(importRoute, /resolveSessionContext\(\)/, "the import route must resolve the caller's role");
assert.match(
  importRoute,
  /!canWriteCrm\(sess\.teamRole\)/,
  "the import route must fail closed for read-only or unknown roles before parsing rows",
);
assert.match(importRoute, /error:\s*"forbidden_role"[\s\S]*status:\s*403/);
assert.match(
  chatRoute,
  /const crmWritesAllowed = canWriteCrm\(operatorRole\)/,
  "chat must apply the same fail-closed role allowlist before exposing mutation tools",
);
assert.match(
  chatRoute,
  /!crmWritesAllowed && READ_ONLY_DENIED_TOOLS\.has\(spec\.name\)/,
  "legacy cloud-tool markers need a dispatcher gate, not only prompt/palette filtering",
);
assert.match(
  chatRoute,
  /!crmWritesAllowed && READ_ONLY_DENIED_MARKERS\.has\(spec\.type\)/,
  "dashboard markers must reject unknown/typo roles as well as exact read_only",
);

console.log("crm-write-role-gate.test.ts: OK");
