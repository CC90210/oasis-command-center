/**
 * contracts/templates — the four OASIS contractor agreements.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY RATE IN EVERY AGREEMENT IS READ FROM lib/website-sales-comp.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 * Not retyped, not approximated, not "kept in sync". A contract that quotes a
 * number the payout engine does not use is not a documentation bug — it is a
 * promise the company will break, in writing, to someone who signed it. The one
 * defence that actually holds is making it impossible to state a rate here that
 * the engine would not pay, so this file imports the constants and formats them.
 *
 * The same constants are rendered to reps on app/playbook/deals. Contract,
 * Playbook and payout are three views of one object.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Legal advice, and not a substitute for a lawyer reading it. CC chose
 * contractor-for-all on 2026-08-20; the classification questions that raises in
 * Québec — and the Revenu Québec dual-filing position — are flagged in the plan
 * and belong with an accountant before this scales. These templates encode the
 * COMMERCIAL terms accurately. They do not certify that the relationship they
 * describe is correctly classified.
 */

import {
  COMPANY_TRACK_BPS,
  MANAGER_OVERRIDE_BPS,
  MAX_HUMAN_PAYOUT_BPS,
  PRICE_BOOK,
  SELF_TRACK_BPS,
  SPECIALIST_SPLIT_FLOOR_CENTS,
  UPSELL_SHARE_BPS,
  BELOW_BOOK_PENALTY_BPS,
  BELOW_FLOOR_PENALTY_BPS,
  VOLUME_ACCELERATOR,
  type Bps,
} from "@/lib/website-sales-comp";
import { CLAWBACK_WINDOW_DAYS } from "@/lib/turso-rpc-shim";

export type ContractRole = "opener" | "closer" | "manager" | "builder";

export type ContractVars = {
  /** Legal name of the contractor. */
  contractorName: string;
  contractorEmail: string;
  /** ISO date the agreement takes effect. */
  effectiveDate: string;
  /** Who they report to, for a manager override. Empty when nobody. */
  managerName?: string;
  companyName?: string;
  governingLaw?: string;
};

