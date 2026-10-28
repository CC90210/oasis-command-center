/**
 * The agent inbox relay, its one API module (2026-10-28).
 *
 *   GET  /api/bridge/inbox/pending     the directives waiting for delivery, oldest first (at most 20)
 *   POST /api/bridge/inbox/delivered   {ids}: these were written into their agents' local inboxes
 *   POST /api/bridge/inbox/acked       {ids}: the agents moved them to their read/ folders
 *
 * WHY. A directive posted from Admin > Agent ops used to stop at the database: only a cloud chat ever
 * read it, never the agent working on CC's computer. The agents owner's paired computer now pulls the
 * directives every minute (bravo_cli/inbox_relay.py), writes each into its agent's local inbox
 * (<repo>/tmp/agent_inbox/inbox/, the folder scripts/core/agent_inbox.py reads at the start of every
 * session) and reports back, so Agent ops can say Delivered and then Read.
 *
 * WHAT TRAVELS. Only a note the operator posted from the dashboard to an agent with a local reader
 * (relay_eligible, set by lib/agent-inbox-db.ts postMessageDb). A note an agent wrote never travels to
 * another agent's machine on its own.
 *
 * GATES, every request: no Origin header (a machine, never a page), the pairing's bearer
 * (resolvePairingFromBearer), an owner on the pairing, approved to claim work, the workspace's agents
 * owner (the computer the agents run on), a live seat, OASIS's own workspace, and the pairing
 * advertising agent_inbox_v1 in its ping. Ten requests a minute per pairing.
 *
 * ONE COMPUTER PER DIRECTIVE. pending RESERVES what it returns for the asking computer (one UPDATE ...
 * RETURNING, lib/agent-inbox-db.ts reserveRelayBatchDb), so two computers polling at once never both
 * write the same directive; only the reserving computer may report it delivered, and only the
 * delivering one may report it read. A reservation with no delivery lapses after five minutes.
 *
 * SCRUBBED. The subject and body go through redactAll before they leave: the note lands in a folder a
 * model reads at the start of every session, so a credential pasted into a directive never reaches it.
 *
 * One module, not one per verb: each Next route compiles to its own server bundle and the Worker is
 * near Cloudflare's size limit (see app/api/automations/guided/[[...path]]/route.ts).
 */
import { type NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { tursoConfigured } from "@/lib/turso";
import { isAgentsOwner } from "@/lib/agents-owner";
import { isOasisWorkspace } from "@/lib/ai/agent-engine-store";
import { pairingCanClaim, resolvePairingFromBearer, type ResolvedPairing } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";
import { rateLimit } from "@/lib/rate-limit";
import { markAckedDb, markDeliveredDb, RELAY_BATCH_MAX, reserveRelayBatchDb } from "@/lib/agent-inbox-db";
import { redactAll } from "@/lib/secret-redaction";
import { AGENT_INBOX_PROTOCOL } from "@/lib/agent-inbox-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_000;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function advertises(pairing: ResolvedPairing): Promise<boolean> {
  const result = await getServiceSupabase()
    .from("bridge_pairings")
    .select("claim_protocols")
    .eq("tenant_id", pairing.tenantId)
    .eq("id", pairing.pairingId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const raw = (result.data as { claim_protocols?: unknown } | null)?.claim_protocols;
  try {
    const protocols = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(protocols) && protocols.includes(AGENT_INBOX_PROTOCOL);
  } catch {
    return false;
  }
}

/** Every gate, in order; the pairing when all pass. */
async function authorize(req: NextRequest): Promise<{ ok: true; pairing: ResolvedPairing } | { ok: false; res: NextResponse }> {
  const refuse = (status: number, error: string) => ({ ok: false as const, res: json(status, { ok: false, error }) });
  if (req.headers.get("origin")) return refuse(403, "unexpected_origin_header");
  if (!tursoConfigured()) return refuse(503, "database_not_configured");
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return refuse(resolved.status, resolved.error);
  const { pairing } = resolved;
  if (!pairing.userId) return refuse(409, "pairing_has_no_owner");
  if (!pairingCanClaim(pairing)) return refuse(403, "not_approved");
  try {
    if (!(await isAgentsOwner(pairing.tenantId, pairing.userId))) return refuse(403, "agents_owner_only");
    if (!(await liveSeat(pairing.tenantId, pairing.userId)).live) return refuse(403, "seat_inactive");
    if (!(await isOasisWorkspace(pairing.tenantId))) return refuse(403, "oasis_workspace_only");
    if (!(await advertises(pairing))) return refuse(400, "unsupported_protocol");
  } catch (error) {
    console.error("[bridge.inbox.gate]", { tenantId: pairing.tenantId, pairingId: pairing.pairingId, error: error instanceof Error ? error.message : String(error) });
    return refuse(503, "gate_check_unavailable");
  }
  const limit = rateLimit({ key: `bridge-inbox:${pairing.tenantId}:${pairing.pairingId}`, capacity: 10, refillPerSec: 10 / 60 });
  if (!limit.allowed) return { ok: false, res: json(429, { ok: false, error: "too_fast", retry_in_sec: limit.resetIn }) };
  return { ok: true, pairing };
}

/** `{ids: [...]}` and nothing else: 1 to 20 well-formed, distinct ids. */
async function idsFrom(req: NextRequest): Promise<string[] | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "ids")) return null;
  const ids = record.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RELAY_BATCH_MAX) return null;
  if (!ids.every((id): id is string => typeof id === "string" && ID_RE.test(id))) return null;
  return [...new Set(ids)];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const path = (await ctx.params).path ?? [];
  if (path.length !== 1 || path[0] !== "pending") return json(404, { ok: false, error: "not_found" });
  const auth = await authorize(req);
  if (!auth.ok) return auth.res;
  try {
    const rows = await reserveRelayBatchDb(auth.pairing.tenantId, auth.pairing.pairingId);
    return json(200, {
      ok: true,
      messages: rows.map((row) => ({
        id: row.id,
        message_id: row.message_id,
        from: row.from_agent,
        to: row.to_agent,
        subject: redactAll(row.subject ?? ""),
        body: redactAll(row.body),
        priority: row.priority,
        requires_response: Boolean(row.requires_response),
        in_reply_to: row.in_reply_to,
        thread_id: row.thread_id || row.message_id,
        created_at: row.created_at,
      })),
    });
  } catch (error) {
    console.error("[bridge.inbox.pending]", { tenantId: auth.pairing.tenantId, error: error instanceof Error ? error.message : String(error) });
    return json(503, { ok: false, error: "inbox_unavailable" });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const path = (await ctx.params).path ?? [];
  const verb = path.length === 1 ? path[0] : "";
  if (verb !== "delivered" && verb !== "acked") return json(404, { ok: false, error: "not_found" });
  const auth = await authorize(req);
  if (!auth.ok) return auth.res;
  const ids = await idsFrom(req);
  if (!ids) return json(400, { ok: false, error: "invalid_body" });
  const { pairing } = auth;
  try {
    if (verb === "delivered") {
      const delivered = await markDeliveredDb(pairing.tenantId, ids, { id: pairing.pairingId, label: pairing.label || "your computer" });
      return json(200, { ok: true, delivered });
    }
    const acked = await markAckedDb(pairing.tenantId, ids, pairing.pairingId);
    return json(200, { ok: true, acked });
  } catch (error) {
    console.error(`[bridge.inbox.${verb}]`, { tenantId: pairing.tenantId, error: error instanceof Error ? error.message : String(error) });
    return json(503, { ok: false, error: "inbox_unavailable" });
  }
}
