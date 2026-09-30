/**
 * lib/connections/route-helpers.ts — the shared front half of every
 * /api/connections/[provider]/* route: resolve the session, apply the manage
 * gate, and build the actor whose tenant id every query will use.
 *
 * The tenant comes from resolveSessionContext() and nowhere else.
 */
import "server-only";
import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { mayManageConnections } from "@/lib/connections/access";
import type { ConnectionsActor, ServiceResult } from "@/lib/connections/service";
import type { ConnectionsDeps } from "@/lib/connections/health";

export type ActorResolution =
  | { ok: true; actor: ConnectionsActor; deps: ConnectionsDeps }
  | { ok: false; response: NextResponse };

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function resolveConnectionsActor(): Promise<ActorResolution> {
  let session: Awaited<ReturnType<typeof resolveSessionContext>>;
  try {
    session = await resolveSessionContext();
  } catch (error) {
    // A profile-store outage is not "signed out"; name the real fault.
    console.error("[connections.session]", error);
    return { ok: false, response: json(503, { ok: false, error: "profile_resolution_unavailable" }) };
  }
  if (!session.ok) return { ok: false, response: json(401, { ok: false, error: "unauthorized" }) };
  if (!mayManageConnections(session)) {
    return {
      ok: false,
      response: json(403, {
        ok: false,
        error: "forbidden",
        message: "Only the workspace owner or an admin can manage connections.",
      }),
    };
  }
  if (!tursoConfigured()) {
    return { ok: false, response: json(503, { ok: false, error: "database_not_configured" }) };
  }
  return {
    ok: true,
    actor: { tenantId: session.tenantId, userId: session.userId, profileId: session.profileId, email: session.email },
    deps: { db: getTursoClient(), now: () => new Date() },
  };
}

export function serviceResponse(result: ServiceResult): NextResponse {
  return json(result.status, result.body);
}

/** A thrown error becomes a loud 500 that names the route — never an empty body. */
export function routeFailure(label: string, error: unknown): NextResponse {
  console.error(`[${label}]`, error instanceof Error ? error.stack : error);
  return json(500, {
    ok: false,
    error: "connection_route_failed",
    message: "Something went wrong on OASIS's side. Refresh to see the current status, then try again.",
  });
}
