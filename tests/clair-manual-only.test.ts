import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { CLAIR_TOOL_NAME, clairCapabilityError } from "../lib/clair/capability";

/**
 * CLEAR (CLAIR) MUST STAY MANUAL. This test is the enforcement, not a comment.
 *
 * Adon, 2026-07-27: "I don't want there to be any mistakes with CLEAR by
 * accidentally being switched to automatic — we need to keep it always manual."
 *
 * Every Thomson Reuters CLEAR query is billable AND asserts a DPPA/GLB
 * permissible use on a named operator's behalf. An automated pull is therefore
 * not merely expensive, it is an impermissible query — there is no human whose
 * permissible use it was made under.
 *
 * WHY A TEST AND NOT A COMMENT. The route's header has always said "if you are
 * adding an automated caller, you are breaking a compliance boundary". A
 * comment cannot fail a build. And the mechanism for making CLEAR automatic
 * already exists and is already used elsewhere in this repo: `lib/underwriting/
 * run.ts` and `lib/forms/next-steps-email.ts` both reach the VPS with
 * `resolveBridgeTarget()` + `callBridgeExecTool()` and NO session at all. A
 * future cron that copies that shape and passes `tool_name: "clair_report"`
 * would fire billable, unattributed CLEAR pulls and nothing else in the repo
 * would object. This test objects.
 *
 * It is deliberately a STATIC test over the source. The property being defended
 * ("no automated caller exists anywhere") is a property of the whole tree, and
 * cannot be established by exercising one function.
 */

const ROOT = join(__dirname, "..");

/** The one file permitted to invoke the CLEAR bridge tool. */
const THE_ONE_ROUTE = ["app", "api", "leads", "[id]", "clair-report", "route.ts"].join(sep);
/** The capability module that names the tool so the transport can gate on it. */
const THE_CAPABILITY = ["lib", "clair", "capability.ts"].join(sep);

