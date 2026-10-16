/**
 * lib/offer-pages/confirm-publish.ts - the browser half of Confirm & publish
 * (/forms/publish): what each offer still needs from the owner, the request
 * each tick turns into, and the order Save and Publish call the routes in.
 *
 * CC 2026-10-16: one screen, no manual video uploads. Six offer pages sat as
 * drafts behind six builders, each with its own ticks. This screen asks for
 * every sign-off of every page in one pass, then publishes.
 *
 * NO SECOND WRITE PATH. Every action is a call to a route the builder and the
 * Library already use, with the body they already send:
 *
 *   approve the proposed video   PATCH /api/founders/marketing/assets/[id]
 *                                { status: "approved", from: "in_review" }
 *                                (the Library's own verdict, with its own
 *                                founders gate and review record;
 *                                components/founders/AssetActions). `from`:
 *                                only while it is still in review, so a
 *                                verdict reached in the Library since this
 *                                screen loaded stands.
 *   save the ticks               PUT /api/forms/[id]/offer
 *                                { draft, version, confirm_claims, unconfirm_claims }
 *                                (OfferBuilder's draft save, compare-and-swap
 *                                on `version`)
 *   publish                      POST /api/forms/[id]/offer/publish
 *                                { version, enable_form } with the version that
 *                                save just returned. enable_form switches a
 *                                switched-off form on in the SAME transaction
 *                                as the publish (store.ts publishDraft), so the
 *                                page and its form change together or not at
 *                                all, even when the response is lost.
 *
 * WHO CONFIRMED IT. A ticked price, guarantee or video goes up as the builder
 * sends it: pendingConfirmation() (components/offer-pages/builder/fields.tsx,
 * passed in as `pending`), never a name or a time this screen chose. The
 * server stamps it with the saving owner and the time
 * (claims.ts stampConfirmations). A claim tick is a sentence hash only; the
 * server records who ticked it (claims.ts applyClaimTicks).
 *
 * NEVER PUBLISH A BLOCKED PAGE. Publish refuses before its first request
 * unless every tick this page needs is ticked and nothing else blocks it, and
 * again after the save, when the gate the server answers with still lists a
 * blocker. The publish route runs the same gate a third time.
 *
 * Pure apart from the injected `fetch`: the screen and the tests drive it.
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import type { ClaimSection } from "./claims";
import type { OfferPageStatus } from "./store";
import type { Aspect, Confirmation, LibraryVideoRef, OfferPageDoc } from "./types";
import { NAV_LABELS, isConfirmed } from "./visibility";
import { fieldLabel } from "./field-labels";
import { FORM_OFF_BLOCKER } from "./gate-words";

// ---------------------------------------------------------------------------
// What the page hands the screen (built on the server by confirm-list.ts)
// ---------------------------------------------------------------------------

export type ClaimItem = { hash: string; sentence: string; why: string[]; section: ClaimSection; confirmed: boolean };
/** A pricing tier with a price, in a section the page draws. `index` is its place in `tiers`. */
export type PriceItem = { index: number; name: string; shown: string; confirmed: boolean };
/** A bonus value. The parser never stores one without an owner's confirmation, so it is always confirmed. */
export type BonusValueItem = { index: number; title: string; value: string; confirmedOn: string };
export type GuaranteeItem = { body: string; confirmed: boolean };

/** The Library ref a proposal attaches, everything but the rights the server stamps. */
export type ProposalRef = LibraryVideoRef & { aspect: Aspect; duration_s?: number };

export type ProposalView =
  /** suggested-videos.ts names nothing for this page. */
  | { state: "none" }
  /** The asset is not an OASIS video with a video file in this workspace's Library. */
  | { state: "missing"; assetId: string }
  /** It exists, but its Library status is one this screen cannot use (draft, scheduled, rejected, archived). */
  | { state: "unavailable"; assetId: string; title: string; status: string }
  | {
      state: "ready";
      assetId: string;
      title: string;
      /** in_review: the tick approves it first, through the Library's own route. */
      status: "in_review" | "approved" | "published";
      needsApproval: boolean;
      ref: ProposalRef;
      /** Signed for this owner's view only; null when it could not be signed. */
      videoUrl: string | null;
      posterUrl: string | null;
      /** The draft's top video is already this one. */
      onPage: boolean;
      /** The draft has a different top video, which the tick would replace. */
      replaces: boolean;
    };

