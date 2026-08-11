/**
 * COMPOSITION ROOT — portal reactions to a tenant-record stage transition.
 *
 * WHY THIS FILE EXISTS
 * `lib/manifest/data.ts` is the generic multi-tenant record layer behind every
 * `/t/<slug>/` surface. It used to import `@/lib/drips/stage-cancel` directly,
 * so EVERY tenant — including a future real-estate portal — routed its stage
 * writes through SunBiz's lending drip engine. `tests/portal-boundaries.test.ts`
 * caught it on its first run, 2026-08-03.
 *
 * Something has to know about all the portals. The fix is not to pretend
 * otherwise; it is to make that knowledge live in exactly ONE clearly-marked
 * file instead of leaking into shared infrastructure. That is this file, and it
 * is declared in `COMPOSITION_ROOTS` so the boundary rule permits it here and
 * nowhere else.
 *
 * WHY A STATIC IMPORT AND NOT A REGISTRY
 * A register-yourself pattern (`registerHook()` at module load) would be more
 * elegant and is the wrong choice here. Next.js builds a module graph per route;
 * a handler nobody statically imports is silently absent from that bundle. The
 * failure mode would be "drips stop being cancelled in some routes and not
 * others", i.e. merchants texted after they convert, with nothing to notice it.
 * A static import list cannot fail that way — if it compiles, it is wired.
 *
 * ADDING A PORTAL'S HOOK
 * Import it here and add it to HOOKS. That import is legal because this is a
 * composition root. Anywhere else it would fail the boundary test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelStaleDripRunsForLead } from "@/lib/drips/stage-cancel";
import { BOARD_EXIT_FIELD } from "@/lib/leads/board-visibility";
import type { PortalId } from "./registry";

type Db = SupabaseClient;

export type RecordTransition = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type StageTransitionContext = {
  db: Db;
  tenantId: string;
  /** Manifest entity name, e.g. "lead" | "application". */
  entity: string;
  /** The record that just changed. */
  recordId: string;
  /** The record's data payload after the write. */
  data: Record<string, unknown>;
  transitions: RecordTransition[];
};

/** A cancellation the SunBiz drip engine should perform. */
export type DripCancellation = {
  leadId: string;
  /** null means "cancel every stage-triggered run" (the shopped-out case). */
  newStage: string | null;
  reason: string;
};

/**
 * PURE. Decides which drip cancellations a transition implies.
 *
 * Extracted verbatim from the logic previously inline in data.ts updateRecord,
 * so behaviour is identical: same branch conditions, same reason strings, same
 * lead-vs-application exclusivity. Pure so it can be asserted without a DB —
 * same convention as `selectStaleRunIds` in lib/drips/stage-cancel.ts.
 */
export function planDripCancellations(input: {
  entity: string;
  recordId: string;
  data: Record<string, unknown>;
  transitions: RecordTransition[];
}): DripCancellation[] {
  const { entity, recordId, data, transitions } = input;
  if (!transitions || transitions.length === 0) return [];

  if (entity === "lead") {
    // A board exit outranks a stage move. Once a lead is transferred to the
    // Applications board NO stage-triggered sequence may speak to it, so this
    // cancels ALL of them (newStage: null) rather than the "keep the new
    // stage's runs" semantics a stage move gets. Checked first because a
    // transfer can arrive in the same write as a stage change, and the
    // narrower stage rule would leave the new stage's runs alive on a lead
    // that is no longer on the board.
    if (transitions.some((t) => t.field === BOARD_EXIT_FIELD)) {
      return [
        {
          leadId: recordId,
          newStage: null,
          reason: "off_board_eager: lead transferred to the Applications board",
        },
      ];
    }
    const stageT = transitions.find(
      (t) => t.field === "stage" && typeof (t as { to: unknown }).to === "string",
    );
    if (!stageT) return [];
    const to = String(stageT.to);
    return [
      {
        leadId: recordId,
        newStage: to,
        reason: `stage_changed_eager: lead moved to ${to}`,
      },
    ];
  }

  // `else if` in the original: a lead never falls through to this branch.
  if (entity === "application") {
    const shopped = transitions.some((t) => t.field === "status" && t.to === "shopping");
    const leadId = typeof data.lead_id === "string" ? String(data.lead_id) : null;
    if (shopped && leadId) {
      return [
        {
          leadId,
          newStage: null,
          reason: "shopped_out_eager: application moved to shopping",
        },
      ];
    }
  }

  return [];
}

type StageTransitionHook = {
  portal: PortalId;
  name: string;
  handle: (ctx: StageTransitionContext) => Promise<void>;
};

/**
 * SunBiz: flush stale stage-triggered drip runs the moment a lead moves, so a
 * fast-moving lead's intermediate-stage sequence never fires. The debounce half
 * of the 2026-07-22 stage-buffer fix.
 *
 * Fail-soft is preserved: cancelStaleDripRunsForLead never throws, and a drip
 * hiccup must not fail the stage write. The dispatcher's stage/shopped rechecks
 * remain the backstop.
 */
const sunbizDripCancel: StageTransitionHook = {
  portal: "sunbiz",
  name: "drip-stage-cancel",
  async handle(ctx) {
    const plan = planDripCancellations({
      entity: ctx.entity,
      recordId: ctx.recordId,
      data: ctx.data,
      transitions: ctx.transitions,
    });
    for (const c of plan) {
      await cancelStaleDripRunsForLead(ctx.db, ctx.tenantId, c.leadId, c.newStage, c.reason);
    }
  },
};

/** Every portal reaction to a stage transition. Static on purpose — see header. */
const HOOKS: StageTransitionHook[] = [sunbizDripCancel];

/**
 * Run every portal's stage-transition reaction.
 *
 * Fail-soft per hook: one portal's handler throwing must not fail the stage
 * write, nor prevent another portal's handler from running. This is the same
 * guarantee the inline call had, now held for N portals instead of one.
 */
export async function runStageTransitionHooks(ctx: StageTransitionContext): Promise<void> {
  if (!ctx.transitions || ctx.transitions.length === 0) return;
  for (const hook of HOOKS) {
    try {
      await hook.handle(ctx);
    } catch (err) {
      // Never rethrow. A stage write must not fail because a portal's reaction did.
      console.warn(
        `[stage-hooks] ${hook.portal}/${hook.name} failed`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Introspection for the boundary test — asserts the wiring is not empty. */
export const REGISTERED_STAGE_HOOKS: ReadonlyArray<{ portal: PortalId; name: string }> = HOOKS.map(
  (h) => ({ portal: h.portal, name: h.name }),
);
