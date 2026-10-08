import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

test("every SEO page's first statement is the operator gate", () => {
  for (const p of ["app/seo/page.tsx", "app/seo/[site]/page.tsx", "app/seo/add/page.tsx"]) {
    const body = read(p).split(/export default async function \w+\([^)]*\)[^{]*\{/s)[1];
    assert.ok(body, `${p}: no default async page function`);
    const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    assert.equal(first, "await requireOperator();", `${p}: the gate must come before any read`);
  }
});

test("the routes delegate to the tested actions with the SESSION identity", () => {
  const add = read("app/api/seo/sites/route.ts");
  assert.match(add, /addSiteAction\(req, \{ operatorEmail: seoOperatorEmail, client: seoClient \}\)/);
  const chk = read("app/api/seo/sites/[site]/check-access/route.ts");
  assert.match(chk, /checkAccessAction\(req, site, \{ operatorEmail: seoOperatorEmail, client: seoClient \}\)/);
  for (const src of [add, chk]) assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)/);
});

test("the service binding is declared", () => {
  assert.match(read("wrangler.jsonc"), /"binding":\s*"SEO_MEASURE",\s*"service":\s*"oasis-seo-measure"/);
});

test("no SEO file reads a database or the public Worker URL", () => {
  for (const p of ["lib/seo/client.ts", "lib/seo/occ.ts", "lib/seo/actions.ts"]) {
    const src = read(p);
    assert.doesNotMatch(src, /turso|libsql|TURSO_|workers\.dev/i, p);
  }
});