export type ConfirmOffer = {
  formId: string;
  name: string;
  slug: string;
  /** The address to hand out (lib/offers/short-links.ts), or null when the workspace slug is unknown. */
  link: string | null;
  /**
   * The owner's preview of the draft, the whole page with its unconfirmed
   * prices marked: the /f address with ?offer_preview=1 (a short address does
   * not pass the preview through, as the builder's own preview knows). null
   * when the workspace slug is unknown.
   */
  previewPath: string | null;
  formEnabled: boolean;
  status: OfferPageStatus;
  version: number;
  /** null when the stored draft no longer parses: the screen sends the owner to the builder. */
  draft: OfferPageDoc | null;
  draftError: string | null;
  /** publishGate's blockers for the draft as stored, in its own words. */
  blockers: string[];
  warnings: string[];
  /** What would still block Publish with every tick here ticked and the form on: only the builder fixes these. */
  unfixable: string[];
  claims: ClaimItem[];
  prices: PriceItem[];
  bonusValues: BonusValueItem[];
  guarantee: GuaranteeItem | null;
  proposal: ProposalView;
};

// ---------------------------------------------------------------------------
// The owner's ticks
// ---------------------------------------------------------------------------

export type Choices = {
  /** sentence hash -> ticked */
  claims: Record<string, boolean>;
  /** tier index -> ticked */
  prices: Record<number, boolean>;
  guarantee: boolean;
  /** The proposed top video's one tick. */
  video: boolean;
};

/**
 * The ticks as the server has them: what an owner already confirmed shows
 * ticked, and nothing else does. The video tick starts empty: the owner
 * watches it and decides.
 */
export function initialChoices(o: ConfirmOffer): Choices {
  return {
    claims: Object.fromEntries(o.claims.map((c) => [c.hash, c.confirmed])),
    prices: Object.fromEntries(o.prices.map((p) => [p.index, p.confirmed])),
    guarantee: !!o.guarantee?.confirmed,
    video: false,
  };
}

/** Can the proposed video be attached by a tick (it is ready and not on the page yet)? */
export function videoTickable(o: ConfirmOffer): boolean {
  return o.proposal.state === "ready" && !o.proposal.onPage;
}

/** Has the owner changed anything this screen would save? */
export function hasChanges(o: ConfirmOffer, c: Choices): boolean {
  if (o.claims.some((x) => !!c.claims[x.hash] !== x.confirmed)) return true;
  if (o.prices.some((x) => !!c.prices[x.index] !== x.confirmed)) return true;
  if (o.guarantee && c.guarantee !== o.guarantee.confirmed) return true;
  return videoTickable(o) && c.video;
}

/** What is still unticked that Publish needs. */
export function stillToTick(o: ConfirmOffer, c: Choices): { claims: number; prices: number; guarantee: boolean } {
  return {
    claims: o.claims.filter((x) => !c.claims[x.hash]).length,
    prices: o.prices.filter((x) => !c.prices[x.index]).length,
    guarantee: !!o.guarantee && !c.guarantee,
  };
}

/**
 * May Publish start? The draft reads, nothing outside this screen blocks it,
 * and every tick it needs is ticked. A switched-off form is not a blocker
 * here: Publish switches it on. The video tick is the owner's choice, never
 * required: without it the page publishes with whatever top video it has.
 */
export function isReady(o: ConfirmOffer, c: Choices): boolean {
  if (!o.draft || o.unfixable.length) return false;
  const left = stillToTick(o, c);
  return left.claims === 0 && left.prices === 0 && !left.guarantee;
}

