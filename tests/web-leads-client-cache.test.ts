import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fetchCachedWebLeadsJson,
  invalidateWebLeadsClientCache,
  prefetchWebLeads,
  webLeadsRequestUrls,
} from "../lib/web-leads/client-cache";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

async function main() {
const canonical = webLeadsRequestUrls("lead=drawer&page=9&prov=ON&view=mine");
assert.equal(canonical.facets, "/api/web-leads/facets?view=mine&prov=ON");
assert.equal(canonical.list, "/api/web-leads?view=mine&prov=ON&page=9&scope=mine");

const originalFetch = globalThis.fetch;
try {
  let calls = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;

  const first = fetchCachedWebLeadsJson<{ value: number }>("/api/web-leads?prov=ON");
  const duplicate = fetchCachedWebLeadsJson<{ value: number }>("/api/web-leads?prov=ON");
  assert.equal(first, duplicate, "identical in-flight reads share one promise");
  assert.equal(calls, 1, "intent prefetch and page mount must not duplicate the read");
  finish(new Response(JSON.stringify({ value: 1 }), { status: 200 }));
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await fetchCachedWebLeadsJson("/api/web-leads?prov=ON"), { value: 1 });
  assert.equal(calls, 1, "a brief successful result remains reusable");

  invalidateWebLeadsClientCache();
  let postMutationCacheMode: RequestCache | undefined;
  let postMutationUrl = "";
  globalThis.fetch = (async (input, init) => {
    calls += 1;
    postMutationUrl = String(input);
    postMutationCacheMode = init?.cache;
    return new Response(JSON.stringify({ value: 2 }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await fetchCachedWebLeadsJson("/api/web-leads?prov=ON"), { value: 2 });
  assert.equal(calls, 2, "claim/release invalidation forces a fresh ownership read");
  assert.equal(postMutationCacheMode, "reload", "invalidation bypasses a still-fresh browser response too");
  assert.match(
    postMutationUrl,
    /[?&]fresh=1(?:&|$)/,
    "invalidation also bypasses per-instance server memos after a mutation",
  );

  invalidateWebLeadsClientCache();
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    fetchCachedWebLeadsJson("/api/web-leads?retry=1"),
    /temporarily_unavailable/,
  );
  assert.deepEqual(await fetchCachedWebLeadsJson("/api/web-leads?retry=1"), { ok: true });
  assert.equal(attempts, 2, "a rejected entry is evicted so the next read can recover");

  invalidateWebLeadsClientCache();
  let prefetchCalls = 0;
  globalThis.fetch = (async () => {
    prefetchCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  await prefetchWebLeads("prov=ON");
  await prefetchWebLeads("prov=ON");
  assert.equal(prefetchCalls, 1, "the combined list/facets receipt is shared across repeat prefetches");

  invalidateWebLeadsClientCache();
  let boundedCalls = 0;
  globalThis.fetch = (async () => {
    boundedCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  for (let index = 0; index < 45; index += 1) {
    await fetchCachedWebLeadsJson(`/api/web-leads?page=${index}`);
  }
  await fetchCachedWebLeadsJson("/api/web-leads?page=0");
  assert.equal(boundedCalls, 46, "long filter sessions evict old responses instead of growing without bound");
} finally {
  invalidateWebLeadsClientCache();
  globalThis.fetch = originalFetch;
}

const browser = read("components/web-leads/WebLeadsBrowser.tsx");
const sidebar = read("components/Sidebar.tsx");
const listRoute = read("app/api/web-leads/route.ts");
const facetsRoute = read("app/api/web-leads/facets/route.ts");

assert.match(browser, /facets: Facets \| null/);
assert.doesNotMatch(
  browser,
  /webLeadsRequestUrls\(qs\)\.facets/,
  "the browser must not launch a second full-corpus facets request",
);
assert.match(browser, /if \(!alive\) return;/, "cached responses retain the late-response guard");
assert.equal(
  (browser.match(/invalidateWebLeadsClientCache\(\)/g) || []).length,
  2,
  "both claim entry points invalidate cached ownership state",
);
assert.match(sidebar, /requestIdleCallback\(prefetchWebLeads/);
assert.match(sidebar, /onMouseEnter=\{onIntent\}/);
assert.match(sidebar, /onFocus=\{onIntent\}/);
assert.match(sidebar, /prefetchRememberedWebLeads\(\)/);

for (const [name, source] of [["list", listRoute], ["facets", facetsRoute]] as const) {
  assert.match(source, /private, max-age=15, stale-while-revalidate=30/, `${name} success is briefly browser-cacheable`);
  assert.match(source, /"Vary": "Cookie"/, `${name} cache varies by authenticated cookie`);
  assert.doesNotMatch(source, /s-maxage|Cache-Control[^\n]*public/, `${name} must never opt into a shared cache`);
  assert.match(source, /searchParams\.get\("fresh"\) === "1"/, `${name} honors ownership refreshes`);
}

console.log("web-leads-client-cache: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
