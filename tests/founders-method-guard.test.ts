/**
 * Every founders API route answers 404 for a verb it does not implement.
 *
 * lib/founders/gate.ts states the invariant: "404 and never 403, because a 403
 * confirms the route exists. SunBiz should not learn there is a founders portal
 * at all." The gate upholds it for the verbs each route implements. The
 * FRAMEWORK does not — Next returns 405 Method Not Allowed for a route with no
 * handler for that verb, before any of our code runs.
 *
 * Measured in production before writing this: an anonymous GET to a real
 * founders API path and to an invented one BOTH returned 401, because
 * middleware gates /api/* first. So no data and no route names ever leaked to a
 * stranger. The gap was visible only to a signed-in user of ANOTHER tenant
 * probing with the wrong verb — narrow, but it is precisely the fact the rule
 * exists to withhold.
 *
 * This test reads the route files rather than booting Next, because the thing
 * being asserted is that no verb is left unhandled — which is a property of the
 * exports, not of a running server.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const API_ROOT = join(process.cwd(), "app", "api", "founders");
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(API_ROOT);

test("there are founders API routes to check", () => {
  // Without this, an empty glob would make every assertion below vacuous and
  // the suite would pass by finding nothing.
  assert.ok(ROUTES.length >= 4, `expected several founders API routes, found ${ROUTES.length}`);
});

for (const file of ROUTES) {
  const rel = file.slice(file.indexOf("app")).replace(/\\/g, "/");

  test(`${rel} handles every verb, implemented or refused`, () => {
    const src = readFileSync(file, "utf8");

    const implemented = new Set([
      ...[...src.matchAll(/export async function ([A-Z]+)/g)].map((m) => m[1]),
      ...[...src.matchAll(/export function ([A-Z]+)/g)].map((m) => m[1]),
    ]);
    const refused = new Set(
      [...src.matchAll(/export const ([A-Z]+)\s*=\s*methodNotHere/g)].map((m) => m[1]),
    );

    assert.ok(
      implemented.size > 0,
      `${rel} exports no handler at all — either it is dead, or the detector is broken`,
    );

    const unhandled = VERBS.filter((v) => !implemented.has(v) && !refused.has(v));
    assert.deepEqual(
      unhandled,
      [],
      `${rel} leaves ${unhandled.join(", ")} to the framework, which answers 405 and ` +
        `thereby confirms the route exists. Add: export const ${unhandled[0]} = methodNotHere;`,
    );
  });
}

test("methodNotHere returns 404, not 403 or 405", async () => {
  const { methodNotHere } = await import("../lib/founders/method-guard");
  const res = methodNotHere();
  assert.equal(res.status, 404, "403 and 405 both confirm the route exists");
  const body = await res.json();
  assert.equal(body.error, "not_found");
});
