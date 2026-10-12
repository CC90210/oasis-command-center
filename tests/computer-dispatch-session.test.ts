/**
 * tests/computer-dispatch-session.test.ts - lib/os/runs/session.ts
 * bestOwnComputer + computerDispatchDecision: NO KEY FALLBACK (Adon,
 * 2026-10-11), as the pure decision O4 made session.ts replace the old
 * blanket "every 'computer' choice is refused" rule with.
 *
 * Only 'can_answer' and 'busy' dispatch (session.ts carries their label
 * forward as RunSession.computerDispatch, which send.ts enqueues as
 * executor 'computer' and starts no driver for). Every other state is a
 * named refusal -- never a silent fall-through to the workspace engine, the
 * API key, or another person's computer.
 *
 * Pure: no session, no database, no mocked getOwnComputers.
 * Run: node --conditions=react-server --import tsx tests/computer-dispatch-session.test.ts
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

type OwnComputer = {
  id: string;
  label: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  scope: string | null;
  pairedVia: string | null;
  claimEnabledAt: string | null;
  claimStateAt: string | null;
  claimBlockedReason: string | null;
  claimCapacity: number | null;
};

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const fresh = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function computer(label: string, over: Partial<OwnComputer> = {}): OwnComputer {
  return {
    id: `pairing-${label}`,
    label,
    lastSeenAt: fresh(5_000),
    revokedAt: null,
    scope: "connector",
    pairedVia: "pair_code",
    claimEnabledAt: fresh(60 * 60_000),
    claimStateAt: fresh(5_000),
    claimBlockedReason: null,
    claimCapacity: 2,
    ...over,
  };
}

async function main() {
  const {
    bestOwnComputer,
    computerDispatchDecision,
    runtimeDispatchDecision,
    runtimeExecutionState,
    runtimeFallbackDecision,
    selectLegacyBindingCandidate,
  } = await import("../lib/os/runs/session");

  console.log("bestOwnComputer + computerDispatchDecision:");

  await check("no paired computer at all: computer_not_connected", () => {
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([], NOW)), { ok: false, error: "computer_not_connected" });
  });
  await check("not approved (no claim_enabled_at): computer_not_approved, never dispatched", () => {
    const c = computer("laptop", { claimEnabledAt: null });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: false, error: "computer_not_approved" });
  });
  await check("approved but no claim call within CLAIM_FRESH_MS: offline, never dispatched (a heartbeat alone is not enough)", () => {
    const c = computer("laptop", { claimStateAt: fresh(10 * 60_000) });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: false, error: "computer_offline" });
  });
  await check("approved, fresh claim call, no claim ever made at all (claimStateAt null): offline, never dispatched", () => {
    const c = computer("laptop", { claimStateAt: null });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: false, error: "computer_offline" });
  });
  await check("a known blocked reason dispatches to its own TurnFailureCode, never a generic one", () => {
    const c = computer("laptop", { claimBlockedReason: "subscription_auth_failure" });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: false, error: "subscription_auth_failure" });
    const c2 = computer("laptop", { claimBlockedReason: "department_profile_unsafe" });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c2], NOW)), { ok: false, error: "department_profile_unsafe" });
  });
  await check("an UNRECOGNISED blocked reason (a future connector value this build does not know) fails closed to computer_offline, never treated as answerable", () => {
    const c = computer("laptop", { claimBlockedReason: "some_future_reason_not_yet_known" });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: false, error: "computer_offline" });
  });
  await check("can_answer (approved, fresh, no blocked reason, capacity > 0) DISPATCHES with the computer's label -- O4's real change from the old blanket refusal", () => {
    const c = computer("Ann's laptop", { claimCapacity: 2 });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: true, label: "Ann's laptop" });
  });
  await check("busy (approved, fresh, no blocked reason, capacity 0) ALSO dispatches -- it is a queue-time clock, never an upfront refusal", () => {
    const c = computer("Ann's laptop", { claimCapacity: 0 });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([c], NOW)), { ok: true, label: "Ann's laptop" });
  });
  await check("with several computers, the BEST one's label and state decide -- can_answer beats busy beats blocked beats offline beats not_approved", () => {
    const offline = computer("old-desktop", { claimStateAt: fresh(10 * 60_000) });
    const notApproved = computer("new-phone", { claimEnabledAt: null });
    const blocked = computer("work-laptop", { claimBlockedReason: "cli_not_found" });
    const busy = computer("home-laptop", { claimCapacity: 0 });
    const canAnswer = computer("the-good-one", { claimCapacity: 1 });
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([offline, notApproved, blocked, busy, canAnswer], NOW)), { ok: true, label: "the-good-one" });
    // Remove the can_answer one: busy wins over blocked/offline/not_approved.
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([offline, notApproved, blocked, busy], NOW)), { ok: true, label: "home-laptop" });
    // Remove busy too: the blocked one's OWN reason surfaces, not a generic one.
    assert.deepEqual(computerDispatchDecision(bestOwnComputer([offline, notApproved, blocked], NOW)), { ok: false, error: "cli_not_found" });
  });
  await check("every return is an explicit decision: never undefined, never a bare pass-through", () => {
    for (const d of [
      computerDispatchDecision(bestOwnComputer([], NOW)),
      computerDispatchDecision(bestOwnComputer([computer("x")], NOW)),
    ]) {
      assert.ok(typeof d.ok === "boolean");
      if (d.ok) assert.ok(typeof d.label === "string" && d.label.length > 0);
      else assert.ok(typeof d.error === "string" && d.error.length > 0);
    }
  });
  await check("a canonical Codex selection is not agent-ready from install/auth alone; its real execution probe must be ready", () => {
    const c = computer("CCPC");
    assert.deepEqual(
      runtimeDispatchDecision(c, { kind: "cli", name: "codex" }, { codex: { installed: true, authenticated: true, state: "probe_required" } }, NOW),
      { ok: false, error: "department_profile_unsupported" },
    );
    assert.deepEqual(
      runtimeDispatchDecision(c, { kind: "cli", name: "codex" }, { codex: { installed: true, authenticated: true, state: "ready" } }, NOW),
      { ok: true, label: "CCPC" },
    );
  });
  await check("runtime failures stay distinct so Settings can offer the right repair", () => {
    const c = computer("Mac");
    assert.deepEqual(runtimeDispatchDecision(c, { kind: "cli", name: "gemini" }, { gemini: { state: "unsupported" } }, NOW), {
      ok: false,
      error: "cli_account_unsupported",
    });
    assert.deepEqual(runtimeDispatchDecision(c, { kind: "cli", name: "claude" }, { claude: { state: "needs_sign_in" } }, NOW), {
      ok: false,
      error: "subscription_auth_failure",
    });
    assert.deepEqual(runtimeDispatchDecision(c, { kind: "cli", name: "codex" }, { codex: { state: "not_installed" } }, NOW), {
      ok: false,
      error: "cli_not_found",
    });
  });
  await check("a signup-secret pairing can never execute an exact canonical engine, even if an approval timestamp was populated", () => {
    const c = computer("unsafe bootstrap", { pairedVia: "signup_secret", claimEnabledAt: fresh(60_000) });
    assert.deepEqual(runtimeDispatchDecision(c, { kind: "cli", name: "codex" }, { codex: { state: "ready" } }, NOW), {
      ok: false,
      error: "computer_not_approved",
    });
  });
  await check("runtime state accepts the heartbeat's persisted { runtime_state: ... } envelope", () => {
    assert.equal(
      runtimeExecutionState({ runtime_state: { codex: { state: "ready" } } }, { kind: "cli", name: "codex" }),
      "ready",
      "the bridge ping persists claim_runtime_state with this envelope",
    );
    assert.equal(
      runtimeExecutionState(
        JSON.stringify({ runtime_state: { local_models: [{ ref: "ollama/llama3.3", state: "ready" }] } }),
        { kind: "local", name: "ollama/llama3.3" },
      ),
      "ready",
    );
  });
  await check("device failure refuses by default and only an explicit workspace_api policy permits API fallback", () => {
    const failed = { ok: false as const, error: "computer_offline" };
    const exact = { kind: "cli" as const, cli: "codex" as const, pairingId: "pair-ccpc", fallback: "workspace_api" as const };
    assert.deepEqual(runtimeFallbackDecision({ ...exact, fallback: "none" }, failed), failed, "fallback none keeps the refusal");
    assert.deepEqual(runtimeFallbackDecision({ kind: "cli", cli: "codex", pairingId: "pair-ccpc" }, failed), failed, "legacy missing policy never opts in");
    assert.deepEqual(
      runtimeFallbackDecision(exact, { ok: false, error: "computer_not_approved" }),
      { ok: false, error: "computer_not_approved" },
      "approval is an authorization boundary, never an availability fallback",
    );
    assert.deepEqual(runtimeFallbackDecision(exact, failed), {
      ok: true,
      mode: "workspace_api",
      fallbackFrom: exact,
      reason: "computer_offline",
    });
    assert.deepEqual(runtimeFallbackDecision(exact, { ok: true, label: "CCPC" }), { ok: true, mode: "computer", label: "CCPC" });
  });
  await check("legacy subscription binding chooses the sole approved v2 pairing whose exact runtime really executed", () => {
    const ready = {
      ...computer("CCPC"),
      claimProtocols: ["department_task_v1", "department_task_v2"],
      claimRuntimeState: { runtime_state: { codex: { installed: true, authenticated: true, state: "ready" } } },
    };
    const v1Only = {
      ...computer("Old Mac"),
      claimProtocols: ["department_task_v1"],
      claimRuntimeState: { runtime_state: { codex: { state: "ready" } } },
    };
    const untested = {
      ...computer("New Mac"),
      claimProtocols: ["department_task_v2"],
      claimRuntimeState: { runtime_state: { codex: { installed: true, authenticated: true, state: "probe_required" } } },
    };
    assert.equal(selectLegacyBindingCandidate([v1Only, untested, ready], { kind: "cli", name: "codex" }, NOW)?.id, ready.id);
  });
  await check("legacy binding requires exactly one ready compatible pairing; zero or multiple force an explicit choice", () => {
    const ready = (label: string) => ({
      ...computer(label),
      claimProtocols: ["department_task_v2"],
      claimRuntimeState: { runtime_state: { claude: { state: "ready" } } },
    });
    assert.equal(selectLegacyBindingCandidate([], { kind: "cli", name: "claude" }, NOW), null);
    assert.equal(
      selectLegacyBindingCandidate([{ ...ready("not-approved"), claimEnabledAt: null }], { kind: "cli", name: "claude" }, NOW),
      null,
      "an execution probe cannot bypass pairing approval",
    );
    assert.equal(
      selectLegacyBindingCandidate(
        [{ ...ready("signup-secret"), pairedVia: "signup_secret", claimEnabledAt: fresh(60_000) }],
        { kind: "cli", name: "claude" },
        NOW,
      ),
      null,
      "a populated timestamp cannot make a signup-secret pairing claim-capable",
    );
    assert.equal(selectLegacyBindingCandidate([ready("one"), ready("two")], { kind: "cli", name: "claude" }, NOW), null);
  });
  await check("legacy pure-local binding matches the selected namespaced model, not any other ready local model", () => {
    const selected = {
      ...computer("Local workstation"),
      claimProtocols: ["department_task_v2"],
      claimRuntimeState: {
        runtime_state: {
          local_models: [
            { ref: "ollama/qwen3", state: "ready" },
            { ref: "ollama/llama3.3", state: "probe_required" },
          ],
        },
      },
    };
    assert.equal(selectLegacyBindingCandidate([selected], { kind: "local", name: "ollama/llama3.3" }, NOW), null);
    assert.equal(selectLegacyBindingCandidate([selected], { kind: "local", name: "ollama/qwen3" }, NOW)?.id, selected.id);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
