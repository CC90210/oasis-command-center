/**
 * delivery-rules.test.ts — the pure rules behind Projects + Tickets.
 * Run: node --conditions=react-server --import tsx tests/delivery-rules.test.ts
 *
 * SLA math, ticket numbering, status transitions, assignee validation (a
 * deactivated or unknown person is never assignable), input validation, what a
 * client may see, and what the public support form may echo into an email.
 */
import assert from "node:assert/strict";
import {
  canTransitionTicket,
  formatTicketNumber,
  isClientVisibleComment,
  isClientVisibleUpdate,
  parseSupportSubmission,
  parseTicketNumber,
  retargetForSeverity,
  safeGreetingName,
  slaStatus,
  slaTargetFor,
  slaTargetPhrase,
  statusTimestampsFor,
  toClientProject,
  toClientTicket,
  validateAssignee,
  validateCommentCreate,
  validateProjectCreate,
  validateProjectPatch,
  validateTicketPatch,
  validateUpdateCreate,
  CLIENT_TICKET_FIELDS,
  TICKET_STATUSES,
} from "../lib/delivery/rules";
import { resolveDeliveryViewer, mayPerform, rowScope, commentScope, updateScope } from "../lib/delivery/access";
import { clientAckEmail, clientReplyEmail, newTicketTelegram } from "../lib/delivery/messages";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

console.log("delivery-rules:");

// ── SLA ────────────────────────────────────────────────────────────────────
const T0 = "2026-09-24T12:00:00.000Z";
check("first-response targets: critical 1h, high 4h, medium 24h, low 72h", () => {
  assert.equal(slaTargetFor(T0, "critical"), "2026-09-24T13:00:00.000Z");
  assert.equal(slaTargetFor(T0, "high"), "2026-09-24T16:00:00.000Z");
  assert.equal(slaTargetFor(T0, "medium"), "2026-09-25T12:00:00.000Z");
  assert.equal(slaTargetFor(T0, "low"), "2026-09-27T12:00:00.000Z");
});
check("the client email states the same targets in words", () => {
  assert.equal(slaTargetPhrase("critical"), "1 hour");
  assert.equal(slaTargetPhrase("high"), "4 hours");
  assert.equal(slaTargetPhrase("medium"), "24 hours");
  assert.equal(slaTargetPhrase("low"), "72 hours");
});
const base = { sla_target: slaTargetFor(T0, "high"), first_response_at: null, status: "open", severity: "high", created_at: T0 };
check("unanswered and early: on_track, minutes remaining", () => {
  const v = slaStatus(base, new Date("2026-09-24T13:00:00.000Z"));
  assert.equal(v.state, "on_track");
  assert.equal(v.minutesRemaining, 180);
});
check("last quarter of the window: at_risk", () => {
  assert.equal(slaStatus(base, new Date("2026-09-24T15:00:00.000Z")).state, "at_risk");
});
check("past the target with no reply: breached, negative minutes", () => {
  const v = slaStatus(base, new Date("2026-09-24T16:30:00.000Z"));
  assert.equal(v.state, "breached");
  assert.equal(v.minutesRemaining, -30);
});
check("a reply on time is responded; after the target is responded_late", () => {
  assert.equal(slaStatus({ ...base, first_response_at: "2026-09-24T15:59:00.000Z" }, new Date("2026-09-30")).state, "responded");
  assert.equal(slaStatus({ ...base, first_response_at: "2026-09-24T16:01:00.000Z" }, new Date("2026-09-30")).state, "responded_late");
});
check("resolved/closed without a reply: the clock no longer applies", () => {
  assert.equal(slaStatus({ ...base, status: "closed" }, new Date("2026-09-30")).state, "closed");
});
check("severity change re-targets an unanswered ticket and clears a stale breach", () => {
  const r = retargetForSeverity({ created_at: T0, first_response_at: null }, "low", new Date("2026-09-24T14:00:00.000Z"));
  assert.deepEqual(r, { sla_target: "2026-09-27T12:00:00.000Z", clearBreach: true });
  const still = retargetForSeverity({ created_at: T0, first_response_at: null }, "critical", new Date("2026-09-24T14:00:00.000Z"));
  assert.equal(still?.clearBreach, false, "a target already in the past keeps the breach");
  assert.equal(retargetForSeverity({ created_at: T0, first_response_at: T0 }, "low", new Date()), null, "an answered ticket's SLA is settled");
});

