import test from "node:test";
import assert from "node:assert/strict";
import { checkAccessOutcome } from "../lib/seo/check-access-outcome";

// M2: a 400 from check-access (e.g. no_domain, actor_required) must carry the route's own
// message, the same as the add path already does, instead of the generic "did not answer" DOWN
// banner. Pure unit tests against the extracted decision function: the static-render test harness
// (tests/seo.render.ts) cannot simulate a fetch response (see Task 6 report), so this logic was
// factored out of check()'s fetch/React code specifically so it can be exercised directly.

test("a 200 with a result is ok", () => {
  const r = { status: 200, json: { result: "ok", property: "sc-domain:acme.ca", permission: "siteFullUser" } };
  assert.deepEqual(checkAccessOutcome(r), { kind: "ok", result: r.json });
});

test("a 404 is gone (the site no longer exists)", () => {
  assert.deepEqual(checkAccessOutcome({ status: 404, json: { error: "unknown site", code: "unknown_site" } }), { kind: "gone" });
});

test("a 400 carries the route's own message, not the generic DOWN banner (M1)", () => {
  const r = { status: 400, json: { error: "A domain is required.", code: "no_domain" } };
  assert.deepEqual(checkAccessOutcome(r), { kind: "bad_request", message: "A domain is required." });
});

test("a 400 with no actor is its own message too", () => {
  const r = { status: 400, json: { error: "The session has no operator identity.", code: "actor_required" } };
  assert.deepEqual(checkAccessOutcome(r), { kind: "bad_request", message: "The session has no operator identity." });
});

test("a 400 with no message text falls back to a generic check-failed message, never DOWN", () => {
  assert.deepEqual(checkAccessOutcome({ status: 400, json: { code: "no_domain" } }), { kind: "bad_request", message: "Check failed. Try again." });
  assert.deepEqual(checkAccessOutcome({ status: 400, json: null }), { kind: "bad_request", message: "Check failed. Try again." });
});

test("0, 5xx and unknown statuses are down, never bad_request", () => {
  for (const status of [0, 500, 503, 401, 403]) {
    assert.deepEqual(checkAccessOutcome({ status, json: null }), { kind: "down" }, String(status));
  }
});

test("a 200 with no usable result shape is down, never a false ok", () => {
  assert.deepEqual(checkAccessOutcome({ status: 200, json: {} }), { kind: "down" });
  assert.deepEqual(checkAccessOutcome({ status: 200, json: null }), { kind: "down" });
});
