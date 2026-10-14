# Money, Guided Automations, and Agent Training Design

**Date:** 2026-10-14
**Owner:** Bravo / CC
**Repo:** `CC90210/oasis-command-center`
**Status:** Approved direction; Money is the first vertical release

---

## 1. Outcome

Three unfinished operator surfaces become usable workflows:

1. **Money** becomes safe enough to run invoicing from: customers can be maintained, invoice state reads like a real billing lifecycle, and a hybrid invoice cleanly separates the high-ticket bank payment from the monthly Stripe retainer.
2. **Automations** becomes a guided builder instead of a chat box plus a technical cron inventory.
3. **Agent training** lets an operator choose an actual agent, attach a URL or text resource with a purpose, review it, and apply it to that agent's runtime context.

Each surface ships as a complete vertical release in that order. A later surface must not delay an earlier one that is ready to use.

## 2. Evidence from the current product

- Money's ledger, reports, invoices, Stripe ingest, Wise matching, and accounting invariants are already substantial and have a green finance suite. The missing work is the operator lifecycle around them.
- `wise_stripe` currently means “bank **or** card.” A partial bank payment leaves the issued Stripe Payment Link at the original full amount because issued links are blindly reused. That is an over-collection risk.
- Finance contacts are create/list only even though `fin_contacts.archived` already exists.
- Stored invoice states are accounting states (`draft`, `sent`, `overdue`, `paid`, `void`). The UI exposes those implementation words instead of the founder-facing lifecycle.
- Automations already has schedule parsing, device/server dispatch, department-task safety rails, connector truth, and run receipts. The missing layer is the guided builder, templates, safe test, and activation flow.
- Agent Training currently saves general marketing notes. It has no agent selector and no agent runtime reads those notes. Calling that “training” is inaccurate until the selected agent consumes the resource.

## 3. Money design

### 3.1 Customer management

The Invoices page keeps a single customer query and presents two groups:

- **Active customers:** edit name, billing email, company, and address; archive when no longer used.
- **Archived customers:** hidden from new invoice selectors but retained on historical invoices; can be restored.

Archive is soft. Nothing deletes invoice history or Stripe customer linkage. Every mutation remains founder-gated and checks the contact belongs to the OASIS business book.

### 3.2 Founder-facing invoice lifecycle

Accounting storage stays compatible. A pure presentation rule derives:

| Founder sees | Stored/effective facts |
|---|---|
| Draft | stored `draft` |
| Issued | issued, amount paid is zero |
| Partially paid | `0 < amount_paid < total` |
| Paid | total covered |
| Void | stored `void` |
| Retainer set up | issued invoice with no one-time amount due |

“Overdue” is a secondary warning on Issued or Partially paid, not a competing lifecycle state. Filters use the founder-facing labels while internal finance-summary compatibility keeps the existing stored/list status.

### 3.3 Three explicit payment modes

The original directive defines the modes precisely:

- **Stripe only:** the one-time amount is paid through a Stripe Payment Link; monthly lines, if present, use the separate recurring Stripe link.
- **Wise / bank wire only:** the invoice contains one-time lines paid by bank transfer. It does not silently create a card checkout.
- **Hybrid (split payment):** the high-ticket one-time implementation amount is paid by Wise/wire, while the monthly retainer is started through its recurring Stripe link on the same invoice.

The stored `wise_stripe` value remains for database compatibility but its product meaning becomes **Hybrid**, not “choose bank or card for the same one-time amount.” Hybrid requires both a one-time amount and a monthly retainer; a bank-only invoice cannot contain a Stripe monthly line. Existing drafts that do not satisfy the selected mode stay editable and receive a plain-English validation message rather than silently changing rail.

### 3.4 One-time card-link safety

A separate safety guard covers the real-world case where an out-of-band bank/manual payment is recorded against a Stripe-only invoice. Such a payment may reduce the balance even though a full-value card link was previously sent.

Safety invariant:

