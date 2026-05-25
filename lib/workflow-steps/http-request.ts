/**
 * http-request step — V6.9.2.
 *
 * Fires an outbound HTTP request and returns the response. Used for
 * webhooks to external systems (Zapier, Slack, custom backends).
 *
 * Input shape:
 *   { method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",
 *     url: string,
 *     headers?: Record<string,string>,
 *     body?: unknown,
 *     timeout_ms?: number }   // default 10000, max 30000
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type HttpRequestInput = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
};

const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const handler: WorkflowStep = {
  type: "http-request",
  async execute(rawInput: unknown, _ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as HttpRequestInput;
    if (!input.url || typeof input.url !== "string") {
      return { status: "failed", error: "missing_url" };
    }
    try {
      new URL(input.url);
    } catch {
      return { status: "failed", error: "invalid_url" };
    }
    const method = input.method ?? "GET";
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(input.url, {
        method,
        headers: input.headers,
        body: input.body !== undefined && method !== "GET" ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      }
      return {
        status: "complete",
        output: { status_code: res.status, body: parsed },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", error: `http_error: ${message}` };
    } finally {
      clearTimeout(t);
    }
  },
};

export default handler;
