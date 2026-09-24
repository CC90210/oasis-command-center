/**
 * Auto-categorisation rules. PURE.
 *
 * A rule is "if the description/payee contains|equals|starts with PATTERN
 * (and the direction and amount range fit), set the category". Rules run in
 * priority order (lower first), ties by creation order, first match wins — so
 * the outcome never depends on the order rows came back from the database.
 * Matching is case- and whitespace-insensitive.
 */

export type RuleMatchField = "description" | "payee";
export type RuleMatchType = "contains" | "equals" | "starts_with";
export type RuleDirection = "in" | "out" | "any";

export type RuleLike = {
  id: string;
  matchField: RuleMatchField;
  matchType: RuleMatchType;
  pattern: string;
  direction: RuleDirection;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  priority: number;
  active: boolean;
  setCategoryId: string;
  setContactId: string | null;
  createdAt?: string;
};

export type TxnLike = { description: string; payee?: string | null; amountCents: number };

export function normalizeText(s: string | null | undefined): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function ruleMatches(rule: RuleLike, txn: TxnLike): boolean {
  if (!rule.active) return false;
  const pattern = normalizeText(rule.pattern);
  if (!pattern) return false;
  if (rule.direction === "in" && txn.amountCents <= 0) return false;
  if (rule.direction === "out" && txn.amountCents >= 0) return false;
  const abs = Math.abs(txn.amountCents);
  if (rule.amountMinCents !== null && abs < rule.amountMinCents) return false;
  if (rule.amountMaxCents !== null && abs > rule.amountMaxCents) return false;
  const haystack = normalizeText(rule.matchField === "payee" ? txn.payee || "" : txn.description);
  switch (rule.matchType) {
    case "equals":
      return haystack === pattern;
    case "starts_with":
      return haystack.startsWith(pattern);
    default:
      return haystack.includes(pattern);
  }
}

export function sortRules<T extends RuleLike>(rules: readonly T[]): T[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      a.id.localeCompare(b.id),
  );
}

export function firstMatchingRule<T extends RuleLike>(rules: readonly T[], txn: TxnLike): T | null {
  for (const r of sortRules(rules)) if (ruleMatches(r, txn)) return r;
  return null;
}

/**
 * A starting pattern for "create a rule from this transaction". Bank lines
 * carry store numbers, card digits and reference ids ("SHOPIFY* 4417283
 * MONTREAL QC"); a rule on the whole string would only ever match itself.
 * Strip digit runs and punctuation, keep the leading words.
 */
export function suggestRulePattern(description: string): string {
  const cleaned = normalizeText(description)
    .replace(/[#*/\\|_:;,.()[\]{}]/g, " ")
    .replace(/\b[a-z]*\d[\w-]*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 1);
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > 24) break;
    out = (out + " " + w).trim();
    if (out.split(" ").length >= 3) break;
  }
  return out || normalizeText(description).slice(0, 24);
}

export function validateRuleInput(input: {
  name?: unknown;
  pattern?: unknown;
  matchField?: unknown;
  matchType?: unknown;
  direction?: unknown;
  priority?: unknown;
}): { ok: true } | { ok: false; error: string } {
  if (typeof input.pattern !== "string" || normalizeText(input.pattern).length < 2) {
    return { ok: false, error: "pattern must be at least 2 characters" };
  }
  if (typeof input.pattern === "string" && input.pattern.length > 120) {
    return { ok: false, error: "pattern is too long" };
  }
  if (input.matchField !== undefined && !["description", "payee"].includes(String(input.matchField))) {
    return { ok: false, error: "matchField must be description or payee" };
  }
  if (input.matchType !== undefined && !["contains", "equals", "starts_with"].includes(String(input.matchType))) {
    return { ok: false, error: "matchType must be contains, equals or starts_with" };
  }
  if (input.direction !== undefined && !["in", "out", "any"].includes(String(input.direction))) {
    return { ok: false, error: "direction must be in, out or any" };
  }
  if (input.priority !== undefined && (!Number.isSafeInteger(input.priority) || (input.priority as number) < 0)) {
    return { ok: false, error: "priority must be a non-negative integer" };
  }
  return { ok: true };
}
