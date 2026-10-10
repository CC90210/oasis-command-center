/**
 * components/agents/run-store.ts - the browser's side of department-channel
 * runs: one store per department, outside React.
 *
 * WHY OUTSIDE REACT. The connection that follows a run must not belong to the
 * component that started it. A person who sends a message and then opens
 * Schedule or Playbook unmounts the channel; if the stream died with it, the
 * page would come back to a half-written reply. Here the connection, and the
 * conversation it fills, live at module level for as long as the tab does, so
 * the channel simply re-reads the store when it mounts again. Nothing in this
 * file reads an unmount: no abort is ever tied to a component.
 *
 * What survives what:
 *   - moving around the app (client navigation): the connection stays open and
 *     the run is followed live the whole time;
 *   - a reload, or opening the channel in another tab: the conversation is
 *     reopened from the server (GET /api/os/conversations/<id>), and any run
 *     still working is followed again from the start (GET /api/os/runs/<id>/stream
 *     replays what was saved, then goes live);
 *   - closing the tab: the server finishes what it can (see
 *     lib/os/runs/keepalive.ts) and the next visit reads the result.
 *
 * Every event is applied by its seq (lib/os/runs/reduce.ts), so an event heard
 * twice (the sending stream and a re-attach overlapping) changes nothing.
 */
import { announceTurn } from "@/components/os/department/turn-event";
import { asFailureModel, viaLine } from "./chat-shared";
import { readSse } from "./sse-client";
import { applyRunEvent, emptyRunView, reduceRunEvents, type RunView } from "@/lib/os/runs/reduce";
import { isRunEventKind, isRunStatus, isTerminalStatus, type RunEvent, type RunStatus } from "@/lib/os/runs/types";
import type { FailureModel } from "@/lib/os/channel/outcome";

/** Not over yet: being sent, waiting its turn, or working. */
export function isActive(status: ChatItem["status"]): boolean {
  return status === "sending" || !isTerminalStatus(status);
}

export type ChatItem = {
  /** Local identity, stable from "sending" to the saved run. */
  key: string;
  runId: string | null;
  seq: number;
  userText: string;
  status: "sending" | RunStatus;
  view: RunView;
  /** The reply: the saved answer once the run ends, else what has arrived. */
  text: string;
  /** What ran it and whose credits ("via ..."), for those who may see it. */
  via: string | null;
  /** Why the message did not run or the run did not finish. A code; the sentence is chosen where it is drawn. */
  failure: { code: string; model: FailureModel | null } | null;
  /** Stop was pressed; the run is ending. */
  stopping: boolean;
  /** This browser watched the run end (so the channel's header is told); a reopened old run is not announced. */
  live: boolean;
};

export type ConversationSummary = { id: string; title: string; lastMessageAt: string; activeRuns: number };

export type DeptChatState = {
  department: string;
  conversationId: string | null;
  title: string;
  items: ChatItem[];
  conversations: ConversationSummary[];
  listState: "idle" | "loading" | "ready" | "failed";
  /** A conversation is being opened. */
  opening: boolean;
  /** Set when the saved-chat service says no (a plain code: chat_history_unavailable). */
  notice: string | null;
};

const states = new Map<string, DeptChatState>();
const listeners = new Set<() => void>();
const following = new Set<string>();
/** Departments with a send stream open: it carries the conversation's queue, so queued runs need no separate follower. */
const sendStreams = new Map<string, string>();
const initialised = new Set<string>();

function blank(department: string): DeptChatState {
  return { department, conversationId: null, title: "", items: [], conversations: [], listState: "idle", opening: false, notice: null };
}

const serverBlank = new Map<string, DeptChatState>();
/** The server-render snapshot: always an empty channel (nothing is fetched while rendering). */
export function getServerState(department: string): DeptChatState {
  let s = serverBlank.get(department);
  if (!s) {
    s = blank(department);
    serverBlank.set(department, s);
  }
  return s;
}

