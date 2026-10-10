/**
 * lib/os/runs/send.ts - send a message into a department channel: what
 * POST /api/os/runs does once the session is resolved.
 *
 * Kept apart from the route so the property that matters can be tested without
 * a browser: THE RUN DOES NOT DEPEND ON THE PERSON STAYING. The driver is a
 * promise started here and handed to the platform (keepAlive); the response the
 * browser reads is only a follower of what the driver writes. When the browser
 * leaves, `onGone` ends the follower. It is deliberately not connected to the
 * driver: nothing in this file lets a disconnect reach it.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { conversationActivity, createConversation, enqueueRun, getConversation, type Conversation } from "./store";
import { driveConversation, type ExecutorDeps } from "./executor";
import { followRun, headOf } from "./follow";
import { sseResponse } from "./sse";
import { keepAlive } from "./keepalive";
import { json } from "./scope";

/** The longest one request follows (and so holds a driver's connection). Past it the browser re-attaches. */
export const MAX_FOLLOW_MS = 14 * 60_000;

export type SendInput = {
  department: string;
  agentSlug: string;
  text: string;
  conversationId: string;
  chatMode: "plan" | "build";
};

export async function sendMessage(args: {
  db: Client;
  deps: ExecutorDeps;
  showThinking: boolean;
  input: SendInput;
  now?: () => Date;
  /** The platform hook (tests pass a recorder). */
  keep?: typeof keepAlive;
  /** Test seam: how fast the follower polls. */
  pollMs?: (elapsedMs: number) => number;
}): Promise<Response> {
  const { db, deps, input } = args;
  const scope = deps.scope;
  const now = args.now ?? (() => new Date());
  const keep = args.keep ?? keepAlive;

  let conversation: Conversation | null;
  if (input.conversationId) {
    conversation = await getConversation(db, scope, input.conversationId);
    if (!conversation || conversation.department !== input.department) return json(404, { ok: false, error: "conversation_not_found" });
  } else {
    conversation = await createConversation(db, scope, { department: input.department, agentSlug: input.agentSlug, now: now() });
  }

  const queued = await enqueueRun(db, scope, {
    conversationId: conversation.id,
    text: input.text,
    chatMode: input.chatMode,
    showThinking: args.showThinking,
    now: now(),
  });
  if (!queued.ok) {
    return queued.reason === "queue_full" ? json(429, { ok: false, error: "queue_full" }) : json(404, { ok: false, error: "conversation_not_found" });
  }
  const run = queued.run;

  // Another driver has the conversation: it runs this message next.
  const activity = await conversationActivity(db, scope, conversation.id, now());
  if (activity.live) {
    return json(202, { ok: true, mode: "queued", conversation_id: conversation.id, run: headOf(run) });
  }

  // Nothing is driving it: this request does. The driver is NOT tied to the response.
  const driving = driveConversation(deps, conversation.id);
  await keep(driving, `drive:${conversation.id}`);

  let gone = false;
  const frames = followRun({
    db,
    scope,
    runId: run.id,
    afterSeq: 0,
    queue: true,
    windowMs: MAX_FOLLOW_MS,
    gone: () => gone,
    now,
    pollMs: args.pollMs,
  });
  const prelude = `event: conversation\ndata: ${JSON.stringify({ id: conversation.id, title: conversation.title || run.userText.slice(0, 80) })}\n\n`;
  return sseResponse(frames, { prelude, onGone: () => (gone = true) });
}
