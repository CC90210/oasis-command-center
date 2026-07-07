import assert from "node:assert/strict";
import { canWriteCrm } from "../lib/role-gates";

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

console.log("crm-write-role-gate.test.ts: OK");