export function getState(department: string): DeptChatState {
  let s = states.get(department);
  if (!s) {
    s = blank(department);
    states.set(department, s);
  }
  return s;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(department: string, patch: (s: DeptChatState) => DeptChatState) {
  states.set(department, patch(getState(department)));
  for (const fn of [...listeners]) fn();
}

function patchItem(department: string, match: (i: ChatItem) => boolean, change: (i: ChatItem) => ChatItem) {
  set(department, (s) => ({ ...s, items: s.items.map((i) => (match(i) ? change(i) : i)) }));
}

let counter = 0;
const newKey = () => `local-${Date.now().toString(36)}-${(counter += 1)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const rememberKey = (department: string) => `oasis.dept-chat.${department}.v1`;
function remember(department: string, id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(rememberKey(department), id);
    else window.sessionStorage.removeItem(rememberKey(department));
  } catch {
    // Private mode or storage off: the channel just opens on a fresh chat after a reload.
  }
}
function remembered(department: string): string | null {
  try {
    return window.sessionStorage.getItem(rememberKey(department));
  } catch {
    return null;
  }
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

// -- Building items ---------------------------------------------------------------

function itemFromHead(head: Record<string, unknown>): ChatItem {
  const status = isRunStatus(head.status) ? head.status : "queued";
  return {
    key: text(head.id) || newKey(),
    runId: text(head.id) || null,
    seq: Number(head.seq) || 0,
    userText: text(head.user_text),
    status,
    view: emptyRunView(),
    text: text(head.final_text),
    via: null,
    failure: null,
    stopping: false,
    live: true,
  };
}

function failureOf(view: RunView, code: string | null): ChatItem["failure"] {
  if (view.error) return { code: view.error.code, model: asFailureModel(view.error.model) };
  return code ? { code, model: null } : null;
}

function itemFromSaved(run: Record<string, unknown>): ChatItem {
  const status = isRunStatus(run.status) ? run.status : "failed";
  const events = (Array.isArray(run.events) ? run.events : []).flatMap((e): RunEvent[] => {
    const r = rec(e);
    return r && isRunEventKind(r.kind) && typeof r.seq === "number" ? [{ seq: r.seq, kind: r.kind, data: rec(r.data) ?? {} }] : [];
  });
  const view = reduceRunEvents(events);
  const code = typeof run.error_code === "string" ? run.error_code : null;
  return {
    key: text(run.id),
    runId: text(run.id),
    seq: Number(run.seq) || 0,
    userText: text(run.user_text),
    status,
    view,
    text: typeof run.final_text === "string" ? run.final_text : view.text,
    via: viaLine(rec(run.agent) ?? view.agent),
    failure: status === "failed" || status === "interrupted" ? failureOf(view, code ?? (status === "interrupted" ? "interrupted" : null)) : null,
    stopping: false,
    live: false,
  };
}

/** Where a run's frames go: the item for this run id. Unknown runs in the open conversation are added (another tab sent them). */
function onEvent(department: string, conversationId: string, runId: string, event: RunEvent) {
  const s = getState(department);
  if (s.conversationId !== conversationId) return;
  patchItem(
    department,
    (i) => i.runId === runId,
    (i) => {
      const view = applyRunEvent(i.view, event);
      if (view === i.view) return i;
      return { ...i, view, text: view.text || i.text, via: i.via ?? viaLine(view.agent), status: i.status === "queued" || i.status === "sending" ? "running" : i.status };
    },
  );
}

function onRun(department: string, conversationId: string, head: Record<string, unknown>, sendKey: string | null) {
  const s = getState(department);
  if (s.conversationId !== conversationId) return;
  const id = text(head.id);
  const status = isRunStatus(head.status) ? head.status : "queued";
  const known = s.items.find((i) => i.runId === id) ?? (sendKey ? s.items.find((i) => i.key === sendKey && i.runId === null) : undefined);
  if (known) {
    patchItem(
      department,
      (i) => i === known,
      (i) => ({ ...i, runId: id, seq: Number(head.seq) || i.seq, status: i.status === "running" ? i.status : status }),
    );
  } else {
    set(department, (cur) => ({ ...cur, items: [...cur.items, itemFromHead(head)] }));
  }
}

function onEnd(department: string, conversationId: string, head: Record<string, unknown>) {
  const s = getState(department);
  if (s.conversationId !== conversationId) return;
  const id = text(head.id);
  const status = isRunStatus(head.status) ? head.status : "done";
  const code = typeof head.error_code === "string" ? head.error_code : null;
  const item = s.items.find((i) => i.runId === id);
  patchItem(
    department,
    (i) => i.runId === id,
    (i) => {
      const finalText = typeof head.final_text === "string" ? head.final_text : null;
      return {
        ...i,
        status,
        text: finalText ?? i.view.text,
        stopping: false,
        failure: status === "failed" || status === "interrupted" ? failureOf(i.view, code ?? (status === "interrupted" ? "interrupted" : null)) : null,
        view: { ...i.view, activity: null, finished: status },
      };
    },
  );
  if (item?.live && isActive(item.status)) {
    // The department header learns how the turn went, as before (turn-event.ts).
    const hasText = (typeof head.final_text === "string" && head.final_text.trim()) || item.view.text.trim();
    if (status === "failed") announceTurn({ department, ok: false, code: code ?? "provider_error" });
    else if (status === "done" && hasText) announceTurn({ department, ok: true });
  }
  void refreshList(department);
}

// -- Following a run ----------------------------------------------------------------

/**
 * Read frames into the store. Returns when the stream ends, or "left" when the
 * person has opened another conversation (the stream is then dropped here; the
 * runs go on, on the server). `sendKey` binds a "sending" item to the run id the
 * server gives it. `ref.id` is the conversation the frames belong to: known at
 * once for a follow, and learned from the first frame of a send that starts a
 * new conversation.
 */
async function pump(
  department: string,
  ref: { id: string | null },
  body: ReadableStream<Uint8Array>,
  sendKey: string | null,
): Promise<"ended" | "left"> {
  for await (const frame of readSse(body)) {
    const d = rec(frame.data);
    if (!d) continue;
    if (frame.event === "conversation") {
      const id = text(d.id);
      if (!ref.id && id) {
        ref.id = id;
        if (sendKey) sendStreams.set(department, id);
        if (getState(department).conversationId === null) {
          remember(department, id);
          set(department, (s) => ({ ...s, conversationId: id, title: text(d.title) || s.title }));
        }
      }
      continue;
    }
    const conversationId = ref.id;
    if (!conversationId || getState(department).conversationId !== conversationId) return "left";
    if (frame.event === "run") onRun(department, conversationId, d, sendKey);
    else if (frame.event === "ev" && isRunEventKind(d.kind) && typeof d.seq === "number") {
      onEvent(department, conversationId, text(d.run_id), { seq: d.seq, kind: d.kind, data: rec(d.data) ?? {} });
    } else if (frame.event === "end") onEnd(department, conversationId, d);
    else if (frame.event === "gone") {
      patchItem(department, (i) => i.runId === text(d.run_id), (i) => ({ ...i, status: "failed", failure: { code: "run_not_found", model: null } }));
    }
  }
  return "ended";
}

/** Follow one run from the server until it ends, re-asking from the last event seen when a window closes or the network drops. */
export function follow(department: string, conversationId: string, runId: string): void {
  if (following.has(runId)) return;
  following.add(runId);
  void (async () => {
    let failures = 0;
    try {
      for (;;) {
        const item = getState(department).items.find((i) => i.runId === runId);
        if (getState(department).conversationId !== conversationId || !item || !isActive(item.status)) return;
        // A send stream for this conversation is already carrying it (and the queue behind it).
        if (sendStreams.get(department) === conversationId) return;
        try {
          const res = await fetch(`/api/os/runs/${runId}/stream?after=${item.view.lastSeq}`);
          if (res.status === 404) {
            patchItem(department, (i) => i.runId === runId, (i) => ({ ...i, status: "failed", failure: { code: "run_not_found", model: null } }));
            return;
          }
          if (res.status === 401 || res.status === 403) return;
          if (res.status === 503) {
            set(department, (s) => ({ ...s, notice: "chat_history_unavailable" }));
            return;
          }
          if (!res.ok || !res.body) throw new Error(`http_${res.status}`);
          failures = 0;
          const how = await pump(department, { id: conversationId }, res.body, null);
          if (how === "left") return;
        } catch {
          failures += 1;
          if (failures > 6) return;
          await sleep(Math.min(1500 * failures, 8000));
        }
      }
    } finally {
      following.delete(runId);
    }
  })();
}

/** Follow every run in the open conversation that is not over (after opening it, or after a send stream closed). */
function followActive(department: string) {
  const s = getState(department);
  if (!s.conversationId) return;
  for (const i of s.items) if (i.runId && isActive(i.status) && i.status !== "sending") follow(department, s.conversationId, i.runId);
}

// -- Conversations ----------------------------------------------------------------

export async function refreshList(department: string): Promise<void> {
  try {
    const res = await fetch(`/api/os/conversations?department=${encodeURIComponent(department)}`);
    if (res.status === 503) {
      set(department, (s) => ({ ...s, listState: "failed", notice: "chat_history_unavailable" }));
      return;
    }
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { conversations?: Array<Record<string, unknown>> };
    const conversations = (body.conversations ?? []).map((c) => ({
      id: text(c.id),
      title: text(c.title),
      lastMessageAt: text(c.last_message_at),
      activeRuns: Number(c.active_runs) || 0,
    }));
    set(department, (s) => ({ ...s, conversations, listState: "ready", notice: s.notice === "chat_history_unavailable" ? null : s.notice }));
  } catch {
    set(department, (s) => ({ ...s, listState: s.listState === "ready" ? "ready" : "failed" }));
  }
}

/** First mount of a channel in this tab: the list, and the chat the person was in (or one still working). Idempotent. */
export async function loadInitial(department: string): Promise<void> {
  if (initialised.has(department)) return;
  initialised.add(department);
  set(department, (s) => ({ ...s, listState: "loading" }));
  await refreshList(department);
  const s = getState(department);
  if (s.conversationId) return; // a message was sent before the list came back
  const pick = s.conversations.find((c) => c.id === remembered(department)) ?? s.conversations.find((c) => c.activeRuns > 0);
  if (pick) await openConversation(department, pick.id);
}

export function newChat(department: string): void {
  remember(department, null);
  set(department, (s) => ({ ...s, conversationId: null, title: "", items: [], opening: false }));
}

export async function openConversation(department: string, id: string): Promise<void> {
  if (getState(department).conversationId === id && getState(department).items.length > 0) return;
  set(department, (s) => ({ ...s, conversationId: id, title: s.conversations.find((c) => c.id === id)?.title ?? "", items: [], opening: true }));
  try {
    const res = await fetch(`/api/os/conversations/${encodeURIComponent(id)}`);
    if (getState(department).conversationId !== id) return; // the person went elsewhere meanwhile
    if (res.status === 404) {
      remember(department, null);
      set(department, (s) => ({ ...s, conversationId: null, title: "", items: [], opening: false }));
      void refreshList(department);
      return;
    }
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { conversation?: Record<string, unknown>; runs?: Array<Record<string, unknown>> };
    const items = (body.runs ?? []).map(itemFromSaved);
    remember(department, id);
    set(department, (s) => ({ ...s, title: text(body.conversation?.title), items, opening: false }));
    followActive(department);
  } catch {
    set(department, (s) => ({ ...s, opening: false, notice: s.notice ?? "chat_history_unavailable" }));
  }
}

export async function renameConversation(department: string, id: string, title: string): Promise<void> {
  const res = await fetch(`/api/os/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (res.ok) {
    set(department, (s) => ({ ...s, title: s.conversationId === id ? title.trim() : s.title }));
    await refreshList(department);
  }
}

