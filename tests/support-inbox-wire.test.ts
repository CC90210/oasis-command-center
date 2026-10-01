/**
 * support-inbox-wire.test.ts — the support@ reader's four routes, at the wire:
 * who may call them and what every status means (the contract the reader on
 * CC's PC acts on, BEA scripts/support/occ_client.py).
 *
 *   - the contract's fixed test vector (section 1.2) verifies here, with the
 *     secret used as trimmed TEXT;
 *   - the signature is checked over the RAW body BEFORE any JSON parsing, with
 *     a 300 s window and a 512 KB cap read first;
 *   - 401 unauthorized / stale_timestamp, 413, 422 for validation and an
 *     unknown mailbox, 503 not_installed for an unset secret or missing
 *     tables, and never a 404 or 405 from a handler (those mean "route not
 *     deployed" to the reader);
 *   - every 2xx is a JSON object with ok: true (the harness's answerOf).
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-wire.test.ts
 */
import "./_support-inbox-harness";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ENV,
  MAILBOX,
  SECRET,
  answerOf,
  asciiJson,
  check,
  emptyDatabase,
  fakeNotify,
  finish,
  ingestBody,
  setupSupportDatabase,
  sign,
  signedRequest,
} from "./_support-inbox-harness";

const ROOT = join(__dirname, "..");
const BS = String.fromCharCode(92);

