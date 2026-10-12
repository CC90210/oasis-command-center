/**
 * lib/forms/router-cat-preselect.ts — maps the "?cat=p1..p4" shorthand used
 * on ad/social links to a router form's own `path` field value, so the
 * matching card arrives pre-selected (HANDOVER 2026-10-12 section 4: "?cat=
 * p1..p4 preselects a card and kw= is recorded").
 *
 * GENERIC ON PURPOSE — not hardcoded to OASIS's /vsl. Any workspace's router
 * form gets the same preselect, as long as it declares a `select` field
 * literally named "path" whose OWN options include the mapped value. A form
 * with no such field, or a value the form does not actually offer, is left
 * alone: `routerPrefillForCat` returns null rather than guess.
 *
 * An unknown `cat` is ignored, never guessed at — the visitor sees the
 * ordinary, unselected router step instead of a wrong path.
 */

/** p1..p4, fixed by the funnel doc's pillar order (HANDOVER section 4). */
export const CAT_TO_ROUTER_PATH: Readonly<Record<string, string>> = {
  p1: "protocol",
  p2: "command",
  p3: "community",
  p4: "fleet",
};

export function routerPathForCatParam(cat: string | null | undefined): string | null {
  if (typeof cat !== "string") return null;
  const key = cat.trim().toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(CAT_TO_ROUTER_PATH, key) ? CAT_TO_ROUTER_PATH[key] : null;
}

type MinimalField = { name: string; options?: ReadonlyArray<{ value: string }> };
type MinimalStep = { fields: ReadonlyArray<MinimalField> };

/**
 * The prefill map to pass into FormPublicClient's `prefill` prop, or null
 * when `cat` is absent/unknown, or this form has no "path" select field
 * offering the mapped value.
 */
export function routerPrefillForCat(
  steps: ReadonlyArray<MinimalStep>,
  cat: string | null | undefined,
): Record<string, string> | null {
  const mapped = routerPathForCatParam(cat);
  if (!mapped) return null;
  for (const step of steps) {
    for (const field of step.fields) {
      if (field.name === "path" && field.options?.some((o) => o.value === mapped)) {
        return { path: mapped };
      }
    }
  }
  return null;
}
