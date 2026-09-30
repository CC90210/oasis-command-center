/**
 * tests/finances-books-cron.test.ts — the books' daily upkeep is scheduled,
 * authenticated, in dependency order, and safe to run: the Wise feed stays a
 * dry run while its switch is off, the Wise invoice match is always a dry run
 * (recording a payment is a founder's call), and a failure answers non-2xx with a
 * stable code and nothing else (the rollback driver prints bodies to a
 * public log).
 *
 * WHY. On 2026-09-29 the four internal finance routes existed and nothing
 * scheduled them: exchange rates stale since 09-24, no Stripe reconcile, the
 * Wise feed never run. The schedule now lives in config/cron-registry.json
 * (tests/cron-driver-coverage.test.ts pins it to the Worker's table and the
 * rollback driver); this file pins what the four registrations must BE.
 *
 * Real route handler, real local libSQL (migration 180) for the jobs that
 * write; the Bank of Canada is served from a fixture, and Stripe and Wise are
 * unconfigured, so their jobs fail closed.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-books-cron.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-books-cron-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "WISE_API_TOKEN", "WISE_PROFILE_ID", "FINANCE_WISE_FEED_WRITES", "CRON_ALLOW_LOCAL"]) delete process.env[k];
process.env.CRON_SECRET = "test-cron-secret-0123456789";
process.env.CRON_ATTEST_SECRET = "test-cron-attest-0123456789";

let valetCalls = 0;
const WISE_PROFILE = "82000009";
globalThis.fetch = (async (input: unknown) => {
  const url = new URL(String(input));
  // Wise, once configured below: a business profile with no balances, so there is nothing to record.
  if (url.host === "api.transferwise.com" && url.pathname === `/v4/profiles/${WISE_PROFILE}/balances`) {
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.host === "www.bankofcanada.ca") {
    valetCalls += 1;
    return new Response(JSON.stringify({ observations: [{ d: "2026-09-28", FXUSDCAD: { v: "1.3912" } }, { d: "2026-09-29", FXUSDCAD: { v: "1.3925" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
}) as typeof fetch;

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const JOBS = ["fx-refresh", "stripe-reconcile", "wise-reconcile", "wise-sync"];

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "185_finance_invoice_retainer.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", f), "utf8"));
  }
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/cron/finance-books/route");
  const books = await import("../lib/founders-finances/books-cron");
  const { WISE_FEED_WRITES_ENABLED } = await import("../lib/founders-finances/wise-feed");
  const { CRON_TABLE } = await import("../workers/oasis-cc-cron/src/index");

  const call = async (job: string | null, auth = true) => {
    const url = `https://oasisai.work/api/cron/finance-books${job === null ? "" : `?job=${job}`}`;
    const headers: Record<string, string> = auth
      ? { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-oasis-cron-attest": String(process.env.CRON_ATTEST_SECRET) }
      : {};
    const res = await route.GET(new NextRequest(url, { headers }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  await check("the registry schedules each job once a day, off the 5-minute grid, rates -> Stripe -> Wise matches -> Wise feed", () => {
    const registry = JSON.parse(readFileSync(join(root, "config/cron-registry.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const ours = registry.crons.filter((c) => c.path.startsWith("/api/cron/finance-books"));
    assert.deepEqual(ours.map((c) => c.path), JOBS.map((j) => `/api/cron/finance-books?job=${j}`));
    const minuteOfDay = (s: string) => {
      const [m, h, dom, mon, dow] = s.split(" ");
      assert.deepEqual([dom, mon, dow], ["*", "*", "*"], `${s} runs every day`);
      assert.ok(/^\d+$/.test(m) && /^\d+$/.test(h), `${s} is one fixed time a day`);
      assert.notEqual(Number(m) % 5, 0, `${s} sits off the 5-minute grid the senders run on`);
      return Number(h) * 60 + Number(m);
    };
    const times = ours.map((c) => minuteOfDay(c.schedule));
    assert.deepEqual([...times].sort((a, b) => a - b), times, "in dependency order");
    for (const c of ours) assert.ok(CRON_TABLE.some((e) => e.path === c.path && e.schedule === c.schedule), `${c.path} is in the Worker's table`);
    assert.deepEqual([...books.FINANCE_BOOK_JOBS], JOBS, "the route serves exactly the scheduled jobs");
  });

  await check("the route refuses without the cron secrets, and refuses an unknown job", async () => {
    assert.equal((await call("fx-refresh", false)).status, 401);
    const unknown = await call("drop-books");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "unknown_job");
    assert.equal((await call(null)).status, 400);
    const src = readFileSync(join(root, "app/api/cron/finance-books/route.ts"), "utf8");
    assert.ok(src.indexOf("checkCronAuth(req)") < src.indexOf("runFinanceBookJob(job)"), "auth runs before any job");
  });

  await check("fx-refresh stores the Bank of Canada's rates and answers with counts only", async () => {
    const r = await call("fx-refresh");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(valetCalls, 1);
    assert.deepEqual(Object.keys(r.body.result as object).sort(), ["from", "observations", "to"]);
    assert.equal(Number((await raw.execute(`SELECT COUNT(*) FROM fin_fx_rates WHERE rate_date IN ('2026-09-28', '2026-09-29')`)).rows[0][0]), 2);
    await call("fx-refresh");
    assert.equal(Number((await raw.execute(`SELECT COUNT(*) FROM fin_fx_rates`)).rows[0][0]), 2, "a re-run upserts, never duplicates");
  });

  await check("stripe-reconcile with no Stripe key fails closed: non-2xx, a stable code, no sentence for the public log", async () => {
    const r = await call("stripe-reconcile");
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { ok: false, job: "stripe-reconcile", error: "stripe_key_missing" });
  });

  await check("wise-sync is a DRY RUN while the feed's switch is off: it reaches Wise (not configured here), never the write path", async () => {
    assert.equal(WISE_FEED_WRITES_ENABLED, false, "production's switch state: off");
    assert.equal(books.wiseSyncDryRun(false), true);
    assert.equal(books.wiseSyncDryRun(true), false);
    // A write run with the switch off stops at once with the "switched off"
    // FinanceInputError (400 invalid_input); the dry run goes on to read Wise,
    // which is not configured in this test, so it answers 503.
    const r = await call("wise-sync");
    assert.deepEqual(r.body, { ok: false, job: "wise-sync", error: "wise_not_configured" });
    assert.equal(r.status, 503);
  });

  await check("wise-reconcile with Wise unconfigured fails closed with its code", async () => {
    const r = await call("wise-reconcile");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, job: "wise-reconcile", error: "wise_not_configured" });
  });

  await check("wise-reconcile on the schedule is a DRY RUN: recording an invoice payment stays a founder's click", async () => {
    assert.equal(books.WISE_RECONCILE_CRON_DRY_RUN, true);
    process.env.WISE_API_TOKEN = "wise-test-token";
    process.env.WISE_PROFILE_ID = WISE_PROFILE;
    try {
      const r = await call("wise-reconcile");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const result = r.body.result as Record<string, unknown>;
      assert.equal(result.dry_run, true, "the job asks reconcileWise for a dry run, whatever the feed switch says");
      assert.equal(result.recorded, 0);
    } finally {
      delete process.env.WISE_API_TOKEN;
      delete process.env.WISE_PROFILE_ID;
    }
  });

  if (failures) {
    console.error(`finances-books-cron: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-books-cron: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
