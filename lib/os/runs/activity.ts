/**
 * lib/os/runs/activity.ts - a turn's stream, written down as run events.
 *
 * The executor (./executor.ts) feeds every event of a department turn (the API
 * tool loop, or the app on the paired computer) through a RunRecorder, which
 * returns the saved events: what the browser replays and follows.
 *
 * WHAT A CLIENT MAY SEE. Every string that leaves here is for a person in a
 * client workspace, so each one is scrubbed:
 *   - credentials and vault values (lib/secret-redaction.ts redactAll), and
 *     for workspace data the desk already applied its own vault scrub;
 *   - house-agent names (Bravo, Maven, Atlas...): replaced by the department
 *     ("the Sales department", lib/os/channel/identity.ts), the way the prompt
 *     is, so the reasoning of a model that was told its persona does not name it;
 *   - a lookup is its plain label ("Looking up Pipeline") and its result line
 *     ("12 leads") or, for an app on the paired computer, its KIND and the size
 *     of what came back. Never an input, a path, a command, a table or a raw
 *     provider payload.
 *
 * COALESCING. Reply text and reasoning arrive in dozens of tiny pieces. Each is
 * buffered and written as one event every FLUSH_MS (or FLUSH_CHARS), so a
 * five-minute turn is hundreds of rows, not tens of thousands.
 */
import { redactAll } from "@/lib/secret-redaction";
import { departmentPrompt } from "@/lib/os/channel/identity";
import type { StreamEvent } from "@/lib/providers";
import { deskToolLabel } from "@/lib/os/desk/catalog";
import { bridgeToolLabel } from "@/lib/ai/bridge-turn";
import type { RunEvent } from "./types";

export const FLUSH_MS = 600;
export const FLUSH_CHARS = 700;
/** Most reasoning text one run keeps. */
export const THINKING_MAX_CHARS = 12_000;
/** Most reply text one run keeps (a reply is capped far below this by its token budget). */
export const REPLY_MAX_CHARS = 60_000;

const LABEL_MAX = 80;
const DETAIL_MAX = 120;
/** A step label that already says what it is doing ("Reading a file"). */
const PHRASED = /^(Reading|Searching|Running|Using|Preparing|Working|Looking|Checking)\b/;

/**
 * What a tool a PRODUCER names (the paired computer's app) is called in the
 * trail. `mcp__oasis__<tool>` is one of the department's own lookups
 * (lib/os/desk/catalog.ts deskToolLabel); the app reading the playbook folder
 * (Read, Glob, Grep) is "Checking the playbook"; nothing else shows a path, a
 * command or a pattern, only the kind.
 */
export function producerToolLabel(name: string): string {
  const oasis = /^mcp__oasis__(.+)$/.exec(name);
  if (oasis) return toolPhrase(deskToolLabel(oasis[1]));
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "read_file" || name === "glob" || name === "grep") {
    return "Checking the playbook";
  }
  return bridgeToolLabel(name);
}

/** What the trail calls a lookup while it runs: "Pipeline" becomes "Looking up Pipeline". */
export function toolPhrase(label: string): string {
  const clean = label.trim();
  if (!clean) return "Working on it";
  return PHRASED.test(clean) ? clean : `Looking up ${clean}`;
}

type Open = { id: string; label: string };

export class RunRecorder {
  private seq = 0;
  private text = "";
  private reasoning = "";
  private deltaBuf = "";
  private thinkBuf = "";
  private bufSince = 0;
  private tools = 0;
  private open: Open[] = [];
  private wrote = false;
  private usage: { input: number | null; output: number | null } | null = null;

  /**
   * `showThinking`: the person may see the model's reasoning (owner, admin, the
   * verified operator). For everyone else it is dropped here, before it is
   * written anywhere. Even for them it is kept only while the run works
   * (./store.ts finishRun deletes it): the saved conversation holds the answer
   * and the lookups, never the reasoning.
   */
  constructor(
    private readonly departmentLabel: string,
    private readonly clock: () => number = Date.now,
    private readonly showThinking = false,
  ) {}

  /** Everything the reply said so far (flushed or not). */
  get replyText(): string {
    return this.text + this.deltaBuf;
  }

  get tokens(): { input: number | null; output: number | null } {
    return this.usage ?? { input: null, output: null };
  }

