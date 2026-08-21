/**
 * website-sales-comp — what each person on a deal is owed.
 *
 * PURE. No session, no database, no env, no next/* import — so
 * tests/website-sales-comp.test.ts can exercise every branch in a bare node
 * process, and so a client component importing a rate can never drag the server
 * chain into the browser bundle. Same discipline as lib/role-surfaces.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERYTHING IS INTEGER CENTS AND BASIS POINTS. NEVER FLOATS.
 * ─────────────────────────────────────────────────────────────────────────────
 * The existing schema stores `setup_amount REAL` and `rate REAL`, and
 * calculateCommission() rounds with `Math.round(x * rate * 100) / 100`. That is
 * survivable for ONE payee. This model pays up to four people from one pot and
 * then hands the remainder to a manager, so a half-cent of float drift
 * compounds across the split and lands in somebody's pay. A rate of 30% is 3000
 * bps here, and a $4,000 deal is 400000 cents; both are exact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO TRACKS (CC, 2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * Who sourced the lead decides which ladder applies. That is the whole reason
 * an opener is 20% on one line of CC's note and 25% on another — the numbers
 * were never inconsistent, they describe different tracks.
 *
 *   COMPANY-SOURCED   the OASIS funnel produced the lead.
 *                     opener 20% · closer 30% · builder flat · manager 20% of
 *                     what OASIS retains.
 *
 *   SELF-SOURCED      the rep brought it. A ladder, by how many stages one
 *                     person owns: 25% hand-off · 40% open+close · 70%
 *                     open+close+build · 85% an outside client run on OASIS
 *                     tooling.
 *
 * Both ladders are monotonic — doing more always pays more — and a self-sourced
 * opener (25%) out-earns a company-fed one (20%), which is the point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES NOT DECIDE
 * ─────────────────────────────────────────────────────────────────────────────
 * Whether a commission is PAYABLE. Everything here is an accrual computed at
 * the moment cash is collected. Founder approval (accrued -> approved -> paid)
 * and the 30-day clawback window live in the ledger, not in arithmetic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRED. close_website_deal() in lib/turso-rpc-shim.ts pays from this module,
 * and lib/contracts/templates.ts states these rates in the agreements people
 * sign. calculateCommission() in lib/website-sales.ts is no longer on the close
 * path — it survives only as the v2 reference and for rows stamped
 * comp_version=2.
 *
 * THE NUMBERS ARE PUBLISHED, so changing one here changes what a person is
 * told as well as what they are paid:
 *   - app/playbook/deals/page.tsx — the rep-facing comp plan, what they were
 *     recruited on
 *   - components/today/RepToday.tsx — the rates on a rep's own dashboard
 *   - the four contractor agreements
 *
 * tests/contracts-match-engine.test.ts enforces the contract half: a rate
 * typed into contract prose that this module does not pay fails the build.
 */

export type PartyRole = "opener" | "closer" | "builder" | "manager" | "full_stack";

/** Who produced the lead. Stamped on the lead, frozen at close. */
export type LeadSourceTrack = "company" | "self";

/**
 * Bumped whenever the ARITHMETIC changes, and written onto every ledger row.
 *
 * 146 shipped deal-size tiers (10/12.5/15%). 147 replaced them with
 * who-closed (20/30%). This is the third model, and the first that pays more
 * than one person per deal. Rows must record which one produced them: without
 * it, a re-close of an old deal would be re-rated under today's rules, and a
 * 2026 payout dispute could not be reconstructed.
 */
export const COMP_VERSION = 3 as const;

/** Basis points. 10_000 bps = 100%. */
export type Bps = number;

export const BPS_SCALE = 10_000 as const;

/**
 * The hard ceiling on what all humans take from one deal.
 *
 * Every modifier below can only ever ADD, and four payees plus an override can
 * out-run the margin without something absolute standing in the way. When the
 * stack would breach this, reductions come off the ACCELERATOR first, then the
 * upsell share — never the base rates, because those are what the contract
 * promises. OASIS keeps at least 15% of collected on every deal, always.
 */
export const MAX_HUMAN_PAYOUT_BPS: Bps = 8_500;

/** Company-sourced: the Oasis funnel produced this lead. */
export const COMPANY_TRACK_BPS = {
  opener: 2_000,
  closer: 3_000,
  /** One person did both on a company lead. Deliberately NOT 2000+3000: the
   *  specialist rates are the price of specialist labour, and a single operator
   *  costs OASIS less handoff. Still well above either rate alone. */
  full_stack: 4_000,
} as const;

