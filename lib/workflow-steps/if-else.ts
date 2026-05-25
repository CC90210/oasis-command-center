/**
 * if-else step — V6.9.2.
 *
 * Evaluates a predicate against prior_outputs and the trigger_event;
 * returns the branch label ('then' or 'else'). The workflow runner uses
 * the output to decide which subsequent steps to execute.
 *
 * Input shape:
 *   { predicate: { field: "<dot.path>", operator: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"|"truthy"|"falsy",
 *                  value?: unknown },
 *     source?: "trigger_event" | "prior_outputs" }   // default trigger_event
 *
 * The predicate language is deliberately tiny — anything more complex
 * should be a custom step type (defense against accidental DSL bloat).
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type Predicate = {
  field?: string;
  operator?: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "truthy" | "falsy";
  value?: unknown;
};

type IfElseInput = {
  predicate?: Predicate;
  source?: "trigger_event" | "prior_outputs";
};

function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function evaluatePredicate(predicate: Predicate, target: unknown): boolean {
  const lhs = predicate.field ? getByPath(target, predicate.field) : target;
  const op = predicate.operator ?? "truthy";
  switch (op) {
    case "eq":
      return lhs === predicate.value;
    case "neq":
      return lhs !== predicate.value;
    case "gt":
      return typeof lhs === "number" && typeof predicate.value === "number" && lhs > predicate.value;
    case "lt":
      return typeof lhs === "number" && typeof predicate.value === "number" && lhs < predicate.value;
    case "gte":
      return typeof lhs === "number" && typeof predicate.value === "number" && lhs >= predicate.value;
    case "lte":
      return typeof lhs === "number" && typeof predicate.value === "number" && lhs <= predicate.value;
    case "contains":
      if (typeof lhs === "string" && typeof predicate.value === "string") return lhs.includes(predicate.value);
      if (Array.isArray(lhs)) return lhs.includes(predicate.value);
      return false;
    case "truthy":
      return Boolean(lhs);
    case "falsy":
      return !lhs;
  }
}

const handler: WorkflowStep = {
  type: "if-else",
  async execute(rawInput: unknown, ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as IfElseInput;
    if (!input.predicate) return { status: "failed", error: "missing_predicate" };
    const source = input.source === "prior_outputs" ? ctx.prior_outputs : ctx.trigger_event;
    const matched = evaluatePredicate(input.predicate, source);
    return {
      status: "complete",
      output: { branch: matched ? "then" : "else", matched },
    };
  },
};

export default handler;