> At every point, the live one-time Stripe link must charge exactly the current unpaid balance, or no one-time link may be live.

Implementation rules:

1. Before recording any external/manual or Wise payment against an invoice with a one-time Stripe link, deactivate that link through the pinned Stripe account.
2. If Stripe cannot confirm the link is disabled, fail closed with a plain-English instruction. Do not write a payment while a known full-value card link may remain live.
3. After Stripe confirms deactivation, clear the stored one-time link/price fields, then record the payment atomically with the ledger posting.
4. “Send again” creates a fresh one-time link for the new balance. Issued links are verified for active/unused state, amount, and currency before reuse; issued status is never a reason to reuse blindly.
5. The UI labels `wise_stripe` as **Hybrid — implementation by bank + monthly retainer by card**. A Stripe-only invoice tells the founder when an updated remaining-balance link must be sent after an out-of-band payment.
6. Monthly retainer links remain separate and untouched.

This does not require a schema migration: the invoice already stores total paid, the live balance is derived, and link replacement fields already exist.

### 3.5 Money operational readiness

Code must not silently mutate live payout-account choices, payment instructions, or move money. The UI may show their readiness, but those production choices remain explicit founder actions.

## 4. Guided Automations design

The default creation path is a five-step builder:

1. **Department** — choose Operations, Sales, Marketing, Finance, or Support.
2. **Job** — choose a versioned template or describe the objective, then fill structured inputs, output, and schedule. Show the next run times in Toronto time.
3. **Connections** — auto-bind required connected services and show exact repair links for anything missing. Never expose secrets.
4. **Runs on** — choose Cloud or an eligible connected machine. Revalidate ownership and presence on activation and every dispatch.
5. **Review** — save paused, run a preview-only test with a receipt, then explicitly activate.

The existing plain-English/script composer remains available under **Advanced**. It is not the primary experience.

The builder writes the existing `tenant_cron_jobs` shape with `action_type=department_task` and a validated payload carrying the template/version, department, inputs, allowed tools, outputs, target, approval policy, and runtime cap. A dispatcher claims due work atomically and uses the existing run engine and `dept_chat_runs` receipt ledger. Outbound actions remain proposal-only unless an existing approval gate authorizes them.

## 5. Agent Training design

The default flow is:

1. **Select agent** — start with the agents the connected harness can actually run: Bravo, Maven, and Atlas.
2. **Add resource** — URL or pasted text, plus a required purpose (“what should this agent learn/use this for?”).
3. **Review & apply** — show the extracted, injection-fenced content; apply it to one or more selected agents.

Training resources and agent assignments are separate records so one resource can train several agents without duplication. Each assignment shows Processing, Ready, Failed, Paused, or Removed.

“Ready” means the selected agent's prompt/context loader can retrieve that resource for the same tenant. The bounded context loader is wired into both department-agent API turns and retained computer/chat resume paths. Unknown agents fail closed; no unrecognised identifier may silently fall back to Bravo.

## 6. Shared security and quality rules

- Derive tenant, operator, and agent identity server-side; never trust browser-supplied tenant IDs.
- Treat fetched URLs and pasted resources as untrusted data and fence them before model use.
- Save new automations paused. Testing is preview-only and cannot send, publish, charge, or delete.
- Preserve every existing finance double-entry, idempotency, entity-scope, and Stripe account-pinning invariant.
- Each vertical release needs focused tests, typecheck, lint, production build, browser smoke, independent review, and a production route check before it is called done.

## 7. Release order

1. **Money:** customer maintenance, lifecycle, split-payment safety, production verification.
2. **Automations:** wizard, templates/payload, preview test, dispatcher/activation, production verification.
3. **Agent Training:** resource/assignment storage, workbench, runtime consumption, production verification.

The Google Ads purchase conversion label is a separate deployment dependency. The repository and prior handoffs contain the corrected tag ID `AW-18509362419` but no conversion-action label suffix. The success page must not invent one; it remains explicit configuration once recovered from Google Ads.
