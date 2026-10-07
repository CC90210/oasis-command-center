import test from "node:test";
import assert from "node:assert/strict";
import { createSeoClient, clientFromEnv, settle, SeoUnavailable, SeoApiError, SEO_TIMEOUT_MS, SEO_CHECK_ACCESS_TIMEOUT_MS } from "../lib/seo/client";

const READ = "r".repeat(32);
const MANAGE = "m".repeat(32);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(reply: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  return { seen, fetch: async (req: Request) => { seen.push(req); return reply(req); } };
}
const SITES = { generated_at: "2026-10-07T00:00:00Z", sites: [] };
const SUMMARY = { site: { id: "oasis" }, range: "28d", grain: "day", rollups_pending: false, current: null, previous: null, prior_year: null, trend: [], freshness: {} };
const TOP = { site: { id: "oasis" }, range: "28d", period: null, previous_period: null, approximate: false, rollups_pending: false, note: "n", rows: [] };

test("reads send the READ key and ask for test sites only when told", async () => {
  const f = fake(() => json(SITES));
  const c = createSeoClient({ fetcher: f, readKey: READ, manageKey: MANAGE });
  await c.listSites();
  await c.listSites({ includeTest: true });
  assert.equal(f.seen[0].headers.get("authorization"), `Bearer ${READ}`);
  assert.equal(new URL(f.seen[0].url).pathname + new URL(f.seen[0].url).search, "/v1/sites");
  assert.equal(new URL(f.seen[1].url).search, "?include_test=1");
  assert.equal(f.seen[0].method, "GET");
});

test("summary, queries and pages build the documented paths", async () => {
  const f = fake((req) => json(new URL(req.url).pathname.endsWith("/summary") ? SUMMARY : TOP));
  const c = createSeoClient({ fetcher: f, readKey: READ });
  await c.summary("oasis", "3m", { includeTest: true });
  await c.queries("oasis", "16m");
  await c.pages("oasis", "28d");
  const paths = f.seen.map((r) => new URL(r.url).pathname + new URL(r.url).search);
  assert.deepEqual(paths, [
    "/v1/sites/oasis/summary?range=3m&include_test=1",
    "/v1/sites/oasis/queries?range=16m",
    "/v1/sites/oasis/pages?range=28d",
  ]);
});

test("a site id that is not a valid id is a 404 and NO request is made", async () => {
  const f = fake(() => json(SUMMARY));
  const c = createSeoClient({ fetcher: f, readKey: READ, manageKey: MANAGE });
  for (const bad of ["Oasis", "../health", "a", "x".repeat(49), "oasis/../x", "", "-oasis"]) {
    await assert.rejects(c.summary(bad, "28d"), (e: unknown) => e instanceof SeoApiError && e.status === 404, bad);
    await assert.rejects(c.checkAccess(bad, "op@oasisai.work"), (e: unknown) => e instanceof SeoApiError && e.status === 404, bad);
  }
  assert.equal(f.seen.length, 0);
});

test("a range outside 28d|3m|16m is refused before any request", async () => {
  const f = fake(() => json(SUMMARY));
  const c = createSeoClient({ fetcher: f, readKey: READ });
  await assert.rejects(c.summary("oasis", "7d" as never), (e: unknown) => e instanceof SeoApiError && e.code === "bad_range");
  assert.equal(f.seen.length, 0);
});

test("addSite uses the MANAGE key and sends the operator as dpa_confirmed_by", async () => {
  const f = fake(() => json({ created: true, site: { id: "acme-ca", domain: "acme.ca", is_test: false, status: "waiting" } }, 201));
  const c = createSeoClient({ fetcher: f, readKey: READ, manageKey: MANAGE });
  const r = await c.addSite({ domain: "acme.ca", dpaConfirmedBy: "op@oasisai.work" });
  assert.equal(f.seen[0].headers.get("authorization"), `Bearer ${MANAGE}`);
  assert.equal(f.seen[0].method, "POST");
  assert.deepEqual(await f.seen[0].json(), { domain: "acme.ca", dpa_confirmed_by: "op@oasisai.work", is_test: false });
  assert.equal(r.created, true);
});

