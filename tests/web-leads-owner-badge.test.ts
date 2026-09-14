import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  claimState,
  CLAIM_STALE_DAYS,
  LOST_RECYCLE_DAYS,
  type ClaimFacts,
} from "../lib/web-leads/claim";
import { assignedNameFor, type Viewer } from "../lib/web-leads/data";

/**
 * The owner badge on a /web-leads row (Adon, 2026-09-14).
 *
 * THE PROBLEM: "when a rep assigns itself a lead ... it causes a lot of
 * confusion between other reps who could assign it and you." No row on that
 * page said who held a lead, so two reps could work toward the same business
 * and a manager could not see which rep held what.
 *
 * WHY THIS IS NOT JUST `assignedTo ? "Taken" : "Free"`. A lead sitting in the
 * shared pool can still NAME a previous owner: a claim that expired after
 * CLAIM_STALE_DAYS undialled, or a "not interested" that recycled after
 * LOST_RECYCLE_DAYS, are both claimable while `assigned_to` still points at
 * whoever had it last (lib/web-leads/data.ts's pool mapping says exactly
 * this). Rendering those as "Taken" would tell reps to skip the leads the
 * recycling rules just handed back to them -- a badge that quietly drains the
 * callable pool, which is the precise failure claim.ts's header exists to
 * prevent. So availability, not the presence of an id, decides the state.
 */

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function facts(over: Partial<ClaimFacts> = {}): ClaimFacts {
  return {
    assignedTo: null,
    claimedAt: null,
    lastCallAt: null,
    stage: null,
    lostAt: null,
    dnc: false,
    ...over,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

// --- nobody holds it ---
assert.equal(
  claimState(facts(), ME, NOW),
  "unassigned",
  "a lead with no assigned_to is free for anyone",
);

// --- my own book ---
assert.equal(
  claimState(facts({ assignedTo: ME, claimedAt: iso(NOW - DAY_MS) }), ME, NOW),
  "you",
  "a lead I hold reads as mine, never as a generic 'taken'",
);
assert.equal(
  claimState(facts({ assignedTo: ME.toUpperCase(), claimedAt: iso(NOW - DAY_MS) }), ME, NOW),
  "you",
  "assigned_to casing must not turn my own lead into someone else's -- same convention as isInBookOf",
);

// --- somebody else holds it ---
assert.equal(
  claimState(facts({ assignedTo: OTHER, claimedAt: iso(NOW - DAY_MS) }), ME, NOW),
  "taken",
  "a lead another rep currently holds must read as taken, so two reps do not work it at once",
);
assert.equal(
  claimState(facts({ assignedTo: OTHER, claimedAt: iso(NOW - 400 * DAY_MS), lastCallAt: iso(NOW - DAY_MS) }), ME, NOW),
  "taken",
  "a logged call keeps a lead held however old the claim is -- the rep is working it",
);

// --- a previous owner on a lead that is claimable again ---
assert.equal(
  claimState(
    facts({ assignedTo: OTHER, claimedAt: iso(NOW - (CLAIM_STALE_DAYS + 1) * DAY_MS) }),
    ME,
    NOW,
  ),
  "worked_before",
  "an expired claim is back in the pool: it must NOT read as taken or reps would skip leads they are entitled to claim",
);
assert.equal(
  claimState(
    facts({
      assignedTo: OTHER,
      stage: "lost",
      lostAt: iso(NOW - (LOST_RECYCLE_DAYS + 1) * DAY_MS),
      lastCallAt: iso(NOW - (LOST_RECYCLE_DAYS + 1) * DAY_MS),
    }),
    ME,
    NOW,
  ),
  "worked_before",
  "a 90-day recycled loss is callable again, and the badge should say it was worked, not that it is held",
);

// --- a lead I hold whose claim lapsed still reads as mine ---
assert.equal(
  claimState(
    facts({ assignedTo: ME, claimedAt: iso(NOW - (CLAIM_STALE_DAYS + 1) * DAY_MS) }),
    ME,
    NOW,
  ),
  "you",
  "my own lapsed lead stays labelled mine -- My Leads already marks it Released; it must not read as an anonymous 'worked before'",
);

// --- an unresolved viewer must never be told a lead is theirs ---
assert.equal(
  claimState(facts({ assignedTo: OTHER, claimedAt: iso(NOW - DAY_MS) }), "", NOW),
  "taken",
  "an empty viewer id must fail closed to 'taken' rather than matching a held lead",
);

// ═══ WHO MAY SEE THE REP'S NAME ════════════════════════════════════════════
//
// Adon wants both halves: every rep sees that a lead is "Taken" so nobody
// double-claims, and a manager or admin additionally sees WHICH rep holds it
// ("more for my end just so I can see which one of my reps is assigned to
// which one").
//
// The name half is gated SERVER-SIDE, in the projection, not by a component
// choosing what to render. A plain rep's browser must never receive another
// rep's name at all -- this board is sold to outside contractors, and handing
// them a roster of who works which business is exactly the cross-book
// disclosure PR #237 closed. A client-side check is a courtesy, never the
// boundary.

const ROSTER = new Map<string, string>([
  [ME.toLowerCase(), "Adon"],
  [OTHER.toLowerCase(), "Matt R."],
]);

const REP: Viewer = { userId: ME, teamRole: "agent", isAdmin: false };
const ADMIN: Viewer = { userId: "33333333-3333-3333-3333-333333333333", teamRole: "member", isAdmin: true };
const MANAGER: Viewer = {
  userId: "44444444-4444-4444-4444-444444444444",
  teamRole: "manager",
  isAdmin: false,
  readableAssigneeIds: [OTHER],
};

const heldByOther = facts({ assignedTo: OTHER, claimedAt: iso(NOW - DAY_MS) });

assert.equal(
  assignedNameFor(heldByOther, REP, ROSTER),
  null,
  "a plain rep must NOT receive another rep's name -- the #237 cross-book fence, enforced in the projection",
);
assert.equal(
  assignedNameFor(heldByOther, ADMIN, ROSTER),
  "Matt R.",
  "an admin sees which rep holds the lead -- the half Adon asked for",
);
assert.equal(
  assignedNameFor(heldByOther, MANAGER, ROSTER),
  "Matt R.",
  "a manager sees the name for a rep on their server-resolved roster",
);
assert.equal(
  assignedNameFor(facts({ assignedTo: ME, claimedAt: iso(NOW - DAY_MS) }), REP, ROSTER),
  "Adon",
  "a rep may always see the name on their own lead -- it is their own book",
);

// --- casing: the stored id and the roster key must still meet ---
assert.equal(
  assignedNameFor(
    facts({ assignedTo: OTHER.toUpperCase(), claimedAt: iso(NOW - DAY_MS) }),
    ADMIN,
    ROSTER,
  ),
  "Matt R.",
  "assigned_to is stored raw while the roster map is keyed lowercase -- the lookup must be case-insensitive or the name silently vanishes",
);

// --- degrade to null, never to a raw UUID ---
assert.equal(
  assignedNameFor(
    facts({ assignedTo: "55555555-5555-5555-5555-555555555555", claimedAt: iso(NOW - DAY_MS) }),
    ADMIN,
    ROSTER,
  ),
  null,
  "a holder missing from the roster yields null, so the UI shows 'Taken' rather than printing a raw UUID at an operator",
);
assert.equal(
  assignedNameFor(facts(), ADMIN, ROSTER),
  null,
  "an unassigned lead has no name to show",
);

// ═══ THE BADGE REACHES BOTH LIST SURFACES ══════════════════════════════════
//
// Source reads, same convention as tests/web-leads-client-cache.test.ts. The
// point is that neither list can quietly lose the badge: /web-leads renders a
// table above `xl` and cards below it, and a rep on a laptop and a rep on a
// phone must get the same ownership signal. A badge on one surface only is how
// the confusion this fixes comes back on half the devices.

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const cells = read("components/web-leads/LeadCells.tsx");
const table = read("components/web-leads/LeadsTable.tsx");
const cards = read("components/web-leads/LeadCards.tsx");

assert.match(
  cells,
  /export function OwnerBadge/,
  "the badge lives in LeadCells.tsx with the other row cells, so both list surfaces render the identical thing",
);
assert.ok(
  /<OwnerBadge/.test(table),
  "the desktop table must render the owner badge",
);
assert.ok(
  /<OwnerBadge/.test(cards),
  "the mobile cards must render the owner badge too -- a rep on a phone needs the same signal",
);

// --- the stage label must not tell a rep a colleague's lead is theirs ---
//
// STAGE_LABEL is keyed on the lead's stage alone and has no idea who is
// looking, so "Mine, not called" rendered on the Team tab for a lead the
// viewer does not hold. Ownership is the badge's job now; the stage label
// describes the lead's lifecycle and must stay viewer-neutral.
const assignedLabel = /assigned:\s*"([^"]+)"/.exec(cells)?.[1] ?? "";
assert.ok(assignedLabel.length > 0, "STAGE_LABEL must still carry an entry for the assigned stage");
assert.doesNotMatch(
  assignedLabel,
  /\bmine\b/i,
  `STAGE_LABEL.assigned is viewer-agnostic, so it must not claim ownership -- it read "${assignedLabel}", which renders on another rep's lead`,
);

console.log("web-leads-owner-badge: all assertions passed");