const SOURCE_DIRS = ["app", "lib", "components", "scripts"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional dir (scripts/) may not exist
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
assert.ok(files.length > 100, "source walk found suspiciously few files — the guard would pass vacuously");

const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(ROOT, f);

// ---- 1. The CLEAR bridge tool name appears in EXACTLY TWO files.
// `clair_report` is the tool_name the VPS bridge dispatches on. Anything that
// sends it is capable of spending a billable permissible-use query.
//
// Codex review 2026-07-27 [P2]: this originally matched only '"clair_report"'
// and "'clair_report'", so a backtick literal, a concatenation or a shared
// constant would have slipped past a guard whose whole purpose was to catch
// them. It now matches the bare substring — and, more importantly, is no longer
// the only line of defence: clairCapabilityError() below runs on the RESOLVED
// tool name inside the shared transport, where spelling cannot help you.
//
// Word-bounded: `clair_reports` is the TABLE and is read all over the UI, which
// is fine and unregulated. `clair_report` is the TOOL — the thing that spends.
const TOOL_NAME_RE = /\bclair_report\b/;
const NAMED = new Set([THE_ONE_ROUTE, THE_CAPABILITY]);
const mentions = files.filter((f) => TOOL_NAME_RE.test(read(f)));
assert.deepEqual(
  mentions.map(rel).sort(),
  [...NAMED].sort(),
  "the CLEAR bridge tool may only be named in the session-gated route and the capability module.\n" +
    "A new mention means CLEAR may now be pulled from somewhere that has not been\n" +
    "proven to have a signed-in human behind it. Found: " +
    mentions.map(rel).join(", "),
);

// ---- 2. That one route keeps every manual-only control.
const route = read(join(ROOT, THE_ONE_ROUTE));
for (const [needle, why] of [
  ["authorizeBridgeRequest(", "requires a real Supabase session — this is what a cron cannot fake"],
  ["ALLOWED_ROLES.has(", "read-only and external collaborator roles cannot spend a billable query"],
  ["getSessionUser(", "resolves the human the permissible use is asserted for"],
  ["manual_operator_required", "fails CLOSED when no operator identity is present"],
] as const) {
  assert.ok(route.includes(needle), `clair-report route lost its manual-only control (${needle}): ${why}`);
}

// ---- 3. Attribution may never fall back to null.
// An anonymous report row IS the signature of an automated pull. If these are
// nullable, an automated caller produces a row that looks merely incomplete
// rather than illegitimate.
for (const bad of ["requested_by: null", "requested_by_email: null", "requested_by: auth.userId ?? null"]) {
  assert.ok(!route.includes(bad), `clair-report route must not write null attribution (${bad})`);
}

// ---- 4. The route must not acquire a session-less path to the VPS.
// resolveBridgeTarget() is the door that lib/underwriting/run.ts and
// lib/forms/next-steps-email.ts use to reach the bridge with no user present.
// It must never appear in this route.
for (const escapeHatch of ["resolveBridgeTarget", "CRON_SECRET", "x-vercel-cron", "isBridgeProxyEnabled"]) {
  assert.ok(
    !route.includes(escapeHatch),
    `clair-report route must not reference ${escapeHatch} — that is a way to reach CLEAR without a signed-in operator`,
  );
}

// ---- 5. No scheduled/background surface mentions CLEAR at all.
// Belt and braces: even a helper that merely prepares a CLEAR pull inside a
// cron route is the beginning of an automated caller.
const scheduled = files.filter((f) => {
  const r = rel(f);
  return r.startsWith(join("app", "api", "cron")) || r.includes(`${sep}cron${sep}`) || /worker|daemon|scheduler/i.test(r);
});
for (const f of scheduled) {
  assert.ok(
    !/clair|clear_report/i.test(read(f)),
    `${rel(f)} is a scheduled/background surface and must not touch CLEAR — CLEAR is operator-initiated only`,
  );
}

// ---- 6. No scheduled job is pointed at the CLEAR route.
//
// Checks BOTH files deliberately. This is a NEGATIVE assertion, so it passes
// vacuously against a file that no longer contains any schedules: when the
// registry moved out of vercel.json (2026-08-30) this guard would have kept
// reporting green while guarding nothing. vercel.json is still checked so a
// re-added crons block aimed at CLEAR is caught too.
const cronRegistry = read(join(ROOT, "config/cron-registry.json"));
assert.ok(
  /"crons"/.test(cronRegistry),
  "config/cron-registry.json must actually contain the schedule list — otherwise the CLEAR check below guards nothing",
);
for (const [name, text] of [
  ["config/cron-registry.json", cronRegistry],
  ["vercel.json", read(join(ROOT, "vercel.json"))],
] as const) {
  assert.ok(
    !/clair/i.test(text),
    `${name} must not schedule anything against the CLEAR route — a cron has no operator identity`,
  );
}

// ---- 7. The transport itself refuses an unattributed CLEAR pull.
// This is the layer that does not depend on how anyone spelled anything: it
// runs on the resolved tool_name inside callBridgeExecTool, which every bridge
// caller must go through. Imported from the pure module because bridge-proxy.ts
// is `server-only` and cannot be loaded here.
const proxy = read(join(ROOT, "lib", "bridge-proxy.ts"));
assert.ok(
  proxy.includes("clairCapabilityError(body, session)"),
  "callBridgeExecTool must run the CLEAR capability gate — without it, any server-side " +
    "caller with a resolved bridge target can spend a regulated query",
);
assert.ok(
  proxy.indexOf("clairCapabilityError(body, session)") < proxy.indexOf("await fetch("),
  "the CLEAR capability gate must run BEFORE the network call, so a refused pull costs nothing",
);
// The identity must be resolved from the session inside the transport. If this
// ever reads out of `body` instead, the gate becomes caller-supplied again.
assert.ok(
  proxy.includes("getSessionUser()") && proxy.indexOf("getSessionUser()") < proxy.indexOf("clairCapabilityError(body, session)"),
  "the transport must resolve the operator from the request session BEFORE gating, " +
    "never trust attribution supplied in the call body",
);

const SESSION = { userId: "user-uuid", email: "op@example.com" };
const OPERATOR = { requested_by: "user-uuid", requested_by_email: "op@example.com" };

// ---- 7a. Missing/blank/non-string attribution is refused even WITH a session.
for (const body of [
  { tool_name: CLAIR_TOOL_NAME },
  { tool_name: CLAIR_TOOL_NAME, requested_by: "user-uuid" },
  { tool_name: CLAIR_TOOL_NAME, requested_by_email: "op@example.com" },
  { tool_name: CLAIR_TOOL_NAME, requested_by: "   ", requested_by_email: "op@example.com" },
  { tool_name: CLAIR_TOOL_NAME, requested_by: "user-uuid", requested_by_email: "" },
  { tool_name: CLAIR_TOOL_NAME, requested_by: null, requested_by_email: null },
  { tool_name: CLAIR_TOOL_NAME, requested_by: 42, requested_by_email: "op@example.com" },
]) {
  assert.equal(
    clairCapabilityError(body as Record<string, unknown>, SESSION),
    "clair_requires_operator_attribution",
    `unattributed CLEAR pull must be refused: ${JSON.stringify(body)}`,
  );
}

// ---- 7b. THE ONE THAT MATTERS (Codex [P1]). A caller that invents its own
// attribution is refused, because the identity comes from the session, not the
// body. These are the exact shapes a cron would produce.
for (const [session, label] of [
  [null, "no session at all (cron / worker / queue)"],
  [{ userId: null, email: null }, "session object with no user"],
  [{ userId: "   ", email: "op@example.com" }, "blank user id"],
] as const) {
  assert.equal(
    clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, requested_by: "system", requested_by_email: "cron@internal" }, session),
    "clair_requires_authenticated_operator",
    `self-asserted attribution must not authorize a pull — ${label}`,
  );
  // …and it stays refused even when the invented attribution is well-formed
  // and looks exactly like a real operator's.
  assert.equal(
    clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, ...OPERATOR }, session),
    "clair_requires_authenticated_operator",
    `a cron copying a real operator's attribution must still be refused — ${label}`,
  );
}

