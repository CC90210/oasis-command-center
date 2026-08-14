/**
 * lib/drips/brand-routing.ts — which brand speaks to this merchant, and when it
 * hands off to the other one.
 *
 * Pure and free of "server-only" so the rules that decide what a real person
 * receives are directly testable. All I/O lives in brand-store.ts.
 *
 * THE RULE (Adon, 2026-08-05): whichever company the merchant ALREADY KNOWS goes
 * first; the other company is the follow-up act. A lead that came through the
 * SunBiz funnel hears from SunBiz, then Bluerise if it goes quiet. A cold sourced
 * lead that knows nobody hears from Bluerise, then SunBiz.
 *
 * TWO GUARDS THAT ARE NOT NEGOTIABLE:
 *
 *   1. At most ONE switch per lead. Alternating brands at one merchant is the
 *      behaviour that produces spam complaints, which is the exact outcome the
 *      split exists to avoid.
 *   2. Never switch a lead that opted out or replied STOP. Not responding is
 *      fair game for the other brand; asking to stop is final for BOTH. The
 *      suppression list is brand-blind and tenant-keyed by design, and both
 *      brands sit on one tenant precisely so an opt-out to either stops both.
 *
 * DIRECTION OF THE SAFE DEFAULT: when anything is unknown, resolve to SunBiz.
 * A cold lead mis-sent as SunBiz costs reputation on an established domain that
 * can absorb it. A warm merchant mis-sent as Bluerise is both a confusing first
 * impression and a complaint on the domain that has no reputation buffer.
 */

import { resolveBrandKey, type BrandKey } from "@/lib/email/brands";

// ---------------------------------------------------------------------------
// Source classification
//
// Seeded from the sources that ACTUALLY exist in production, measured
// 2026-08-05 across 1,194 leads:
//
//   public_form              560   inbound to a SunBiz form        -> warm
//   MCA WEBFORMS MAY 25-29   407   a purchased batch               -> cold
//   cold_call_tracker        119   dialled from a sourced list     -> cold
//   breeze_uw_sheet           83   live-sub sourced                -> cold
//   dropped_application       16   started a SunBiz application    -> warm
//
// Both lists are env-extendable because purchased list names change with every
// batch, and a new list must not require a deploy. Unrecognised sources are
// UNKNOWN rather than silently cold: the caller applies the safe default and the
// store logs the unrecognised value so the gap surfaces instead of sitting
// silent.
// ---------------------------------------------------------------------------

export type SourceClass = "warm" | "cold" | "unknown";

const BUILTIN_WARM = ["public_form", "dropped_application", "inbound_form", "referral", "website"];

