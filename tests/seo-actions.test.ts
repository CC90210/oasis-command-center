import test from "node:test";
import assert from "node:assert/strict";
import { addSiteAction, checkAccessAction, type ActionDeps } from "../lib/seo/actions";
import { SeoApiError, SeoUnavailable, type SeoClient } from "../lib/seo/client";

const OP = "op@oasisai.work";
const URL_ = "https://oasisai.work/api/seo/sites";

function req(body: unknown, { origin = "https://oasisai.work", raw }: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "oasisai.work" };
  if (origin) headers.origin = origin;
  return new Request(URL_, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

function deps(over: Partial<SeoClient> = {}, who: string | null = OP) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    addSite: async (a: unknown) => { calls.push(["addSite", a]); return { created: true, site: { id: "acme-ca", domain: "acme.ca", is_test: false, status: "waiting" } }; },
    checkAccess: async (id: string, actor: string) => { calls.push(["checkAccess", { id, actor }]); return { result: "ok", property: "sc-domain:acme.ca", permission: "siteFullUser" }; },
    ...over,
  } as unknown as SeoClient;
  const d: ActionDeps = { operatorEmail: async () => who, client: async () => client };
  return { d, calls };
}
const body = async (r: Response) => r.json() as Promise<Record<string, unknown>>;

test("a non-operator gets 404 and the client is never built", async () => {
  let built = false;
  const d: ActionDeps = { operatorEmail: async () => null, client: async () => { built = true; throw new Error("no"); } };
  assert.equal((await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }), d)).status, 404);
  assert.equal((await checkAccessAction(req({}), "acme-ca", d)).status, 404);
  assert.equal(built, false);
});

test("a cross-site or Origin-less POST is refused before the body is read", async () => {
  const { d, calls } = deps();
  assert.equal((await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }, { origin: "https://evil.example" }), d)).status, 403);
  assert.equal((await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }, { origin: null }), d)).status, 403);
  assert.equal((await checkAccessAction(req({}, { origin: "https://evil.example" }), "acme-ca", d)).status, 403);
  assert.equal(calls.length, 0);
});

test("the operator from the SESSION is recorded, whatever the form says", async () => {
  const { d, calls } = deps();
  const r = await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true, dpa_confirmed_by: "attacker@evil.example", created_by: "x" }), d);
  assert.equal(r.status, 201);
  assert.deepEqual(calls[0], ["addSite", { domain: "acme.ca", dpaConfirmedBy: OP, isTest: false }]);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("check-access sends the session operator as the actor", async () => {
  const { d, calls } = deps();
  const r = await checkAccessAction(req({ actor: "attacker@evil.example" }), "acme-ca", d);
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0], ["checkAccess", { id: "acme-ca", actor: OP }]);
  assert.equal((await body(r)).result, "ok");
});

test("no DPA tick, no domain, bad JSON, a big body or a non-boolean test flag = 400 and nothing sent", async () => {
  const { d, calls } = deps();
  const cases: Array<[Request, string]> = [
    [req({ domain: "acme.ca" }), "dpa_required"],
    [req({ domain: "acme.ca", dpa_confirmed: "yes" }), "dpa_required"],
    [req({ dpa_confirmed: true }), "bad_domain"],
    [req(null, { raw: "{not json" }), "bad_json"],
    [req(null, { raw: "[1,2]" }), "bad_json"],
    [req(null, { raw: JSON.stringify({ domain: "a".repeat(5000), dpa_confirmed: true }) }), "bad_json"],
    [req({ domain: "acme.ca", dpa_confirmed: true, is_test: "1" }), "bad_is_test"],
  ];
  for (const [r, code] of cases) {
    const res = await addSiteAction(r, d);
    assert.equal(res.status, 400, code);
    assert.equal((await body(res)).code, code);
  }
  assert.equal(calls.length, 0);
});

test("the test-site flag passes through when true", async () => {
  const { d, calls } = deps();
  await addSiteAction(req({ domain: "seo-canary.oasisai.work", dpa_confirmed: true, is_test: true }), d);
  assert.deepEqual(calls[0], ["addSite", { domain: "seo-canary.oasisai.work", dpaConfirmedBy: OP, isTest: true }]);
});

test("an existing domain is 409 with the existing site, never a duplicate", async () => {
  const { d } = deps({ addSite: (async () => ({ created: false, site: { id: "acme-ca", domain: "acme.ca", is_test: false } })) as never });
  const r = await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }), d);
  assert.equal(r.status, 409);
  assert.deepEqual((await body(r)).site, { id: "acme-ca", domain: "acme.ca", is_test: false });
});

test("the Worker's own 400 message reaches the operator", async () => {
  const { d } = deps({ addSite: (async () => { throw new SeoApiError(400, "bad_domain", "Enter just the domain, like example.com. No https://, path, port or spaces."); }) as never });
  const r = await addSiteAction(req({ domain: "https://acme.ca/x", dpa_confirmed: true }), d);
  assert.equal(r.status, 400);
  assert.deepEqual(await body(r), { error: "Enter just the domain, like example.com. No https://, path, port or spaces.", code: "bad_domain" });
});

test("unknown site on check-access is 404; a down Worker or missing binding is 503", async () => {
  const gone = deps({ checkAccess: (async () => { throw new SeoApiError(404, "unknown_site", "unknown site"); }) as never });
  assert.equal((await checkAccessAction(req({}), "ghost", gone.d)).status, 404);
  const down = deps({ addSite: (async () => { throw new SeoUnavailable("503_unavailable"); }) as never });
  const r = await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }), down.d);
  assert.equal(r.status, 503);
  assert.equal((await body(r)).code, "unavailable");
  const noBinding: ActionDeps = { operatorEmail: async () => OP, client: async () => { throw new SeoUnavailable("binding_missing"); } };
  assert.equal((await addSiteAction(req({ domain: "acme.ca", dpa_confirmed: true }), noBinding)).status, 503);
});
