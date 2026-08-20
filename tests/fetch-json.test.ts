/**
 * The Automations tab reported "Unexpected end of JSON input" for weeks. That
 * string is what `await res.json()` throws on an EMPTY body — the parser
 * speaking in place of the server, naming nothing anyone can act on.
 *
 * These assertions pin the two behaviours that replaced it: an empty body
 * surfaces its HTTP status, and a transient failure is retried rather than
 * shown to the operator.
 */
import assert from "node:assert/strict";
import { fetchJson } from "../lib/fetch-json";

const realFetch = globalThis.fetch;

async function main() {

  function stubFetch(responses: Array<{ status: number; body: string } | "throw">) {
    let i = 0;
    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next === "throw") throw new Error("network down");
      return new Response(next.body, { status: next.status });
    }) as typeof fetch;
    return calls;
  }

  // 1. An empty 200 must NOT surface as a parser error.
  stubFetch([{ status: 200, body: "" }]);
  let r = await fetchJson<{ ok: boolean }>("/x");
  assert.equal(r.ok, false);
  assert.match(
    (r as { error: string }).error,
    /empty response \(HTTP 200\)/,
    "an empty body must name the HTTP status, never the JSON parser",
  );
  assert.doesNotMatch((r as { error: string }).error, /Unexpected end of JSON input/);

  // 2. A gateway timeout says so in words the operator can act on.
  stubFetch([{ status: 504, body: "" }]);
  r = await fetchJson<{ ok: boolean }>("/x");
  assert.match((r as { error: string }).error, /took too long to answer \(HTTP 504\)/);

  // 3. An HTML error page is reported as non-JSON, with an excerpt, not as a crash.
  stubFetch([{ status: 500, body: "<!DOCTYPE html><title>Server Error</title>" }]);
  r = await fetchJson<{ ok: boolean }>("/x");
  assert.match((r as { error: string }).error, /non-JSON response \(HTTP 500\)/);
  assert.match((r as { raw?: string }).raw || "", /DOCTYPE/);

  // 4. Valid JSON parses through untouched.
  stubFetch([{ status: 200, body: '{"ok":true,"jobs":[1,2]}' }]);
  const good = await fetchJson<{ ok: boolean; jobs: number[] }>("/x");
  assert.equal(good.ok, true);
  assert.deepEqual((good as { data: { jobs: number[] } }).data.jobs, [1, 2]);

  // 5. A transient failure is RETRIED and recovers — the operator never sees it.
  {
    let i = 0;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (i++ === 0) return new Response("", { status: 503 });
      return new Response('{"ok":true,"jobs":[]}', { status: 200 });
    }) as typeof fetch;
    const res = await fetchJson<{ ok: boolean }>("/x", undefined, { retries: 2, retryDelayMs: 1 });
    assert.equal(res.ok, true, "a 503 followed by a 200 must resolve as success");
    assert.equal(calls, 2, "it must have retried exactly once");
  }

  // 6. A 4xx is NOT retried — asking the same wrong question twice helps nobody.
  {
    const calls = stubFetch([{ status: 401, body: '{"ok":false,"error":"unauthorized"}' }]);
    const res = await fetchJson<{ ok: boolean }>("/x", undefined, { retries: 3, retryDelayMs: 1 });
    assert.equal(res.ok, true, "401 with a JSON body still parses — the caller inspects .ok");
    assert.equal(calls.count, 1, "a 401 must not be retried");
  }

  // 7. Retries are bounded: a permanently dead endpoint gives up and reports.
  {
    const calls = stubFetch(["throw"]);
    const res = await fetchJson<{ ok: boolean }>("/x", undefined, { retries: 2, retryDelayMs: 1 });
    assert.equal(res.ok, false);
    assert.equal(calls.count, 3, "initial attempt plus exactly 2 retries");
  }

  globalThis.fetch = realFetch;
  console.log("fetch-json ok — empty bodies name their status, transients retry, 4xx does not");

}

main();
