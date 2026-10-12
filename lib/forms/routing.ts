/**
 * lib/forms/routing.ts — per-answer routing rules for a form, stored as data
 * on the form itself (migration bravo__220, `forms.routing`), never as code.
 * V2 "router routing" (HANDOVER 2026-10-12 section 4): the "Start here"
 * router page (/vsl) is the first form to carry this, but the shape is
 * generic — any workspace's form can declare routing rules.
 *
 * SHAPE (one array, default '[]'):
 *   [{ go: "<form slug>" | "community_link",
 *      when_any: [ { "<field>": ["<value>", ...], ... }, ... ] }, ...]
 *
 * Evaluated against the SAME merged-answers context show_if already uses
 * (lib/forms/visibility.ts buildAnswerContext) — never trusted from the
 * request body directly. One rule's `when_any` entries OR together; the
 * fields inside ONE entry AND together. First rule that both MATCHES and
 * resolves to a real destination wins (lib/forms/routing-destination.ts
 * does the resolving, since that needs a database read).
 *
 * "go":"community_link" is a LITERAL MARKER for the /go/community save
 * basin (lib/offers/community-link.ts) — distinct on purpose from an actual
 * tenant form that happens to be named "community" (OASIS's own COMMUNITY
 * pillar page is a real form with slug "community" and its own routing
 * destination). Conflating the two would send every "go: community_link"
 * fallback into the COMMUNITY pillar's qualification form instead of the
 * free Telegram lounge.
 *
 * STRICT PARSING ONLY. A malformed `forms.routing` value must never crash a
 * submission or silently misroute one — parseFormRouting throws
 * RoutingDefinitionError, and the only correct caller behavior is to catch
 * it, log it, and treat the form as having no routing rules at all (fail
 * closed on DESTINATION, fail open on the ORDINARY submit).
 */

export const COMMUNITY_LINK_GO = "community_link";

/** Same shape as a form/field slug elsewhere in this codebase (lib/forms/types.ts, seed-oasis-offer-pages.ts). */
const GO_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
/** Same as lib/forms/types.ts FIELD_NAME_RE — a routing condition keys off a real field name. */
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export type FormRoutingCondition = Readonly<Record<string, readonly string[]>>;

export type FormRoutingRule = {
  readonly go: string;
  readonly whenAny: readonly FormRoutingCondition[];
};

export class RoutingDefinitionError extends Error {
  constructor(public path: string, public reason: string) {
    super(`forms.routing invalid at ${path}: ${reason}`);
    this.name = "RoutingDefinitionError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseCondition(v: unknown, path: string): FormRoutingCondition {
  if (!isRecord(v)) throw new RoutingDefinitionError(path, "expected an object");
  const keys = Object.keys(v);
  if (keys.length === 0) throw new RoutingDefinitionError(path, "must name at least one field");
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    if (!FIELD_NAME_RE.test(key)) {
      throw new RoutingDefinitionError(`${path}.${key}`, `field name must match /^[a-z][a-z0-9_]{0,62}$/`);
    }
    const vals = v[key];
    if (!Array.isArray(vals) || vals.length === 0 || vals.some((x) => typeof x !== "string" || !x.trim())) {
      throw new RoutingDefinitionError(`${path}.${key}`, "expected a non-empty array of non-empty strings");
    }
    out[key] = vals as string[];
  }
  return out;
}

/**
 * Validate a `forms.routing` jsonb/TEXT value. Returns the typed rule list,
 * or throws RoutingDefinitionError on any shape violation. An empty/absent
 * value (`[]`, `null`, `undefined`) parses to `[]` — "this form has no
 * routing rules", the default for every ordinary form.
 */
export function parseFormRouting(value: unknown): FormRoutingRule[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RoutingDefinitionError("$", "expected an array");
  }
  return value.map((rawRule, idx) => {
    const path = `$[${idx}]`;
    if (!isRecord(rawRule)) throw new RoutingDefinitionError(path, "expected an object");
    const go = rawRule.go;
    if (typeof go !== "string" || !(go === COMMUNITY_LINK_GO || GO_SLUG_RE.test(go))) {
      throw new RoutingDefinitionError(
        `${path}.go`,
        `must be "${COMMUNITY_LINK_GO}" or match /^[a-z0-9][a-z0-9_-]{1,62}$/`,
      );
    }
    const whenAnyRaw = rawRule.when_any;
    if (!Array.isArray(whenAnyRaw) || whenAnyRaw.length === 0) {
      throw new RoutingDefinitionError(`${path}.when_any`, "expected a non-empty array");
    }
    const whenAny = whenAnyRaw.map((c, cIdx) => parseCondition(c, `${path}.when_any[${cIdx}]`));
    const extraKeys = Object.keys(rawRule).filter((k) => k !== "go" && k !== "when_any");
    if (extraKeys.length > 0) {
      throw new RoutingDefinitionError(path, `unknown key(s): ${extraKeys.join(", ")}`);
    }
    return { go, whenAny };
  });
}

/**
 * One condition's fields all agree with `answers` (scalar equality against
 * the field's allowed-value set). Mirrors lib/forms/visibility.ts's
 * `in` semantics: a missing/non-string answer never matches, which is the
 * correct default before the controlling field has been answered.
 */
export function conditionMatches(condition: FormRoutingCondition, answers: Readonly<Record<string, unknown>>): boolean {
  for (const [field, allowed] of Object.entries(condition)) {
    const target = answers[field];
    if (typeof target !== "string" || !allowed.includes(target)) return false;
  }
  return true;
}

/** A rule matches when ANY of its `when_any` conditions matches. */
export function ruleMatches(rule: FormRoutingRule, answers: Readonly<Record<string, unknown>>): boolean {
  return rule.whenAny.some((c) => conditionMatches(c, answers));
}

/**
 * The first rule (in file order) whose condition matches, or null when none
 * do. This is NOT the final destination — lib/forms/routing-destination.ts
 * resolveRouterDestination still has to confirm `go` resolves to something
 * real (an enabled form of the SAME tenant, or a configured community link)
 * and keeps walking past a rule that matches but does not resolve.
 */
export function firstMatchingGo(rules: readonly FormRoutingRule[], answers: Readonly<Record<string, unknown>>): string | null {
  for (const rule of rules) {
    if (ruleMatches(rule, answers)) return rule.go;
  }
  return null;
}