async function main() {
  const db = await setupSupportDatabase();
  const empty = emptyDatabase();
  const auth = await import("../lib/delivery/support-ingest-auth");
  const intake = await import("../lib/delivery/email-intake");
  const drafts = await import("../lib/delivery/support-drafts");
  const health = await import("../lib/delivery/support-inbox-health");
  const now = new Date("2026-10-01T18:00:00.000Z");
  const notify = fakeNotify();
  const deps = { db, env: ENV, now, notify: notify.deps, schedule: notify.schedule };

  console.log("support-inbox-wire:");

  await check("the contract's fixed vector: signature 408f12fc... over the ASCII body, the secret trimmed and used as text", async () => {
    const secret = `  ${"0123456789abcdef".repeat(4)}\n`;
    const ts = 1759341600;
    const raw = `{"mailbox":"support@oasisai.work","note":"caf${BS}u00e9"}`;
    assert.equal(raw, asciiJson({ mailbox: "support@oasisai.work", note: `caf${String.fromCharCode(0xe9)}` }), "the harness serialises like the reader");
    assert.equal(sign(secret, ts, raw), "408f12fc1e79093642445269a8eb6b08ae5ef4eacd03fc67dbd30509136f9212");
    const req = signedRequest("/api/internal/support/heartbeat", null, new Date(ts * 1000), { raw, ts, secret });
    const r = await auth.authenticateSupportRequest(req, { SUPPORT_INGEST_SECRET_BEA: secret }, new Date((ts + 10) * 1000));
    assert.equal(r.ok, true, "the vector authenticates");
    if (r.ok) assert.deepEqual(r.body, { mailbox: "support@oasisai.work", note: `caf${String.fromCharCode(0xe9)}` });
  });

  await check("a bad signature is 401 unauthorized and the body is never parsed (not 422, though it is not JSON)", async () => {
    const res = await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", null, now, { raw: "this is not json", signature: "a".repeat(64) }), deps);
    const a = await answerOf(res);
    assert.equal(a.status, 401);
    assert.equal(a.body.error, "unauthorized");
    // The SAME body, correctly signed, gets as far as parsing: 422 invalid_json.
    const parsed = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", null, now, { raw: "this is not json" }), deps));
    assert.equal(parsed.status, 422);
    assert.equal(parsed.body.error, "invalid_json");
  });

  await check("an unknown or missing producer, or a missing signature header, is 401", async () => {
    const body = ingestBody({}, now);
    for (const o of [{ producer: "maven" }, { producer: null }, { headers: { "x-support-signature": "" } }, { headers: { "x-support-timestamp": "" } }]) {
      const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now, o as never), deps));
      assert.equal(a.status, 401, JSON.stringify(o));
      assert.equal(a.body.error, "unauthorized");
    }
  });

  await check("the window is 300 s either way: 301 s off is 401 stale_timestamp, 299 s is accepted", async () => {
    const body = ingestBody({ mailbox: "nobody@example.test" }, now);
    const t = Math.floor(now.getTime() / 1000);
    for (const ts of [t - 301, t + 301]) {
      const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now, { ts }), deps));
      assert.equal(a.status, 401);
      assert.equal(a.body.error, "stale_timestamp", "the reader reports skew as occ_clock_skew from this code");
    }
    for (const ts of [t - 299, t + 299]) {
      // Authenticated: it reaches validation (an unknown mailbox is 422).
      const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now, { ts }), deps));
      assert.equal(a.status, 422);
    }
  });

  await check("an unset or short secret is 503 not_installed on every route: fail closed, never open", async () => {
    for (const env of [{}, { SUPPORT_INGEST_SECRET_BEA: "too-short-secret" }, { SUPPORT_INGEST_SECRET_BEA: `   ${"x".repeat(31)}   ` }]) {
      const d = { ...deps, env };
      const answers = [
        await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", ingestBody({}, now), now), d),
        await health.handleSupportHeartbeat(signedRequest("/api/internal/support/heartbeat", {}, now), d),
        await drafts.handlePendingDrafts(signedRequest("/api/internal/support/pending-drafts", {}, now), d),
        await drafts.handleSupportDraft(signedRequest("/api/internal/support/draft", {}, now), d),
      ];
      for (const res of answers) {
        const a = await answerOf(res);
        assert.equal(a.status, 503);
        assert.equal(a.body.error, "not_installed");
      }
    }
  });

  await check("the 512 KB cap is read BEFORE the signature: a declared or streamed oversize body is 413", async () => {
    const big = "x".repeat(512 * 1024 + 1);
    const streamed = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", null, now, { raw: big }), deps));
    assert.equal(streamed.status, 413);
    assert.equal(streamed.body.error, "body_too_large");
    const declared = await answerOf(
      await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", {}, now, { headers: { "content-length": String(600 * 1024) } }), deps),
    );
    assert.equal(declared.status, 413);
    // At the cap exactly it is read (and then judged on its signature and content).
    const atCap = "y".repeat(512 * 1024);
    const ok = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", null, now, { raw: atCap }), deps));
    assert.equal(ok.status, 422);
  });

  await check("missing tables (migration bravo__200 not applied) are 503 not_installed on every route", async () => {
    const d = { ...deps, db: empty };
    const answers = [
      await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", ingestBody({}, now), now), d),
      await health.handleSupportHeartbeat(
        signedRequest("/api/internal/support/heartbeat", { mailbox: MAILBOX, producer: "bea", phase: "ingest", ok: true, error_code: null, at: now.toISOString(), last_ok_at: null, consecutive_failures: 0, counts: {} }, now),
        d,
      ),
      await drafts.handlePendingDrafts(signedRequest("/api/internal/support/pending-drafts", { mailbox: MAILBOX, limit: 2 }, now), d),
      await drafts.handleSupportDraft(
        signedRequest("/api/internal/support/draft", { message_record_id: "r1", ticket_id: "t1", model_ref: "claude-cli:opus", body: "x".repeat(30), critic: { verdict: "ship", score: 9, issues: [], notes: "" } }, now),
        d,
      ),
    ];
    for (const res of answers) {
      const a = await answerOf(res);
      assert.equal(a.status, 503, JSON.stringify(a.body));
      assert.equal(a.body.error, "not_installed");
    }
  });

  await check("validation and an unknown mailbox are 422 (final), with a short code", async () => {
    const cases: Array<[unknown, string]> = [
      [ingestBody({ mailbox: "help@oasisai.work" }, now), "unknown_mailbox"],
      [ingestBody({ delivered_to: "conaugh@oasisai.work" }, now), "invalid_payload"],
      [ingestBody({ origin: "personal_inbox" }, now), "invalid_payload"],
      [{ ...ingestBody({}, now), ack_wanted: "yes" }, "invalid_payload"],
      [{ ...ingestBody({}, now), message: { ...ingestBody({}, now).message, received_at: "yesterday" } }, "invalid_payload"],
      [{ ...ingestBody({}, now), classification: undefined }, "invalid_payload"],
      [[1, 2, 3], "invalid_payload"],
    ];
    for (const [body, error] of cases) {
      const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now), deps));
      assert.equal(a.status, 422, JSON.stringify(body).slice(0, 120));
      assert.equal(a.body.error, error);
    }
    const hb = await answerOf(
      await health.handleSupportHeartbeat(
        signedRequest("/api/internal/support/heartbeat", { mailbox: "help@oasisai.work", producer: "bea", phase: "ingest", ok: true, error_code: null, at: null, last_ok_at: null, consecutive_failures: 0, counts: {} }, now),
        deps,
      ),
    );
    assert.equal(hb.status, 422);
    assert.equal(hb.body.error, "unknown_mailbox");
    const pd = await answerOf(await drafts.handlePendingDrafts(signedRequest("/api/internal/support/pending-drafts", { mailbox: "help@oasisai.work", limit: 2 }, now), deps));
    assert.equal(pd.status, 422);
    assert.equal(pd.body.error, "unknown_mailbox");
  });

  await check("the contract's whole key set is accepted, the additive keys included, and an unknown extra key is ignored", async () => {
    const body = { ...ingestBody({}, now), something_new: { from: "a newer reader" } } as Record<string, unknown>;
    const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now), deps));
    assert.equal(a.status, 200);
    assert.match(String((a.body.ticket as { number?: string }).number), /^T-\d{4,9}$/i);
  });

  await check("the routes answer POST only, and no handler ever answers 404 or 405 (those mean 'not deployed' to the reader)", async () => {
    for (const route of ["ingest", "heartbeat", "pending-drafts", "draft"]) {
      const src = readFileSync(join(ROOT, "app", "api", "internal", "support", route, "route.ts"), "utf8");
      const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      assert.deepEqual(exported, ["POST"], route);
    }
    const lib = ["email-intake.ts", "support-drafts.ts", "support-inbox-health.ts", "support-ingest-auth.ts"];
    for (const f of lib) {
      const src = readFileSync(join(ROOT, "lib", "delivery", f), "utf8");
      assert.doesNotMatch(src, /refuse\(\s*40[45]\b|status:\s*40[45]\b|supportJson\(\s*40[45]\b/, f);
    }
    assert.ok(readdirSync(join(ROOT, "app", "api", "internal", "support")).length === 4, "exactly the four routes");
  });

  await check("through the deployed route module: the secret from the Worker env, the database from the deployment", async () => {
    process.env.SUPPORT_INGEST_SECRET_BEA = SECRET;
    try {
      const route = await import("../app/api/internal/support/heartbeat/route");
      const res = await route.POST(
        signedRequest(
          "/api/internal/support/heartbeat",
          { mailbox: MAILBOX, producer: "bea", phase: "ingest", ok: true, error_code: null, at: new Date().toISOString(), last_ok_at: null, consecutive_failures: 0, counts: { found: 1 } },
          new Date(),
        ),
      );
      const a = await answerOf(res);
      assert.equal(a.status, 200);
      assert.equal(a.body.stale_after_minutes, 20);
    } finally {
      delete process.env.SUPPORT_INGEST_SECRET_BEA;
    }
  });

  await notify.drain();
  finish("support-inbox-wire");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
