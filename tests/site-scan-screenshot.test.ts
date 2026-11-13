/**
 * tests/site-scan-screenshot.test.ts - POST /api/internal/tools/scan-screenshot
 * (lib/tools/runner-handlers.ts handleToolsScanScreenshot) and lib/site-scan/screenshot.ts: the
 * runner's picture of a scanned home page, against the real migrations (bravo__206, __259, __260,
 * __261) in a local libSQL file. Signed requests only; the job's lease must hold; only
 * site_scan_enrich, only its own scan; only a real JPEG within MAX_SCREENSHOT_BYTES; a full-size
 * picture fits the route's body cap; the feed announces only our own stored picture, and a
 * `screenshot` line posted through progress is dropped. No network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-screenshot.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ENV, OASIS, answerOf, applyMigrationFile, check, finish, setupToolsDatabase, signedRequest } from "./_tools-harness";

const ROOT = join(__dirname, "..");
const LEASE = "c".repeat(32);

function jpeg(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function main() {
  console.log("site scan screenshot:");
  const db = await setupToolsDatabase();
  await applyMigrationFile(db, join(ROOT, "database", "turso", "bravo__259_site_scans.sql"));
  await applyMigrationFile(db, join(ROOT, "database", "turso", "bravo__260_site_scan_events.sql"));
  await applyMigrationFile(db, join(ROOT, "database", "turso", "bravo__261_site_scan_screenshot.sql"));
  const h = await import("../lib/tools/runner-handlers");
  const { insertScan } = await import("../lib/site-scan/store");
  const { queueEnrichment } = await import("../lib/site-scan/run");
  const { listEvents } = await import("../lib/site-scan/events");
  const shots = await import("../lib/site-scan/screenshot");

  const t0 = new Date("2026-11-12T20:00:00.000Z");
  const { row } = await insertScan(db, { tenantId: OASIS, domain: "acme-plumbing.ca", url: "https://acme-plumbing.ca/", ipHash: null, now: t0 });
  assert.deepEqual(await queueEnrichment(db, { tenantId: OASIS, scanId: row.id, now: t0 }), { ok: true });
  const jobId = String((await db.execute({ sql: "SELECT id FROM tool_jobs WHERE tool_key = 'site_scan_enrich' AND json_extract(input_json, '$.scan_id') = ?", args: [row.id] })).rows[0].id);
  await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:oasis-pc-scan', lease_id = ? WHERE id = ?", args: [LEASE, jobId] });

  const post = (body: Record<string, unknown>, now = t0) => h.handleToolsScanScreenshot(signedRequest("scan-screenshot", body, now), { db, env: ENV, now, storage: null }).then(answerOf);
  const base = { runner_id: "oasis-pc-scan", job_id: jobId, lease_id: LEASE };
  const feedOf = () => listEvents(db, { tenantId: OASIS, scanId: row.id, afterId: 0 });

  await check("only a real JPEG within the size limit decodes", async () => {
    assert.ok(shots.isJpeg(jpeg(16)));
    assert.equal(shots.isJpeg(new TextEncoder().encode("<svg onload=alert(1)>")), false);
    assert.equal(shots.decodeScreenshot(b64(jpeg(64)))?.length, 64);
    assert.equal(shots.decodeScreenshot("not base64!"), null);
    assert.equal(shots.decodeScreenshot(b64(new TextEncoder().encode("GIF89a........"))), null);
    assert.equal(shots.decodeScreenshot(b64(jpeg(shots.MAX_SCREENSHOT_BYTES + 1))), null);
    assert.equal(shots.decodeScreenshot(42), null);
    assert.equal(shots.screenshotPath(row.id), `/api/scan/${row.id}/screenshot`);
  });

  await check("a full-size picture under the lease is kept on its scan and announced in the feed", async () => {
    const full = jpeg(shots.MAX_SCREENSHOT_BYTES);
    const a = await post({ ...base, image_b64: b64(full) });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.bytes, shots.MAX_SCREENSHOT_BYTES);
    const stored = await shots.readScreenshot(db, { tenantId: OASIS, scanId: row.id });
    assert.ok(stored && stored.length === full.length && shots.isJpeg(stored), "the same bytes come back");
    const line = (await feedOf()).filter((e) => e.kind === "screenshot");
    assert.equal(line.length, 1);
    assert.equal(line[0].source, "runner");
    assert.equal(line[0].data?.url, `/api/scan/${row.id}/screenshot`);
    const at = (await db.execute({ sql: "SELECT screenshot_at FROM site_scans WHERE id = ?", args: [row.id] })).rows[0].screenshot_at;
    assert.equal(at, t0.toISOString());
  });

  await check("a bad picture, a lost lease or an unsigned post stores nothing", async () => {
    const before = (await feedOf()).length;
    const notJpeg = await post({ ...base, image_b64: b64(new TextEncoder().encode("<html>hi</html>")) });
    assert.equal(notJpeg.status, 422);
    assert.equal((notJpeg.body as { field?: string }).field, "image_b64");
    const missing = await post({ ...base });
    assert.equal(missing.status, 422);
    const tooBig = await post({ ...base, image_b64: b64(jpeg(400 * 1024)) });
    assert.equal(tooBig.status, 413, "past the route's body cap");
    const lost = await post({ ...base, lease_id: "d".repeat(32), image_b64: b64(jpeg(64)) });
    assert.equal(lost.status, 409);
    const unsigned = await h.handleToolsScanScreenshot(
      signedRequest("scan-screenshot", { ...base, image_b64: b64(jpeg(64)) }, t0, { secret: "wrong-secret-0123456789abcdef0123456789" }),
      { db, env: ENV, now: t0, storage: null },
    );
    assert.equal(unsigned.status, 401);
    assert.equal((await feedOf()).length, before);
    assert.equal((await shots.readScreenshot(db, { tenantId: OASIS, scanId: row.id }))?.length, shots.MAX_SCREENSHOT_BYTES, "the kept picture is untouched");
  });

  await check("only the scan's own tool may post a picture", async () => {
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'ai_audit_pdf' WHERE id = ?", args: [jobId] });
    const a = await post({ ...base, image_b64: b64(jpeg(64)) });
    assert.equal(a.status, 422);
    assert.equal((a.body as { field?: string }).field, "tool_key");
    await db.execute({ sql: "UPDATE tool_jobs SET tool_key = 'site_scan_enrich' WHERE id = ?", args: [jobId] });
  });

  await check("a screenshot line posted through progress is dropped (it could point the page anywhere)", async () => {
    const before = (await feedOf()).filter((e) => e.kind === "screenshot").length;
    const a = await h
      .handleToolsProgress(
        signedRequest("progress", { ...base, events: [{ kind: "screenshot", text: "look", data: { url: "https://evil.example/x.png" } }, { kind: "note", text: "kept" }] }, t0),
        { db, env: ENV, now: t0, storage: null },
      )
      .then(answerOf);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.written, 1);
    assert.equal((await feedOf()).filter((e) => e.kind === "screenshot").length, before);
  });

  finish("site-scan-screenshot");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
