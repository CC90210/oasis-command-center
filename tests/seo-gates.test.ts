import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSeoOwner, type SeoOwnerDeps } from "../lib/seo/owner";
import { buildOsNav, osNavRows, OS_NAV_CATALOG, type BuildOsNavInput } from "../lib/os/nav";
import { resolveOsModules } from "../lib/os/modules";
import { capabilitiesFor, type Persona } from "../lib/role-surfaces";

const read = (p: string) => readFileSync(p, "utf8");

test("every SEO page's first statement is the owners gate", () => {
  for (const p of ["app/seo/page.tsx", "app/seo/[site]/page.tsx", "app/seo/add/page.tsx"]) {
    const src = read(p);
    const body = src.split(/export default async function \w+\([^)]*\)[^{]*\{/s)[1];
    assert.ok(body, `${p}: no default async page function`);
    const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    assert.equal(first, "await requireSeoOwner();", `${p}: the gate must come before any read`);
    assert.match(src, /import \{[^}]*\brequireSeoOwner\b[^}]*\} from "@\/lib\/seo\/occ";/, `${p}: gate comes from lib/seo/occ`);
    assert.doesNotMatch(src, /requireOperator/, `${p}: the operator gate admits CC's admin list, not CC and Adon`);
  }
});

test("the routes delegate to the tested actions with the SESSION owner", () => {
  const add = read("app/api/seo/sites/route.ts");
  assert.match(add, /addSiteAction\(req, \{ operatorEmail: seoOwnerEmail, client: seoClient \}\)/);
  const chk = read("app/api/seo/sites/[site]/check-access/route.ts");
  assert.match(chk, /checkAccessAction\(req, site, \{ operatorEmail: seoOwnerEmail, client: seoClient \}\)/);
  for (const src of [add, chk]) assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)/);
});

test("occ.ts wires the Money tab's owners rule, not the operator list", () => {
  const src = read("lib/seo/occ.ts");
  assert.match(src, /resolveFounder/, "founders portal gate (tenant + capability)");
  assert.match(src, /ownerKeyForUser\(/, "auth user id behind an owner email");
  assert.match(src, /loadOwnerProfiles\(/);
  assert.match(src, /resolveSeoOwner\(/, "the tested order + fail-closed core");
  assert.doesNotMatch(src, /resolvePlatformOperatorForAuthUser|isOperatorEmail|seoOperatorEmail/);
});

// ── the owners decision (lib/seo/owner.ts) ──────────────────────────────────
const CC = "conaugh@oasisai.work";
const ADON = "adon@oasisai.work";

function ownerDeps(over: Partial<SeoOwnerDeps> = {}): { d: SeoOwnerDeps; asked: string[] } {
  const asked: string[] = [];
  const d: SeoOwnerDeps = {
    inFoundersPortal: async () => { asked.push("portal"); return true; },
    sessionUserId: async () => { asked.push("session"); return "uid-adon"; },
    ownerEmailForUser: async (uid) => { asked.push(`owner:${uid}`); return uid === "uid-adon" ? ADON : uid === "uid-cc" ? CC : null; },
    ...over,
  };
  return { d, asked };
}

test("CC and Adon are admitted, as themselves", async () => {
  assert.equal(await resolveSeoOwner(ownerDeps().d), ADON);
  assert.equal(await resolveSeoOwner(ownerDeps({ sessionUserId: async () => "uid-cc" }).d), CC);
});

test("a third OASIS admin, a marketing hire, or a builder is refused", async () => {
  // In the founders portal (founder, marketing or builder) but not behind an owner email.
  const { d, asked } = ownerDeps({ sessionUserId: async () => "uid-schneur" });
  assert.equal(await resolveSeoOwner(d), null);
  assert.deepEqual(asked, ["portal", "owner:uid-schneur"]);
});

test("an owner's auth id outside the founders portal is refused, and the owner rows are never read", async () => {
  const { d, asked } = ownerDeps({ inFoundersPortal: async () => { asked.push("portal"); return false; } });
  assert.equal(await resolveSeoOwner(d), null);
  assert.deepEqual(asked, ["portal"]);
});

test("no session is refused", async () => {
  const { d } = ownerDeps({ sessionUserId: async () => null });
  assert.equal(await resolveSeoOwner(d), null);
});

test("every lookup failure is a refusal, never an admit", async () => {
  const boom = async () => { throw new Error("db down"); };
  for (const over of [{ inFoundersPortal: boom }, { sessionUserId: boom }, { ownerEmailForUser: boom }] as Partial<SeoOwnerDeps>[]) {
    assert.equal(await resolveSeoOwner(ownerDeps(over).d), null);
  }
});

// ── the rail row matches the page wall ─────────────────────────────────────
const OASIS = "oasis-ai-cc";
function viewer(persona: Persona, over: Partial<BuildOsNavInput> = {}): BuildOsNavInput {
  return {
    persona,
    capabilities: capabilitiesFor(persona, OASIS),
    isOperator: false,
    tenantSlug: OASIS,
    isOasisTenant: true,
    modules: resolveOsModules({ tenantSlug: OASIS, provisioned: true }),
    provisioned: true,
    founders: { content: true, finances: false },
    ...over,
  };
}
const seesSeo = (input: BuildOsNavInput) => osNavRows(buildOsNav(input)).some((r) => r.href === "/seo");

test("the SEO row is on CC's and Adon's rail and nobody else's", () => {
  assert.equal(OS_NAV_CATALOG.find((e) => e.href === "/seo")?.audience, "finance_owner");
  assert.ok(seesSeo(viewer("founder", { founders: { content: true, finances: true } })), "an owner (not an operator) sees SEO");
  assert.ok(!seesSeo(viewer("founder", { isOperator: true })), "an operator who is not an owner does not");
  assert.ok(!seesSeo(viewer("founder")), "another OASIS admin does not");
  for (const persona of ["marketing", "builder", "manager", "sales"] as Persona[]) {
    assert.ok(!seesSeo(viewer(persona, { founders: { content: true, finances: true } })), `${persona} does not, even with lying flags`);
  }
});

test("the service binding is declared", () => {
  assert.match(read("wrangler.jsonc"), /"binding":\s*"SEO_MEASURE",\s*"service":\s*"oasis-seo-measure"/);
});

test("no SEO file reads a database or the public Worker URL", () => {
  for (const p of ["lib/seo/client.ts", "lib/seo/occ.ts", "lib/seo/actions.ts", "lib/seo/owner.ts"]) {
    const src = read(p);
    assert.doesNotMatch(src, /turso|libsql|TURSO_|workers\.dev/i, p);
  }
});
