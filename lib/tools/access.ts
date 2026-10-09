/**
 * lib/tools/access.ts - who may use the Toolkit. THE one gate: every tools
 * route and the Tools section ask this function and nothing else.
 *
 * TODAY it is the founders gate (lib/founders/gate.ts resolveFounder: a
 * founders workspace AND a persona that may see marketing), which keeps
 * OASIS's commission-only contractors away from OASIS's PC runner and OASIS's
 * training material. The signed-in person's id comes from the same session
 * (the usage ledger names who a model call served).
 *
 * A per-workspace Toolkit page later changes only this function. Callers answer
 * 404 `not_found` when it returns null (the founders convention: never 403, which
 * would confirm the route exists).
 */
import "server-only";
import { resolveFounder } from "@/lib/founders/gate";
import { resolveSessionContext } from "@/lib/api-auth";

export type ToolsViewer = {
  tenantId: string;
  /** The signed-in person (auth user id). */
  userId: string;
  /** Their user_profiles row, stamped as created_by on every run. */
  profileId: string;
  /** Their email: the author of what a run makes (a Library video, a training note). */
  email: string | null;
};

export async function resolveToolsViewer(): Promise<ToolsViewer | null> {
  const founder = await resolveFounder();
  if (!founder) return null;
  const session = await resolveSessionContext();
  // Both reads must name the same workspace; a disagreement is refused, never guessed.
  if (!session.ok || session.tenantId !== founder.tenantId) return null;
  return {
    tenantId: founder.tenantId,
    userId: session.userId,
    profileId: founder.profileId,
    email: founder.email ?? session.email ?? null,
  };
}
