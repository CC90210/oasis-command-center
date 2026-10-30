/**
 * Cloud dashboard-email sender contract.
 *
 * Runs entirely in memory: no credentials, provider, or production database.
 * The fixture mirrors the two queue families the retired PC process owned.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OASIS_DASHBOARD_EMAIL_SENDER_SWITCH,
  dashboardEmailCredentialReadiness,
  dashboardEmailIdempotencyKey,
  dashboardEmailSenderEnabled,
  dashboardEmailStaleSending,
  isDashboardEmailLane,
  runDashboardEmailSender,
  type DashboardEmailCasExpected,
  type DashboardEmailCasWrite,
  type DashboardEmailQueueRow,
  type DashboardEmailReceipt,
  type DashboardEmailSenderStore,
} from "../lib/leads/dashboard-email-sender";
import { SupabaseDashboardEmailSenderStore } from "../lib/leads/dashboard-email-sender-store";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const NOW = new Date("2026-10-29T23:00:00.000Z");

function metadata(row: DashboardEmailQueueRow): Record<string, unknown> {
  return typeof row.metadata === "string"
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : { ...(row.metadata ?? {}) };
}

function row(overrides: Partial<DashboardEmailQueueRow> = {}): DashboardEmailQueueRow {
  return {
    id: crypto.randomUUID(),
    tenant_id: OASIS,
    lead_id: crypto.randomUUID(),
    type: "email_queued",
    channel: "email",
    direction: "outbound",
    agent_source: "dashboard_drawer",
    provider: null,
    provider_message_id: null,
    subject: "A useful subject",
    content: "A useful body",
    content_preview: "A useful body",
    to_email: "prospect@example.com",
    metadata: { status: "queued", preserve_me: "yes" },
    created_at: "2026-10-29T22:00:00.000Z",
    sent_at: null,
    ...overrides,
  };
}

class MemoryStore implements DashboardEmailSenderStore {
  readonly rows = new Map<string, DashboardEmailQueueRow>();
  readonly receipts = new Map<string, DashboardEmailReceipt>();
  mutations = 0;

  constructor(rows: DashboardEmailQueueRow[]) {
    for (const value of rows) this.rows.set(value.id, structuredClone(value));
  }

  private eligible(statuses: string[]): DashboardEmailQueueRow[] {
    return [...this.rows.values()]
      .filter((value) => isDashboardEmailLane(value))
      .filter((value) => statuses.includes(String(metadata(value).status ?? "")))
      .map((value) => structuredClone(value));
  }

  async listRunnable(now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    return this.eligible(["queued", "retry"])
      .filter((value) => {
        const md = metadata(value);
        if (md.status !== "retry") return true;
        const due = Date.parse(String(md.next_attempt_at ?? ""));
        return !Number.isFinite(due) || due <= now.getTime();
      })
      .slice(0, limit);
  }

  async listStaleSending(_now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    // The production adapter performs due queries plus a bounded malformed-row
    // scan; the pure state machine makes the final stale/ambiguous decision.
    return this.eligible(["sending"]).slice(0, limit);
  }

  async listAmbiguousReceipts(_now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    return this.eligible(["delivery_unknown"])
      .filter((value) => value.agent_source === "ai_audit_transactional")
      .slice(0, limit);
  }

  async findCanonicalReceipt(value: DashboardEmailQueueRow): Promise<DashboardEmailReceipt | null> {
    return this.receipts.get(value.id) ?? null;
  }

  async compareAndSet(
    value: DashboardEmailQueueRow,
    expected: DashboardEmailCasExpected,
    write: DashboardEmailCasWrite,
  ): Promise<boolean> {
    const current = this.rows.get(value.id);
    if (!current) return false;
    const md = metadata(current);
    if (md.status !== expected.status) return false;
    if (expected.claimToken !== undefined && md.claim_token !== expected.claimToken) return false;
    if (expected.claimedAt === null && md.claimed_at != null) return false;
    if (expected.claimedAt !== undefined && expected.claimedAt !== null && md.claimed_at !== expected.claimedAt) return false;
    this.rows.set(value.id, {
      ...current,
      metadata: structuredClone(write.metadata),
      ...(write.sentAt !== undefined ? { sent_at: write.sentAt } : {}),
    });
    this.mutations += 1;
    return true;
  }
}

class ReceiptAfterClaimStore extends MemoryStore {
  override async compareAndSet(
    value: DashboardEmailQueueRow,
    expected: DashboardEmailCasExpected,
    write: DashboardEmailCasWrite,
  ): Promise<boolean> {
    const changed = await super.compareAndSet(value, expected, write);
    if (changed && write.metadata.status === "sending") {
      this.receipts.set(value.id, {
        id: "receipt-after-claim",
        sent_at: "2026-10-29T22:59:30.000Z",
        provider_message_id: "<after-claim@oasisai.work>",
      });
    }
    return changed;
  }
}

type RecordedOperation = { method: string; args: unknown[] };

class RecordingQuery implements PromiseLike<{ data: unknown[]; error: null }> {
  readonly operations: RecordedOperation[] = [];
  private updatePayload: Record<string, unknown> | null = null;

  constructor(readonly table: string, private readonly resultData: unknown[] = []) {}

  private record(method: string, ...args: unknown[]): this {
    this.operations.push({ method, args });
    return this;
  }

  select(...args: unknown[]): this { return this.record("select", ...args); }
  update(payload: Record<string, unknown>): this {
    this.updatePayload = payload;
    return this.record("update", payload);
  }
  eq(...args: unknown[]): this { return this.record("eq", ...args); }
  in(...args: unknown[]): this { return this.record("in", ...args); }
  lte(...args: unknown[]): this { return this.record("lte", ...args); }
  is(...args: unknown[]): this { return this.record("is", ...args); }
  order(...args: unknown[]): this { return this.record("order", ...args); }
  limit(...args: unknown[]): this { return this.record("limit", ...args); }
  maybeSingle(): Promise<{ data: { id: string } | null; error: null }> {
    return Promise.resolve({ data: this.updatePayload ? { id: "changed" } : null, error: null });
  }
  then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.resultData, error: null }).then(onfulfilled, onrejected);
  }
}

class RecordingDb {
  readonly queries: RecordingQuery[] = [];
  from(table: string): RecordingQuery {
    const query = new RecordingQuery(table);
    this.queries.push(query);
    return query;
  }
}

class FixtureDb {
  private index = 0;

  constructor(private readonly batches: unknown[][]) {}

  from(table: string): RecordingQuery {
    return new RecordingQuery(table, this.batches[this.index++] ?? []);
  }
}

function hasOperation(query: RecordingQuery, method: string, ...args: unknown[]): boolean {
  return query.operations.some((operation) => (
    operation.method === method && JSON.stringify(operation.args) === JSON.stringify(args)
  ));
}

async function run(): Promise<void> {
assert.equal(OASIS_DASHBOARD_EMAIL_SENDER_SWITCH, "OASIS_DASHBOARD_EMAIL_SENDER_FORWARD");
for (const value of ["on", "true", "1", "yes", " ON "]) {
  assert.equal(dashboardEmailSenderEnabled({ [OASIS_DASHBOARD_EMAIL_SENDER_SWITCH]: value }), true);
}
for (const value of [undefined, "", "off", "false", "enabled", "onn"]) {
  assert.equal(dashboardEmailSenderEnabled({ [OASIS_DASHBOARD_EMAIL_SENDER_SWITCH]: value }), false);
}

assert.deepEqual(
  dashboardEmailCredentialReadiness({}),
  {
    ready: false,
    reason: "missing OASIS_MAIL_FROM and OASIS_MAIL_APP_PASSWORD",
    missing: ["OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD"],
  },
);

{
  const routeSource = readFileSync("app/api/cron/dashboard-email-sender/route.ts", "utf8");
  const enabledAt = routeSource.indexOf("dashboardEmailSenderEnabled()");
  const credentialsAt = routeSource.indexOf("dashboardEmailCredentialReadiness()");
  const databaseAt = routeSource.indexOf("getServiceSupabase()");
  assert.ok(enabledAt >= 0 && enabledAt < credentialsAt && credentialsAt < databaseAt,
    "the job switch must be read before credential readiness and database access");
  assert.match(routeSource, /terminalFailure \? 409 : 200/,
    "durable queue failures must be recorded once, not retried into a green no-work tick");
}

{
  const db = new RecordingDb();
  const store = new SupabaseDashboardEmailSenderStore(db as never);
  await store.listRunnable(NOW, 5);
  assert.equal(db.queries.length, 6, "queued plus due/missing-due retry queries for both exact lanes");
  for (const query of db.queries) {
    assert.equal(query.table, "lead_interactions");
    assert.ok(hasOperation(query, "eq", "type", "email_queued"));
    assert.ok(hasOperation(query, "eq", "channel", "email"));
    assert.ok(hasOperation(query, "eq", "direction", "outbound"));
    assert.ok(query.operations.some((op) => op.method === "in" && op.args[0] === "tenant_id"));
  }
  const retryQueries = db.queries.filter((query) => hasOperation(query, "eq", "metadata->>status", "retry"));
  assert.equal(retryQueries.length, 4);
  assert.equal(retryQueries.filter((query) => query.operations.some((op) => op.method === "lte" && op.args[0] === "metadata->>next_attempt_at")).length, 2);
  assert.equal(retryQueries.filter((query) => hasOperation(query, "is", "metadata->>next_attempt_at", null)).length, 2);
  const transactional = db.queries.filter((query) => hasOperation(query, "eq", "agent_source", "ai_audit_transactional"));
  assert.equal(transactional.length, 3);
  assert.ok(transactional.every((query) => hasOperation(query, "eq", "provider", "oasis_transactional_outbox")));

  db.queries.length = 0;
  await store.listStaleSending(NOW, 5);
  assert.equal(db.queries.length, 6, "expired-lease, expired-claim, and malformed scans for both lanes");
  assert.equal(db.queries.filter((query) => query.operations.some((op) => op.method === "lte" && op.args[0] === "metadata->>lease_expires_at")).length, 2);
  assert.equal(db.queries.filter((query) => hasOperation(query, "is", "metadata->>lease_expires_at", null)).length, 2);

  const expired = row({
    id: "expired-after-live-row",
    created_at: "2026-10-29T22:05:00.000Z",
    metadata: {
      status: "sending",
      claimed_at: "2026-10-29T22:50:00.000Z",
      lease_expires_at: "2026-10-29T22:55:00.000Z",
    },
  });
  const live = row({
    id: "older-live-row",
    created_at: "2026-10-29T22:00:00.000Z",
    metadata: {
      status: "sending",
      claimed_at: "2026-10-29T22:59:00.000Z",
      lease_expires_at: "2026-10-29T23:02:00.000Z",
    },
  });
  const fixtureStore = new SupabaseDashboardEmailSenderStore(new FixtureDb([
    [expired],
    [],
    [live],
    [],
    [],
    [],
  ]) as never);
  assert.deepEqual(
    (await fixtureStore.listStaleSending(NOW, 1)).map((value) => value.id),
    [expired.id],
    "an older live lease in the safety scan must not crowd out an expired claim",
  );

  db.queries.length = 0;
  await store.listAmbiguousReceipts(NOW, 5);
  assert.equal(db.queries.length, 1);
  assert.ok(hasOperation(db.queries[0], "eq", "metadata->>status", "delivery_unknown"));
  assert.ok(hasOperation(db.queries[0], "eq", "agent_source", "ai_audit_transactional"));
  assert.ok(hasOperation(db.queries[0], "eq", "provider", "oasis_transactional_outbox"));

  db.queries.length = 0;
  const claimed = row({
    id: "cas-row",
    metadata: { status: "sending", claim_token: "claim-1", preserve_me: "yes" },
  });
  assert.equal(await store.compareAndSet(
    claimed,
    { status: "sending", claimToken: "claim-1" },
    { metadata: { ...metadata(claimed), status: "sent" }, sentAt: NOW.toISOString() },
  ), true);
  const cas = db.queries[0];
  for (const [field, value] of [
    ["id", "cas-row"],
    ["tenant_id", OASIS],
    ["type", "email_queued"],
    ["channel", "email"],
    ["direction", "outbound"],
    ["agent_source", "dashboard_drawer"],
    ["metadata->>status", "sending"],
    ["metadata->>claim_token", "claim-1"],
  ]) assert.ok(hasOperation(cas, "eq", field, value), `CAS must fence ${field}`);

  db.queries.length = 0;
  const legacyRetry = row({
    id: "legacy-retry-cas-row",
    metadata: { status: "retry", attempts: 1, next_attempt_at: "2026-10-29T22:59:00.000Z" },
  });
  assert.equal(await store.compareAndSet(
    legacyRetry,
    { status: "retry", claimedAt: null },
    { metadata: { ...metadata(legacyRetry), status: "sending" } },
  ), true);
  assert.ok(
    hasOperation(db.queries[0], "is", "metadata->>claimed_at", null),
    "a legacy retry without claimed_at must fence the CAS on that absence",
  );
}
assert.equal(
  dashboardEmailCredentialReadiness({
    OASIS_MAIL_FROM: "sender@another-company.test",
    OASIS_MAIL_APP_PASSWORD: "secret",
  }).ready,
  false,
  "a non-OASIS mailbox must fail readiness",
);
assert.deepEqual(
  dashboardEmailCredentialReadiness({
    OASIS_MAIL_FROM: "sender@oasisai.work",
    OASIS_MAIL_APP_PASSWORD: "secret",
  }),
  { ready: true, fromAddress: "sender@oasisai.work" },
);

{
  const drawer = row({ id: "drawer" });
  const audit = row({
    id: "audit",
    agent_source: "ai_audit_transactional",
    provider: "oasis_transactional_outbox",
    provider_message_id: "delivery-key",
    metadata: { status: "retry", next_attempt_at: "2026-10-29T22:59:00.000Z", attempts: 1 },
  });
  const store = new MemoryStore([
    drawer,
    audit,
    row({ id: "sms", type: "sms_queued", channel: "sms", to_email: null }),
    row({ id: "bulk", agent_source: "dashboard_bulk_email_v2" }),
    row({ id: "other-tenant", tenant_id: OTHER }),
    row({ id: "wrong-provider", agent_source: "ai_audit_transactional", provider: "something_else" }),
  ]);
  let sends = 0;
  const result = await runDashboardEmailSender({
    store,
    now: NOW,
    dryRun: true,
    send: async () => {
      sends += 1;
      return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: "never", from_address: "sender@oasisai.work" };
    },
  });
  assert.deepEqual(result.would_process.map((v) => v.id).sort(), ["audit", "drawer"]);
  assert.equal(result.mode, "dry_run");
  assert.equal(store.mutations, 0, "a dry run must make zero state changes");
  assert.equal(sends, 0, "a dry run must make zero provider calls");
}

{
  const queued = row({ id: "one-winner" });
  const store = new MemoryStore([queued]);
  let sends = 0;
  const send = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true as const, provider: "oasis_shared_gmail" as const, gmail_message_id: "<one@oasisai.work>", from_address: "sender@oasisai.work" };
  };
  const [a, b] = await Promise.all([
    runDashboardEmailSender({ store, now: NOW, send, claimToken: () => "claim-a" }),
    runDashboardEmailSender({ store, now: NOW, send, claimToken: () => "claim-b" }),
  ]);
  assert.equal(sends, 1, "two overlapping cron ticks may produce only one provider call");
  assert.equal(a.sent + b.sent, 1);
  assert.equal(metadata(store.rows.get(queued.id)!).status, "sent");
  assert.equal(metadata(store.rows.get(queued.id)!).preserve_me, "yes", "metadata must survive every transition");
}

{
  class RetryAdvancedBeforeClaimStore extends MemoryStore {
    private advanced = false;

    override async compareAndSet(
      value: DashboardEmailQueueRow,
      expected: DashboardEmailCasExpected,
      write: DashboardEmailCasWrite,
    ): Promise<boolean> {
      if (!this.advanced && write.metadata.status === "sending") {
        const current = this.rows.get(value.id)!;
        this.rows.set(value.id, {
          ...current,
          metadata: {
            ...metadata(current),
            status: "retry",
            attempts: 2,
            claimed_at: "2026-10-29T22:59:30.000Z",
            next_attempt_at: "2026-10-29T23:05:00.000Z",
          },
        });
        this.advanced = true;
      }
      return super.compareAndSet(value, expected, write);
    }
  }

  const retry = row({
    id: "retry-claim-fence",
    metadata: {
      status: "retry",
      attempts: 1,
      next_attempt_at: "2026-10-29T22:59:00.000Z",
    },
  });
  const store = new RetryAdvancedBeforeClaimStore([retry]);
  let sends = 0;
  const result = await runDashboardEmailSender({
    store,
    now: NOW,
    claimToken: () => "stale-tick-claim",
    send: async () => {
      sends += 1;
      return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: "never", from_address: "sender@oasisai.work" };
    },
  });
  assert.equal(sends, 0, "a legacy retry snapshot without claimed_at must not send after a newer retry transition");
  assert.equal(result.raced, 1);
  assert.equal(metadata(store.rows.get(retry.id)!).attempts, 2);
  assert.equal(metadata(store.rows.get(retry.id)!).next_attempt_at, "2026-10-29T23:05:00.000Z");
}

assert.equal(
  dashboardEmailStaleSending(row({ metadata: { status: "sending", lease_expires_at: "2026-10-29T22:59:00.000Z" } }), NOW.getTime()),
  true,
);
assert.equal(
  dashboardEmailStaleSending(row({ metadata: { status: "sending", lease_expires_at: "2026-10-29T23:02:00.000Z" } }), NOW.getTime()),
  false,
);

{
  const queued = row({
    id: "receipt-race",
    agent_source: "ai_audit_transactional",
    provider: "oasis_transactional_outbox",
    provider_message_id: "receipt-race-key",
  });
  const store = new ReceiptAfterClaimStore([queued]);
  let sends = 0;
  const result = await runDashboardEmailSender({
    store,
    now: NOW,
    claimToken: () => "claim-receipt-race",
    send: async () => {
      sends += 1;
      throw new Error("receipt proof must suppress the provider call");
    },
  });
  assert.equal(sends, 0);
  assert.equal(result.reconciled, 1);
  assert.equal(metadata(store.rows.get(queued.id)!).status, "sent");
  assert.equal(metadata(store.rows.get(queued.id)!).gateway_interaction_id, "receipt-after-claim");
}

{
  const withReceipt = row({
    id: "receipt-first",
    agent_source: "ai_audit_transactional",
    provider: "oasis_transactional_outbox",
    provider_message_id: "receipt-key",
  });
  const stale = row({
    id: "stale-ambiguous",
    metadata: {
      status: "sending",
      claim_token: "old-claim",
      claimed_at: "2026-10-29T22:50:00.000Z",
      lease_expires_at: "2026-10-29T22:53:00.000Z",
      preserve_me: "yes",
    },
  });
  const malformed = row({
    id: "malformed-claim",
    metadata: { status: "sending", lease_expires_at: "not-a-date", claimed_at: "also-not-a-date" },
  });
  const lateReceipt = row({
    id: "late-receipt",
    agent_source: "ai_audit_transactional",
    provider: "oasis_transactional_outbox",
    provider_message_id: "late-key",
    metadata: { status: "delivery_unknown", needs_operator_review: true },
  });
  const store = new MemoryStore([withReceipt, stale, malformed, lateReceipt]);
  store.receipts.set(withReceipt.id, {
    id: "canonical-receipt",
    sent_at: "2026-10-29T22:58:00.000Z",
    provider_message_id: "<receipt@oasisai.work>",
  });
  store.receipts.set(lateReceipt.id, {
    id: "late-canonical-receipt",
    sent_at: "2026-10-29T22:59:00.000Z",
    provider_message_id: "<late@oasisai.work>",
  });
  let sends = 0;
  const result = await runDashboardEmailSender({
    store,
    now: NOW,
    send: async () => {
      sends += 1;
      throw new Error("must not send");
    },
  });
  assert.equal(sends, 0);
  assert.equal(result.reconciled, 2);
  assert.equal(result.delivery_unknown, 2);
  assert.equal(metadata(store.rows.get(withReceipt.id)!).status, "sent");
  assert.equal(metadata(store.rows.get(withReceipt.id)!).gateway_interaction_id, "canonical-receipt");
  assert.equal(metadata(store.rows.get(stale.id)!).status, "delivery_unknown");
  assert.equal(metadata(store.rows.get(stale.id)!).needs_operator_review, true);
  assert.equal(metadata(store.rows.get(stale.id)!).preserve_me, "yes");
  assert.equal(metadata(store.rows.get(malformed.id)!).status, "delivery_unknown");
  assert.equal(metadata(store.rows.get(lateReceipt.id)!).status, "sent");
  assert.equal(metadata(store.rows.get(lateReceipt.id)!).gateway_interaction_id, "late-canonical-receipt");
}

{
  const retry = row({ id: "retry-safe", metadata: { status: "queued", attempts: 0, max_attempts: 3, preserve_me: "yes" } });
  const unknown = row({ id: "unknown", to_email: "other@example.com" });
  const thrown = row({ id: "provider-threw", to_email: "third@example.com" });
  const store = new MemoryStore([retry, unknown, thrown]);
  const result = await runDashboardEmailSender({
    store,
    now: NOW,
    claimToken: () => crypto.randomUUID(),
    send: async ({ row: value }) => {
      if (value.id === retry.id) {
        return { ok: false, provider: "oasis_shared_gmail", reason: "send_failed", error: "535 rejected before DATA" };
      }
      if (value.id === thrown.id) throw new Error("socket vanished after DATA");
      return { ok: false, provider: "oasis_shared_gmail", reason: "delivery_unknown", error: "socket closed after DATA" };
    },
  });
  assert.equal(result.retried, 1);
  assert.equal(result.delivery_unknown, 2);
  assert.equal(metadata(store.rows.get(retry.id)!).status, "retry");
  assert.equal(metadata(store.rows.get(retry.id)!).attempts, 1);
  assert.equal(metadata(store.rows.get(retry.id)!).preserve_me, "yes");
  assert.equal(metadata(store.rows.get(unknown.id)!).status, "delivery_unknown");
  assert.equal(metadata(store.rows.get(thrown.id)!).status, "delivery_unknown");
}

{
  const a = row({ id: "stable", provider_message_id: "provider-key" });
  assert.equal(dashboardEmailIdempotencyKey(a), dashboardEmailIdempotencyKey(structuredClone(a)));
  assert.equal(dashboardEmailIdempotencyKey(a), "provider-key");
  assert.equal(dashboardEmailIdempotencyKey(row({ id: "fallback", provider_message_id: null })), "dashboard-email:fallback");
}

console.log("dashboard-email-sender: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
