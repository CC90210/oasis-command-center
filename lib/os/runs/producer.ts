/**
 * lib/os/runs/producer.ts - a PRODUCER's batch of events, checked and written.
 *
 * The second door into a run's event list. The first is the Worker's own
 * driver (./executor.ts), which writes through ./activity.ts. This one is for
 * the paired computer's bridge when it runs a department turn itself and posts
 * what the app does (POST /api/os/runs/<id>/events, authenticated by the run
 * credential in ./producer-auth.ts). Both end in the same table, through the
 * same appendEvents, so a browser follows either the same way.
 *
 * WIRE FORMAT (one JSON body: { "events": [...] }, at most MAX_BATCH_EVENTS; an
 * empty or absent list is a heartbeat). Every event carries `seq`, an integer
 * the producer counts up from 1; a seq already written is ignored, so a batch
 * can be resent whole.
 *
 *   { seq, type: "status",      label? }
 *   { seq, type: "thinking",    text }                    kept only while the run works, and only if the run's person may see it
 *   { seq, type: "delta",       text }                    reply text
 *   { seq, type: "tool",        id, name }                a lookup began: shown by KIND, never by path, command or input
 *   { seq, type: "tool_result", id, ok, size? }
 *   { seq, type: "done",        usage?: { input_tokens, output_tokens }, cancelled? }
 *   { seq, type: "error",       code }
 *
 * `done` and `error` end the run (the answer is the reply text posted). The
 * response says whether the person pressed Stop (`cancel`): the producer then
 * stops the app and posts `done` with cancelled: true. Events after the first
 * `done` or `error` in a batch are ignored.
 *
 * WHAT IS WRITTEN IS WHAT THE DRIVER WRITES: scrubbed (credentials, workspace
 * vault values), house-agent names replaced by the department, lookups under
 * plain labels. A producer is trusted to run the app, not to decide what a
 * client may read.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { classifyStreamError, failureCopy, isTurnFailureCode, type TurnFailureCode } from "@/lib/os/channel/outcome";
import { producerToolLabel } from "./activity";
import { appendEvents, finishProducerRun, partialText, producerHeartbeat, type Run } from "./store";
import { PRODUCER_SEQ_BASE, type RunEvent } from "./types";

export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 256_000;
const MAX_SEQ = 1_000_000;
const MAX_TEXT = 8_000;

export type ProducerEvent =
  | { seq: number; type: "status"; label: string | null }
  | { seq: number; type: "thinking"; text: string }
  | { seq: number; type: "delta"; text: string }
  | { seq: number; type: "tool"; id: string; name: string }
  | { seq: number; type: "tool_result"; id: string; ok: boolean; size: number | null }
  | { seq: number; type: "done"; usage: { input: number | null; output: number | null } | null; cancelled: boolean }
  | { seq: number; type: "error"; code: string };

export type ParsedBatch = { ok: true; events: ProducerEvent[] } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");
const idOf = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(v) ? v : "");
const tokens = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Parse a body into events. Anything malformed refuses the whole batch: a producer that sends nonsense is broken, not partly right. */
export function parseBatch(body: unknown): ParsedBatch {
  if (!isRecord(body)) return { ok: false, error: "invalid_body" };
  const list = body.events === undefined ? [] : body.events;
  if (!Array.isArray(list)) return { ok: false, error: "invalid_events" };
  if (list.length > MAX_BATCH_EVENTS) return { ok: false, error: "too_many_events" };
  const events: ProducerEvent[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) return { ok: false, error: "invalid_event" };
    const seq = raw.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return { ok: false, error: "invalid_seq" };
    switch (raw.type) {
      case "status":
        events.push({ seq, type: "status", label: text(raw.label).slice(0, 80) || null });
        break;
      case "thinking":
      case "delta":
        events.push({ seq, type: raw.type, text: text(raw.text) });
        break;
      case "tool": {
        const id = idOf(raw.id);
        if (!id || typeof raw.name !== "string") return { ok: false, error: "invalid_tool" };
        events.push({ seq, type: "tool", id, name: raw.name.slice(0, 120) });
        break;
      }
      case "tool_result": {
        const id = idOf(raw.id);
        if (!id) return { ok: false, error: "invalid_tool" };
        events.push({ seq, type: "tool_result", id, ok: raw.ok !== false, size: tokens(raw.size) });
        break;
      }
      case "done": {
        const u = isRecord(raw.usage) ? raw.usage : null;
        events.push({
          seq,
          type: "done",
          usage: u ? { input: tokens(u.input_tokens), output: tokens(u.output_tokens) } : null,
          cancelled: raw.cancelled === true,
        });
        break;
      }
      case "error":
        events.push({ seq, type: "error", code: text(raw.code).slice(0, 80) || "error" });
        break;
      default:
        return { ok: false, error: "unknown_event_type" };
    }
  }
  return { ok: true, events };
}

