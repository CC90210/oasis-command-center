/**
 * /api/conversations/threads/[key] — Phase 3 spine surface (plan §7).
 *
 * GET   — lazy-load a selected thread's messages. Under CONVERSATIONS_SPINE,
 *         listThreadsFromSpine() returns thread METADATA only (no messages,
 *         to keep the list query cheap and pagination-friendly); the client
 *         fetches the full message window here once the operator selects a
 *         thread. Re-queries lead_interactions server-side, tenant-scoped —
 *         never trusts a client-supplied transcript.
 *
 * PATCH — workflow ops: { status?, assigned_to?, snoozed_until?, markRead? }.
 *         Any subset of fields may be present; only the fields present are
 *         changed (no implicit side effects between them — e.g. a "snooze"
 *         quick-action must send BOTH status:"snoozed" and snoozed_until
 *         explicitly). Each change writes a conversation_events audit row,
 *         mirroring the assign-RPC audit pattern in
 *         app/api/leads/[id]/assign/route.ts. Auth via resolveSessionContext
 *         (any tenant member — thread workflow state is a team surface, same
 *         soft-ownership model as lead assignment).
 *
 * `key` is a ConversationThread.key (`lead:<uuid>` | `phone:<E164>` |
 * `email:<addr>` | `id:<uuid>`) and MUST be `encodeURIComponent`-ed by the
 * caller (it can contain `+`/`@`/`:`).
 *
 * Both handlers require the Phase 3 migration (database/112_conversations_
 * spine.sql) to be applied — `conversation_threads` not existing yet is a
 * clean 503, not a crash, so shipping this route is safe before the
 * migration lands (the UI never calls it unless CONVERSATIONS_SPINE=1).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { loadThreadMessages } from "@/lib/lead-interactions-queries";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import type { ThreadStatus } from "@/lib/conversation-threading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES: ThreadStatus[] = [
  "open",
  "needs_reply",
  "waiting_on_client",
  "closed",
  "snoozed",
  "triage",
];

function isMissingTableError(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message || "";
  const code = (err as { code?: string } | null)?.code || "";
  // Postgres undefined_table (42P01, if the query reaches pg directly), or
  // PostgREST's own schema-cache miss (PGRST205 — "Could not find the
  // table ... in the schema cache", what supabase-js actually surfaces for
  // an unmigrated table) — either way the 112 migration hasn't been applied
  // on this environment yet.
  return code === "42P01" || code === "PGRST205" || /relation .* does not exist|schema cache/i.test(msg);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ key: string }> },
) {
  const { key: rawKey } = await ctx.params;
  const key = decodeURIComponent(rawKey || "");
  if (!key) {
    return NextResponse.json({ ok: false, error: "invalid_key" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const thread = await loadThreadMessages(sess.tenantId, key);
  if (!thread) {
    return NextResponse.json({ ok: true, messages: [], tt_chat_id: null });
  }
  return NextResponse.json({ ok: true, messages: thread.messages, tt_chat_id: thread.tt_chat_id });
}

type PatchBody = {
  status?: unknown;
  assigned_to?: unknown;
  snoozed_until?: unknown;
  markRead?: unknown;
};

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ key: string }> },
) {
  const { key: rawKey } = await ctx.params;
  const key = decodeURIComponent(rawKey || "");
  if (!key) {
    return NextResponse.json({ ok: false, error: "invalid_key" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Validate whichever fields are present. `undefined` = untouched;
  // `null` (where allowed) = explicit clear.
  const patch: Record<string, unknown> = {};
  const events: Array<{ event_type: string; metadata: Record<string, unknown> }> = [];

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !VALID_STATUSES.includes(body.status as ThreadStatus)) {
      return NextResponse.json(
        { ok: false, error: "invalid_status", message: `status must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    patch.status = body.status;
    events.push({ event_type: "status_changed", metadata: { status: body.status } });
  }

  if (body.assigned_to !== undefined) {
    let nextAssignedTo: string | null = null;
    if (body.assigned_to !== null) {
      if (typeof body.assigned_to !== "string" || !UUID_RE.test(body.assigned_to)) {
        return NextResponse.json(
          { ok: false, error: "invalid_assigned_to", message: "Must be a user UUID or null." },
          { status: 400 },
        );
      }
      nextAssignedTo = body.assigned_to.toLowerCase();
    }
    patch.assigned_to = nextAssignedTo;
    events.push({ event_type: "assigned", metadata: { assigned_to: nextAssignedTo } });
  }

  if (body.snoozed_until !== undefined) {
    let nextSnoozedUntil: string | null = null;
    if (body.snoozed_until !== null) {
      if (typeof body.snoozed_until !== "string" || Number.isNaN(Date.parse(body.snoozed_until))) {
        return NextResponse.json(
          { ok: false, error: "invalid_snoozed_until", message: "Must be an ISO timestamp or null." },
          { status: 400 },
        );
      }
      nextSnoozedUntil = new Date(body.snoozed_until).toISOString();
    }
    patch.snoozed_until = nextSnoozedUntil;
    events.push({ event_type: "snoozed", metadata: { snoozed_until: nextSnoozedUntil } });
  }

  const markRead = body.markRead === true;
  if (markRead) {
    patch.unread_count = 0;
    patch.last_read_at = new Date().toISOString();
    events.push({ event_type: "read", metadata: {} });
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no_fields" }, { status: 400 });
  }

  // Membership check mirrors app/api/leads/[id]/assign/route.ts — prevent
  // assigning a thread to a UUID that isn't actually on this tenant.
  const db = getServiceSupabase();
  if (typeof patch.assigned_to === "string") {
    const member = await db
      .from("user_profiles")
      .select("auth_user_id")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", patch.assigned_to)
      .maybeSingle();
    if (!member.data) {
      return NextResponse.json(
        { ok: false, error: "not_a_tenant_member", message: "That user isn't on this tenant." },
        { status: 400 },
      );
    }
  }

  patch.updated_at = new Date().toISOString();

  try {
    const existing = await db
      .from("conversation_threads")
      .select("id, lead_id")
      .eq("tenant_id", tenantId)
      .eq("thread_key", key)
      .maybeSingle();
    if (existing.error) throw existing.error;
    const row = existing.data as { id: string; lead_id: string | null } | null;
    // A thread row only exists once at least one lead_interactions insert has
    // fired the conv_thread_upsert trigger — a workflow-ops PATCH on a thread
    // that was never on the spine list is a client/data bug, not a valid
    // "create on demand" case. Fail closed (404), don't fabricate a row.
    if (!row) {
      return NextResponse.json({ ok: false, error: "thread_not_found" }, { status: 404 });
    }

    const update = await db.from("conversation_threads").update(patch).eq("id", row.id);
    if (update.error) throw update.error;

    // Best-effort audit trail — a logging failure never fails the workflow
    // change itself, but IS surfaced (console.error) for observability.
    try {
      if (events.length) {
        await db.from("conversation_events").insert(
          events.map((e) => ({
            tenant_id: tenantId,
            thread_id: row.id,
            lead_id: row.lead_id,
            event_type: e.event_type,
            actor_user_id: sess.userId,
            metadata: e.metadata,
          })),
        );
      }
    } catch (err) {
      console.error("[conversations.threads.PATCH] event audit insert failed", err);
    }

    await nudgeConversations(tenantId);

    return NextResponse.json({ ok: true, thread_id: row.id, patch });
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json(
        { ok: false, error: "spine_not_applied", message: "The conversations spine migration hasn't been applied yet." },
        { status: 503 },
      );
    }
    console.error("[conversations.threads.PATCH] failed", err);
    return NextResponse.json({ ok: false, error: "update_failed" }, { status: 500 });
  }
}
