# Public Funnel, Finance, Vault, and Automation Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the four public offer surfaces and close the verified lifecycle gaps in Finances, the credential vault, and automation creation without regressing public booking or machine pairing.

**Architecture:** Keep the existing public form, invoice ledger, encrypted tenant credential, and bridge scheduler systems as the sources of truth. Add only the missing domain transitions and tenant-scoped metadata: offer content remains draft-gated, invoice partial state stays derived from reconciled payments, credentials are probed only on the server, and automation templates bind to an active tenant pairing while legacy untargeted jobs keep their current executor rules.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind semantic tokens, Turso/libSQL through the existing Supabase-compatible server adapter, Node test harnesses.

---

### Task 1: Standardize the four OASIS offers

**Files:**
- Add: `content/offers/oasis/ai-audit.json`
- Move/modify: `content/offers/oasis/protocol.json` -> `content/offers/oasis/protocols.json`
- Modify: `content/offers/oasis/command.json`
- Modify: `content/offers/oasis/fleet.json`
- Modify: `content/offers/oasis/vsl.json`
- Modify: `scripts/seed-oasis-offer-pages.ts`
- Modify: `app/f/[tenant_slug]/[form_slug]/page.tsx`
- Modify: `tests/offer-pages-oasis-content.test.ts`

1. Add a conversion-structured AI Audit page backed by the existing `ai-audit` form.
2. Make `protocols` the canonical slug while permanently redirecting the old singular route.
3. Bind approved CMO library assets to the four hero facades with explicit rights metadata.
4. Keep all pages draft-only and claim-gated; do not invent testimonials, results, or guarantees.
5. Verify parser, seed idempotency, video references, canonical slugs, and 15/45-minute booking contracts.

### Task 2: Complete invoice and customer lifecycle controls

**Files:**
- Modify: `lib/founders-finances/invoice.ts`
- Modify: `lib/founders-finances/invoices-io.ts`
- Modify: `lib/founders-finances/wise.ts`
- Modify: `components/founders/finances/ui.ts`
- Add: `components/founders/finances/CustomerManager.tsx`
- Modify: `app/founders/finances/invoices/page.tsx`
- Modify: `app/founders/finances/invoices/[id]/page.tsx`
- Modify: `app/api/founders/finances/actions/route.ts`
- Modify: `tests/finances-core.test.ts`
- Modify: `tests/finances-io.test.ts`
- Modify: `tests/finances-surface.test.ts`

1. Derive `partially_paid` from reconciled payment totals without weakening the stored invoice status constraint.
2. Add tenant/book-scoped customer update and archive actions; archive instead of deleting so historical ledger references remain valid.
3. Add draft-only invoice deletion that atomically removes lines and the unissued invoice, writes an audit event, and refuses issued/payment-bearing invoices.
4. Clarify the existing Stripe, Wise/wire, and hybrid payment labels while preserving the proven reconciliation and retainer flows.
5. Add responsive customer edit/archive UI and a draft delete action.

### Task 3: Add server-only Shopify, Wise, and Higgsfield health checks

**Files:**
- Add: `lib/credential-vault/service-checks.ts`
- Add: `app/api/credentials/custom/status/route.ts`
- Modify: `components/settings/CustomCredentialsVault.tsx`
- Add: `tests/credential-vault-status.test.ts`
- Modify: `package.json`

1. Define exact required vault keys and sanitized provider status shapes.
2. Read encrypted values only inside the route, with no environment fallback and no value in the response.
3. Probe each official provider endpoint with bounded timeouts; treat only authenticated provider responses as healthy.
4. Add vault setup cards and per-provider Test connection controls using presence-only key state.
5. Verify tenant scoping, no-secret serialization, timeout behavior, and official authentication headers.

### Task 4: Replace automation free-text entry with a deterministic pipeline wizard

**Files:**
- Add: `database/turso/bravo__225_automation_templates.sql`
- Add: `lib/automations/pipeline.ts`
- Modify: `components/automations/DescribeAutomationFlow.tsx`
- Modify: `app/api/automations/draft/route.ts`
- Modify: `app/api/automations/save-draft/route.ts`
- Modify: `app/api/cron-jobs/poll/route.ts`
- Companion runtime: `CEO-Agent/bravo_cli/cron_runner.py`
- Companion test: `CEO-Agent/scripts/tests/test_cron_runner_generated_script.py`
- Add: `tests/automation-pipeline-migration.test.ts`
- Modify: `package.json`

1. Collect department, trigger/schedule/input/output, connector needs, and a live active target pairing in four deterministic steps.
2. Convert the structured answers into the existing AI drafter input while keeping generated code reviewable and disabled by default.
3. Persist the reviewed definition to tenant-scoped `automation_templates` and bind the cron row to the selected pairing.
4. Filter only explicitly targeted rows by pairing; preserve current behavior for every legacy row with no target.
5. Validate the pairing against the authenticated tenant, active status, owner rules, daemon scope, and heartbeat freshness before saving.
6. Carry reviewed source through the exact-pairing pull path and atomically materialize it on that daemon before execution; never push it through the tenant-level bridge proxy.

### Task 5: Verification and branch lock

**Files:**
- Modify only files revealed by failing checks within the claimed scope.

1. Run focused offer, finance, credential, and automation tests.
2. Run `npx tsc --noEmit`, the UI slop gate, and `npm run build`.
3. Run `git diff --check`, inspect the full diff, and perform the required independent Codex review.
4. Commit and push the completed branch only after every required gate is green.
5. Sync Business-Empire-Agent state/session notes and release coordination leases.