export type IngestContext = {
  /** The run's person may see the model's reasoning (the run row says so). */
  showThinking: boolean;
  /** Credentials and the workspace's vault values out of a string. */
  scrub: (text: string) => string;
  /** The same, and house-agent names replaced by the department. */
  scrubReasoning: (text: string) => string;
  now: Date;
};

export type IngestResult = {
  /** Events written or already there (a resent seq counts: the producer can drop it). */
  accepted: number;
  /** The run is over (this batch ended it, or it had already ended). */
  finished: boolean;
  /** The person pressed Stop: the producer stops the app and posts `done` with cancelled: true. */
  cancel: boolean;
};

/**
 * Write a producer's batch. The run row decides who may (source `producer`,
 * status `running`), and every event lands in the run's own workspace.
 */
export async function ingestBatch(db: Client, run: Run, events: readonly ProducerEvent[], ctx: IngestContext): Promise<IngestResult> {
  const beat = await producerHeartbeat(db, run, ctx.now);
  if (!beat.owned) return { accepted: 0, finished: true, cancel: false };

  const scope = { tenantId: run.tenantId, userId: run.userId };
  const stored: RunEvent[] = [];
  let ending: Extract<ProducerEvent, { type: "done" | "error" }> | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ending) break;
    const seq = PRODUCER_SEQ_BASE + e.seq;
    switch (e.type) {
      case "status":
        stored.push({ seq, kind: "status", data: { phase: "thinking", label: ctx.scrub(e.label ?? "Working on it") } });
        break;
      case "thinking":
        if (ctx.showThinking && e.text) stored.push({ seq, kind: "thinking", data: { text: ctx.scrubReasoning(e.text) } });
        break;
      case "delta":
        if (e.text) stored.push({ seq, kind: "delta", data: { text: ctx.scrub(e.text) } });
        break;
      case "tool":
        stored.push({ seq, kind: "tool", data: { id: `p${e.id}`, phase: "start", label: producerToolLabel(e.name), ok: null } });
        break;
      case "tool_result":
        stored.push({
          seq,
          kind: "tool",
          data: { id: `p${e.id}`, phase: "done", ok: e.ok, ...(e.size !== null ? { size: e.size } : {}) },
        });
        break;
      case "done":
        if (e.usage && e.usage.input !== null && e.usage.output !== null) {
          stored.push({ seq, kind: "usage", data: { input_tokens: e.usage.input, output_tokens: e.usage.output } });
        }
        ending = e;
        break;
      case "error":
        ending = e;
        break;
    }
  }

  const written = await appendEvents(db, scope, run.id, stored, ctx.now);
  if (!written && stored.length > 0) {
    // INSERT OR IGNORE writes 0 rows for a resent seq: that is not a lost run.
    // appendEvents reports a vanished run the same way, so look again.
    const again = await producerHeartbeat(db, run, ctx.now);
    if (!again.owned) return { accepted: 0, finished: true, cancel: false };
  }

  if (!ending) return { accepted: events.length, finished: false, cancel: beat.cancel };

  let status: "done" | "failed" | "cancelled" = "done";
  let errorCode: TurnFailureCode | null = null;
  if (ending.type === "error") {
    errorCode = isTurnFailureCode(ending.code) ? ending.code : classifyStreamError(`cli_error:${ending.code}`);
    status = "failed";
  } else if (ending.cancelled) {
    status = "cancelled";
  } else if (!(await partialText(db, scope, run.id)).trim()) {
    errorCode = "reply_empty";
    status = "failed";
  }
  const usage = ending.type === "done" ? ending.usage : null;
  await finishProducerRun(db, run, {
    status,
    errorCode,
    message: errorCode ? failureCopy(errorCode, { canManageAi: false }).sentence : null,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    now: ctx.now,
  });
  return { accepted: events.length, finished: true, cancel: false };
}