/** Is there anything for Publish to do (a draft, newer changes, a switched-off form, or new ticks)? */
export function needsPublish(o: ConfirmOffer, c: Choices): boolean {
  return o.status !== "live" || !o.formEnabled || hasChanges(o, c);
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export type SaveBody = { draft: OfferPageDoc; version: number; confirm_claims: string[]; unconfirm_claims: string[] };

/**
 * The builder's draft-save body for these ticks. The document is the stored
 * draft with only what was ticked or unticked here changed, each change the
 * way the builder makes it (SectionEditors: a price's and the guarantee's
 * tick set `confirmed` to a pending confirmation, an untick removes it;
 * VideoPicker: a Library video is attached with pending rights). A
 * confirmation already on record is sent back as it is, so the server keeps
 * its first stamp.
 */
export function buildSaveBody(o: ConfirmOffer, c: Choices, pending: () => Confirmation): SaveBody {
  if (!o.draft) throw new Error("this page's draft can't be read");
  const draft = JSON.parse(JSON.stringify(o.draft)) as OfferPageDoc;
  const priceTicks = new Map(o.prices.map((p) => [p.index, !!c.prices[p.index]]));
  for (const s of draft.sections) {
    if (s.key === "pricing" && !s.hidden) {
      s.tiers.forEach((t, i) => {
        if (!priceTicks.has(i)) return;
        const want = priceTicks.get(i);
        if (want && !isConfirmed(t.confirmed)) t.confirmed = pending();
        if (!want && t.confirmed) delete t.confirmed;
      });
    }
    if (s.key === "guarantee" && o.guarantee) {
      if (c.guarantee && !isConfirmed(s.confirmed)) s.confirmed = pending();
      if (!c.guarantee && s.confirmed) delete s.confirmed;
    }
  }
  if (c.video && o.proposal.state === "ready" && !o.proposal.onPage) {
    draft.hero = { ...draft.hero, video: { ...o.proposal.ref, rights: pending() } };
  }
  return {
    draft,
    version: o.version,
    confirm_claims: o.claims.filter((x) => c.claims[x.hash] && !x.confirmed).map((x) => x.hash),
    unconfirm_claims: o.claims.filter((x) => !c.claims[x.hash] && x.confirmed).map((x) => x.hash),
  };
}

// ---------------------------------------------------------------------------
// Save and Publish
// ---------------------------------------------------------------------------

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
export type ActionDeps = { fetch: Fetcher; pending: () => Confirmation };

export type ActionOutcome = (
  | { kind: "saved"; version: number; blockers: string[] }
  | { kind: "published"; publishedVersion: number; warnings: string[] }
  | { kind: "blocked"; blockers: string[] }
  | { kind: "conflict"; message: string }
  | { kind: "approve_failed"; message: string }
  | { kind: "error"; message: string }
) & {
  /** What did happen on the way, when the action stopped later (the video's Library approval). */
  notes?: string[];
};

/** Said when the video's approval went through and a later step did not. */
export const APPROVED_NOTE = "The video itself was approved in the Library. After you reload, tick it again to attach it.";

export const CONFLICT_MESSAGE = "Someone edited this page since this screen loaded, so nothing was changed. Reload the page, then tick again.";

type Answer = { ok: boolean; status: number; data: Record<string, unknown> };

async function call(deps: ActionDeps, url: string, method: string, body?: unknown): Promise<Answer> {
  try {
    const res = await deps.fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return { ok: res.ok && data.ok === true, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

const blockersOf = (data: Record<string, unknown>): string[] =>
  Array.isArray(data.blockers) ? data.blockers.filter((b): b is string => typeof b === "string") : [];

/**
 * Library statuses a page's top video may newly carry: exactly what the offer
 * save accepts for a newly attached Library video (app/api/forms/[id]/offer,
 * "approved or published"). Not "scheduled": the save would refuse it.
 */
const ATTACHABLE = new Set(["approved", "published"]);

type Approval = { refused: ActionOutcome | null; approved: boolean };

/**
 * The approval the video tick needs first, when the proposal is still in
 * review. `refused` is set when the action must stop here; `approved` says
 * this call approved it, so a later step that fails can say so.
 */
async function approveIfNeeded(o: ConfirmOffer, c: Choices, deps: ActionDeps): Promise<Approval> {
  const p = o.proposal;
  if (!c.video || p.state !== "ready" || p.onPage || !p.needsApproval) return { refused: null, approved: false };
  const r = await call(deps, `/api/founders/marketing/assets/${encodeURIComponent(p.assetId)}`, "PATCH", {
    status: "approved",
    from: "in_review",
  });
  if (r.ok) return { refused: null, approved: true };
  if (r.data.error === "status_changed") {
    const now = typeof r.data.status === "string" ? r.data.status : "";
    // Approved or published since this screen loaded: nothing to approve, attach it as it is.
    if (ATTACHABLE.has(now)) return { refused: null, approved: false };
    return {
      refused: {
        kind: "approve_failed",
        message:
          `This video's status changed in the Library since this screen loaded${now ? ` (it is ${now.replace(/_/g, " ")} now)` : ""}, ` +
          "so it was not approved, nothing was saved and no video was attached. Reload the page.",
      },
      approved: false,
    };
  }
  // No answer at all (status 0): the approval may or may not have gone through.
  const unknown = r.status === 0;
  return {
    refused: {
      kind: "approve_failed",
      message: unknown
        ? "No answer came back from the Library, so nothing was saved and no video was attached. Reload the page: it shows whether the video was approved."
        : "The video could not be approved in the Library, so nothing was saved and no video was attached. Try again, or approve it in the Library and come back.",
    },
    approved: false,
  };
}

/** A later step's outcome, with the approval this action already made said out loud. */
const afterApproval = (outcome: ActionOutcome, a: Approval): ActionOutcome =>
  a.approved && outcome.kind !== "published" && outcome.kind !== "saved"
    ? { ...outcome, notes: [...(outcome.notes ?? []), APPROVED_NOTE] }
    : outcome;

type Saved = { ok: true; version: number; blockers: string[] } | { ok: false; outcome: ActionOutcome };

async function putDraft(o: ConfirmOffer, c: Choices, deps: ActionDeps): Promise<Saved> {
  const body = buildSaveBody(o, c, deps.pending);
  const r = await call(deps, `/api/forms/${encodeURIComponent(o.formId)}/offer`, "PUT", body);
  const offer = r.data.offer as { version?: unknown; gate?: { blockers?: unknown } | null } | undefined;
  if (r.ok && offer && Number.isInteger(offer.version)) {
    const gate = offer.gate;
    // No gate (an unreadable draft) is not "nothing blocks it".
    const blockers = gate && Array.isArray(gate.blockers) ? blockersOf(gate as Record<string, unknown>) : ["The saved draft can't be read. Open it in the builder."];
    return { ok: true, version: Number(offer.version), blockers };
  }
  if (r.data.error === "draft_conflict") return { ok: false, outcome: { kind: "conflict", message: CONFLICT_MESSAGE } };
  if (r.data.error === "invalid_page") {
    return {
      ok: false,
      outcome: { kind: "error", message: `Not saved. ${fieldLabel(r.data.path as string | undefined, body.draft)}: ${String(r.data.reason ?? "needs a change")}.` },
    };
  }
  const said = typeof r.data.message === "string" ? r.data.message : null;
  return { ok: false, outcome: { kind: "error", message: said || "Not saved. Try again in a moment." } };
}

/** The saved gate's blockers but the switched-off form, which Publish clears itself. */
const besidesFormOff = (blockers: string[]) => blockers.filter((b) => b !== FORM_OFF_BLOCKER);

/** Save: approve the proposed video if it needs it, then the builder's draft save. */
export async function saveOffer(o: ConfirmOffer, c: Choices, deps: ActionDeps): Promise<ActionOutcome> {
  if (!o.draft) return { kind: "error", message: "This page's saved draft can't be read. Open it in the builder." };
  const approval = await approveIfNeeded(o, c, deps);
  if (approval.refused) return approval.refused;
  const saved = await putDraft(o, c, deps);
  return saved.ok
    ? { kind: "saved", version: saved.version, blockers: besidesFormOff(saved.blockers) }
    : afterApproval(saved.outcome, approval);
}

/**
 * Publish, in this order: approve the proposed video (when it is ticked and
 * still in review), save every tick, then publish the version that save
 * returned, switching a switched-off form on in the same transaction. Each
 * step runs only when the one before it went through: a refused approval saves
 * nothing, and a failed save or a saved gate that lists anything besides the
 * switched-off form never reaches the publish. The form and the page change
 * together or not at all, so no answer lost on the way back can leave a
 * draft's plain form public.
 */
export async function publishOffer(o: ConfirmOffer, c: Choices, deps: ActionDeps): Promise<ActionOutcome> {
  if (!o.draft) return { kind: "error", message: "This page's saved draft can't be read. Open it in the builder." };
  if (!isReady(o, c)) return { kind: "blocked", blockers: whatBlocks(o, c) };
  const approval = await approveIfNeeded(o, c, deps);
  if (approval.refused) return approval.refused;
  const saved = await putDraft(o, c, deps);
  if (!saved.ok) return afterApproval(saved.outcome, approval);
  const rest = besidesFormOff(saved.blockers);
  if (rest.length) return afterApproval({ kind: "blocked", blockers: rest }, approval);
  const r = await call(deps, `/api/forms/${encodeURIComponent(o.formId)}/offer/publish`, "POST", {
    version: saved.version,
    // Always: a page this screen publishes goes live with its form on, even
    // if someone switched the form off after the save (Codex on #637).
    enable_form: true,
  });
  if (r.ok) {
    const warnings = Array.isArray(r.data.warnings) ? r.data.warnings.filter((w): w is string => typeof w === "string") : [];
    return { kind: "published", publishedVersion: Number(r.data.published_version), warnings };
  }
  const failed: ActionOutcome =
    r.data.error === "draft_conflict"
      ? { kind: "conflict", message: CONFLICT_MESSAGE }
      : r.data.error === "publish_blocked"
        ? { kind: "blocked", blockers: blockersOf(r.data) }
        : r.status === 0
          ? { kind: "error", message: NO_ANSWER_MESSAGE }
          : { kind: "error", message: "Saved, but not published. Try Publish again in a moment." };
  return afterApproval(failed, approval);
}

/** Publish sent, no answer back: it went live with its form on, or nothing changed. */
export const NO_ANSWER_MESSAGE =
  "Saved, but no answer came back from Publish. Reload this page: it shows Live with the form on if it went through, and Draft with the form as it was if not.";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Where a flagged sentence sits, in the owner's words. */
export function claimSectionLabel(section: ClaimSection): string {
  switch (section) {
    case "hero":
      return "Top of the page";
    case "nav":
      return "Header button";
    case "book":
      return "Book section";
    case "seo":
      return "Browser tab and link preview";
    default:
      return NAV_LABELS[section] ?? "This page";
  }
}

/** The flagged sentences, grouped by where they sit, in the page's order. */
export function groupClaims(claims: ClaimItem[]): Array<{ section: ClaimSection; label: string; items: ClaimItem[] }> {
  const out: Array<{ section: ClaimSection; label: string; items: ClaimItem[] }> = [];
  for (const c of claims) {
    const group = out.find((g) => g.section === c.section);
    if (group) group.items.push(c);
    else out.push({ section: c.section, label: claimSectionLabel(c.section), items: [c] });
  }
  return out;
}

/** What still stands between this page and Publish, in plain sentences. */
export function whatBlocks(o: ConfirmOffer, c: Choices): string[] {
  if (!o.draft) return ["This page's saved draft can't be read. Open it in the builder."];
  const left = stillToTick(o, c);
  const out: string[] = [];
  if (left.claims) out.push(left.claims === 1 ? "Tick the sentence below that makes a claim." : `Tick the ${left.claims} sentences below that make a claim.`);
  if (left.prices) out.push(left.prices === 1 ? "Confirm the price below." : `Confirm the ${left.prices} prices below.`);
  if (left.guarantee) out.push("Confirm the guarantee's terms below.");
  return [...out, ...o.unfixable];
}

/** One outcome, as the card says it, with what did happen on the way (`notes`) last. */
export function outcomeWords(outcome: ActionOutcome): { tone: "ok" | "warn" | "error"; lines: string[] } {
  const words = baseWords(outcome);
  return outcome.notes?.length ? { ...words, lines: [...words.lines, ...outcome.notes] } : words;
}

function baseWords(outcome: ActionOutcome): { tone: "ok" | "warn" | "error"; lines: string[] } {
  switch (outcome.kind) {
    case "published":
      return { tone: "ok", lines: [`Published. The page is live (version ${outcome.publishedVersion}).`, ...outcome.warnings] };
    case "saved":
      return {
        tone: "ok",
        lines: outcome.blockers.length ? ["Saved. Not ready to publish yet:", ...outcome.blockers] : ["Saved. Nothing blocks publishing."],
      };
    case "blocked":
      return { tone: "warn", lines: ["Not published. What still blocks it:", ...(outcome.blockers.length ? outcome.blockers : ["Reload the page to see what changed."])] };
    case "conflict":
      return { tone: "warn", lines: [outcome.message] };
    case "approve_failed":
    case "error":
      return { tone: "error", lines: [outcome.message] };
  }
}
