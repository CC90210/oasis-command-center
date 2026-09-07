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
// This used to assert the OPPOSITE — that the sidebar fires
// requestIdleCallback(prefetchWebLeads) on every page. That eager prefetch was
// deliberately removed: measured on its own /api/web-leads costs 989-2,647 ms,
// it ran on every navigation whether or not anyone was heading for Web Leads,
// and the next click queued behind work nobody asked for. Sidebar.tsx:263-288
// carries the reasoning, and tests/perf-prefetch.test.ts pins the replacement.
//
// Nobody updated this line, so two tests in the same suite asserted
// contradictory things and `main` went red on 2026-09-04 and stayed red,
// blocking every open PR in the repo. Flipped to guard the fix instead of the
// behaviour it replaced: re-introducing the idle prefetch now fails here too.
// Matched on the SCHEDULER, not on one spelling of its argument. The first
// version of this guard looked for `requestIdleCallback(prefetchWebLeads` —
// which is a check on spelling, exactly the defect that let the stale assertion
// above survive a refactor. `requestIdleCallback(() => prefetchWebLeads())`
// would have reintroduced the whole 989-2,647 ms regression with the test still
// green. (Caught by CodeRabbit on #394.) So: find every deferred scheduler call
// in the file and assert none of them mentions a prefetch anywhere in its body.
// Two more holes, both caught by CodeRabbit on #395 and both real:
//   * requiring `(` after the name missed `setTimeout(prefetchWebLeads, 0)` —
//     a BARE function reference, which is the shortest way to write the bug.
//   * a fixed 300-character window let a longer callback hide the call past
//     the end of it.
// So the argument list is extracted by balancing parentheses — the whole
// callback, however long — and the names are matched as identifiers, called or
// merely passed.
function deferredCallBodies(src: string): string[] {
  const out: string[] = [];
  for (const scheduler of ["requestIdleCallback", "setTimeout", "setInterval"]) {
    const calls = new RegExp(`\\b${scheduler}\\s*\\(`, "g");
    for (let m = calls.exec(src); m; m = calls.exec(src)) {
      let depth = 0;
      let i = m.index + m[0].length - 1;         // sits on the opening paren
      for (; i < src.length; i += 1) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(src.slice(m.index, Math.min(i + 1, src.length)));
    }
  }
  return out;
}
for (const body of deferredCallBodies(sidebar)) {
  // The FUNCTION names as identifiers, not the word "prefetch": Next's
  // <Link prefetch> prop is legitimate and common in this file, and a guard
  // that failed on it would be a false alarm blocking CI — which is how the
  // stale assertion above trained everyone to ignore this suite.
  assert.doesNotMatch(
    body,
    /\bprefetch(WebLeads|RememberedWebLeads)\b/,
    `the sidebar must not prefetch Web Leads on a timer — that was the 989-2,647 ms "everything feels slow". Found in: ${body.slice(0, 110).replace(/\s+/g, " ")}`,
  );
}
// Hover AND focus must both reach the intent path — focus is how a keyboard
// operator expresses the same intent, and dropping it would silently make the
// prefetch mouse-only. Asserted through the handler the JSX actually binds
// rather than a hardcoded name: the previous version demanded
// `onMouseEnter={onIntent}` when the component binds a local callback that
// calls onIntent?.(), so it failed on a rename while the behaviour was fine.
const hover = /onMouseEnter=\{(\w+)\}/.exec(sidebar);
assert(hover, "the nav item must prefetch on hover");
assert.match(
  sidebar,
  new RegExp(`onFocus=\\{${hover[1]}\\}`),
  "focus must reach the same handler as hover, or the prefetch is mouse-only",
);
assert.match(
  sidebar,
  new RegExp(`const ${hover[1]} = useCallback\\([\\s\\S]{0,400}?onIntent\\?\\.\\(\\)`),
  "that handler must actually fire onIntent, not merely exist",
);
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