const BUILTIN_COLD = [
  "cold_call_tracker",
  "breeze_uw_sheet",
  "mca webforms may 25-29",
  "live_subs",
  "livesubs",
  "bd_live_subs",
  "purchased",
  "purchased_list",
  "cold_list",
  "cold_outreach",
  "scraped",
  "vendor",
  "tps",
];

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalize(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * Does this lead source indicate a prior relationship with SunBiz, no
 * relationship at all, or something we have not seen before?
 */
export function classifyLeadSource(raw: unknown): SourceClass {
  const s = normalize(raw);
  if (!s) return "unknown";
  // Operator overrides win, so a mislabelled batch can be corrected without a
  // deploy. Cold is checked first: if a value somehow appears in both lists,
  // treating it as cold keeps the volume off the established domain, which is
  // the conservative reading of an operator's intent when they add a name.
  if (envList("DRIP_COLD_LEAD_SOURCES").includes(s)) return "cold";
  if (envList("DRIP_WARM_LEAD_SOURCES").includes(s)) return "warm";
  if (BUILTIN_COLD.includes(s)) return "cold";
  if (BUILTIN_WARM.includes(s)) return "warm";
  return "unknown";
}

export function otherBrand(b: BrandKey): BrandKey {
  return b === "sunbiz" ? "bluerise" : "sunbiz";
}

// ---------------------------------------------------------------------------
// Stage → mailbox (Adon, 2026-08-11)
//
// "For the submissions email you will be sending out the viewed AND signed.
//  The Bluerise email will be used for the follow-ups tab."
//
// This is a DIFFERENT question from the source-based assignment below, and it
// wins. Source classification answers "which company does this merchant already
// know"; this answers "which desk is speaking right now". A merchant in the
// application funnel is mid-transaction with SunBiz submissions@ — the mailbox
// their application, their signature request and their document links already
// came from — and hearing the bank-statement chase from a second company would
// read as a phishing attempt. Follow-ups are the re-engagement desk, and that
// is Bluerise's job.
//
// CONSEQUENCE WORTH NAMING: because this keys on the CURRENT stage rather than
// on a sticky per-lead stamp, a lead that moves follow_up -> viewed_application
// changes voice. That is intended here (the desks are genuinely different) but
// it does relax the "at most one switch per lead" guard below for these stages.
// The guard still governs the source-based handoff for every other stage.
//
// Env-overridable so a stage can be moved between mailboxes without a deploy —
// the Leads board's columns are operator-editable and a new one must not
// require a release to route.
// ---------------------------------------------------------------------------

const BUILTIN_STAGE_BRAND: Record<string, BrandKey> = {
  // The application funnel. One continuous transaction, one mailbox.
  sent_application: "sunbiz",
  viewed_application: "sunbiz",
  signed_application: "sunbiz",
  // The follow-ups desk.
  follow_up: "bluerise",
};

/**
 * The mailbox this stage speaks from, or null when the stage has no rule and
 * the source-based assignment should decide.
 *
 * Returns null rather than a default on purpose: "no opinion" and "SunBiz" are
 * different answers, and collapsing them here would silently override the
 * stamped brand for every stage that is not listed.
 */
export function brandForStage(stage: unknown): BrandKey | null {
  const s = normalize(stage);
  if (!s) return null;
  // Operator overrides win, and are checked before the built-ins so a stage can
  // be MOVED rather than only added.
  if (envList("DRIP_BLUERISE_STAGES").includes(s)) return "bluerise";
  if (envList("DRIP_SUNBIZ_STAGES").includes(s)) return "sunbiz";
  return BUILTIN_STAGE_BRAND[s] ?? null;
}

// ---------------------------------------------------------------------------
// Initial assignment
// ---------------------------------------------------------------------------

export type InitialBrandArgs = {
  /** Already-stamped brand. Sticky: wins over every heuristic below. */
  existingBrand?: unknown;
  /**
   * Lead creation time in ms. NOTE: this comes from the tenant_records ROW
   * (`row.created_at`), not from `data.created_at` — measured 2026-08-05, zero
   * of 1,194 leads carry a created_at inside `data`.
   */
  createdAtMs?: number;
  /** `data.source`. Present on 1,190 of 1,194 leads. */
  source?: unknown;
  /** Leads created before this instant predate Bluerise and know SunBiz. */
  blueriseLaunchAtMs: number;
};


export function resolveInitialBrand(args: InitialBrandArgs): BrandKey {
  // 1. Sticky. Re-deriving on every dispatch run would let a lead flip brand
  //    mid-sequence, which is the alternating behaviour guard 1 forbids.
  const existing = normalize(args.existingBrand);
  if (existing === "sunbiz" || existing === "bluerise") return existing as BrandKey;

  // 2. Everything that predates Bluerise knows SunBiz, whatever its source says.
  //    An absent or unparseable timestamp is treated as pre-launch: reading
  //    absence as "just arrived" would push the entire back catalogue onto a
  //    domain with no reputation the first time this deploys.
  const created = args.createdAtMs;
  if (typeof created !== "number" || !Number.isFinite(created) || created < args.blueriseLaunchAtMs) {
    return "sunbiz";
  }

  // 3. New lead: the source decides. Unknown falls back to the established brand.
  return classifyLeadSource(args.source) === "cold" ? "bluerise" : "sunbiz";
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

export type SwitchArgs = {
  currentBrand: BrandKey;
  brandAssignedAtMs: number;
  /** Most recent INBOUND message from this merchant, or null. */
  lastInboundAtMs: number | null;
  switchCount: number;
  suppressed: boolean;
  optedOut: boolean;
  nowMs: number;
  silenceDays: number;
};

export type SwitchDecision =
  | { switch: false; reason: string }
  | { switch: true; to: BrandKey };

export function shouldSwitchBrand(a: SwitchArgs): SwitchDecision {
  // Guard 2, first and unconditional. No amount of silence unlocks a switch for
  // someone who asked to stop.
  if (a.optedOut) return { switch: false, reason: "opted_out" };
  if (a.suppressed) return { switch: false, reason: "suppressed" };

  // Guard 1.
  if (a.switchCount >= 1) return { switch: false, reason: "already_switched" };

  // A non-positive window would make every lead instantly switchable, so clamp
  // to at least one day rather than trusting the caller's env parse.
  const silenceMs = Math.max(1, a.silenceDays) * 86_400_000;

  // A merchant who replied is warm. Never hand a live conversation to a
  // different company.
  if (a.lastInboundAtMs !== null && a.nowMs - a.lastInboundAtMs < silenceMs) {
    return { switch: false, reason: "recent_inbound" };
  }

  // Silence is measured from the LATER of assignment and their last reply, so a
  // merchant who answered and then went quiet gets the full window again rather
  // than being switched on the strength of an old assignment date.
  const since = Math.max(a.brandAssignedAtMs, a.lastInboundAtMs ?? 0);
  if (a.nowMs - since < silenceMs) return { switch: false, reason: "not_silent_long_enough" };

  return { switch: true, to: otherBrand(resolveBrandKey(a.currentBrand)) };
}
