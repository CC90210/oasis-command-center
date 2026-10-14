# Money Finish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the Money invoicing workflow with maintainable customers, a clear founder-facing lifecycle, the specified bank-implementation-plus-Stripe-retainer hybrid mode, and safe one-time card links.

**Architecture:** Preserve the existing accounting status and ledger model. Add pure presentation-state derivation, soft-archive contact mutations, explicit validation for Stripe-only / bank-only / hybrid invoice rails, and a strict Stripe-link retirement/reissue invariant around out-of-band payments. Reuse the existing founder gate, entity checks, action route, invoice balance arithmetic, Stripe pinning, retainer link, and finance test harness.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Turso/libSQL, Stripe Payment Links, `node --import tsx` tests.

---

## Constraints

- No live payment, refund, payout-account, bank, or Stripe configuration mutation in this implementation.
- No hard customer delete. Historical invoices must remain readable.
- No stored-status migration. `draft/sent/overdue/paid/void` remains the accounting contract.
- A known one-time Stripe link must be confirmed inactive before a manual/Wise payment is recorded.
- Monthly retainer links are never changed by one-time split-payment handling.
- Use test-first changes and commit after each completed task.

## Task 1: Founder-facing lifecycle rules

**Files:** Modify `lib/founders-finances/invoice.ts`, `lib/founders-finances/invoices-io.ts`, `components/founders/finances/ui.ts`, `app/founders/finances/invoices/page.tsx`, `app/founders/finances/invoices/[id]/page.tsx`; test `tests/finances-invoice-retainer.test.ts`.

- [ ] Add failing pure tests for Issued, Partially paid, Paid, Draft, Void, retainer-only, and overdue-as-secondary-warning.
- [ ] Add `InvoiceDisplayStatus` and a pure derivation helper without changing stored/list status.
- [ ] Include `display_status` and `is_overdue` in invoice list/detail output.
- [ ] Replace UI labels and filters with Draft, Issued, Partially paid, Paid, Void, plus Retainer set up.
- [ ] Keep legacy `sent`/`overdue` filtering valid for internal callers.
- [ ] Run `node --conditions=react-server --import tsx tests/finances-invoice-retainer.test.ts`.
- [ ] Commit.

## Task 2: Customer edit, archive, and restore

**Files:** Modify `lib/founders-finances/invoice-store.ts`, `lib/founders-finances/invoices-io.ts`, `lib/founders-finances/page-context.ts`, `app/api/founders/finances/actions/route.ts`, `app/founders/finances/invoices/page.tsx`; create `components/founders/finances/CustomersManager.tsx`; test `tests/finances-io.test.ts` and surface/round-trip tests if needed.

- [ ] Add failing tests for tenant/entity isolation, validation, update, soft archive, restore, active selector exclusion, and historical invoice retention.
- [ ] Extend contact reads with `archived`, using one all-customers query on the invoice page and an active-only slice for invoice creation.
- [ ] Implement `updateContact` and `setContactArchived` with `requireRowEntity`, business-only enforcement, validation, and audit rows.
- [ ] Add `contact.update`, `contact.archive`, and `contact.restore` action handlers.
- [ ] Build a compact customer manager with edit/save, archive confirmation, archived section, and restore.
- [ ] Prove invoice-page round trips remain inside the acceptance ceiling.
- [ ] Run focused tests and commit.

## Task 3: Make the three payment modes honest and close the stale-link overcharge path

**Files:** Modify `lib/founders-finances/invoices-io.ts`, `lib/founders-finances/wise-reconcile.ts`, and `lib/founders-finances/stripe-ingest.ts` only if the shared helper belongs there; test `tests/finances-invoice-retainer.test.ts` and `tests/finances-wise.test.ts`.

- [ ] Add failing tests for the product contract: Stripe only creates the one-time card link; Bank/Wise only requires one-time bank-paid lines and creates no card link; Hybrid requires a one-time implementation amount plus a monthly retainer, prints bank instructions for the former, and creates only the recurring Stripe link for the latter.
- [ ] Keep the stored `wise_stripe` value for compatibility but change its label/behavior to Hybrid; reject incomplete mode/line combinations in plain English.
- [ ] Add a failing safety test: issue a Stripe-only invoice with a full-value one-time link, record an out-of-band partial payment, and prove the original link cannot remain active or be reused.
- [ ] Add a failing test: after that partial payment, sending again creates a link for exactly the remaining balance and switches off/rejects the old link.
- [ ] Add a failing test: when Stripe cannot confirm link deactivation, the external payment is not recorded and the invoice balance is unchanged.
- [ ] Generalise link validation so issued links are checked for active/unused state, exact current balance, and currency before reuse.
- [ ] Add a shared pre-payment retirement helper: disable the one-time link, clear its stored fields only after confirmation, and fail closed on Stripe errors.
- [ ] Call it before manual and Wise payment writes. Keep retainer fields untouched.
- [ ] Update `wise_stripe` copy to “Hybrid — implementation by bank + monthly retainer by card” and surface the resend-new-balance step for out-of-band payments on Stripe-only invoices.
- [ ] Run focused retainer/Wise tests and commit.

## Task 4: Money regression and acceptance gates

**Files:** Test files plus any surgical fixes discovered by the gates.

- [ ] Run `npm run test:finances`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run the repository's ten-check acceptance sequence from `docs/BUILD_ACCEPTANCE_STANDARD.md`, including production build.
- [ ] Run a browser smoke for customer edit/archive/restore, lifecycle filters, partial bank payment, and refreshed remaining-balance card link using non-money-moving test fixtures.
- [ ] Review the full diff against the design; run an independent adversarial review and resolve every P0/P1 finding.
- [ ] Commit the verified release, push through the repository's required branch/PR path, deploy, and verify production routes.

## Definition of done

- A founder can add, edit, archive, restore, and select active customers.
- Invoices visibly progress Draft → Issued → Partially paid → Paid, with overdue shown as a warning and Void preserved.
- Hybrid visibly combines a bank-paid one-time implementation with a card-paid monthly retainer on one invoice.
- A partial out-of-band payment cannot leave a known full-value one-time card link live.
- A replacement card link charges exactly the remaining balance.
- Finance tests, typecheck, lint, build, acceptance checks, browser smoke, independent review, and production verification all pass.
