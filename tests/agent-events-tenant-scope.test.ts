/**
 * Regression test for B1 (2026-07-23): recentEvents() cross-tenant leak.
 *
 * Bug: the non-operator read path filtered agent_events by
 * `publisher_agent IN agentNames` only. publisher_agent is an AGENT-level
 * label (e.g. "kixie"), not a tenant boundary — two different tenants who
 * both enable the same agent matched the same filter and could see each
 * other's rows (call recordings, dispositions, lead IDs, in Kixie's case).
 * `opts.tenantId` was accepted by the function signature but never applied
 * to the query.
 *
 * Fix: lib/queries.ts::recentEvents() now applies
 * `.eq("correlation_id", tenantId)` whenever the caller supplies a
 * tenantId, on both the non-operator and the operator-explicit-scope path.
 *
 * This test exercises the REAL recentEvents() query-building logic against
 * a fake Supabase client that actually filters an in-memory row set (not
 * just a call-was-made assertion) — a regression that stops calling
 * `.eq("correlation_id", ...)` correctly will fail this test, not just a
 * mock-spy check.
 *
 * Run standalone: npx tsx tests/agent-events-tenant-scope.test.ts
 */
import assert from "node:assert/strict";
import { recentEvents } from "@/lib/queries";

type Row = Record<string, unknown>;

// Minimal chainable fake that mirrors the subset of the Supabase
// query-builder surface lib/queries.ts::recentEvents() calls
// (select/in/eq/gte/order/limit), applying each filter against a real
// in-memory array so the test proves actual filtering behavior.
function makeFakeAgentEventsClient(seedRows: Row[]) {
  return {
    from(table: string) {
      let rows: Row[] = table === "agent_events" ? [...seedRows] : [];
      let limitN: number | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only chainable stub mirroring PostgREST's fluent builder shape
      const chain: any = {
        select() {
          return chain;
        },
        in(col: string, vals: unknown[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return chain;
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val);
          return chain;
        },
        gte(col: string, val: string) {
          rows = rows.filter((r) => String(r[col]) >= val);
          return chain;
        },
        order(col: string, opts: { ascending: boolean }) {
          rows = [...rows].sort((a, b) => {
            const av = String(a[col]);
            const bv = String(b[col]);
            return opts.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return chain;
        },
        limit(n: number) {
          limitN = n;
          return chain;
        },
        then(
          resolve: (v: { data: Row[] | null; error: null }) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          const data = limitN != null ? rows.slice(0, limitN) : rows;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const now = new Date().toISOString();

const SEED_ROWS: Row[] = [
  {
    id: "evt-tenant-a-1",
    event_type: "SUNBIZ_KIXIE_CALL",
    publisher_agent: "kixie",
    severity: "info",
    payload: { call_id: "a1" },
    correlation_id: "tenant-A",
    published_at: now,
  },
  {
    id: "evt-tenant-b-1",
    event_type: "SUNBIZ_KIXIE_CALL",
    publisher_agent: "kixie",
    severity: "info",
    payload: { call_id: "b1", recording_url: "https://leak.example/b1.mp3" },
    correlation_id: "tenant-B",
    published_at: now,
  },
  {
    id: "evt-tenant-b-2",
    event_type: "SUNBIZ_KIXIE_CALL",
    publisher_agent: "kixie",
    severity: "info",
    payload: { call_id: "b2" },
    correlation_id: "tenant-B",
    published_at: now,
  },
];

let passed = 0;
let failed = 0;
async function test(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${label}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${label}\n         ${msg}`);
  }
}

async function main() {
  console.log("=== recentEvents tenant scoping (B1) ===");

  await test(
    "non-operator + tenantId + shared agent name → only that tenant's rows come back",
    async () => {
      const db = makeFakeAgentEventsClient(SEED_ROWS);
      const rows = await recentEvents(25, {
        tenantId: "tenant-A",
        agentNames: ["kixie"],
        isOperator: false,
        sinceDays: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake client only implements the subset recentEvents() calls
        db: db as any,
      });

      assert.equal(rows.length, 1, "tenant A must see exactly its own row");
      assert.equal(rows[0].id, "evt-tenant-a-1");
      assert.ok(
        rows.every((r) => (r as unknown as Row).correlation_id === "tenant-A"),
        "no row with a different tenant's correlation_id may leak through",
      );
      assert.ok(
        !rows.some((r) => (r as unknown as Row).id === "evt-tenant-b-1"),
        "tenant B's row (with a live recording_url) must never appear in tenant A's feed",
      );
    },
  );

  await test(
    "non-operator + tenantId B sees only tenant B's rows (both directions checked)",
    async () => {
      const db = makeFakeAgentEventsClient(SEED_ROWS);
      const rows = await recentEvents(25, {
        tenantId: "tenant-B",
        agentNames: ["kixie"],
        isOperator: false,
        sinceDays: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake client only implements the subset recentEvents() calls
        db: db as any,
      });

      assert.equal(rows.length, 2, "tenant B must see both of its own rows");
      assert.ok(
        rows.every((r) => (r as unknown as Row).correlation_id === "tenant-B"),
        "tenant B's feed must not include tenant A's row",
      );
    },
  );

  await test(
    "operator + no tenantId → full empire-wide view unchanged (regression guard)",
    async () => {
      const db = makeFakeAgentEventsClient(SEED_ROWS);
      const rows = await recentEvents(25, {
        isOperator: true,
        sinceDays: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake client only implements the subset recentEvents() calls
        db: db as any,
      });
      assert.equal(rows.length, 3, "operator with no explicit tenantId still sees everything");
    },
  );

  await test(
    "operator + explicit tenantId → operator can scope down to one tenant",
    async () => {
      const db = makeFakeAgentEventsClient(SEED_ROWS);
      const rows = await recentEvents(25, {
        isOperator: true,
        tenantId: "tenant-A",
        sinceDays: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake client only implements the subset recentEvents() calls
        db: db as any,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "evt-tenant-a-1");
    },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
