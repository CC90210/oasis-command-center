import assert from "node:assert/strict";
import { ObserverIncident, type Incident, type Env } from "../workers/oasis-automation-observer/src/index";

async function main() {
  const original = { fetch: globalThis.fetch, now: Date.now, log: console.log };
  let clock = Date.parse("2026-11-09T12:00:00Z");
  let healthy = false;
  let calls = 0;
  let reply = () => Response.json({ ok: true, result: { message_id: calls } });
  const data = new Map<string, unknown>();
  const env = { CRON_SECRET: "synthetic", AUTOMATION_OBSERVER_ATTEST_SECRET: "dedicated", OASIS_TELEGRAM_BOT_TOKEN: "synthetic", OASIS_TELEGRAM_CHAT_ID: "fixture" } as Env;
  const worker = new ObserverIncident({ storage: { get: async <T>(key: string) => data.get(key) as T | undefined, put: async (key, value) => { data.set(key, value); } }, blockConcurrencyWhile: async (fn) => fn() }, env);
  const incident = () => data.get("incident") as Incident;
  const tick = async (seconds = 60) => { clock += seconds * 1000; await worker.fetch(); };
  try {
    Date.now = () => clock;
    console.log = () => undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("api.telegram.org")) { calls++; return reply(); }
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-oasis-observer-attest"], "dedicated");
      assert.equal(headers["x-oasis-cron-attest"], undefined);
      return Response.json({ ok: healthy, status: healthy ? "observed" : "unverified" }, { status: healthy ? 200 : 503 });
    }) as typeof fetch;
    await tick(); await tick();
    assert.equal(incident().receipts?.alert, 1);
    healthy = true; await tick(300); await tick();
    assert.equal(incident().open, false);
    assert.deepEqual(incident().receipts, { alert: 1, recovery: 2 }, "closed incident retains provider receipts");

    for (const code of [400, 401, 403, 404]) {
      data.clear(); healthy = false;
      reply = () => new Response("provider refusal", { status: code });
      const before = calls;
      await tick(); await tick();
      assert.equal(incident().delivery, "permanent_failure");
      for (let i = 0; i < 4; i++) await tick(300);
      assert.equal(calls, before + 1, `HTTP${code} must not retry until explicit repair/reconciliation`);
      healthy = true; await tick(); await tick();
      assert.equal(incident().delivery, "permanent_failure", "successful observations cannot clear a broken alert credential");
    }

    data.clear(); healthy = false;
    reply = () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 900 } }, { status: 429, headers: { "retry-after": "1200" } });
    const before = calls;
    await tick(); await tick();
    assert.equal(incident().delivery, "refused");
    assert.equal(incident().retryAt, clock + 1200_000);
    await tick(1199); assert.equal(calls, before + 1);
    reply = () => Response.json({ ok: true, result: { message_id: calls } });
    await tick(1); assert.equal(calls, before + 2);
    assert.equal(incident().receipts?.alert, calls);
    assert.equal(incident().retryAt, 0);
  } finally { globalThis.fetch = original.fetch; Date.now = original.now; console.log = original.log; }
  console.log("automation-observer-delivery: OK (durable provider IDs, permanent stops, provider backoff)");
}
main().catch((error) => { console.error(error); process.exit(1); });
