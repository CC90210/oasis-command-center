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

/**
 * SSRF guard (V6.9.5 hotfix). Once operator-editable workflows ship in
 * V6.9.4.x, http-request inputs become attacker-controlled. Block:
 *   - non-http(s) protocols
 *   - localhost / loopback
 *   - private IPv4 ranges (10/8, 172.16/12, 192.168/16)
 *   - link-local + cloud metadata endpoints (169.254.x.x, incl. 169.254.169.254)
 *   - IPv6 loopback + link-local
 * Hostnames are checked verbatim; DNS rebinding is out of scope (the worker
 * runtime would need its own DNS pin to defend against that).
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "ip6-localhost",
  "ip6-loopback",
]);
const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

export function isUrlSafeForWorkflowRequest(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `blocked_protocol: ${parsed.protocol}` };
  }
  // Node's URL.hostname keeps the brackets on bracketed IPv6 literals
  // ("http://[::1]/" → "[::1]"); strip them for the host check.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `blocked_hostname: ${host}` };
  }
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(host)) {
      return { ok: false, reason: `blocked_private_ip: ${host}` };
    }
  }
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7) — coarse check
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return { ok: false, reason: `blocked_ipv6_private: ${host}` };
  }
  return { ok: true };
}

const handler: WorkflowStep = {
  type: "http-request",
  async execute(rawInput: unknown, _ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as HttpRequestInput;
    if (!input.url || typeof input.url !== "string") {
      return { status: "failed", error: "missing_url" };
    }
    const safety = isUrlSafeForWorkflowRequest(input.url);
    if (!safety.ok) {
      return { status: "failed", error: `ssrf_blocked: ${safety.reason}` };
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