// ── ticket numbers ─────────────────────────────────────────────────────────
check("T-0001 format, width grows past 9999, round-trips", () => {
  assert.equal(formatTicketNumber(1), "T-0001");
  assert.equal(formatTicketNumber(42), "T-0042");
  assert.equal(formatTicketNumber(9999), "T-9999");
  assert.equal(formatTicketNumber(12345), "T-12345");
  assert.equal(parseTicketNumber("T-0042"), 42);
  assert.equal(parseTicketNumber("t-12345"), 12345);
  assert.equal(parseTicketNumber("T-42"), null);
  assert.equal(parseTicketNumber("T-0000"), null);
  assert.throws(() => formatTicketNumber(0));
  assert.throws(() => formatTicketNumber(1.5));
});

// ── status transitions ─────────────────────────────────────────────────────
check("closed only reopens; same-status is not a transition", () => {
  assert.equal(canTransitionTicket("closed", "open"), true);
  assert.equal(canTransitionTicket("closed", "resolved"), false);
  assert.equal(canTransitionTicket("closed", "in_progress"), false);
  for (const s of TICKET_STATUSES) assert.equal(canTransitionTicket(s, s), false, s);
  assert.equal(canTransitionTicket("open", "resolved"), true);
  assert.equal(canTransitionTicket("resolved", "open"), true);
});
check("resolve stamps resolved_at; close keeps it; reopen clears both", () => {
  const now = "2026-09-25T00:00:00.000Z";
  assert.deepEqual(statusTimestampsFor("resolved", { resolved_at: null }, now), { resolved_at: now, closed_at: null });
  assert.deepEqual(statusTimestampsFor("closed", { resolved_at: T0 }, now), { resolved_at: T0, closed_at: now });
  assert.deepEqual(statusTimestampsFor("closed", { resolved_at: null }, now), { resolved_at: now, closed_at: now });
  assert.deepEqual(statusTimestampsFor("open", { resolved_at: T0 }, now), { resolved_at: null, closed_at: null });
});

// ── assignment ─────────────────────────────────────────────────────────────
const roster = [
  { auth_user_id: "u-cc", full_name: "CC" },
  { auth_user_id: "U-Adon ", full_name: "Adon" },
  { auth_user_id: "u-gone", full_name: "Gone", deactivated_at: "2026-09-20T00:00:00Z" },
];
check("roster members are assignable, trimmed and lowercased", () => {
  assert.deepEqual(validateAssignee("u-cc", roster), { ok: true, value: "u-cc" });
  assert.deepEqual(validateAssignee(" U-ADON", roster), { ok: true, value: "u-adon" });
});
check("unassign is always allowed", () => {
  assert.deepEqual(validateAssignee(null, roster), { ok: true, value: null });
  assert.deepEqual(validateAssignee("", roster), { ok: true, value: null });
});
check("a deactivated teammate is NOT assignable even if a history roster lists them", () => {
  assert.deepEqual(validateAssignee("u-gone", roster), { ok: false, error: "assignee_not_on_roster" });
});
check("someone not on the roster, or a non-string, is refused", () => {
  assert.deepEqual(validateAssignee("u-stranger", roster), { ok: false, error: "assignee_not_on_roster" });
  assert.deepEqual(validateAssignee(42, roster), { ok: false, error: "assignee_invalid" });
  assert.deepEqual(validateAssignee("u-cc", []), { ok: false, error: "assignee_not_on_roster" });
});

