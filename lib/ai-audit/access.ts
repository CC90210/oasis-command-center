/**
 * lib/ai-audit/access.ts — who may work an AI audit.
 *
 * The feature runs only in OASIS's own workspaces. Inside them, the founders
 * (owner or admin by base role) work engagements; only the workspace OWNER
 * (user_profiles.is_owner, CC) confirms prices, changes the tax rule and
 * passes the two gates. The tenant always comes from the session, never from
 * a request body.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { dbBool } from "@/lib/db-bool";
import { aiAuditTablesInstalled } from "@/lib/ai-audit/store";

export type AiAuditSession = {
  tenantId: string;
  userId: string;
  email: string | null;
  isOwner: boolean;
  db: Client;
};

export type AiAuditAccess = { ok: true; session: AiAuditSession } | { ok: false; response: NextResponse };

function refuse(status: number, error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } }) };
}

export async function isWorkspaceOwner(db: Client, tenantId: string, userId: string): Promise<boolean> {
  const row = (await db.execute({ sql: "SELECT is_owner FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1", args: [tenantId, userId] })).rows[0];
  return !!row && dbBool(row.is_owner);
}

/** For the API routes: a founder of an OASIS workspace, with the tables installed. */
export async function requireAiAuditSession(opts: { ownerOnly?: boolean } = {}): Promise<AiAuditAccess> {
  const session = await resolveSessionContext();
  if (!session.ok) return refuse(401, "unauthorized");
  if (!isOasisInternalTenant(session.tenantId)) return refuse(404, "not_found");
  if (!session.isTrueAdmin) return refuse(403, "founders_only");
  if (!tursoConfigured()) return refuse(503, "database_not_configured");
  const db = getTursoClient();
  if (!(await aiAuditTablesInstalled(db))) return refuse(503, "ai_audit_not_installed");
  const owner = await isWorkspaceOwner(db, session.tenantId, session.userId);
  if (opts.ownerOnly && !owner) return refuse(403, "owner_only");
  return { ok: true, session: { tenantId: session.tenantId, userId: session.userId, email: session.email, isOwner: owner, db } };
}

/** For the pages: the same rule, answering null instead of a response. */
export async function aiAuditPageSession(): Promise<AiAuditSession | null> {
  try {
    const r = await requireAiAuditSession();
    return r.ok ? r.session : null;
  } catch {
    return null;
  }
}
