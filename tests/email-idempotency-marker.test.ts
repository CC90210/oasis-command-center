/**
 * A merchant receipt that is suppressed because the idempotency read FAILED must
 * leave a visible row, not vanish into a console line.
 *
 * This is a behavioural test, not a source-text one: it drives the real exported
 * function with a fake client whose `lead_interactions` SELECT errors, and it is
 * run RED first (before the fix, no insert is attempted at all). Proving the
 * guard fires is the whole point — see memory/feedback_prove_the_guard_fires.md.
 */
import assert from "node:assert/strict";
import { maybeSendApplicationReceivedEmail } from "../lib/forms/next-steps-email";

type Insert = { table: string; row: Record<string, unknown> };

/**
 * Minimal stand-in for the PostgREST builder: chainable, thenable, and it
 * resolves to whatever the per-table handler returns. Only the shapes this code
 * path actually uses are implemented.
 */
function makeDb(opts: { interactionsSelectErrors: boolean; inserts: Insert[] }) {
  const { inserts } = opts;

  const resultFor = (table: string, op: string): { data: unknown; error: unknown } => {
    if (table === "lead_interactions" && op === "select") {
      return opts.interactionsSelectErrors
        ? { data: null, error: { message: "connection reset by peer", code: "57P01" } }
        : { data: [], error: null };
    }
    if (table === "tenant_records" && op === "select") {
      // `email` is the field loadHandoffContext actually reads. `assigned_to` is
      // deliberately absent so resolveAssignedAgent short-circuits without
      // reaching the team/roster lookups — this test is about the gate, not CC.
      return {
        data: { data: { email: "merchant@example.com", contact_name: "Dana Merchant" } },
        error: null,
      };
    }
    if (table === "tenants" && op === "select") {
      return {
        data: { slug: "submissions", name: "SunBiz Funding", custom_fields: null },
        error: null,
      };
    }
    // email_suppressions and anything else: benign empty result.
    return { data: null, error: null };
  };

  const from = (table: string) => {
    let op = "select";
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: chain,
      neq: chain,
      ilike: chain,
      contains: chain,
      order: chain,
      limit: chain,
      in: chain,
      gte: chain, // alreadySent's resend-window filter (2026-08-18)
      like: chain, // reservation deterministic-winner check (2026-08-18)
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        inserts.push({ table, row });
        return builder;
      },
      update: () => {
        op = "update";
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      maybeSingle: async () => resultFor(table, op),
      single: async () => resultFor(table, op),
      then: (
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resultFor(table, op)).then(onFulfilled, onRejected),
    });
    return builder;
  };

  return { from } as unknown as Parameters<typeof maybeSendApplicationReceivedEmail>[0]["db"];
}

const baseInput = (db: ReturnType<typeof makeDb>) => ({
  db,
  form: { id: "form-1", tenant_id: "tenant-1", slug: "full-application" },
  link: { tenant: "submissions", lead_id: "lead-1" },
  payload: {} as Record<string, unknown>,
  origin: "https://oasisai.work",
});

async function main() {
  // 1) The failure case: the idempotency read errors, so the send is suppressed
  //    (fail-closed is correct) — but it MUST be recorded.
  const failInserts: Insert[] = [];
  await maybeSendApplicationReceivedEmail(
    baseInput(makeDb({ interactionsSelectErrors: true, inserts: failInserts })) as never,
  );

  const marker = failInserts.find(
    (i) =>
      i.table === "lead_interactions" &&
      (i.row.metadata as Record<string, unknown> | undefined)?.send_error ===
        "idempotency_check_failed",
  );
  assert.ok(
    marker,
    "a suppressed receipt must leave a lead_interactions row, not disappear into a console log",
  );

  const meta = marker.row.metadata as Record<string, unknown>;
  assert.equal(meta.status, "failed", "the marker must read as a FAILURE, not a send");
  assert.equal(meta.sent_at, null, "a suppressed receipt was never sent");
  assert.equal(meta.needs_operator_review, true, "a lost merchant receipt needs a human");
  assert.equal(marker.row.tenant_id, "tenant-1", "the marker must stay tenant-scoped");
  assert.equal(marker.row.lead_id, "lead-1");
  assert.equal(marker.row.to_email, "merchant@example.com");
  assert.equal(
    marker.row.agent_source,
    "form_intake_application_received",
    "the marker must carry the variant's source so it also suppresses a duplicate",
  );
  assert.ok(
    !String(marker.row.subject).toLowerCase().startsWith("application received"),
    "the marker subject must NOT satisfy another variant's subject-prefix idempotency check",
  );

  // 2) No merchant email may be sent on that path.
  assert.ok(
    !failInserts.some(
      (i) => (i.row.metadata as Record<string, unknown> | undefined)?.status === "sent",
    ),
    "suppression must remain fail-closed — no send is recorded",
  );

  // 3) The healthy case must NOT write a spurious failure marker.
  const okInserts: Insert[] = [];
  await maybeSendApplicationReceivedEmail(
    baseInput(makeDb({ interactionsSelectErrors: false, inserts: okInserts })) as never,
  );
  assert.ok(
    !okInserts.some(
      (i) =>
        (i.row.metadata as Record<string, unknown> | undefined)?.send_error ===
        "idempotency_check_failed",
    ),
    "a successful idempotency check must never record a check failure",
  );

  console.log("email idempotency marker tests passed");
}

void main();