test("a duplicate add (409) returns created:false with the existing site, not an error", async () => {
  const f = fake(() => json({ error: "site already exists", code: "exists", site: { id: "acme-ca", domain: "acme.ca", is_test: false } }, 409));
  const c = createSeoClient({ fetcher: f, readKey: READ, manageKey: MANAGE });
  assert.deepEqual(await c.addSite({ domain: "acme.ca", dpaConfirmedBy: "op@oasisai.work" }), {
    created: false, site: { id: "acme-ca", domain: "acme.ca", is_test: false },
  });
});

test("checkAccess posts the actor with the manage key", async () => {
  const f = fake(() => json({ result: "blocked", reason: "sc-domain:acme.ca: User does not have sufficient permission" }));
  const c = createSeoClient({ fetcher: f, readKey: READ, manageKey: MANAGE });
  const r = await c.checkAccess("acme-ca", "op@oasisai.work");
  assert.equal(new URL(f.seen[0].url).pathname, "/v1/sites/acme-ca/check-access");
  assert.deepEqual(await f.seen[0].json(), { actor: "op@oasisai.work" });
  assert.equal(r.result, "blocked");
});

test("a manage call without a manage key is unavailable and makes no request", async () => {
  const f = fake(() => json({}));
  const c = createSeoClient({ fetcher: f, readKey: READ });
  await assert.rejects(c.addSite({ domain: "acme.ca", dpaConfirmedBy: "x" }), (e: unknown) => e instanceof SeoUnavailable && e.reason === "manage_key_missing");
  assert.equal(f.seen.length, 0);
});

test("refused keys, a down Worker and an old Worker are UNAVAILABLE, never data", async () => {
  const cases: Array<[Response, string]> = [
    [json({ error: "unauthorized", code: "unauthorized" }, 401), "401_unauthorized"],
    [json({ error: "this key cannot change anything", code: "forbidden" }, 403), "403_forbidden"],
    [json({ error: "SEO data unavailable", code: "unavailable" }, 503), "503_unavailable"],
    [json({ error: "not found", code: "not_found" }, 404), "404_not_found"],
  ];
  for (const [res, reason] of cases) {
    const c = createSeoClient({ fetcher: fake(() => res), readKey: READ });
    await assert.rejects(c.listSites(), (e: unknown) => e instanceof SeoUnavailable && e.reason === reason, reason);
  }
});

test("a 200 that is not the API's shape is unavailable, never an empty list", async () => {
  const shapes: Array<[() => Response, (c: ReturnType<typeof createSeoClient>) => Promise<unknown>]> = [
    [() => new Response("<html>error</html>", { status: 200 }), (c) => c.listSites()],
    [() => json({}), (c) => c.listSites()],
    [() => json({ sites: null }), (c) => c.listSites()],
    [() => json({ site: { id: "oasis" } }), (c) => c.summary("oasis", "28d")],
    [() => json({ site: { id: "oasis" }, rows: "x" }), (c) => c.queries("oasis", "28d")],
    [() => json([]), (c) => c.listSites()],
  ];
  for (const [reply, run] of shapes) {
    const c = createSeoClient({ fetcher: fake(reply), readKey: READ });
    await assert.rejects(run(c), (e: unknown) => e instanceof SeoUnavailable);
  }
});

test("a 400 carries the Worker's own message; an unknown site is a 404 SeoApiError", async () => {
  const bad = createSeoClient({ fetcher: fake(() => json({ error: "Enter just the domain, like example.com.", code: "bad_domain" }, 400)), readKey: READ, manageKey: MANAGE });
  await assert.rejects(bad.addSite({ domain: "https://x", dpaConfirmedBy: "o" }),
    (e: unknown) => e instanceof SeoApiError && e.status === 400 && e.code === "bad_domain" && e.message.startsWith("Enter just the domain"));
  const gone = createSeoClient({ fetcher: fake(() => json({ error: "unknown site", code: "unknown_site" }, 404)), readKey: READ });
  await assert.rejects(gone.summary("ghost-site", "28d"), (e: unknown) => e instanceof SeoApiError && e.status === 404);
});

