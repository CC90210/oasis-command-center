/**
 * lib/automations/guided/api-types.ts - what the guided-automation HTTP routes say, and the client the wizard uses.
 *
 * The routes (app/api/automations/guided/*) derive tenant, user and department rights from the session.
 * Nothing here is ever read from a request body except the payload being validated. The wizard never
 * talks to fetch directly: it takes a `GuidedApi`, so its tests pass a fake and the page passes
 * `guidedApi` (a thin fetch wrapper at the bottom).
 *
 * PURE types plus one small client. No server imports.
 */
import type { DepartmentKey } from "@/lib/os/types";
import type { GuidedErrorCode, GuidedPayload } from "./types";

/** Where a person goes to fix something: a Connections-hub link from lib/setup-links.ts, never a guessed URL. */
export type RepairLink = { label: string; href: string };

export type ConnectionState = "connected" | "attention" | "not_connected" | "unknown";

/** One app a template needs, as Settings > Connections shows it. */
export type ConnectionFact = { slug: string; label: string; state: ConnectionState; repair: RepairLink | null };

/** Whether "Cloud" can run right now, in the words the page shows. */
export type CloudState = { ready: boolean; reason: string | null; repair: RepairLink | null };

/** What the wizard needs to know about this workspace and this person, read once when it opens. */
export type GuidedContextView = {
  /** May this person use the Finance department's template (company financials)? */
  companyFinancials: boolean;
  /** The departments this person may build for. */
  departments: DepartmentKey[];
  cloud: CloudState;
  /** The apps any template needs, with their live state. */
  connections: ConnectionFact[];
};

/** Why an automation cannot be turned on (or ran badly) right now, with the fix. */
export type Problem = { code: string; message: string; repair: RepairLink | null };

export type GuidedStatus = "paused" | "on" | "needs_attention";

export type LastRunView = {
  /** ISO time the run started. */
  at: string;
  /** "done" | "failed" | "missed" | "cancelled" | "running" | "queued" */
  status: string;
  /** One plain sentence: what it found, or why it did not run. */
  summary: string;
  /** The run id: the receipt a person can open. */
  receiptId: string | null;
  /** Whether this was a preview (Test now) and not a scheduled run. */
  preview: boolean;
};

/** One saved guided automation as the list and the wizard show it. */
export type GuidedAutomationView = {
  id: string;
  name: string;
  department: DepartmentKey;
  templateId: string;
  templateTitle: string;
  status: GuidedStatus;
  payload: GuidedPayload;
  /** "Weekdays at 7:30 AM Toronto time". */
  scheduleSentence: string;
  /** The next runs as ISO instants (up to 3), from the one schedule library. Empty when paused or manual. */
  nextRuns: string[];
  lastRun: LastRunView | null;
  /** Empty when it can be turned on and is healthy. */
  problems: Problem[];
};

export type PreviewDraft = { to: string; subject: string; body: string };

/** The result of "Test now": a preview run. It never sends, posts, charges or files an approval. */
export type TestResult = {
  runId: string;
  status: "done" | "failed" | "cancelled";
  /** The text the run produced (a digest, or its summary of what it would draft). */
  finalText: string;
  /** What it WOULD have drafted, when the output is email drafts. */
  wouldDraft: PreviewDraft[];
  /** A plain sentence when it failed. */
  failure: string | null;
};

export type ApiFailure = {
  ok: false;
  error: GuidedErrorCode | "unauthorized" | "forbidden" | "not_found" | "cloud_unavailable" | "connection_missing" | "rate_limited" | "server_error" | string;
  message: string;
  /** The input or section the message is about, for inline display. */
  field?: string;
  repair?: RepairLink | null;
  problems?: Problem[];
};

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

export interface GuidedApi {
  /** The workspace and person facts the wizard needs. */
  context(): Promise<ApiResult<{ context: GuidedContextView }>>;
  list(): Promise<ApiResult<{ items: GuidedAutomationView[] }>>;
  /** Save a NEW automation, always paused. */
  create(input: { name: string; payload: unknown }): Promise<ApiResult<{ item: GuidedAutomationView }>>;
  /** Change a saved automation. Changing a turned-on one pauses it: it must be tested and turned on again. */
  update(id: string, input: { name?: string; payload?: unknown }): Promise<ApiResult<{ item: GuidedAutomationView }>>;
  /** Run it once, preview only. */
  test(id: string): Promise<ApiResult<{ result: TestResult }>>;
  /** Turn it on. Revalidated on the server: seat, department, connections, tools, Cloud. */
  activate(id: string): Promise<ApiResult<{ item: GuidedAutomationView }>>;
  pause(id: string): Promise<ApiResult<{ item: GuidedAutomationView }>>;
  remove(id: string): Promise<ApiResult<Record<string, never>>>;
}

// ── the browser's client ───────────────────────────────────────────────

const BASE = "/api/automations/guided";

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as (ApiResult<T> & Record<string, unknown>) | null;
    if (body && typeof body === "object" && "ok" in body) return body;
    return { ok: false, error: "server_error", message: "Something went wrong on our side. Nothing was changed. Try again in a moment." };
  } catch {
    return { ok: false, error: "server_error", message: "We could not reach the server. Check your connection and try again." };
  }
}

const post = (path: string, body?: unknown) => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }) satisfies RequestInit;

/** The page's GuidedApi: the routes under /api/automations/guided. */
export const guidedApi: GuidedApi = {
  context: () => call("/context"),
  list: () => call(""),
  create: (input) => call("", post("", input)),
  update: (id, input) => call(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  test: (id) => call(`/${encodeURIComponent(id)}/test`, post("")),
  activate: (id) => call(`/${encodeURIComponent(id)}/activate`, post("")),
  pause: (id) => call(`/${encodeURIComponent(id)}/pause`, post("")),
  remove: (id) => call(`/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
