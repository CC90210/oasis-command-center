/**
 * tests/bridge-rpc-registry.test.ts — the RPCs external callers actually invoke
 * must be reachable through the bridge.
 *
 * TWO REGISTRIES EXISTED AND THEY DID NOT MATCH.
 *
 *   lib/turso-rpc-shim.ts        ports RPCs for the WEB APP (in-process)
 *   app/api/pg/.../route.ts      is what EXTERNAL callers reach
 *
 * `patch_tenant_record_data` was in the first and not the second, so every
 * JARVIS call came back `501 rpc "patch_tenant_record_data" has no Turso port`.
 *
 * Measured 2026-08-20: the TPS phone-lookup worker looked a merchant up, found
 * a mobile, and then could not write it onto the lead — it stamped
 * `manual_review` and dropped the number. A pipeline that finds phones and
 * cannot keep them is indistinguishable from one that finds nothing, and it was
 * the last blocker between 1,099 landline-only leads and being textable.
 *
 * The wider lesson, and why this test exists rather than a comment: the estate
 * has more than one place that decides what is "ported", and being ported in
 * one of them reads exactly like being ported.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(
  new URL("../app/api/pg/rest/v1/[...path]/route.ts", import.meta.url),
  "utf8",
);
const shim = readFileSync(new URL("../lib/turso-rpc-shim.ts", import.meta.url), "utf8");

/**
 * RPCs that callers OUTSIDE this repo invoke through the bridge.
 *
 * Deliberately a short, explicit list rather than "everything in the shim":
 * spreading the whole shim into the bridge would expose 14 RPCs, 12 of them
 * writes and all marked ported-unverified, to anyone holding a bridge token.
 * Reachability here is a decision per function, not a default.
 */
const REQUIRED_ON_BRIDGE = ["patch_tenant_record_data"];

for (const name of REQUIRED_ON_BRIDGE) {
  // It must exist in the shim...
  assert.ok(
    new RegExp(`export async function ${name}\\b`).test(shim),
    `${name} must be implemented in the shim`,
  );
  // ...be imported by the bridge route...
  assert.ok(
    new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "@/lib/turso-rpc-shim"`).test(route),
    `${name} must be imported by the bridge route`,
  );
  // ...and actually be in the dispatch table. Importing without registering is
  // the same silent 501, with a reassuring import line above it.
  const start = route.indexOf("const RPCS: Record<string, RpcFn> = {");
  assert.ok(start > 0, "the RPCS dispatch table must exist");
  const table = route.slice(start, route.indexOf("\n};", start));
  assert.ok(table.includes(name), `${name} must be registered in RPCS, not merely imported`);
}

// ── The bridge must NOT become a blanket re-export of the shim ───────────
// The fix is one function, chosen. A spread would hand every ported RPC to any
// bridge-token holder, which is a privilege change disguised as a convenience.
assert.ok(
  !/\.\.\.TURSO_RPC_SHIM/.test(route) && !/\.\.\.RPC_SHIM/.test(route),
  "the whole shim must never be spread into the bridge registry",
);

// ── An unported RPC must still fail LOUDLY ──────────────────────────────
// The 501 is correct behaviour and must stay: an unported RPC that returned an
// empty result would look like a successful write of nothing, which is the
// failure mode this whole cutover keeps producing.
assert.ok(
  route.includes('return bad(501, `rpc "${name}" has no Turso port`);'),
  "an unregistered RPC must 501 by name, never return an empty success",
);

console.log("bridge-rpc-registry.test.ts — all assertions passed");