export async function deleteConversation(department: string, id: string): Promise<void> {
  const res = await fetch(`/api/os/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) return;
  if (getState(department).conversationId === id) newChat(department);
  await refreshList(department);
}

// -- Sending and stopping -----------------------------------------------------------

export type SendInput = { agentSlug: string; text: string; chatMode: "plan" | "build" };

function failItem(department: string, key: string, code: string) {
  patchItem(department, (i) => i.key === key, (i) => ({ ...i, status: "failed", failure: { code, model: null } }));
}

/**
 * Send a message. It shows at once; the server answers with a stream that
 * follows its run (and anything queued behind it), or with 202 when another run
 * in the conversation is being driven, in which case this one waits its turn.
 */
export async function sendMessage(department: string, input: SendInput): Promise<void> {
  const key = newKey();
  const before = getState(department);
  const item: ChatItem = {
    key,
    runId: null,
    seq: 0,
    userText: input.text,
    status: "sending",
    view: emptyRunView(),
    text: "",
    via: null,
    failure: null,
    stopping: false,
    live: true,
  };
  set(department, (s) => ({ ...s, items: [...s.items, item], notice: null }));
  let conversationId = before.conversationId;
  try {
    const res = await fetch("/api/os/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        department,
        agent_slug: input.agentSlug,
        text: input.text,
        chat_mode: input.chatMode,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
    });
    if (res.status === 202) {
      const body = (await res.json()) as { conversation_id?: string; run?: Record<string, unknown> };
      conversationId = body.conversation_id ?? conversationId;
      if (!conversationId || !body.run) throw new Error("bad_ack");
      onRun(department, conversationId, body.run, key);
      follow(department, conversationId, text(body.run.id));
      void refreshList(department);
      return;
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === "chat_history_unavailable") set(department, (s) => ({ ...s, notice: "chat_history_unavailable" }));
      failItem(department, key, body.error || `http_${res.status}`);
      return;
    }
    // The stream's first frame names the conversation (a new one has no id yet).
    const ref = { id: conversationId };
    if (conversationId) sendStreams.set(department, conversationId);
    try {
      await pump(department, ref, res.body, key);
    } finally {
      if (sendStreams.get(department) === (ref.id ?? conversationId)) sendStreams.delete(department);
    }
    conversationId = ref.id;
    // The stream closed (its window ended, or the network): anything still working is followed from the server.
    followActive(department);
    void refreshList(department);
  } catch (err) {
    console.error("[run-store.send]", err);
    const cur = getState(department).items.find((i) => i.key === key);
    // The message may have been saved before the connection dropped: follow it if it was.
    if (cur?.runId && conversationId) follow(department, conversationId, cur.runId);
    else failItem(department, key, "network");
  }
}

export async function stopRun(department: string, runId: string): Promise<void> {
  patchItem(department, (i) => i.runId === runId, (i) => ({ ...i, stopping: true }));
  try {
    const res = await fetch(`/api/os/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { result?: string };
    // A queued message is cancelled on the spot; a running one ends through its stream.
    if (body.result === "cancelled") {
      patchItem(department, (i) => i.runId === runId, (i) => ({ ...i, status: "cancelled", stopping: false, view: { ...i.view, activity: null, finished: "cancelled" } }));
      void refreshList(department);
    }
  } catch {
    patchItem(department, (i) => i.runId === runId, (i) => ({ ...i, stopping: false }));
  }
}