const pct = (bps: Bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const DEFAULT_COMPANY = "OASIS AI Solutions";
const DEFAULT_LAW = "the Province of Québec, Canada";

/**
 * The clauses EVERY agreement carries, so a term cannot be present in one and
 * quietly missing from another.
 *
 * `from` is the section number to start at, because the sales agreements have
 * three role-specific sections ahead of the boilerplate and the builder's has
 * five. An earlier draft got this by string-splitting the rendered output of
 * this same function — which worked until someone renamed a heading, and would
 * then have silently dropped whole clauses out of a signed contract.
 */
function commonTerms(v: ContractVars, from = 4): string {
  const company = v.companyName ?? DEFAULT_COMPANY;
  const n = (offset: number) => from + offset;
  return `
## ${n(0)}. When commission is earned

Commission is earned on **cash collected**, not on a signed proposal or an
invoice raised. A deal that is signed but unpaid earns nothing until the client's
money clears. This protects both parties: ${company} never pays out of pocket on
a deal that has not funded, and the Contractor is never asked to repay an advance.

Commission is calculated at the moment of collection and recorded as *accrued*.
Payment follows founder approval on the next payment cycle.

## ${n(1)}. Clawback

If a client refunds or charges back within **${CLAWBACK_WINDOW_DAYS} days** of
collection, the corresponding commission is reversed. After ${CLAWBACK_WINDOW_DAYS}
days it is final and will not be reclaimed, even if the client later refunds.

Reversals are recorded as offsetting entries — never by deleting the original —
so the Contractor can always reconstruct what was earned, what was reversed, and
why. Commission already **paid out** is not clawed back by ledger entry; recovery
of paid amounts, if any, is a matter for discussion between the parties.

## ${n(2)}. Total payout ceiling

Across all participants, commissions and fees on a single deal will never exceed
**${pct(MAX_HUMAN_PAYOUT_BPS)}** of the cash collected on it. Where a combination
of rates and bonuses would exceed that ceiling, each participant's share is
reduced proportionally, and the reduction is recorded on the payout record with
its reason. Base rates in this agreement are never reduced for any other cause.

## ${n(3)}. Independent contractor status

The Contractor is an independent contractor, not an employee. They control their
own hours, methods and location, supply their own equipment, and are responsible
for their own taxes, remittances and any applicable registrations. Nothing in
this agreement creates an employment, partnership, or agency relationship.

The Contractor invoices ${company}; ${company} does not withhold or remit source
deductions on their behalf.

## ${n(4)}. Confidentiality and non-solicitation

Client lists, pricing, pipeline data, prompts, playbooks and internal tooling are
confidential and remain ${company} property. During the engagement and for
12 months after it ends, the Contractor will not solicit ${company} clients they
were introduced to through this engagement, nor recruit its personnel.

## ${n(5)}. Intellectual property

Work product created for a ${company} client in the course of this engagement —
including sites, automations, copy and configuration — is assigned to ${company}
on creation. The Contractor retains no licence to reuse client-specific work.

Nothing here assigns the Contractor's pre-existing tools or general skill.

## ${n(6)}. Termination, and the tail

Either party may end this agreement on **14 days' written notice**, or
immediately for material breach.

Deals already **closed and collected** before termination are paid in full on the
normal cycle. Deals **in flight** — proposal sent, not yet collected — pay at the
agreed rate if they collect within **60 days** of termination. After that, no
further commission accrues.

## ${n(7)}. Governing law

This agreement is governed by the laws of ${v.governingLaw ?? DEFAULT_LAW}.

---

**${company}**

Signature: ______________________  Date: ____________

**${v.contractorName}** (${v.contractorEmail})

Signature: ______________________  Date: ____________
`.trim();
}

function priceTable(): string {
  const rows = Object.entries(PRICE_BOOK)
    .map(([id, t]) => {
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      const splits = t.floorCents < SPECIALIST_SPLIT_FLOOR_CENTS ? "Full-stack only" : "Yes";
      return `| ${name} | ${usd(t.floorCents)} | ${usd(t.bookCents)} | ${usd(t.builderFeeCents)} | ${splits} |`;
    })
    .join("\n");
  return `| Package | Floor | Book price | Build fee | Split roles? |
|---|---|---|---|---|
${rows}`;
}

function priceTerms(): string {
  return `
### Selling above or below book

Each package has a **book price** (the standard) and a **floor** (the lowest
price permitted without founder approval).

- **At or above book** — full rate, plus **${pct(UPSELL_SHARE_BPS)} of the amount
  above book price** on top. Selling well is rewarded directly.
- **Below book, at or above floor** — rate reduced by
  **${(BELOW_BOOK_PENALTY_BPS / 100).toFixed(0)} percentage points**.
- **Below floor** — requires founder approval in advance, and the rate is
  reduced by **${(BELOW_FLOOR_PENALTY_BPS / 100).toFixed(0)} percentage points**.

Discounting is permitted. It is simply not free.

### Volume accelerator

Measured on the Contractor's own collected revenue over the trailing 30 days.
Applies to commission rates only — not to flat build fees or manager overrides.

${VOLUME_ACCELERATOR.filter((b) => b.bonusBps > 0)
  .map((b) => `- **${usd(b.fromCents)}+ collected** — add ${(b.bonusBps / 100).toFixed(0)} percentage points`)
  .join("\n")}

### Small deals

Below **${usd(SPECIALIST_SPLIT_FLOOR_CENTS)}** collected, a deal is worked by one
person end to end rather than split between an opener and a closer. A split at
that size pays neither party properly. These deals are still commissionable in
full — they are not excluded.
`.trim();
}

function header(title: string, v: ContractVars): string {
  const company = v.companyName ?? DEFAULT_COMPANY;
  return `# ${title}

**Between:** ${company} ("${company}")
**And:** ${v.contractorName} ("the Contractor"), ${v.contractorEmail}
**Effective:** ${v.effectiveDate}
`;
}

const SOURCING = `
## 2. How a lead is sourced changes the rate

Two tracks, and which one applies is recorded on the deal at the time it closes.

- **Company-sourced** — ${DEFAULT_COMPANY} produced the lead through its funnel,
  marketing or inbound channels.
- **Self-sourced** — the Contractor found the client themselves.

Self-sourced work pays more, because the Contractor supplied what the company
otherwise pays to generate. The track is frozen when the deal closes; re-sourcing
a client later does not re-rate a deal that has already paid.
`.trim();

export function openerAgreement(v: ContractVars): string {
  return `${header("Appointment Setter (Opener) Agreement", v)}
## 1. The role

The Contractor sources and qualifies prospective clients, and books qualified
meetings for a closer or founder. A meeting counts as booked when the prospect
attends; no-shows may be rebooked and are not separately compensated.

${SOURCING}

## 3. Commission

| Track | Rate on cash collected |
|---|---|
| Company-sourced lead | **${pct(COMPANY_TRACK_BPS.opener)}** |
| Self-sourced lead, handed to a closer | **${pct(SELF_TRACK_BPS.opener)}** |
| Self-sourced, and the Contractor also closes it | **${pct(SELF_TRACK_BPS.open_close)}** |

If the Contractor opens a deal and someone else closes it, the Contractor is
still paid on it. Handing a deal off does not forfeit the commission, and the
Contractor keeps visibility of that deal until it is paid.

### Packages

${priceTable()}

${priceTerms()}

${commonTerms(v)}`;
}

export function closerAgreement(v: ContractVars): string {
  return `${header("Closer Agreement", v)}
## 1. The role

The Contractor runs the demo, the proposal and the close on qualified
opportunities, and owns the client relationship until the deal is collected and
handed to delivery.

${SOURCING}

## 3. Commission

| What the Contractor did | Rate on cash collected |
|---|---|
| Closed a company-sourced lead opened by someone else | **${pct(COMPANY_TRACK_BPS.closer)}** |
| Opened AND closed a company-sourced lead | **${pct(COMPANY_TRACK_BPS.full_stack)}** |
| Opened and closed a self-sourced lead | **${pct(SELF_TRACK_BPS.open_close)}** |
| Self-sourced, closed, and built it | **${pct(SELF_TRACK_BPS.full_stack)}** |

Where an opener booked the meeting, the opener is paid their own share
separately. The rates above are the Contractor's, not a pool to divide.

### Packages

${priceTable()}

${priceTerms()}

${commonTerms(v)}`;
}

export function managerAgreement(v: ContractVars): string {
  return `${header("Sales Manager Agreement", v)}
## 1. The role

The Contractor leads a team of openers and closers: coaching, pipeline review,
call quality, and accountability for the team's collected revenue. They also sell
personally.

${SOURCING}

## 3. Compensation

### 3a. Override on the team

**${pct(MANAGER_OVERRIDE_BPS)} of what ${v.companyName ?? DEFAULT_COMPANY} retains**
from deals closed by the Contractor's direct reports.

"What the company retains" means cash collected on the deal, less the opener,
closer and build compensation paid on it. The override is calculated after those
and never out of them — a teammate's commission is never reduced to fund this
override, and the override cannot make a deal unprofitable.

### 3b. Personal production

On deals the Contractor personally opens, closes or builds, they are paid at the
standard rates:

| What the Contractor did | Rate on cash collected |
|---|---|
| Opened a company-sourced lead | **${pct(COMPANY_TRACK_BPS.opener)}** |
| Closed a company-sourced lead | **${pct(COMPANY_TRACK_BPS.closer)}** |
| Opened and closed a self-sourced lead | **${pct(SELF_TRACK_BPS.open_close)}** |

Personal production is paid in addition to the override, not instead of it.

### Packages

${priceTable()}

${priceTerms()}

${commonTerms(v)}`;
}

export function builderAgreement(v: ContractVars): string {
  const tiers = Object.entries(PRICE_BOOK)
    .map(([id, t]) => `| ${id.charAt(0).toUpperCase() + id.slice(1)} | ${usd(t.builderFeeCents)} |`)
    .join("\n");
  return `${header("Builder (Delivery) Agreement", v)}
## 1. The role

The Contractor builds and launches the websites and automations sold by the sales
team: build, revisions within scope, client review, and launch.

## 2. Fees

A **flat fee per completed build**, by package tier. Build fees are not a
percentage of the sale, so a discounted deal does not reduce the Contractor's fee,
and a large deal does not inflate it. The fee reflects the work.

| Package | Fee per build |
|---|---|
${tiers}

A build is complete, and the fee earned, when the client approves and the site is
launched. Where a client goes silent after delivery, the build is treated as
complete **14 days** after handover for approval.

## 3. Scope and revisions

Each build includes **two rounds of revisions** against the agreed scope. Work
beyond the sold scope — additional pages, new automations, a redesign after
approval — is quoted separately and is not covered by the fee above.

## 4. When fees are paid

Build fees are earned on delivery and paid on the next payment cycle following
client approval.

Build fees are **not subject to the ${CLAWBACK_WINDOW_DAYS}-day commission
clawback**: the Contractor built the site, and a client's later refund does not
un-build it. Where a refund is issued for demonstrable defects in the build, the
parties will discuss remedy in good faith.

${commonTerms(v, 5)}`;
}

export const CONTRACT_BUILDERS: Record<ContractRole, (v: ContractVars) => string> = {
  opener: openerAgreement,
  closer: closerAgreement,
  manager: managerAgreement,
  builder: builderAgreement,
};

/** Render one agreement as Markdown. */
export function renderContract(role: ContractRole, vars: ContractVars): string {
  return CONTRACT_BUILDERS[role](vars);
}
