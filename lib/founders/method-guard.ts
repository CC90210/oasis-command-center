import { NextResponse } from "next/server";

/**
 * 404 for a verb a founders route does not implement.
 *
 * lib/founders/gate.ts states the invariant: SunBiz and every other tenant must
 * not learn this portal exists — "404 and never 403, because a 403 confirms the
 * route exists." The gate upholds that for the verbs each route implements.
 *
 * The framework does not. Next returns 405 Method Not Allowed for an exported
 * route with no handler for that verb, and it returns it BEFORE any of our code
 * runs — so `GET /api/founders/marketing/ingest` answered 405 (this path is
 * real) while `GET /api/founders/nonsense` answered 404. Different answers, and
 * the difference is the thing the design is trying not to say.
 *
 * Anonymous callers never saw it — middleware 401s every /api/* path, verified
 * in production against both real and invented routes. The gap was only ever
 * visible to a signed-in user of ANOTHER tenant probing with the wrong verb. No
 * data crossed; the route's existence did, and that is the whole point of the
 * rule.
 *
 * Usage — name every verb the route does not implement:
 *
 *   export const GET = methodNotHere;
 *   export const DELETE = methodNotHere;
 */
export function methodNotHere() {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}