// ── validation ─────────────────────────────────────────────────────────────
check("project create: title required, defaults, bad stage/date/email refused", () => {
  assert.equal(validateProjectCreate({}).ok, false);
  const ok = validateProjectCreate({ title: "  Site build ", client_email: "A@B.CO" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.title, "Site build");
    assert.equal(ok.value.stage, "discovery");
    assert.equal(ok.value.priority, "medium");
    assert.equal(ok.value.client_email, "a@b.co", "emails are stored lowercased");
  }
  assert.deepEqual(validateProjectCreate({ title: "x", stage: "qa" }), { ok: false, error: "stage_invalid", field: "stage" });
  assert.deepEqual(validateProjectCreate({ title: "x", due_date: "2026-02-30" }), { ok: false, error: "due_date_invalid", field: "due_date" });
  assert.deepEqual(validateProjectCreate({ title: "x", client_email: "nope" }), { ok: false, error: "client_email_invalid", field: "client_email" });
});
check("patches take only known keys and refuse an empty change", () => {
  assert.deepEqual(validateProjectPatch({ bogus: 1 }), { ok: false, error: "no_changes" });
  assert.deepEqual(validateProjectPatch({ stage: null }), { ok: false, error: "stage_invalid", field: "stage" });
  assert.deepEqual(validateProjectPatch({ archived: true }), { ok: true, value: { archived: true } });
  assert.deepEqual(validateTicketPatch({ status: "done" }), { ok: false, error: "status_invalid", field: "status" });
});
check("an update is internal unless explicitly shared with the client", () => {
  assert.deepEqual(validateUpdateCreate({ body: "hi" }), { ok: true, value: { body: "hi", visibility: "internal" } });
  assert.deepEqual(validateUpdateCreate({ body: "hi", visibility: "client" }), { ok: true, value: { body: "hi", visibility: "client" } });
  assert.equal(validateUpdateCreate({ body: "hi", visibility: "public" }).ok, false);
});
check("team comments default INTERNAL; a client comment is always public", () => {
  assert.deepEqual(validateCommentCreate({ body: "x" }, "team"), { ok: true, value: { body: "x", is_internal: true } });
  assert.deepEqual(validateCommentCreate({ body: "x", is_internal: false }, "team"), { ok: true, value: { body: "x", is_internal: false } });
  assert.deepEqual(validateCommentCreate({ body: "x", is_internal: true }, "client"), { ok: true, value: { body: "x", is_internal: false } });
});

// ── the public support form ────────────────────────────────────────────────
check("support payload: required fields, lowercased email, derived title", () => {
  const r = parseSupportSubmission({
    name: "Jane Doe",
    email: "Jane@Example.COM",
    category: "bug",
    priority: "high",
    description: "Contact form on /pricing returns 500\nsince this morning",
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.email, "jane@example.com");
    assert.equal(r.value.severity, "high");
    assert.equal(r.value.title, "Bug: Contact form on /pricing returns 500");
  }
  assert.equal(parseSupportSubmission({ name: "x", email: "bad", description: "d" }).ok, false);
  assert.equal(parseSupportSubmission({ name: "x", email: "a@b.co" }).ok, false);
});
check("an unknown category/priority degrades instead of refusing the client", () => {
  const r = parseSupportSubmission({ name: "x", email: "a@b.co", description: "d", category: "??", priority: "urgent!!" });
  assert.ok(r.ok && r.value.category === "other" && r.value.severity === "medium");
});
check("the greeting name cannot smuggle a link or markup into our email", () => {
  assert.equal(safeGreetingName("Jane Doe"), "Jane");
  assert.equal(safeGreetingName("Click https://evil.example"), "Click");
  assert.equal(safeGreetingName("https://evil.example now"), "httpsevilexample");
  assert.equal(safeGreetingName("<b>x</b>"), "bxb");
  assert.equal(safeGreetingName(""), "there");
  assert.equal(safeGreetingName("Zoë-Anne O'Neil"), "Zoë-Anne");
});
const ackTicket = {
  id: "t1",
  ticket_number: "T-0007",
  title: "Bug: visit https://evil.example to claim your refund",
  description: "SECRET-DESCRIPTION https://evil.example",
  category: "bug" as const,
  severity: "high" as const,
  status: "open" as const,
  source: "form",
  client_name: "Victim <script>",
  client_email: "victim@example.com",
  client_company: null,
  client_tenant_name: null,
  client_match: "none",
  project_title: null,
  project_hint: null,
  sla_target: slaTargetFor(T0, "high"),
};
check("the client acknowledgement never echoes the title or description (unverified sender)", () => {
  const m = clientAckEmail(ackTicket);
  assert.match(m.subject, /T-0007/);
  assert.match(m.body, /T-0007/);
  assert.match(m.body, /within 4 hours/);
  assert.doesNotMatch(`${m.subject}\n${m.body}`, /evil\.example|SECRET-DESCRIPTION|refund|<script>/);
});
check("a reply email carries the team's words, not the client's title", () => {
  const m = clientReplyEmail(ackTicket, { body: "Fixed, please re-check.", authorName: "CC" });
  assert.match(m.body, /Fixed, please re-check\./);
  assert.doesNotMatch(`${m.subject}\n${m.body}`, /evil\.example/);
});
check("the founders' Telegram alert escapes client-typed HTML", () => {
  const text = newTicketTelegram(ackTicket, "https://x.test/tickets/t1", new Date(T0));
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
});

