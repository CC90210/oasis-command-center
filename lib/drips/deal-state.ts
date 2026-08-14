/**
 * lib/drips/deal-state.ts — does this lead's DEAL still want to hear the stage
 * drip?
 *
 * WHY THIS EXISTS (Adon, 2026-08-11: "it's sending it to funded deals. We fund
 * them in the past. I don't understand what the misassociation with that is").
 *
 * SunBiz runs two boards over the same merchant, and they record progress in
 * two DIFFERENT fields:
 *
 *   Leads board          tenant_records(entity_type='lead').data.stage
 *   Applications board   tenant_records(entity_type='application').data.status
 *
 * The drip engine triggers on the LEAD stage. Nothing writes back to the lead
 * when the DEAL moves, so a merchant who signs is parked at
 * `signed_application` permanently — right through shopping, approval, funding,
 * decline and death. The bank-statement nag keeps chasing them the whole time,
 * and from the operator's seat that reads exactly as "why are we emailing a
 * deal we funded".
 *
 * Measured against production 2026-08-11. Of the 311 leads sitting in
 * `signed_application` (the nag's entire audience), the linked application
 * said:
 *
 *   177  declined        49  dead_file        41  follow_ups
 *    12  approved        10  funded            2  docs_out
 *
 * 291 of 311 were deals that had already left the funnel, and it had already
 * reached them: 148 emails to 117 declined merchants, 18 to 16 dead files, and
 * 4 emails to 3 FUNDED merchants — the most recent on the morning this was
 * reported.
 *
 * THIS IS A READ, NOT A WRITE-BACK, deliberately. Syncing lead.stage from
 * application.status would mass-mutate the board operators work from every day
 * and make the drip engine a second claimant on a field it does not own. This
 * instead asks the deal its state at enrolment and again at dispatch, and
 * declines to speak when the answer is "this deal is done".
 *
 * ALLOWLIST, NOT DENYLIST. Only a status that means "the deal is still open and
 * nobody has worked it yet" keeps the drip alive. An unrecognised status stops
 * the drip rather than permitting it, because the two error directions are not
 * symmetric: a drip wrongly silenced is a lead an operator still sees on the
 * board, and a drip wrongly sent is a funded merchant asking why we want their
 * bank statements again.
 *
 * Pure and free of "server-only" so the rule that decides what a real person
 * receives stays directly testable. The I/O lives in deal-state-store.ts.
 */

/** A lead with NO application row at all is open — that is the ordinary case
 *  for the whole top of the funnel and must never be gated. */
export type DealGate =
  | { open: true; reason: "no_application" | "open_status" | "stage_agrees" }
  | { open: false; status: string };

/**
 * The only status that keeps a stage drip alive.
 *
 * `application_in` is the deal that has landed and is not yet worked. Every
 * other value on the Applications board — shopping, approved, requested_docs,
 * docs_out, login, funded, follow_ups, declined, dead_file, default,
 * missing_info — means a human has taken the file somewhere, and a generic
 * stage nag is at best noise and at worst an embarrassment.
 */
const BUILTIN_OPEN = ["application_in"];

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Extendable without a deploy, because the Applications board's enum is
 *  operator-editable and a newly added "still open" column must not silently
 *  mute the funnel. */
export function openDealStatuses(): Set<string> {
  return new Set([...BUILTIN_OPEN, ...envList("DRIP_OPEN_DEAL_STATUSES")]);
}