  /** The next event in order, numbered. */
  event(kind: RunEvent["kind"], data: Record<string, unknown>): RunEvent {
    this.seq += 1;
    return { seq: this.seq, kind, data };
  }

  private scrub(text: string): string {
    return departmentPrompt(redactAll(text), this.departmentLabel);
  }

  /** Reply text arrives as it is written; reasoning is kept apart and never joins it. */
  private flushText(): RunEvent[] {
    const out: RunEvent[] = [];
    if (this.thinkBuf) {
      out.push(this.event("thinking", { text: this.thinkBuf }));
      this.thinkBuf = "";
    }
    if (this.deltaBuf) {
      out.push(this.event("delta", { text: this.deltaBuf }));
      this.text += this.deltaBuf;
      this.deltaBuf = "";
    }
    this.bufSince = 0;
    return out;
  }

  /** Write out what has been buffered for FLUSH_MS or more. Called by the executor's timer. */
  flushIfDue(): RunEvent[] {
    if (!this.deltaBuf && !this.thinkBuf) return [];
    return this.clock() - this.bufSince >= FLUSH_MS ? this.flushText() : [];
  }

  /** Write out everything buffered (a step began, or the turn ended). */
  flush(): RunEvent[] {
    return this.flushText();
  }

  /** The start of a run: the agent line, and what it is doing first. */
  start(agent: Record<string, unknown>): RunEvent[] {
    return [this.event("agent", agent), this.event("status", { phase: "thinking", label: "Thinking it through" })];
  }

  /** One event of the turn's stream, as the events to save. */
  push(ev: StreamEvent): RunEvent[] {
    const out: RunEvent[] = [];
    const due = () => {
      if (this.bufSince === 0) this.bufSince = this.clock();
      if (this.deltaBuf.length >= FLUSH_CHARS || this.thinkBuf.length >= FLUSH_CHARS || this.clock() - this.bufSince >= FLUSH_MS) {
        out.push(...this.flushText());
      }
    };
    switch (ev.type) {
      case "delta": {
        if (!this.wrote) {
          out.push(...this.flushText());
          out.push(this.event("status", { phase: "writing", label: "Writing the reply" }));
          this.wrote = true;
        }
        const room = REPLY_MAX_CHARS - this.text.length - this.deltaBuf.length;
        if (room > 0 && ev.text) {
          this.deltaBuf += redactAll(ev.text).slice(0, room);
          due();
        }
        break;
      }
      case "thinking": {
        if (!this.showThinking) break;
        const room = THINKING_MAX_CHARS - this.reasoning.length;
        if (room > 0 && ev.text) {
          const clean = this.scrub(ev.text).slice(0, room);
          this.reasoning += clean;
          this.thinkBuf += clean;
          due();
        }
        break;
      }
      case "tool": {
        out.push(...this.flushText());
        const label = toolPhrase(this.scrub(ev.label).slice(0, LABEL_MAX));
        if (ev.phase === "start") {
          this.tools += 1;
          const id = `t${this.tools}`;
          this.open.push({ id, label });
          out.push(this.event("tool", { id, phase: "start", label, ok: null }));
        } else {
          const at = this.open.findIndex((o) => o.label === label);
          const found = at >= 0 ? this.open.splice(at, 1)[0] : null;
          const id = found ? found.id : `t${++this.tools}`;
          const data: Record<string, unknown> = { id, phase: "done", label, ok: ev.ok };
          if (ev.detail) data.detail = this.scrub(ev.detail).slice(0, DETAIL_MAX);
          if (typeof ev.size === "number" && ev.size >= 0) data.size = Math.round(ev.size);
          out.push(this.event("tool", data));
        }
        break;
      }
      case "done":
        out.push(...this.flushText());
        this.usage = { input: ev.inputTokens, output: ev.outputTokens };
        out.push(this.event("usage", { input_tokens: ev.inputTokens, output_tokens: ev.outputTokens }));
        break;
      case "error":
        // The executor classifies the failure and writes the error event.
        break;
    }
    return out;
  }

  /** Steps still running when the turn ended are closed, so no step spins forever on a finished run. */
  closeOpenTools(ok: boolean): RunEvent[] {
    const out = this.open.splice(0).map((o) => this.event("tool", { id: o.id, phase: "done", label: o.label, ok }));
    return out;
  }
}