// ── client visibility ──────────────────────────────────────────────────────
check("client projections are an allowlist: internal fields never leave", () => {
  const t = toClientTicket({
    id: "t1", ticket_number: "T-0001", title: "x", assigned_to: "u-cc", client_match: "email_tenant",
    founder_alert_status: "sent", sla_breached_at: T0, client_email: "c@d.co", reporter_user_id: "u-1", resolution: "r",
  });
  for (const k of ["assigned_to", "client_match", "founder_alert_status", "sla_breached_at", "client_email", "reporter_user_id"]) {
    assert.equal(k in t, false, `${k} leaked`);
  }
  assert.deepEqual(Object.keys(t).sort(), [...CLIENT_TICKET_FIELDS].sort());
  const p = toClientProject({ id: "p", title: "x", assigned_to: "u", client_email: "c@d.co", lead_id: "l", archived_at: null });
  for (const k of ["assigned_to", "client_email", "lead_id"]) assert.equal(k in p, false, `${k} leaked`);
});
check("only an explicit public comment / client update is client-visible", () => {
  assert.equal(isClientVisibleComment({ is_internal: 0 }), true);
  assert.equal(isClientVisibleComment({ is_internal: 1 }), false);
  assert.equal(isClientVisibleComment({ is_internal: null }), false, "NULL fails closed");
  assert.equal(isClientVisibleUpdate({ visibility: "client" }), true);
  assert.equal(isClientVisibleUpdate({ visibility: "internal" }), false);
  assert.equal(isClientVisibleUpdate({ visibility: "Client" }), false);
});

// ── access matrix ──────────────────────────────────────────────────────────
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
check("founder in the OASIS workspace: everything", () => {
  const a = resolveDeliveryViewer({ ok: true, persona: "founder", tenantId: OASIS, userId: "U-CC", canAct: true });
  assert.ok(a.ok && a.viewer.kind === "founder" && a.viewer.userId === "u-cc");
  if (a.ok) for (const act of ["project.create", "ticket.update", "ticket.comment.internal"] as const) assert.equal(mayPerform(a.viewer, act), true);
});
check("every non-founder persona inside OASIS is refused (fail closed)", () => {
  for (const persona of ["manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"] as const) {
    const a = resolveDeliveryViewer({ ok: true, persona, tenantId: OASIS, userId: "u", canAct: true });
    assert.deepEqual(a, { ok: false, status: 403, error: "forbidden" }, persona);
  }
});
check("anyone in another workspace is a CLIENT of that workspace, even its owner", () => {
  const a = resolveDeliveryViewer({ ok: true, persona: "founder", tenantId: "client-x", userId: "u", canAct: true });
  assert.ok(a.ok && a.viewer.kind === "client" && a.viewer.clientTenantId === "client-x");
  if (a.ok) {
    assert.equal(mayPerform(a.viewer, "ticket.create"), true);
    assert.equal(mayPerform(a.viewer, "ticket.comment.public"), true);
    for (const act of ["project.create", "project.update", "task.write", "update.write", "ticket.update", "ticket.comment.internal"] as const) {
      assert.equal(mayPerform(a.viewer, act), false, act);
    }
  }
});
check("a read-only client can read but not write", () => {
  const a = resolveDeliveryViewer({ ok: true, persona: "readonly", tenantId: "client-x", userId: "u", canAct: false });
  assert.ok(a.ok && !mayPerform(a.viewer, "ticket.create"));
});
check("no session: 401", () => {
  assert.deepEqual(resolveDeliveryViewer({ ok: false }), { ok: false, status: 401, error: "not_signed_in" });
});
check("SQL scope: founder pinned to OASIS; client pinned to OASIS AND their workspace", () => {
  assert.deepEqual(rowScope({ kind: "founder", userId: "u", canAct: true }, "t"), { sql: "t.tenant_id = ?", args: [OASIS] });
  assert.deepEqual(rowScope({ kind: "client", userId: "u", clientTenantId: "cx", canAct: true }, "p"), {
    sql: "p.tenant_id = ? AND p.client_tenant_id = ?",
    args: [OASIS, "cx"],
  });
  assert.equal(commentScope({ kind: "client", userId: "u", clientTenantId: "cx", canAct: true }, "c"), "c.is_internal = 0");
  assert.equal(updateScope({ kind: "client", userId: "u", clientTenantId: "cx", canAct: true }, "u"), "u.visibility = 'client'");
  assert.throws(() => rowScope({ kind: "founder", userId: "u", canAct: true }, "t; DROP"));
});

if (failures) {
  console.log(`delivery-rules: ${failures} failure(s)`);
  process.exit(1);
}
console.log("delivery-rules: all passed");