/**
 * Application status -> the Leads-board stage that means the SAME THING.
 *
 * THIS IS WHAT KEEPS THE GATE FROM EATING THE RE-ENGAGEMENT DRIPS. Some
 * sequences deliberately target a terminal stage: "Declined — 1-month
 * check-back" exists precisely to talk to declined deals, and on 2026-08-11 it
 * had 61 runs pending. A naive "closed status => never send" rule would have
 * cancelled every one of them, silently deleting a whole re-engagement
 * programme while claiming to fix over-sending.
 *
 * So the gate does not ask "is this deal closed". It asks whether the deal's
 * status CONTRADICTS the lead's stage:
 *
 *   lead=declined            app=declined   -> open. The board already agrees;
 *                                              the sequence is aimed correctly.
 *   lead=signed_application  app=declined   -> CLOSED. Stale: the lead is parked
 *                                              in the funnel, the deal is not.
 *   lead=declined            app=funded     -> CLOSED. Also a contradiction, and
 *                                              funded is never a drip audience.
 *
 * THE TWO BOARDS SPELL SHARED STATES DIFFERENTLY, so this table is also a
 * naming bridge and not only a semantic one. The Applications board says
 * `follow_ups`; the Leads board says `follow_up`. Missing that single letter
 * would have silenced the follow-up programme this same change routes to
 * Bluerise — the gate would have called every one of those leads a closed deal
 * (Codex review, 2026-08-11, P1). Zero leads sat in that intersection on the
 * day it was found, which is exactly why it needed a reviewer rather than a
 * production count: it would have started biting the first time an operator
 * moved a follow-ups deal onto the follow-up stage.
 *
 * Statuses with no Leads-board equivalent (funded, approved, requested_docs,
 * docs_out, login, shopping) are absent on purpose: no lead stage can agree
 * with them, so they always close the gate.
 */
const STATUS_MEANS_STAGE: Record<string, string> = {
  declined: "declined",
  dead_file: "dead_file",
  default: "default",
  // Spelled differently on each board. See above.
  follow_ups: "follow_up",
  // Same name on both, and there is a live "Missing info - chase + book call"
  // sequence aimed at it. Without this the chase would gate itself closed on
  // precisely the deals it exists to chase.
  missing_info: "missing_info",
};

export type DealRow = {
  lead_id: string;
  /** `data.status` — the Applications board's live field. */
  status: unknown;
  /** `data.stage` — carried by the 2026-05 Monday.com import only. Consulted
   *  as a fallback so an imported deal is not read as statusless-and-open. */
  stage?: unknown;
  /** Row created_at. Decides WHICH application speaks for a lead. */
  created_at?: string | null;
};

function normalize(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function statusOf(row: DealRow): string {
  return normalize(row.status) || normalize(row.stage);
}

function timeOf(row: DealRow): number {
  const t = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Reduce one lead's application rows to the gate.
 *
 * THE MOST RECENT application decides, not "any closed application anywhere".
 * Re-applications are ordinary in this business: a merchant declined in March
 * and re-applying in August has two rows, and letting the March decline mute
 * the August deal would silence exactly the leads worth chasing. Ties and
 * undated rows fall back to the last row in the list, which is the caller's
 * query order.
 */
export function dealGateFor(rows: DealRow[], leadStage?: unknown): DealGate {
  if (!rows || rows.length === 0) return { open: true, reason: "no_application" };

  let latest: DealRow | null = null;
  for (const row of rows) {
    if (latest === null || timeOf(row) >= timeOf(latest)) latest = row;
  }
  const status = statusOf(latest as DealRow);

  // A row with no status at all is not evidence that the deal closed. Every
  // application created by this app leaves `status` unset until someone moves
  // it on the board, so reading blank as closed would mute the funnel entirely.
  if (!status) return { open: true, reason: "no_application" };

  if (openDealStatuses().has(status)) return { open: true, reason: "open_status" };

  // The deal has left the open funnel. That only makes the drip stale if the
  // lead's stage disagrees — see STATUS_MEANS_STAGE for why this is the whole
  // difference between fixing over-sending and deleting the re-engagement
  // drips.
  const agreesWith = STATUS_MEANS_STAGE[status];
  if (agreesWith && agreesWith === normalize(leadStage)) return { open: true, reason: "stage_agrees" };

  return { open: false, status };
}
