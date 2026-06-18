/**
 * lib/bridge-chat-persistence.ts — persist bridge/CLI chat turns to
 * chat_sessions + chat_messages so they show up in the "Previous chats"
 * drawer, the same as cloud-path turns.
 *
 * WHY THIS EXISTS (the SunBiz "Previous chats is empty" bug, 2026-06-18):
 * /api/bridge/chat is a transparent SSE relay to the VPS bridge — it writes
 * NOTHING to Supabase, and the VPS bridge persists only Claude Code's local
 * --resume store, not our chat tables. SunBiz employees default to the bridge
 * (CLI) path, so their Previous-chats drawer was permanently empty. Only the
 * cloud path (/api/chat) persisted. This tees the relay so bridge turns persist
 * too — scoped to (tenant_id, user_id, agent_key), so every employee + agent
 * gets their own isolated, accurate history.
 *
 * HOW IT WORKS (no migration, no client change, no SSE rewrite):
 * The bridge emits a `session` SSE event carrying Claude Code's own session
 * UUID, which the client stores and sends back as session_id for --resume on
 * the next turn. We reuse that SAME UUID as chat_sessions.id, so the client's
 * single sessionId already matches what GET /api/chat/sessions[/id] keys on —
 * loadPastSession + the drawer work unchanged. The relay byte-stream is passed
 * through UNCHANGED; we only OBSERVE a decoded copy for bookkeeping.
 *
 * Failure isolation: every DB op soft-fails (logs, never throws) — a
 * persistence hiccup must never break the live chat relay.
 */

import "server-only";
import { getServiceSupabase } from "./supabase-server";
import {
  persistAssistantTurn,
  fetchTenantVaultSecretsForRedaction,
} from "./chat-persistence";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BridgePersistCtx = {
  tenantId: string;
  userId: string;
  agent: string;
  cliProvider: string;
  /** This turn's user message (last user message in the request). */
  userMessage: string;
  /** Date.now() at request start, for latency_ms. */
  startedAt: number;
};

/**
 * Wrap the upstream SSE body so bytes pass through to the client UNCHANGED
 * while we observe a decoded copy and persist the turn. Returns the stream to
 * hand straight to the Response.
 */
export function teeBridgeChatPersistence(
  upstreamBody: ReadableStream<Uint8Array>,
  ctx: BridgePersistCtx,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let sessionId: string | null = null;
  let assistant = "";
  let errorMsg: string | null = null;
  // The session row + user message are written once, as soon as we learn the
  // session id (early in the stream). flush() awaits this before persisting the
  // assistant turn so the assistant row never races ahead of its session row.
  let ensurePromise: Promise<void> | null = null;

  async function ensureSessionAndUser(sid: string): Promise<void> {
    try {
      const db = getServiceSupabase();
      // Insert the session row if new; ignoreDuplicates so a later turn never
      // overwrites the original title/created_at.
      await db.from("chat_sessions").upsert(
        {
          id: sid,
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          agent_key: ctx.agent,
          provider: "bridge",
          model: ctx.cliProvider,
          title: ctx.userMessage.slice(0, 80) || "New chat",
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      // Bump updated_at so active threads sort to the top of Previous chats.
      await db
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sid);
      // Persist THIS turn's user message (incremental — mirrors /api/chat,
      // which writes only the latest user message per turn, not the whole
      // transcript the client re-sends each turn).
      await db.from("chat_messages").insert({
        session_id: sid,
        tenant_id: ctx.tenantId,
        role: "user",
        content: ctx.userMessage,
      });
    } catch (err) {
      console.error("[bridge-chat-persistence.ensure]", (err as Error).message);
    }
  }

  function handleFrame(block: string): void {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed) return;
    if (event === "session" && typeof parsed.session_id === "string") {
      // First valid session id wins. Skip the synthetic "provider-timestamp"
      // fallback the bridge emits when Claude didn't surface a session id —
      // it isn't a valid uuid PK, so persisting it would error.
      if (!sessionId && UUID_RE.test(parsed.session_id)) {
        sessionId = parsed.session_id;
        ensurePromise = ensureSessionAndUser(parsed.session_id);
      }
    } else if (event === "delta" && typeof parsed.text === "string") {
      assistant += parsed.text;
    } else if (event === "error") {
      const m = parsed.message ?? parsed.error;
      if (typeof m === "string" && !errorMsg) errorMsg = m;
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 1) Pass bytes through UNCHANGED — the client stream is byte-identical.
      controller.enqueue(chunk);
      // 2) Parse a decoded copy for persistence; never let parsing break the
      //    relay (any throw is swallowed).
      try {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(block);
        }
      } catch {
        /* bookkeeping only — never affect the passthrough */
      }
    },
    async flush() {
      try {
        if (ensurePromise) await ensurePromise;
        if (!sessionId) return; // no real session id seen → nothing to persist
        const vaultSecrets = await fetchTenantVaultSecretsForRedaction(
          ctx.tenantId,
        ).catch(() => []);
        await persistAssistantTurn({
          sessionId,
          tenantId: ctx.tenantId,
          content: assistant,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Math.max(0, Date.now() - ctx.startedAt),
          error: errorMsg,
          vaultSecrets,
        });
      } catch (err) {
        console.error("[bridge-chat-persistence.flush]", (err as Error).message);
      }
    },
  });

  return upstreamBody.pipeThrough(transform);
}
