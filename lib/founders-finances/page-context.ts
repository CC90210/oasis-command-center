/**
 * Shared server-side preamble for every Finances page: resolve the finance
 * viewer (404 otherwise), the books they may see, and the book selected by
 * ?entity=. A slug the viewer may not see is a 404, same as a missing one.
 */
import "server-only";

import { notFound } from "next/navigation";
import { resolveFinanceViewer, visibleEntities, type EntityRow, type FounderViewer } from "./access-io";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function param(sp: Record<string, string | string[] | undefined>, key: string): string {
  const v = sp[key];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] || "" : "";
}

export async function financePage(searchParams: SearchParams): Promise<{
  viewer: FounderViewer;
  entity: EntityRow;
  entities: EntityRow[];
  sp: Record<string, string | string[] | undefined>;
}> {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  const sp = await searchParams;
  const entities = await visibleEntities(viewer);
  const slug = param(sp, "entity") || "oasis";
  const entity = entities.find((e) => e.slug === slug);
  if (!entity) notFound();
  return { viewer, entity, entities, sp };
}