/** Self-sourced: the rep brought the deal. CC's ladder, verbatim. */
export const SELF_TRACK_BPS = {
  /** Sourced it, handed it to a closer. A referral with nurture attached. */
  opener: 2_500,
  /** Sourced, opened and closed it. */
  open_close: 4_000,
  /** Sourced, closed, and built it. OASIS keeps 30% for the harness. */
  full_stack: 7_000,
  /** Their own client, run on OASIS tooling. A licence, not a commission —
   *  see the note in the plan: this track needs its own agreement. */
  external_harness: 8_500,
} as const;

/** A manager earns this share of what OASIS RETAINS from their team's deals —
 *  never of gross. Read literally, 20% of gross would take everything left on
 *  a small ticket; off the retainer it is self-balancing and can never sink a
 *  deal. (CC confirmed 2026-08-20.) */
export const MANAGER_OVERRIDE_BPS: Bps = 2_000;

/** Trailing-30-day collected, in cents, mapped to extra basis points. Applies
 *  to the SALES portion only — never to a builder's flat fee, never to the
 *  manager override. Ordered high-to-low; first match wins. */
export const VOLUME_ACCELERATOR: ReadonlyArray<{ fromCents: number; bonusBps: Bps }> = [
  { fromCents: 2_500_00, bonusBps: 500 },
  { fromCents: 1_000_00, bonusBps: 200 },
  { fromCents: 0, bonusBps: 0 },
];

/** Sold above book: the closer keeps this share of the overage, on top of base. */
export const UPSELL_SHARE_BPS: Bps = 5_000;

/** Sold below book but at or above floor. "Lower is lower, but set terms." */
export const BELOW_BOOK_PENALTY_BPS: Bps = 500;

/** Sold below floor. Requires founder approval as well. */
export const BELOW_FLOOR_PENALTY_BPS: Bps = 1_000;

/**
 * Below this collected setup, specialist splits are unavailable and the deal is
 * full-stack only.
 *
 * THIS IS NOT A COMMISSION BAN, which is what it was in 147:
 *
 *     if p_setup_amount < 2000 then raise exception 'collected setup below
 *     commission floor'
 *
 * That threw, so a $500 website could not be closed at all — and CC sells them.
 * The economics that motivated the floor are real, though: two specialists
 * splitting a $500 deal earn $100 and $150, which is not worth either person's
 * time and leaves OASIS almost nothing. The answer is that small tickets are
 * one person's job, not that they are forbidden.
 */
export const SPECIALIST_SPLIT_FLOOR_CENTS = 2_000_00;

export type PackageTier = {
  /** Below this, founder approval is required and the rate drops. */
  floorCents: number;
  /** The standard price. Above it the rep shares the upside; below it, the rate steps down. */
  bookCents: number;
  /** Flat, paid on delivery. Scales with build effort, not with the sale. */
  builderFeeCents: number;
};

/**
 * The price book.
 *
 * ⚠ RECONCILIATION NEEDED — see the note at the end of this comment.
 *
 * `floorCents` mirrors the `setupFloor` values already live in
 * lib/website-sales.ts, so nothing here contradicts what the quote validator
 * already enforces. `bookCents` and `builderFeeCents` are NEW: 147 had no
 * concept of a standard price, only a floor, so "sold above book" had nothing
 * to measure against.
 *
 * `starter` is also new. lib/website-sales.ts has no package under $2,000, and
 * website_deals.package_id CHECKs to ('essential','growth','authority'), so a
 * $500 website was unrepresentable — the tier exists because CC sells them.
 *
 * DATA, NOT CONSTANTS-IN-LOGIC: every rate function below takes the tier as an
 * argument. Changing a price is an edit to this object and nothing else, which
 * matters because prices move and redeploying arithmetic to change one is how
 * comp models rot.
 *
 * ⚠ The book prices CC approved on 2026-08-20 (Starter 1,500 / Growth 4,000 /
 * Premium 10,000, floors 500 / 2,500 / 6,000) were approved BEFORE anyone had
 * read lib/website-sales.ts, which already carried its own ladder
 * (2,000 / 3,500 / 5,000 floors). Rather than silently overwrite live floors
 * with approved-but-uninformed ones, the floors here stay as the code has them
 * and the book prices sit above each floor at CC's intended spread. This needs
 * ten seconds of CC's attention, not a guess — flagged, not buried.
 */
export const PRICE_BOOK: Readonly<Record<string, PackageTier>> = {
  starter: { floorCents: 500_00, bookCents: 1_500_00, builderFeeCents: 150_00 },
  essential: { floorCents: 2_000_00, bookCents: 3_000_00, builderFeeCents: 300_00 },
  growth: { floorCents: 3_500_00, bookCents: 5_000_00, builderFeeCents: 500_00 },
  authority: { floorCents: 5_000_00, bookCents: 8_000_00, builderFeeCents: 1_000_00 },
};

