/**
 * lib/bridge-chat-persistence.ts — persist bridge/CLI chat turns to
 * chat_sessions + chat_messages so they show up in the "Previous chats"
 * drawer, the same as cloud-path turns.
 *
 * WHY THIS EXISTS (the SunBiz "Previous chats is empty" bug, 2026-06-18):
 * /api/bridge/chat is a transparent SSE relay to the VPS bridge — it writes
 * NOTHING to Supabase, and the VPS bridge persists only Claude Code's local
 * --resume store, not our chat tables. SunBiz employees default to the bridge
 * (CLI) path, so their Previous-chats drawer was permanently empty.
 *
 * THE THREAD KEY (fixed after adversarial review, 2026-06-18):
 * We DO NOT key on the session id the bridge emits — that's Claude Code's own
 * session UUID, and `claude --resume <id>` FORKS a new id every turn, so keying
 * on it would write a fresh one-turn chat_sessions row per message and shatter
 * one conversation into N drawer entries. Instead we key on the client's
 * `tab_id` — a stable per-conversation UUID the client mints once per
 * conversation (re-minted on "New chat", set to the loaded id on resume) and
 * sends on every bridge turn. tab_id is ALSO the bridge's warm-pool key, so the
 * persistence thread and the runtime thread line up. Claude's per-turn session
 * id stays the bridge's --resume key only; it never touches our history id.
 *
 * Because we hold tab_id from the REQUEST (not the SSE stream), we create the
 * session row + write the user message UP FRONT (mirroring the cloud path),
 * then persist the assistant turn on the terminal `done`/`error` frame (so it
 * survives a client disconnect that skips TransformStream.flush()), with flush
 * as an idempotent fallback for the normal-close path.
 *
 * Failure isolation: every DB op soft-fails (logs, never throws) — a
 * persistence hiccup must never break the live chat relay, and the byte stream
 * is passed through UNCHANGED (we only observe a decoded copy).
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
  /** Stable per-conversation key = the client's tab_id (a UUID). This is the
   *  chat_sessions.id we persist under. */
  conversationId: string;
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
  let assistant = "";
  let errorMsg: string | null = null;
  let persisted = false;
  const valid = UUID_RE.test(ctx.conversationId);

  // Create the session row + write this turn's user message UP FRONT — we
  // already hold the stable conversation key, so there's no need to wait for the
  // SSE `session` event (which carries Claude's per-turn id). If the request
  // carries no valid tab_id (older client), skip persistence entirely.
  const ensurePromise: Promise<void> = valid
    ? ensureSessionAndUser()
    : Promise.resolve();

  async function ensureSessionAndUser(): Promise<void> {
    try {
      const db = getServiceSupabase();
      // Insert the session row if new; ignoreDuplicates so later turns never
      // overwrite the original title/created_at.
      await db.from("chat_sessions").upsert(
        {
          id: ctx.conversationId,
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          agent_key: ctx.agent,
          provider: "bridge",
          // For bridge rows `model` holds the CLI runtime, not an LLM model id —
          // namespaced so analytics can't conflate it with a real model name.
          model: `bridge:${ctx.cliProvider}`,
          title: ctx.userMessage.slice(0, 80) || "New chat",
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      // Persist THIS turn's user message (incremental — mirrors /api/chat,
      // which writes only the latest user message per turn).
      await db.from("chat_messages").insert({
        session_id: ctx.conversationId,
        tenant_id: ctx.tenantId,
        role: "user",
        content: ctx.userMessage,
      });
    } catch (err) {
      console.error("[bridge-chat-persistence.ensure]", (err as Error).message);
    }
  }

  // Persist the assistant turn exactly once. Called on the terminal `done`/
  // `error` frame (so it runs even when a client disconnect skips flush()) and
  // again from flush() (normal close) — the `persisted` latch makes it
  // idempotent so there's no double-write.
  async function persistAssistant(): Promise<void> {
    if (persisted || !valid) return;
    persisted = true;
    try {
      await ensurePromise;
      const vaultSecrets = await fetchTenantVaultSecretsForRedaction(
        ctx.tenantId,
      ).catch(() => []);
      await persistAssistantTurn({
        sessionId: ctx.conversationId,
        tenantId: ctx.tenantId,
        content: assistant,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Math.max(0, Date.now() - ctx.startedAt),
        error: errorMsg,
        vaultSecrets,
      });
      // Bump updated_at so active threads sort to the top of Previous chats.
      // (trg_chat_sessions_updated_at sets the value on any UPDATE; we pass it
      // explicitly too for clarity.)
      await getServiceSupabase()
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", ctx.conversationId);
    } catch (err) {
      console.error("[bridge-chat-persistence.persist]", (err as Error).message);
    }
  }

  function handleFrame(block: string): void {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    // Terminal frame — persist now (the full assistant text has already
    // streamed) so the turn survives even if the client disconnects before
    // flush() would run.
    if (event === "done") {
      void persistAssistant();
      return;
    }
    if (!data) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed) return;
    if (event === "delta" && typeof parsed.text === "string") {
      assistant += parsed.text;
    } else if (event === "error") {
      const m = parsed.message ?? parsed.error;
      if (typeof m === "string" && !errorMsg) errorMsg = m;
      void persistAssistant();
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
      // Normal-close fallback (idempotent with the terminal-frame persist).
      await persistAssistant();
    },
  });

  return upstreamBody.pipeThrough(transform);
}
