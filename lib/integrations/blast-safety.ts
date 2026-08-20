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
import { stripDashes, matchLenderNames, matchPositioningPhrases } from "./blast-safety-core";

export { stripDashes, matchLenderNames, matchPositioningPhrases } from "./blast-safety-core";

/**
 * Which of the tenant's lender names appear in `text`. `checked` is false if
 * the lookup failed — callers must treat that as fail-closed.
 */
/**
 * The tenant's lender names. Exported so a caller that must check MANY texts
 * against the same list (per-recipient bulk copy, where merge values differ
 * per row) can pay for the lookup once and then use the pure matcher, instead
 * of either running a query per recipient or skipping the check.
 *
 * `checked: false` means the lookup could not run. Callers MUST treat that as
 * fail-closed and block, never as "no lender names found".
 */
export async function getTenantLenderNames(
  tenantId: string,
): Promise<{ names: string[]; checked: boolean }> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lender")
      .limit(2000);
    if (r.error) return { names: [], checked: false };
    const names = (r.data || [])
      .map((row) => (typeof (row as { data?: Record<string, unknown> }).data?.name === "string" ? ((row as { data: Record<string, unknown> }).data.name as string) : ""))
      .filter(Boolean);
    return { names, checked: true };
  } catch {
    return { names: [], checked: false };
  }
}

async function findLenderNamesInText(
  tenantId: string,
  text: string,
): Promise<{ hits: string[]; checked: boolean }> {
  const { names, checked } = await getTenantLenderNames(tenantId);
  if (!checked) return { hits: [], checked: false };
  return { hits: matchLenderNames(text, names), checked: true };
}

export type BlastSanitizeResult =
  | { ok: true; cleaned: string }
  | {
      ok: false;
      reason: "lender_name" | "positioning" | "safety_check_failed";
      message: string;
      lenderHits?: string[];
      positioningHits?: string[];
    };

/**
 * Sanitize a blast message before send. Strips em/en dashes (auto), then runs
 * the lender-name hard guard (fail-closed). Returns the cleaned message on
 * success, or a block with a clear operator-facing reason.
 */
export async function sanitizeBlastMessage(
  tenantId: string,
  message: string,
  opts: { checkPositioning?: boolean } = {},
): Promise<BlastSanitizeResult> {
  const cleaned = stripDashes(message);
  // Direct-lender POSITIONING guard (hardwired 2026-07-10). Static + in-process,
  // so it's fail-closed by construction — it can never silently "pass" on a DB
  // error the way the lender-name lookup can. SunBiz is the DIRECT funder; a
  // broker-positioning phrase must never reach a merchant. Enforced on paths
  // whose template copy is already direct-lender-clean (the drip engine passes
  // checkPositioning:true); other callers opt in as their legacy copy is
  // rewritten, so turning this on can't retro-block a live rep send mid-cleanup.
  if (opts.checkPositioning) {
    const positioningHits = matchPositioningPhrases(cleaned);
    if (positioningHits.length > 0) {
      return {
        ok: false,
        reason: "positioning",
        message: `SunBiz is the DIRECT funder — remove broker-positioning phrase${positioningHits.length > 1 ? "s" : ""}: ${positioningHits.join(", ")}. We fund/underwrite/offer ourselves.`,
        positioningHits,
      };
    }
  }
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
