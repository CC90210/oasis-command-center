/**
 * V6.9.2 — workflow-steps registry + pure-function tests.
 *
 * Scope: the dispatcher's registry lookup, the cap-enforcement short
 * circuits, the if-else predicate evaluator, and the delay step's
 * inline/deferred threshold logic. DB-dependent paths (record-crud,
 * mail-sender bridge call) are integration tests; the DB-less surface
 * is fully covered here.
 */

import assert from "node:assert/strict";
import {
  runStep,
  getStepHandler,
  listRegisteredStepTypes,
} from "@/lib/workflow-steps/run-step";
import { evaluatePredicate } from "@/lib/workflow-steps/if-else";
import { computeDelayMs } from "@/lib/workflow-steps/delay";
import type { StepContext } from "@/lib/workflow-steps/types";

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    tenant_id: "tenant-1",
    run_id: "run-1",
    trigger_event: {},
    prior_outputs: {},
    step_count_remaining: 100,
    outbound_cap_remaining: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Registry — 5 step types registered, names match.
// ---------------------------------------------------------------------------
const registered = listRegisteredStepTypes();
assert.deepEqual(
  registered.sort(),
  ["ai-agent", "delay", "http-request", "if-else", "mail-sender", "record-crud"].sort(),
  "registered step types must match the V6.9.2+V6.9.3 substrate set",
);

assert.ok(getStepHandler("record-crud") !== null);
assert.ok(getStepHandler("http-request") !== null);
assert.ok(getStepHandler("if-else") !== null);
assert.ok(getStepHandler("delay") !== null);
assert.ok(getStepHandler("mail-sender") !== null);
assert.ok(getStepHandler("ai-agent") !== null);
assert.equal(getStepHandler("unknown-type"), null);

async function main() {
// ---------------------------------------------------------------------------
// 2. runStep — unknown type → failed with explicit error.
// ---------------------------------------------------------------------------
const unknown = await runStep("nonexistent", {}, makeCtx());
assert.equal(unknown.status, "failed");
assert.ok(unknown.status === "failed" && unknown.error.includes("unknown_step_type"));

// ---------------------------------------------------------------------------
// 3. runStep — step_count_remaining=0 → cap_exhausted before handler.
// ---------------------------------------------------------------------------
const exhausted = await runStep("delay", { seconds: 0 }, makeCtx({ step_count_remaining: 0 }));
assert.equal(exhausted.status, "failed");
assert.ok(exhausted.status === "failed" && exhausted.error === "step_cap_exhausted");

// ---------------------------------------------------------------------------
// 4. delay step — inline (<5s) vs deferred (>5s) mode.
// ---------------------------------------------------------------------------
const inlineDelay = await runStep("delay", { seconds: 0 }, makeCtx());
assert.equal(inlineDelay.status, "complete");
assert.deepEqual(
  inlineDelay.status === "complete" && (inlineDelay.output as { mode?: string }).mode,
  "inline",
);

const deferredDelay = await runStep("delay", { hours: 1 }, makeCtx());
assert.equal(deferredDelay.status, "complete");
assert.deepEqual(
  deferredDelay.status === "complete" && (deferredDelay.output as { mode?: string }).mode,
  "deferred",
);

// ---------------------------------------------------------------------------
// 5. computeDelayMs — unit arithmetic + 24h cap.
// ---------------------------------------------------------------------------
assert.equal(computeDelayMs({ seconds: 30 }), 30_000);
assert.equal(computeDelayMs({ minutes: 5 }), 300_000);
assert.equal(computeDelayMs({ hours: 1 }), 3_600_000);
assert.equal(computeDelayMs({ hours: 48 }), 24 * 60 * 60 * 1000, "24h cap enforced");
assert.equal(computeDelayMs({ seconds: -10 }), 0, "negative durations floor to 0");

// ---------------------------------------------------------------------------
// 6. evaluatePredicate — all 9 operators.
// ---------------------------------------------------------------------------
assert.equal(evaluatePredicate({ field: "x", operator: "eq", value: 5 }, { x: 5 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "eq", value: 5 }, { x: 6 }), false);
assert.equal(evaluatePredicate({ field: "x", operator: "neq", value: 5 }, { x: 6 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "gt", value: 5 }, { x: 10 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "lt", value: 5 }, { x: 3 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "gte", value: 5 }, { x: 5 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "lte", value: 5 }, { x: 5 }), true);
assert.equal(evaluatePredicate({ field: "name", operator: "contains", value: "ace" }, { name: "place" }), true);
assert.equal(evaluatePredicate({ field: "tags", operator: "contains", value: "hot" }, { tags: ["cold", "hot"] }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "truthy" }, { x: 1 }), true);
assert.equal(evaluatePredicate({ field: "x", operator: "truthy" }, { x: 0 }), false);
assert.equal(evaluatePredicate({ field: "x", operator: "falsy" }, { x: 0 }), true);

// Nested-path lookup
assert.equal(
  evaluatePredicate({ field: "lead.stage", operator: "eq", value: "hot" }, { lead: { stage: "hot" } }),
  true,
);

// Missing path → undefined → truthy false
assert.equal(evaluatePredicate({ field: "missing.path", operator: "truthy" }, {}), false);

// ---------------------------------------------------------------------------
// 7. if-else step — returns branch.
// ---------------------------------------------------------------------------
const branch = await runStep(
  "if-else",
  { predicate: { field: "stage", operator: "eq", value: "hot" } },
  makeCtx({ trigger_event: { stage: "hot" } }),
);
assert.equal(branch.status, "complete");
assert.deepEqual(
  branch.status === "complete" && (branch.output as { branch?: string }).branch,
  "then",
);

const branchElse = await runStep(
  "if-else",
  { predicate: { field: "stage", operator: "eq", value: "hot" } },
  makeCtx({ trigger_event: { stage: "cold" } }),
);
assert.equal(branchElse.status, "complete");
assert.deepEqual(
  branchElse.status === "complete" && (branchElse.output as { branch?: string }).branch,
  "else",
);

console.log("workflow-steps: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
