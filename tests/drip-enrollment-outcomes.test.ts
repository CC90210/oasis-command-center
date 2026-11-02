/** Exercise the real enroller's error/no-work/idempotency paths with an in-memory adapter. */
import assert from "node:assert/strict";
const mock = (path: string, exports: object) => {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
};
process.env.DRIPS_LIVE = "1";
process.env.DRIPS_ENROLL_STAGES = "sent_application";
process.env.DRIPS_ENROLL_DAILY_CAP = "0";
let fault = "", rows = 0, writes = 0, noSequences = false;
const tenant = "11111111-1111-4111-8111-111111111111";
const db = { from(table: string) {
  let action = "read", head = false, columns = "", acceleratedQuery = false;
  const result = () => {
    if (action === "insert") {
      writes++;
      if (fault === "insert") return { error: { message: "database unavailable" } };
      if (fault === "duplicate") return { error: { message: "unique constraint failed" } };
      rows++; return { data: null, error: null };
    }
    if (action === "update") return { error: fault === "metadata" ? { message: "database unavailable" } : null };
    if (table === "drip_sequences" && columns === "id, trigger_filter") return { data: [{ id: "chase", trigger_filter: { field: "accelerated_followup", to: "true" } }], error: fault === "accelerated_sequence" ? { message: "read failed" } : null };
    if (table === "drip_sequences") return { data: noSequences ? [] : [{ id: "sequence", tenant_id: tenant, name: "fixture", enabled: true,
      trigger_filter: { to: "sent_application" }, steps: [{ channel: "sms", delay_minutes: 0 }] }], error: fault === "sequence" ? { message: "read failed" } : null };
    if (table === "drip_runs" && acceleratedQuery) return { data: [], error: fault === "accelerated_runs" ? { message: "read failed" } : null };
    if (table === "drip_runs") return head ? { count: 0, error: fault === "budget" ? { message: "read failed" } : null }
      : { data: rows ? [{ lead_id: "lead", created_at: new Date().toISOString() }] : [], error: null };
    if (table === "tenant_records") return { data: [{ id: "lead", created_at: new Date().toISOString(), data: { stage: "sent_application", phone: "+14165550123", assigned_to: "rep", rep_name: "Fixture Rep", accelerated_followup: true } }], error: fault === "candidate" ? { message: "read failed" } : null };
    if (table === "lead_interactions") return { data: [], error: fault === "shopped" ? { message: "read failed" } : null };
    throw new Error(`Unexpected fixture table ${table}`);
  };
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "gte", "filter", "order", "range", "not", "in", "neq", "is", "or", "ilike", "limit"]) chain[method] = () => chain;
  chain.select = (value: string, options?: { head?: boolean }) => { columns = value; head = !!options?.head; return chain; };
  chain.in = (field: string) => { if (field === "sequence_id") acceleratedQuery = true; return chain; };
  chain.insert = () => { action = "insert"; return chain; };
  chain.update = () => { action = "update"; return chain; };
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(result).then(resolve, reject);
  return chain;
} };
mock("../lib/supabase-server", { getServiceSupabase: () => db });
mock("../lib/drips/deal-state-store", { loadDealGates: async () => ({ ok: true, gates: new Map() }) });
mock("../lib/drips/brand-store", { ensureInitialBrand: async () => { if (fault === "brand") throw new Error("brand write failed"); } });
mock("../lib/team", { memberStanding: async () => { if (fault === "standing") throw new Error("standing unreadable"); return { standing: fault === "not_member" ? "not_member" : "active" }; } });
let checks = 0;
async function check(label: string, run: () => Promise<void>) { rows = 0; writes = 0; fault = ""; await run(); checks++; console.log(`ok ${label}`); }
async function main() {
  const { runEnrollDrips } = await import("../lib/drips/enroller");
  const original = { fetch: globalThis.fetch, error: console.error };
  globalThis.fetch = async () => { throw new Error("No network permitted in this fixture"); }; console.error = () => undefined;
  try {
    await check("sequence and budget read failures cannot become empty successful scans or unlimited enrollment", async () => {
      fault = "sequence"; await assert.rejects(runEnrollDrips(), /drip_sequences_unavailable/); assert.equal(writes, 0);
      fault = "budget"; process.env.DRIPS_ENROLL_DAILY_CAP = "10";
      await assert.rejects(runEnrollDrips(), /drip_enrollment_budget_unavailable/); assert.equal(writes, 0);
      process.env.DRIPS_ENROLL_DAILY_CAP = "0";
    });
    await check("a failed candidate read is an explicit sequence failure with no enrollment", async () => {
      fault = "candidate"; const result = await runEnrollDrips();
      assert.equal(result.perSequence.length, 1); assert.ok(result.perSequence[0].error); assert.equal(writes, 0);
    });
    await check("failed writes surface while a concurrent unique-key winner remains a harmless no-op", async () => {
      fault = "insert"; let result = await runEnrollDrips(); assert.equal(result.totals.enrolled, 0); assert.equal(result.perSequence[0].error, "drip_enrollment_write_failed");
      fault = "duplicate"; result = await runEnrollDrips(); assert.equal(result.totals.enrolled, 0); assert.equal(result.perSequence[0].error, undefined);
    });
    await check("unreadable shopped, chase sequence/run or rep standing prevents enrollment; confirmed absence still permits it", async () => {
      process.env.ACCELERATED_ENROLL_LIVE = "1";
      for (const [kind, code] of [["shopped", "drip_shopped_lookup_unavailable"], ["accelerated_sequence", "drip_accelerated_lookup_unavailable"], ["accelerated_runs", "drip_accelerated_lookup_unavailable"], ["standing", "drip_rep_standing_unavailable"]]) {
        fault = kind; const result = await runEnrollDrips();
        assert.equal(result.totals.enrolled, 0); assert.equal(result.perSequence[0].error, code); assert.equal(writes, 0);
      }
      fault = "not_member"; const result = await runEnrollDrips(); assert.equal(result.totals.enrolled, 1);
      delete process.env.ACCELERATED_ENROLL_LIVE;
    });
    await check("partial metadata or brand failures remain visible after enrollment, and retry cannot double-enroll", async () => {
      for (const kind of ["metadata", "brand"]) {
        rows = 0; writes = 0; fault = kind; let result = await runEnrollDrips();
        assert.equal(result.totals.enrolled, 1); assert.equal(result.perSequence[0].error, `drip_enrollment_${kind}_failed`);
        result = await runEnrollDrips(); assert.equal(result.totals.enrolled, 0); assert.equal(writes, 1);
      }
    });
    await check("an empty configured estate and preview mode remain truthful no-work", async () => {
      noSequences = true; let result = await runEnrollDrips(); assert.equal(result.sequencesScanned, 0); noSequences = false;
      process.env.DRIPS_LIVE = "0"; result = await runEnrollDrips();
      assert.equal(result.live, false); assert.equal(result.totals.candidates, 1); assert.equal(writes, 0);
    });
  } finally { globalThis.fetch = original.fetch; console.error = original.error; }
  console.log(`drip-enrollment-outcomes: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
