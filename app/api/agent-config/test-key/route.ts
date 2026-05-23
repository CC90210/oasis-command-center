/**
 * POST /api/agent-config/test-key
 *
 * Tests an API key against the provider before the operator saves it.
 * Hits the provider's lightest possible endpoint (usually `/models`) with
 * the supplied key, measures latency, and returns a structured result so
 * the AgentConfigEditor can render a green check / red X inline.
 *
 * Auth: session — same surface as the rest of /api/agent-config. We don't
 * accept anonymous probes because:
 *   1. each call costs a tiny amount on the upstream provider's quota
 *   2. unauthenticated key validation = oracle for credential stuffing
 *
 * Body:
 *   { provider: "anthropic" | "openai" | "google" | "openrouter" | "ollama",
 *     api_key: string }
 *
 * Returns:
 *   { ok: true,  provider_response_ms: 412 }
 *   { ok: false, code: "401" | "403" | "429" | "5xx" | "network" | "timeout",
 *     status: 401, message: "Invalid API key." }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { bad } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 8_000;

type Provider = "anthropic" | "openai" | "google" | "openrouter" | "ollama";

interface TestResult {
  ok: boolean;
  code?: string;
  status?: number;
  message?: string;
  provider_response_ms?: number;
}

const PROBE_URL: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  // Ollama is local — the key field for ollama actually holds the URL.
  // We probe that URL's /api/tags endpoint and accept the configured
  // URL as-is. validated inline below.
  ollama: "",
};

function buildHeaders(provider: Provider, key: string): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    };
  }
  if (provider === "google") {
    // Google AI uses ?key=<APIKEY> as a query param; no header.
    return { accept: "application/json" };
  }
  return {
    authorization: `Bearer ${key}`,
    accept: "application/json",
  };
}

function buildUrl(provider: Provider, key: string): string {
  if (provider === "ollama") {
    // Accept either http://host:port or http://host:port/v1 — strip /v1
    // since /api/tags is the unversioned endpoint that gives a fast probe.
    const trimmed = key.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${trimmed}/api/tags`;
  }
  const base = PROBE_URL[provider];
  if (!base) return "";
  if (provider === "google") {
    return `${base}?key=${encodeURIComponent(key)}&pageSize=1`;
  }
  return base;
}

function classify(status: number, body: string): { code: string; message: string } {
  if (status === 401) {
    return {
      code: "401",
      message: "Provider rejected the key (401). Double-check you copied it correctly — most provider dashboards let you generate a fresh key in 10 seconds.",
    };
  }
  if (status === 403) {
    return {
      code: "403",
      message: "Provider accepted the key but says it isn't authorized for this endpoint. Verify your account has API access enabled.",
    };
  }
  if (status === 429) {
    return {
      code: "429",
      message: "Provider rate-limited the test call. Wait a minute and try again — the key may still be valid.",
    };
  }
  if (status >= 500) {
    return {
      code: "5xx",
      message: `Provider returned ${status}. Often transient — try again in a minute.`,
    };
  }
  return {
    code: String(status),
    message: `Probe failed with HTTP ${status}. ${body.slice(0, 200)}`,
  };
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  let body: { provider?: unknown; api_key?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid_json");
  }

  const provider = String(body.provider || "").trim() as Provider;
  const key = String(body.api_key || "").trim();
  const validProviders: Provider[] = ["anthropic", "openai", "google", "openrouter", "ollama"];
  if (!validProviders.includes(provider)) return bad(400, "invalid_provider");
  if (!key) return bad(400, "missing_api_key");

  // Cheap shape sanity-check so the operator gets fast feedback when they
  // paste the wrong thing (e.g. an openai sk- key into the Anthropic
  // field). The full provider probe still runs after this — these are
  // just early hints.
  const shapeHint = inferShapeHint(provider, key);

  const url = buildUrl(provider, key);
  if (!url) {
    return NextResponse.json<TestResult>({
      ok: false,
      code: "config",
      message: `No probe URL configured for ${provider}.`,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(provider, key),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    clearTimeout(timer);
    if (res.ok) {
      return NextResponse.json<TestResult>({ ok: true, provider_response_ms: elapsed });
    }
    const bodyText = await res.text().catch(() => "");
    const { code, message } = classify(res.status, bodyText);
    const combined = shapeHint && code === "401" ? `${message} ${shapeHint}` : message;
    return NextResponse.json<TestResult>({
      ok: false,
      code,
      status: res.status,
      message: combined,
      provider_response_ms: elapsed,
    });
  } catch (e) {
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const isAbort = e instanceof Error && e.name === "AbortError";
    return NextResponse.json<TestResult>({
      ok: false,
      code: isAbort ? "timeout" : "network",
      message: isAbort
        ? `Probe timed out after ${TIMEOUT_MS / 1000}s. ${provider === "ollama" ? "Is Ollama running and the URL reachable?" : "Check your network connection."}`
        : `Couldn't reach ${provider}. ${e instanceof Error ? e.message : "Network error."}`,
      provider_response_ms: elapsed,
    });
  }
}

function inferShapeHint(provider: Provider, key: string): string {
  // Quick paste-error detection. Returns a single sentence to append to
  // a 401 message when the key obviously doesn't match the provider's
  // shape — saves the operator a confused round-trip.
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return "Anthropic keys start with `sk-ant-`.";
  }
  if (provider === "openai" && !(key.startsWith("sk-") || key.startsWith("sk-proj-"))) {
    return "OpenAI keys start with `sk-` or `sk-proj-`.";
  }
  if (provider === "openrouter" && !key.startsWith("sk-or-")) {
    return "OpenRouter keys start with `sk-or-`.";
  }
  if (provider === "google" && !(key.startsWith("AIza") || key.startsWith("AIzaSy"))) {
    return "Google AI Studio keys start with `AIza`.";
  }
  if (provider === "ollama" && !key.startsWith("http")) {
    return "Ollama field takes a URL like `http://localhost:11434`, not an API key.";
  }
  return "";
}