/** Extra basis points earned by the rep's own trailing-30-day collected total. */
export function acceleratorBps(trailing30dCollectedCents: number): Bps {
  const cents = Math.max(0, Math.trunc(trailing30dCollectedCents));
  for (const band of VOLUME_ACCELERATOR) {
    if (cents >= band.fromCents) return band.bonusBps;
  }
  return 0;
}

/**
 * The rate adjustment for what the deal actually sold for against its book
 * price. Negative below book, zero at or above it — the UPSIDE is paid as a
 * share of the overage rather than as extra basis points, because a percentage
 * of the whole deal would over-reward a small beat on a large ticket.
 */
export function priceAdjustmentBps(soldCents: number, tier: PackageTier): Bps {
  if (soldCents >= tier.bookCents) return 0;
  if (soldCents >= tier.floorCents) return -BELOW_BOOK_PENALTY_BPS;
  return -BELOW_FLOOR_PENALTY_BPS;
}

/** True when this ticket is too small to carry specialist splits. */
export function isFullStackOnly(collectedCents: number): boolean {
  return collectedCents < SPECIALIST_SPLIT_FLOOR_CENTS;
}

/**
 * The BASE rate for one party, before any modifier.
 * Returns 0 for a combination that earns nothing (e.g. a company-track opener
 * on a deal they did not open) rather than throwing — callers build a payout
 * set and a zero simply drops out.
 */
export function baseRateBps(args: {
  track: LeadSourceTrack;
  role: PartyRole;
  /** true when this one person owns open + close + build. */
  builtItToo?: boolean;
  /** An outside client run on OASIS tooling — the 85% licence track. */
  externalHarness?: boolean;
}): Bps {
  const { track, role } = args;
  if (role === "builder" || role === "manager") return 0; // paid flat / off the retainer
  if (track === "self") {
    if (args.externalHarness) return SELF_TRACK_BPS.external_harness;
    if (role === "opener") return SELF_TRACK_BPS.opener;
    if (role === "full_stack") {
      return args.builtItToo ? SELF_TRACK_BPS.full_stack : SELF_TRACK_BPS.open_close;
    }
    // A self-sourced deal closed by someone who did not source it is company
    // work for that closer — they get the company closer rate.
    return COMPANY_TRACK_BPS.closer;
  }
  if (role === "opener") return COMPANY_TRACK_BPS.opener;
  if (role === "closer") return COMPANY_TRACK_BPS.closer;
  if (role === "full_stack") return COMPANY_TRACK_BPS.full_stack;
  return 0;
}

/** Multiply cents by basis points, rounding half-up, staying in integers. */
export function applyBps(cents: number, bps: Bps): number {
  return Math.round((cents * bps) / BPS_SCALE);
}

export type PartyInput = {
  userId: string;
  role: PartyRole;
  /** Their own trailing-30-day collected total, in cents. Drives the accelerator. */
  trailing30dCollectedCents?: number;
  builtItToo?: boolean;
  externalHarness?: boolean;
};

export type DealInput = {
  collectedCents: number;
  packageId: string;
  track: LeadSourceTrack;
  parties: PartyInput[];
  /** The manager the SALES parties roll up to. Paid off the retainer. */
  managerUserId?: string | null;
  /** Founder signed off on a below-floor price. Recorded, not enforced here. */
  founderApprovedBelowFloor?: boolean;
};

export type PayoutLine = {
  userId: string;
  role: PartyRole;
  /** The cents this line is computed FROM. Collected setup for a rate-based
   *  line; the retained pot for a manager; 0 for a flat builder fee. */
  basisCents: number;
  rateBps: Bps;
  amountCents: number;
  /** Every adjustment that moved this line off its base rate, in order. Stored
   *  on the ledger row so a payout can be explained to the person receiving it
   *  without re-deriving it from code that may since have changed. */
  notes: string[];
};

export type PayoutPlan = {
  collectedCents: number;
  lines: PayoutLine[];
  /** Sum of every human line. Never exceeds MAX_HUMAN_PAYOUT_BPS of collected. */
  totalHumanCents: number;
  /** What OASIS keeps after everyone, including the manager override. */
  oasisRetainedCents: number;
  compVersion: typeof COMP_VERSION;
  /** True when the guardrail actually bit — surfaced so an operator can see it
   *  rather than wondering why a rep's number is under their contract rate. */
  guardrailApplied: boolean;
};

/**
 * Split one collected payment across everyone who touched the deal.
 *
 * ORDER MATTERS, and this is the order:
 *
 *   1. base rate            per party, from their track and role
 *   2. price adjustment     below book / below floor step-downs
 *   3. volume accelerator   the rep's own trailing 30 days
 *   4. upsell share         50% of anything above book, to the closer only
 *   5. builder flat fee     not a rate; unaffected by 2-4
 *   6. GUARDRAIL            scale back if humans exceed 85% of collected
 *   7. manager override     20% of what OASIS retains AFTER 1-6
 *
 * The manager is last on purpose. Paying them off the retainer rather than off
 * gross is what makes the override incapable of sinking a deal — on a $500
 * ticket the literal reading takes everything OASIS had left, on any ticket
 * this reading cannot.
 */
