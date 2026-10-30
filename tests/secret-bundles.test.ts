/**
 * Secret bundles (lib/runtime/secret-bundles.ts): many Worker secrets carried in a few, expanded by worker-entry.ts
 * before OpenNext copies the env into process.env. And the signed digest check (lib/runtime/secret-digests.ts) that
 * proves a bundled copy equals the value served before the individual secret is deleted.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  SECRET_BUNDLE_DIGESTS_KEY,
  expandSecretBundles,
  isSecretName,
  scrubBundlesFromProcessEnv,
  secretDigest,
} from "../lib/runtime/secret-bundles";
import { handleSecretDigests } from "../lib/runtime/secret-digests";
import { uploadedEntryName } from "../scripts/check-worker-bundle";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

function testExpansion() {
  const binding = { fetch: () => undefined };
  const env = {
    STRIPE_SECRET_KEY: "individual-stripe",
    ASSETS: binding,
    OCC_SECRET_BUNDLE_1: JSON.stringify({ STRIPE_SECRET_KEY: "bundled-stripe", RESEND_API_KEY: "re_123" }),
    OCC_SECRET_BUNDLE_2: JSON.stringify({ TWILIO_AUTH_TOKEN: "tw_456" }),
  };
  const before = JSON.stringify(env);
  const { env: out, report } = expandSecretBundles(env as Record<string, unknown>);
  assert.equal(JSON.stringify(env), before, "the Worker's env object is never changed");
  assert.equal(out.RESEND_API_KEY, "re_123");
  assert.equal(out.TWILIO_AUTH_TOKEN, "tw_456");
  assert.equal(out.STRIPE_SECRET_KEY, "individual-stripe", "an individual secret wins over its bundled copy");
  assert.equal(out.ASSETS, binding, "bindings pass through as the same object");
  assert.equal("OCC_SECRET_BUNDLE_1" in out, false, "a bundle's JSON never reaches process.env");
  assert.equal("OCC_SECRET_BUNDLE_2" in out, false);
  assert.deepEqual(report, {
    bundles: ["OCC_SECRET_BUNDLE_1", "OCC_SECRET_BUNDLE_2"],
    added: 2,
    shadowed: ["STRIPE_SECRET_KEY"],
    invalid: [],
  });
  assert.deepEqual(JSON.parse(String(out[SECRET_BUNDLE_DIGESTS_KEY])), {
    STRIPE_SECRET_KEY: digest("bundled-stripe"),
    RESEND_API_KEY: digest("re_123"),
    TWILIO_AUTH_TOKEN: digest("tw_456"),
  }, "the digests record carries each bundled value's digest, never the value");
  assert.equal(String(out[SECRET_BUNDLE_DIGESTS_KEY]).includes("re_123"), false);
  assert.equal(secretDigest("re_123"), digest("re_123"));
}

function testInvalidBundlesAreSkippedWhole() {
  for (const bad of ["not json", "[1,2]", JSON.stringify({ OK_KEY: "fine", BAD: 5 }), JSON.stringify({ "bad key": "x" }), "null",
    // "__proto__" fits the name pattern but would set a prototype, not a value (CodeRabbit on #699).
    '{"OK_KEY":"fine","__proto__":"x"}', JSON.stringify({ OK_KEY: "fine", constructor: "x" })]) {
    const { env: out, report } = expandSecretBundles({ OCC_SECRET_BUNDLE_3: bad, KEEP: "k" } as Record<string, unknown>);
    assert.deepEqual(report.invalid, ["OCC_SECRET_BUNDLE_3"], bad);
    assert.equal("OK_KEY" in out, false, "a half-valid bundle sets none of its keys");
    assert.equal(out.KEEP, "k");
    assert.equal(SECRET_BUNDLE_DIGESTS_KEY in out, false);
  }
  // No bundles at all: the env comes back with the same keys, and no digests record.
  const { env: plain, report } = expandSecretBundles({ A: "1" } as Record<string, unknown>);
  assert.deepEqual(plain, { A: "1" });
  assert.deepEqual(report, { bundles: [], added: 0, shadowed: [], invalid: [] });
  // A stray digests key from outside is not trusted: it is rebuilt from the bundles or dropped.
  const { env: stray } = expandSecretBundles({ [SECRET_BUNDLE_DIGESTS_KEY]: "{\"A\":\"forged\"}" } as Record<string, unknown>);
  assert.equal(SECRET_BUNDLE_DIGESTS_KEY in stray, false);
}

function testRawBundlesLeaveProcessEnv() {
  // nodejs_compat copies every binding into process.env at isolate start, raw bundles included (CodeRabbit on #699).
  const processEnv: Record<string, string | undefined> = {
    OCC_SECRET_BUNDLE_1: "{\"A\":\"1\"}",
    OCC_SECRET_BUNDLE_12: "{}",
    OCC_SECRET_BUNDLE_DIGESTS: "{\"A\":\"abc\"}",
    RESEND_API_KEY: "re_1",
  };
  assert.equal(scrubBundlesFromProcessEnv(processEnv), 2);
  assert.deepEqual(processEnv, { OCC_SECRET_BUNDLE_DIGESTS: "{\"A\":\"abc\"}", RESEND_API_KEY: "re_1" },
    "only the raw bundles go; the digests record and every secret stay");
  assert.equal(isSecretName("__proto__"), false);
  assert.equal(isSecretName("RESEND_API_KEY"), true);
}

const SECRET = "t".repeat(40);
const NOW = new Date("2026-10-18T12:00:00.000Z");

function signed(body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(NOW.getTime() / 1000));
  return new Request("https://oasisai.work/api/internal/tools/secret-digests", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tools-producer": "bea",
      "x-tools-timestamp": ts,
      "x-tools-signature": createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex"),
    },
    body: raw,
  });
}

async function testDigestCheck() {
  const { env: served } = expandSecretBundles({
    TOOLS_RUNNER_SECRET_BEA: SECRET,
    STRIPE_SECRET_KEY: "individual-stripe",
    OCC_SECRET_BUNDLE_1: JSON.stringify({ STRIPE_SECRET_KEY: "bundled-stripe", RESEND_API_KEY: "re_123" }),
  } as Record<string, unknown>);
  const deps = { env: served as Record<string, string | undefined>, now: NOW };
  const res = await handleSecretDigests(signed({ names: ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "MISSING_KEY"] }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { digests: unknown }).digests, {
    STRIPE_SECRET_KEY: { served: digest("individual-stripe"), bundled: digest("bundled-stripe") },
    RESEND_API_KEY: { served: digest("re_123"), bundled: digest("re_123") },
    MISSING_KEY: { served: null, bundled: null },
  }, "served differs from bundled until the copies match");

  assert.equal((await handleSecretDigests(signed({ names: ["X"] }, "w".repeat(40)), deps)).status, 401, "a wrong signature");
  assert.equal((await handleSecretDigests(signed({ names: ["X"] }), { env: {}, now: NOW })).status, 503, "no secret: not installed");
  for (const body of [{ names: [] }, { names: ["OCC_SECRET_BUNDLE_1"] }, { names: [SECRET_BUNDLE_DIGESTS_KEY] }, { names: ["bad name"] },
    { names: ["__proto__"] },
    { names: Array.from({ length: 201 }, (_, i) => `K${i}`) }, { names: ["A"], extra: 1 }]) {
    assert.equal((await handleSecretDigests(signed(body), deps)).status, 422, JSON.stringify(body).slice(0, 60));
  }
}

function testEntryWiring() {
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  assert.match(wrangler, /"main":\s*"worker-entry\.ts"/, "the Worker runs worker-entry.ts, which expands the bundles");
  assert.equal(uploadedEntryName(wrangler), "worker-entry.js", "the bundle check reads the entry's own output file");
  assert.equal(uploadedEntryName('{ "main": ".open-next/worker.js" }'), "worker.js");
  const entry = readFileSync("worker-entry.ts", "utf8");
  assert.match(entry, /fetch\(request: Request, env: Env, ctx: Ctx\): Promise<Response> \{\s*return handler\.fetch\(request, withSecretBundles\(env\), ctx\);/);
  assert.match(entry, /const full = withSecretBundles\(env\);\s*await routeQueueBatch\(batch, full, \(request\) => handler\.fetch\(request, full, ctx\)\);/,
    "the exact-name router receives the expanded env and passes the same env to OpenNext");
  assert.match(wrangler, /"producers"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"TELEGRAM_AGENT_JOBS"\s*,\s*"queue"\s*:\s*"oasis-telegram-agent-jobs"\s*\}/,
    "the dedicated Telegram producer is present");
  assert.match(wrangler, /"consumers"\s*:\s*\[\s*\{\s*"queue"\s*:\s*"oasis-telegram-agent-jobs"/,
    "the dedicated Telegram consumer is present");
  assert.doesNotMatch(wrangler, /SLACK_AGENT_JOBS|oasis-slack-agent-jobs/,
    "Slack bindings stay absent while its separate cutover is held");
  assert.match(entry, /scrubBundlesFromProcessEnv\(process\.env\);\s*expanded\.set\(env, merged\);/,
    "the entry removes the raw bundles nodejs_compat copied into process.env");
}

async function main() {
  testExpansion();
  testInvalidBundlesAreSkippedWhole();
  testRawBundlesLeaveProcessEnv();
  await testDigestCheck();
  testEntryWiring();
  console.log("secret-bundles: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
