/**
 * lib/playbook/visibility.ts - which business documents a viewer may see.
 *
 * PURE: no session, no database. The session half is lib/playbook/viewer.ts.
 *
 * THE RULE (T2 spec, 2026-09-30):
 *   founder persona (CC, Adon, and anyone an owner granted admin access)
 *       every document.
 *   every other OASIS persona (manager, sales, marketing, builder, and the
 *   worker / read-only roles)
 *       team, client_safe and public documents. A founders document is a 404
 *       on its page and on its download: the answer does not confirm it
 *       exists.
 *   any other workspace
 *       404 on everything (lib/playbook-access.ts, the F0 containment rule).
 *
 * The rule is applied TWICE on purpose: the catalog is filtered before any
 * read, and the database query carries `visibility IN (...)` (store.ts), so a
 * founders row is never fetched for a teammate even if the catalog and a row
 * ever disagree. A document is visible only when both allow it.
 */

import type { Persona } from "@/lib/role-surfaces";
import type { CatalogDoc, DocVisibility } from "./catalog";

export const ALL_VISIBILITIES: readonly DocVisibility[] = ["founders", "team", "client_safe", "public"];
const TEAM_VISIBILITIES: readonly DocVisibility[] = ["team", "client_safe", "public"];

export function isFounderPersona(persona: Persona): boolean {
  return persona === "founder";
}

/** The visibility levels `persona` may read, in the order the query lists them. */
export function visibilitiesFor(persona: Persona): readonly DocVisibility[] {
  return isFounderPersona(persona) ? ALL_VISIBILITIES : TEAM_VISIBILITIES;
}

export function mayViewVisibility(persona: Persona, visibility: string | null | undefined): boolean {
  return (visibilitiesFor(persona) as readonly string[]).includes(visibility || "");
}

export function visibleCatalog<T extends Pick<CatalogDoc, "visibility">>(persona: Persona, docs: readonly T[]): T[] {
  return docs.filter((d) => mayViewVisibility(persona, d.visibility));
}

/** `visibility IN (?, ?, ...)` for `persona`, with its args. */
export function visibilityClause(persona: Persona, column = "visibility"): { sql: string; args: string[] } {
  const levels = [...visibilitiesFor(persona)];
  return { sql: `${column} IN (${levels.map(() => "?").join(", ")})`, args: levels };
}

export const VISIBILITY_LABEL: Readonly<Record<DocVisibility, string>> = {
  founders: "Founders only",
  team: "Team",
  client_safe: "Client-safe",
  public: "Public",
};