// ---- 7c. Attribution must name the ACTUAL session user, not a different one.
assert.equal(
  clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, requested_by: "someone-else", requested_by_email: "op@example.com" }, SESSION),
  "clair_attribution_mismatch",
  "a pull may not be spent in another operator's name",
);
assert.equal(
  clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, requested_by: "user-uuid", requested_by_email: "other@example.com" }, SESSION),
  "clair_attribution_mismatch",
  "the attributed email must match the authenticated session",
);

// ---- 7d. The real path works, and nothing else is affected.
assert.equal(clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, ...OPERATOR }, SESSION), null);
assert.equal(
  clairCapabilityError({ tool_name: CLAIR_TOOL_NAME, requested_by: "user-uuid", requested_by_email: "OP@Example.com " }, SESSION),
  null,
  "email comparison is case/whitespace insensitive — a real operator must not be locked out",
);
assert.equal(clairCapabilityError({ tool_name: "bash", command: "ls" }, null), null);
assert.equal(clairCapabilityError({ tool_name: "send_email" }, null), null);

// The spelling-independence claim, stated as a test: a caller that builds the
// name by concatenation — the exact case the source scan cannot see — is still
// refused, because this gate reads the resolved value.
assert.equal(
  clairCapabilityError({ tool_name: "clair" + "_report", requested_by: "system", requested_by_email: "cron@internal" }, null),
  "clair_requires_authenticated_operator",
  "the capability gate must not depend on how the tool name was spelled in source",
);

console.log(
  `clair-manual-only: OK — CLEAR named in 2 files only, transport gate enforced, ` +
    `${scheduled.length} scheduled surfaces clean, ${files.length} files scanned`,
);
