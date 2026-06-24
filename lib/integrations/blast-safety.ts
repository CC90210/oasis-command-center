/**
 * lib/integrations/blast-safety.ts — merchant-facing safety guard for outbound
 * text BLASTS (TT campaigns). Two load-bearing rules:
 *   1. NEVER name a real lender/funder in merchant-facing copy (SunBiz frames
 *      itself AS the funder). Hard guard: if any of the tenant's lender names
 *      appears in the message, BLOCK the send — don't silently mangle it.
 *   2. No em dashes (an AI tell) — auto-replaced with hyphens (cosmetic).
 *
 * The lender list is read from the tenant's own `lender` records (never
 * hardcoded — per the lender-verification architecture). FAIL-CLOSED: if the
 * lender lookup can't run, we block rather than risk a leak.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { stripDashes, matchLenderNames } from "./blast-safety-core";

export { stripDashes, matchLenderNames } from "./blast-safety-core";

/**
 * Which of the tenant's lender names appear in `text`. `checked` is false if
 * the lookup failed — callers must treat that as fail-closed.
 */
async function findLenderNamesInText(
  tenantId: string,
  text: string,
): Promise<{ hits: string[]; checked: boolean }> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lender")
      .limit(2000);
    if (r.error) return { hits: [], checked: false };
    const names = (r.data || [])
      .map((row) => (typeof (row as { data?: Record<string, unknown> }).data?.name === "string" ? ((row as { data: Record<string, unknown> }).data.name as string) : ""))
      .filter(Boolean);
    return { hits: matchLenderNames(text, names), checked: true };
  } catch {
    return { hits: [], checked: false };
  }
}

export type BlastSanitizeResult =
  | { ok: true; cleaned: string }
  | { ok: false; reason: "lender_name" | "safety_check_failed"; message: string; lenderHits?: string[] };

/**
 * Sanitize a blast message before send. Strips em/en dashes (auto), then runs
 * the lender-name hard guard (fail-closed). Returns the cleaned message on
 * success, or a block with a clear operator-facing reason.
 */
export async function sanitizeBlastMessage(
  tenantId: string,
  message: string,
): Promise<BlastSanitizeResult> {
  const cleaned = stripDashes(message);
  const { hits, checked } = await findLenderNamesInText(tenantId, cleaned);
  if (!checked) {
    return {
      ok: false,
      reason: "safety_check_failed",
      message: "Couldn't verify the message is lender-name-safe right now. Try again in a moment.",
    };
  }
  if (hits.length > 0) {
    return {
      ok: false,
      reason: "lender_name",
      message: `Remove the lender name${hits.length > 1 ? "s" : ""} from the message before sending: ${hits.join(", ")}. SunBiz is the funder in all merchant-facing copy.`,
      lenderHits: hits,
    };
  }
  return { ok: true, cleaned };
}
