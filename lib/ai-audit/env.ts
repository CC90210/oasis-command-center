/**
 * lib/ai-audit/env.ts — the configuration the Free AI Audit reads, in one place.
 *
 * AI_AUDIT_LINK_SECRET signs the client's private link and the PDF render
 * address. It is a Worker secret (config/cloudflare manifest), never in
 * source. Missing or shorter than 32 characters means "not configured": the
 * delivery gate refuses before anything is sent, and says so.
 */
import "server-only";
import { publicAppBaseUrl } from "@/lib/api-helpers";

export const LINK_SECRET_MIN_LENGTH = 32;
export const MODEL_SEARCH_SWITCH = "AI_AUDIT_MODEL_SEARCH_ENABLED" as const;

/**
 * Independent kill switch for every model-assisted Free AI Audit boundary.
 * Missing, misspelled and explicit "off" values all fail closed. Website
 * reading, PageSpeed, evidence rules, deterministic drafts, proposals and PDF
 * printing do not read this switch.
 */
export function aiAuditModelSearchEnabled(): boolean {
  return String(process.env[MODEL_SEARCH_SWITCH] || "").trim().toLowerCase() === "on";
}

export function aiAuditLinkSecret(): string | null {
  const v = (process.env.AI_AUDIT_LINK_SECRET || "").trim();
  return v.length >= LINK_SECRET_MIN_LENGTH ? v : null;
}

/** The canonical HTTPS origin client links are built on (never a request's Host header). */
export function aiAuditBaseUrl(): string {
  return publicAppBaseUrl().replace(/\/+$/, "");
}