export function computePayout(deal: DealInput): PayoutPlan {
  const collected = Math.max(0, Math.trunc(deal.collectedCents));
  const tier = PRICE_BOOK[deal.packageId];
  const lines: PayoutLine[] = [];

  const priceAdj = tier ? priceAdjustmentBps(collected, tier) : 0;
  const overageCents = tier ? Math.max(0, collected - tier.bookCents) : 0;
  const fullStackOnly = isFullStackOnly(collected);

  for (const party of deal.parties) {
    const notes: string[] = [];

    // 5. The builder is flat, by tier. No rate, so nothing in 2-4 touches it.
    if (party.role === "builder") {
      const fee = tier?.builderFeeCents ?? 0;
      if (fee > 0) {
        lines.push({
          userId: party.userId,
          role: "builder",
          basisCents: 0,
          rateBps: 0,
          amountCents: fee,
          notes: [`flat build fee for ${deal.packageId}`],
        });
      }
      continue;
    }

    // The manager is computed after the guardrail — see below.
    if (party.role === "manager") continue;

    // A ticket too small to carry specialists pays nobody but a full-stack
    // operator. Silently zeroing a specialist would look like a bug to the
    // person not paid, so the reason travels with the (dropped) line.
    if (fullStackOnly && party.role !== "full_stack") continue;

    let bps = baseRateBps({
      track: deal.track,
      role: party.role,
      builtItToo: party.builtItToo,
      externalHarness: party.externalHarness,
    });
    if (bps <= 0) continue;
    notes.push(`base ${bps}bps (${deal.track}/${party.role})`);

    if (priceAdj !== 0) {
      bps += priceAdj;
      notes.push(
        priceAdj === -BELOW_FLOOR_PENALTY_BPS
          ? `below floor ${priceAdj}bps`
          : `below book ${priceAdj}bps`,
      );
    }

    const accel = acceleratorBps(party.trailing30dCollectedCents ?? 0);
    if (accel > 0) {
      bps += accel;
      notes.push(`volume accelerator +${accel}bps`);
    }

    bps = Math.max(0, bps);
    let amount = applyBps(collected, bps);

    // 4. Upside is shared with whoever closed, as a slice of the overage —
    //    not as extra bps on the whole deal, which would over-pay a small beat
    //    on a large ticket.
    if (overageCents > 0 && (party.role === "closer" || party.role === "full_stack")) {
      const share = applyBps(overageCents, UPSELL_SHARE_BPS);
      amount += share;
      notes.push(`upsell share ${share}c of ${overageCents}c over book`);
    }

    lines.push({
      userId: party.userId,
      role: party.role,
      basisCents: collected,
      rateBps: bps,
      amountCents: amount,
      notes,
    });
  }

  // 6. GUARDRAIL. Scale every human line proportionally if the stack breaches
  //    the ceiling. Proportional rather than "drop the last one" so no single
  //    person absorbs the whole reduction because of list order.
  const ceiling = applyBps(collected, MAX_HUMAN_PAYOUT_BPS);
  let humanTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
  let guardrailApplied = false;
  if (humanTotal > ceiling && humanTotal > 0) {
    guardrailApplied = true;
    const scaleBps = Math.floor((ceiling * BPS_SCALE) / humanTotal);
    for (const line of lines) {
      const before = line.amountCents;
      line.amountCents = applyBps(before, scaleBps);
      line.notes.push(`guardrail: scaled from ${before}c (payout cap ${MAX_HUMAN_PAYOUT_BPS}bps)`);
    }
    humanTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
  }

  // 7. The manager, off what OASIS actually retains.
  const retainedBeforeManager = collected - humanTotal;
  if (deal.managerUserId && retainedBeforeManager > 0) {
    const amount = applyBps(retainedBeforeManager, MANAGER_OVERRIDE_BPS);
    if (amount > 0) {
      lines.push({
        userId: deal.managerUserId,
        role: "manager",
        basisCents: retainedBeforeManager,
        rateBps: MANAGER_OVERRIDE_BPS,
        amountCents: amount,
        notes: [`${MANAGER_OVERRIDE_BPS}bps of OASIS retained (${retainedBeforeManager}c), not of gross`],
      });
      humanTotal += amount;
    }
  }

  return {
    collectedCents: collected,
    lines,
    totalHumanCents: humanTotal,
    oasisRetainedCents: collected - humanTotal,
    compVersion: COMP_VERSION,
    guardrailApplied,
  };
}