test("a Worker that never answers times out as unavailable", async () => {
  const c = createSeoClient({ fetcher: { fetch: () => new Promise<Response>(() => undefined) }, readKey: READ, timeoutMs: 20 });
  await assert.rejects(c.listSites(), (e: unknown) => e instanceof SeoUnavailable && e.reason === "timeout");
});

test("the default check-access timeout is 20s, longer than the general 8s default (M1)", () => {
  assert.equal(SEO_TIMEOUT_MS, 8_000);
  assert.equal(SEO_CHECK_ACCESS_TIMEOUT_MS, 20_000);
});

test("checkAccess uses its own longer timeout; other calls keep the general one (M1)", async () => {
  const never = { fetch: () => new Promise<Response>(() => undefined) };
  const c = createSeoClient({ fetcher: never, readKey: READ, manageKey: MANAGE, timeoutMs: 25, checkAccessTimeoutMs: 90 });
  const t0 = Date.now();
  await assert.rejects(c.checkAccess("acme-ca", "op@oasisai.work"), (e: unknown) => e instanceof SeoUnavailable && e.reason === "timeout");
  const checkDur = Date.now() - t0;
  const t1 = Date.now();
  await assert.rejects(c.listSites(), (e: unknown) => e instanceof SeoUnavailable && e.reason === "timeout");
  const listDur = Date.now() - t1;
  assert.ok(checkDur >= 80, `checkAccess should wait ~90ms before timing out, waited ${checkDur}ms`);
  assert.ok(listDur < 60, `listSites should wait ~25ms before timing out, waited ${listDur}ms`);
});

test("a fetch that throws is unreachable", async () => {
  const c = createSeoClient({ fetcher: { fetch: async () => { throw new TypeError("network"); } }, readKey: READ });
  await assert.rejects(c.listSites(), (e: unknown) => e instanceof SeoUnavailable && e.reason === "unreachable");
});

test("clientFromEnv fails closed on a missing binding or a short key", () => {
  const binding = { fetch: async () => json(SITES) };
  assert.throws(() => clientFromEnv({ SEO_READ_TOKEN: READ }), (e: unknown) => e instanceof SeoUnavailable && e.reason === "binding_missing");
  assert.throws(() => clientFromEnv({ SEO_MEASURE: {}, SEO_READ_TOKEN: READ }), (e: unknown) => e instanceof SeoUnavailable && e.reason === "binding_missing");
  assert.throws(() => clientFromEnv({ SEO_MEASURE: binding }), (e: unknown) => e instanceof SeoUnavailable && e.reason === "read_key_missing");
  assert.throws(() => clientFromEnv({ SEO_MEASURE: binding, SEO_READ_TOKEN: "short" }), (e: unknown) => e instanceof SeoUnavailable && e.reason === "read_key_missing");
  assert.ok(clientFromEnv({ SEO_MEASURE: binding, SEO_READ_TOKEN: READ }));
});

test("clientFromEnv calls the binding as a method (a detached fetch loses its binding)", async () => {
  const binding = { calls: 0, async fetch(this: { calls: number }) { this.calls += 1; return json(SITES); } };
  await clientFromEnv({ SEO_MEASURE: binding, SEO_READ_TOKEN: READ }).listSites();
  assert.equal(binding.calls, 1);
});

test("settle: data, not_found for an unknown site, unavailable for everything else", async () => {
  assert.deepEqual(await settle(async () => 5), { state: "ok", data: 5 });
  assert.deepEqual(await settle(async () => { throw new SeoApiError(404, "unknown_site", "x"); }), { state: "not_found" });
  assert.deepEqual(await settle(async () => { throw new SeoUnavailable("timeout"); }), { state: "unavailable", reason: "timeout" });
  assert.deepEqual(await settle(async () => { throw new Error("boom"); }), { state: "unavailable", reason: "error" });
});
