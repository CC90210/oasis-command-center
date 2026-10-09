/**
 * lib/tools/types.ts - the shapes the Tools section receives from the server
 * (the catalog the page passes in, and each run the routes answer).
 *
 * PURE, types only: the client grid imports them without pulling a server
 * module into the browser.
 */
import type { ToolField, ToolKey } from "@/lib/tools/registry";

export type ToolJobStatus = "queued" | "claimed" | "running" | "done" | "failed";

/** One run as GET /api/tools/jobs and POST /api/tools/run answer it. */
export type JobView = {
  id: string;
  tool_key: string;
  status: ToolJobStatus;
  stage: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** The link that was run, or the first 80 characters of the text. */
  input_summary: string;
  /** The tool's result, when done. */
  result: unknown;
  /** The failure's code and its plain line (lib/tools/errors.ts), when failed. */
  error_code: string | null;
  error_message: string | null;
  /** The Library asset a download made, when done. */
  asset_id: string | null;
};

export type CatalogToolState = "ready" | "needs_ai_account" | "ai_account_unreadable";

export type CatalogTool = {
  key: ToolKey;
  title: string;
  description: string;
  runLabel: string;
  runsOn: "worker" | "runner";
  fields: ToolField[];
  state: CatalogToolState;
  /** The runner that will do the work (runner tools only). lastSeenAt is ISO; the grid turns it into "seen n min ago" on the viewer's clock. */
  runner?: { label: string; lastSeenAt: string };
};

export type ToolCatalog = { installed: false } | { installed: true; tools: CatalogTool[] };
