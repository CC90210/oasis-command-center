/**
 * tests/site-scan-progress.test.ts — POST /api/internal/tools/progress (lib/tools/runner-handlers.ts
 * handleToolsProgress): the runner's live lines for the free scan's feed, against the real
 * migrations (bravo__206, __259, __260) in a local libSQL file. Signed requests only; the job's
 * lease must hold; only site_scan_enrich may post, only to its own scan; lines are cleaned and
 * capped like the Worker's; a runner's clock far off the server's is not trusted. No network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-progress.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ENV, OASIS, answerOf, applyMigrationFile, check, finish, setupToolsDatabase, signedRequest } from "./_tools-harness";

const ROOT = join(__dirname, "..");
const LEASE = "c".repeat(32);

async function main() {
  console.log("site scan progress:");
  const db = await setupToolsDatabase();
  await applyMigrationFile(db, join(ROOT, "database", "turso", "bravo__259_site_scans.sql"));
  await applyMigrationFile(db, join(ROOT, "database", "turso", "bravo__260_site_scan_events.sql"));
  const h = await import("../lib/tools/runner-handlers");
  const { insertScan } = await import("../lib/site-scan/store");
  const { queueEnrichment } = await import("../lib/site-scan/run");
  const { listEvents } = await import("../lib/site-scan/events");

  const t0 = new Date("2026-11-12T20:00:00.000Z");
  const { row } = await insertScan(db, { tenantId: OASIS, domain: "acme-plumbing.ca", url: "https://acme-plumbing.ca/", ipHash: null, now: t0 });
  assert.deepEqual(await queueEnrichment(db, { tenantId: OASIS, scanId: row.id, attempt: row.createdAt, now: t0 }), { ok: true });
  const jobId = String((await db.execute({ sql: "SELECT id FROM tool_jobs WHERE tool_key = 'site_scan_enrich' AND json_extract(input_json, '$.scan_id') = ?", args: [row.id] })).rows[0].id);
  await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:oasis-pc-scan', lease_id = ? WHERE id = ?", args: [LEASE, jobId] });

  const post = (body: Record<string, unknown>, now = t0) => h.handleToolsProgress(signedRequest("progress", body, now), { db, env: ENV, now, storage: null }).then(answerOf);
  const base = { runner_id: "oasis-pc-scan", job_id: jobId, lease_id: LEASE };

  await check("the lines a runner posts under its lease land in the scan's feed, cleaned, with its own clock when it is close", async () => {
    const a = await post({
      ...base,
      events: [
        { kind: "category", text: "Reads as a plumbing business (92%)", data: { key: "plumbing_hvac", confidence: 0.92 }, at: "2026-11-12T19:59:58.000Z" },
        { kind: "competitor", text: "Found a competitor 3.2 km away:\n  Pipe Pros", data: { name: "Pipe Pros", distance_km: 3.2, bearing_deg: 140 }, at: "1999-01-01T00:00:00.000Z" },
        { kind: "not-a-kind", text: "dropped" },
        "not an object",
      ],
    });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.written, 2);
    const feed = await listEvents(db, { tenantId: OASIS, scanId: row.id, afterId: 0 });
    assert.deepEqual(feed.map((e) => [e.source, e.kind, e.text]), [
      ["runner", "category", "Reads as a plumbing business (92%)"],
      ["runner", "competitor", "Found a competitor 3.2 km away: Pipe Pros"],
    ]);
    assert.equal(feed[0].at, "2026-11-12T19:59:58.000Z", "a close runner clock is kept");
    assert.equal(feed[1].at, t0.toISOString(), "a runner clock far from the server's is replaced");
    assert.equal(feed[1].data?.distance_km, 3.2);
  });

  await check("an unsigned or lease-less post writes nothing", async () => {
    const before = (await listEvents(db, { tenantId: OASIS, scanId: row.id, afterId: 0 })).length;
    const bad = await h.handleToolsProgress(signedRequest("progress", { ...base, events: [{ kind: "note", text: "x" }] }, t0, { secret: "wrong-secret-0123456789abcdef0123456789" }), { db, env: ENV, now: t0, storage: null });
    assert.equal(bad.status, 401);
    const lost = await post({ ...base, lease_id: "d".repeat(32), events: [{ kind: "note", text: "x" }] });
    assert.equal(lost.status, 409);
    const empty = await post({ ...base, events: [] });
    assert.equal(empty.status, 422);
    const many = await post({ ...base, events: Array.from({ length: h.MAX_PROGRESS_EVENTS + 1 }, () => ({ kind: "note", text: "x" })) });
    assert.equal(many.status, 422);
    assert.equal((await listEvents(db, { tenantId: OASIS, scanId: row.id, afterId: 0 })).length, before);
  });

  await check("only a tool that publishes a feed may post", async () => {
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'ai_audit_pdf' WHERE id = ?", args: [jobId] });
    const a = await post({ ...base, events: [{ kind: "note", text: "x" }] });
    assert.equal(a.status, 422);
    assert.equal((a.body as { field?: string }).field, "tool_key");
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'site_scan_enrich' WHERE id = ?", args: [jobId] });
  });

  finish("site-scan-progress");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
