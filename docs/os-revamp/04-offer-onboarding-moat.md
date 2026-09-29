# OASIS OS: offer packaging, onboarding, data moat and go-to-market readiness

Plan mode, 2026-09-28. Read-only design. Nothing here has been edited, committed or deployed. Code references were checked against `origin/main` of `C:\Users\User\APPS\oasis-command-center` (OCC), local ref 20732c31. The primary checkout is 2 commits behind that ref, on a stale branch. BEA means `C:\Users\User\Business-Empire-Agent`. The same design is saved at `C:\Users\User\.claude\plans\pasted-content-id-eb3a-we-ve-been-tranquil-pascal-agent-a32974ceb0dd7fa00.md`.

## 0. Summary

1. **Entitlements cannot live in the manifest.** A tenant's owner or admin can rewrite its whole manifest (`app/api/manifest/[slug]/route.ts:112-137`), and `manifest.tier` is "pure metadata, no enforcement" (`lib/manifest/schema.ts:316-320`). Tier gating therefore needs a new table that only operators can write, `tenant_entitlements`. The effective feature set is **what was bought ∩ what the manifest turns on ∩ what the viewer's persona may see**, and it is checked on the server in every route and cron. Hiding a nav row is not enforcement.
2. **The install should be built on parts that already work, not the broken wizard:**
   - hashed-token invites (`/invite/[token]`), plus a new owner-claim invite kind
   - the OASIS delivery board, since `delivery_projects.client_tenant_id` already models "a hosted client with its own workspace" (`database/turso/183_delivery_and_support.turso.sql:17-19,63-68`)
   - the real `provisioning_runs` table (183:42)
   - the consent-text-pinned intake form pattern (`lib/forms/oasis-client-onboarding-seed.ts:78`)

   **Retire** `/onboarding/wizard`, open `/signup`, `stripe-provision`, and both BEA provisioning scripts. The scripts hard-code the SunBiz shell and Supabase auth.
3. **Industry packs are versioned data bundles** (stages, forms, KPIs, skills, routines, agreements, objection taxonomy) applied by one `applyPack()`. They never carry tenant data and never fork code. Ship **agency/consulting** first (OASIS dogfoods it), then **home services**, **coaching/education**, and **clinic/practice** (the last only after Lex reviews health data).
4. **The moat is outcome-labelled records.** The chain is ad angle → booked → objection → closed → **paid (verified in Stripe)** → retained, written to a tenant-scoped, append-only `outcome_events` ledger. Today's status events are best-effort and go to `agent_events`, which has no `tenant_id`. The system learns per tenant through retrieval. Cross-tenant use is anonymized aggregate benchmarks only: opt-in, k ≥ 10, OASIS-native metrics only, never model training. **SunBiz's data is never harvested.**
5. **Five go-to-market blockers that are not UI work:**
   - **The privacy page makes false statements.** It claims row-level security (`app/(marketing)/privacy/page.tsx:238`). It lists Supabase and Vercel as subprocessors (`lib/legal/constants.ts:69,77`). It cites a missing audit doc (`constants.ts:61`). It names no privacy officer.
   - **GST/QST.** OASIS is a small supplier (`lib/founders-finances/tax.ts:4`). Two or three installs cross the CA$30K-per-quarter test. A taxed retainer is refused (`invoice.ts:281-282`).
   - **Client Stripe keys.** The Stripe connector asks clients for a full `sk_live_` key (`lib/tenant-integration-schemas.ts:134`), which breaks "no money movement".
   - **AI metering has no source.** Session token totals are overwritten on every turn (`app/api/chat/route.ts:857-859`).
   - **Document extraction runs on CC's subscription** (`lib/ai-document-extractor.ts:6-13`).

---

## 1. Code facts this design depends on

| # | Fact | Evidence | Consequence |
|---|---|---|---|
| F1 | Tenant owners and admins can rewrite their entire manifest, including `tier`, `agents`, `pages` and `required_services`. So can the AI editor. | `app/api/manifest/[slug]/route.ts:112-137`; `lib/manifest/guards.ts:67-81` | Gating stored in the manifest can be edited by the client. |
| F2 | `tier` is "pure metadata, no enforcement". Template price hints ($49, $99) are stale. | `lib/manifest/schema.ts:316-320`; `lib/manifest/templates.ts:111,421,490` | Tier is not a gate. |
| F3 | The wizard drops most answers and never links the manifest to the tenant. The unknown-slug fallback is CC's nav. | `lib/manifest/wizard-finalize.ts:86-150`; `lib/manifest/seeds.ts:900-903` | Rebuild. |
| F4 | `stripe-provision` checks no signature, trusts `client_reference_id` from the request body and "simulates" progress. | `app/api/webhooks/stripe-provision/route.ts:4-29` | Delete it and replace with a verified billing webhook. |
| F5 | Invites cannot mint an owner (`team_role: Exclude<TeamRole,"owner">`). | `lib/team.ts:235,247` | A provisioning-only owner-claim invite is needed. |
| F6 | Readiness checks only that a key is present ("Key on file"). It fails every tenant with no local bridge, and it has a SunBiz lender check. | `lib/setup-readiness.ts:181-191,226-256,196-224` | Levels need live probes. Bridge and lender checks must not appear for OS tenants. |
| F7 | The Stripe connector asks for a full secret key. | `lib/tenant-integration-schemas.ts:134` ("starts with sk_live_") | Client Finance must accept restricted `rk_` keys only. |
| F8 | Env-credential fallback is fenced for Stripe only. | `lib/tenant-integration-store.ts:184-193` | Phase 0 must fix this before any client tenant exists. |
| F9 | Chat writes per-turn tokens to `chat_messages` with a `tenant_id`, but overwrites the session totals each turn. `estimateCostUsd` is private to the route. | `lib/chat-persistence.ts:122-127`; `app/api/chat/route.ts:853-859,910` | AI metering needs a ledger at the provider-call chokepoint. |
| F10 | Record status events are best-effort (errors swallowed) and go into `agent_events`, keyed by `correlation_id`, with no `tenant_id`. | `lib/manifest/events.ts:1-26` | Outcome capture needs its own tenant-scoped, non-lossy ledger. |
| F11 | OASIS is not registered for GST/QST. The small-supplier test is CA$30K in one quarter or across four. A taxed monthly retainer is refused until the Stripe ingest splits out tax. | `lib/founders-finances/tax.ts:4,14-24`; `invoice.ts:272-285`; `docs/FINANCES_SUITE.md:29,173` | Atlas must resolve this before the first OS invoice cycle. |
| F12 | The invoice flow bills a one-time implementation fee by Wise transfer and a monthly retainer through a Stripe recurring link. Payment links carry `metadata[fin_invoice_id]`. | `lib/founders-finances/invoice.ts:9-16`; `invoices-io.ts:755-771` | Reuse this for Setup and Managed billing. |
| F13 | The privacy page claims "row-level security" (Turso has none). Subprocessors still list Supabase and Vercel. `LEGAL_COMPLIANCE_AUDIT.md` is cited but does not exist. The only contact is `privacy@`, with no named person. The Lex ToS also claims RLS. | `app/(marketing)/privacy/page.tsx:238`; `lib/legal/constants.ts:36,61,69,77`; `Lex-Agent/legal/TERMS_OF_SERVICE.md §4` | Correct these before selling. They are false statements, not styling issues. |
| F14 | Document extraction runs on a VPS daemon using CC's Claude subscription. | `lib/ai-document-extractor.ts:6-13` | Turning a client's SOPs into skills must use the managed client runtime. |
| F15 | BEA `provision_client_tenant.py` hard-codes `command_center_profile_slug:"sun"` and `solara/helios`, and uses Supabase auth-admin. `provision_secrets.py` is one VPS per tenant, with SunBiz defaults. | BEA `scripts/provision_client_tenant.py:44-52,99,130,137-138`; `scripts/provision_secrets.py:85,102-111,228` | Neither script fits. Retire both with SunBiz. |
| F16 | Delivery projects and tasks, tickets, SLA and `provisioning_runs` exist. `client_tenant_id` models a hosted client workspace. | `database/turso/183_delivery_and_support.turso.sql:17-19,42,63-88`; `lib/delivery/rules.ts:17` | The install console can be the OASIS tenant's own Projects board. |
| F17 | Payment verification per tenant already exists for website deals. | `app/api/cron/reconcile-website-sales-payments/route.ts`; `lib/website-sales-payment-reconciliation.ts` | This is the pattern for "win verified by payment" (Cook uses Whop for this). |
| F18 | Consent text is an exported constant pinned by a test. The voice/taste questions are already written. | `lib/forms/oasis-client-onboarding-seed.ts:78` (+ voice step ~288-340) | Reuse both for the interview and for DPA/send-on-behalf consent. |
| F19 | A URL ingest classifier exists (YouTube, IG, TikTok, GitHub, web). | `lib/founders/ingest-core.ts` | Front door for SOP/YouTube-to-skill ingestion. |
| F20 | The agent library's Bravo entry lists `edit_file` and `search_repo`. Categories include sales, support, research, content, finance, legal and operations. | `lib/agents/library.ts:18-35,91` | Department agents need new, neutral templates with restricted palettes. |
| F21 | The seat warning is a soft banner only ("No hard block"). | `lib/seat-warning.ts:1-8` | DIY seat caps need a hard check at invite creation. |
| F22 | New Worker crons must be added to `CRON_TABLE`, which mirrors `config/cron-registry.json`. | `workers/oasis-cc-cron/src/index.ts:15-49` | Every cron in this design is registered in both places. |

---

## (a) Tiers mapped to capabilities

### a.1 What each tier gets

Prices are fixed by CC's decisions. Seat counts, AI budgets and support hours below are **placeholders for Atlas to validate** (§a.6).

| | **DIY** $497/mo | **Setup** $2,500 once + $997/mo | **Managed** $5,000 once + $2,500-3,500/mo |
|---|---|---|---|
| Who installs | The owner, using the same guided install OASIS staff use (§b) | An OASIS installer, 14-day done-for-you install | An OASIS installer, then a named OASIS operator |
| Who runs it after | The owner | The owner, with 30 days of hypercare | OASIS runs ads, the setter and content on the platform, with approvals |
| **Today / Chief of Staff** | ✓ | ✓ | ✓ |
| **Sales** (Pipeline, follow-up drafts, booking, approvals) | ✓ | ✓ | ✓ + an OASIS setter works the queue (human-approved) |
| **Marketing** (Funnels & Forms, email, campaigns) | ✓ | ✓ | ✓ + OASIS runs campaigns |
| **Content** | Text only (ideas, scripts, captions) | Text + images within the AI budget | + OASIS produces, video by booked GPU slot (one queue) |
| **Client Success** (Clients tab: customers, tickets + SLA, projects, agreements/e-sign, portal) | ✓ | ✓ | ✓ + OASIS runs the weekly health sweep |
| **Finance cockpit** (Stripe restricted key, CSV/OFX, QuickBooks/Xero), read-only | ✓ | ✓ + categories and chart configured by OASIS | ✓ + a monthly CFO brief, prepared by Atlas and reviewed by a human |
| **Research** | Weekly market brief (a pack routine) | ✓ on demand | ✓ + OASIS competitor breakdowns |
| **Operations** (routines, connection health) | Pack routines only (toggle on/off) | + chat-built custom routines | + OASIS maintains the routines |
| **Legal** (Lex drafts, then e-sign) | ✗ | Opt-in, after the attorney-reviewed ToS exists | Opt-in |
| **Commissions** (opt-in module) | Self-configured from a template | Configured by OASIS | Managed |
| **Bank feeds** (Plaid Trial, then pay-as-you-go) | Add-on, passed through | Passed through, set up by OASIS | Passed through |
| **Meta Ads** | Read insights, after Meta App Review | Read + create ads **PAUSED** with approval | OASIS operates. During the review wait, pilots use partner access to OASIS's Business Manager |
| **Twilio SMS/voice** | OASIS ISV subaccount (passed through) or bring your own Twilio. The owner runs the A2P wizard | OASIS files A2P | Same as Setup |
| **Meeting capture** | Fathom/Fireflies connector (free API); Recall bot passed through | Same, configured by OASIS | + call reviews by OASIS |
| **Slack/Discord bridge** (notifications + approvals only) | ✓ | ✓ | ✓ |
| **Seats included** (placeholder) | 3 (hard cap; extra seats sold) | 10 | 25 (OASIS operator seats not counted) |
| **Included AI budget** (model cost at OASIS's contracted rates; placeholder) | ~8% of fee (≈$40) | ~10% (≈$100) | ~10% (≈$300) |
| **Bring your own model key / subscription connector** | ✓ (not counted against the budget) | ✓ | ✓ |
| **Support** | In-app ticket to OASIS's own help desk, first response within 2 business days; Loom/doc library | Named installer, 30-day hypercare, 1 business day | Named operator, 4 business hours; weekly ops review; monthly QBR |
| Levels reachable (§b.4) | All | All | All |

Two design rules:
- **The plan caps modules, not levels.** Cook caps levels by plan. We don't, because a DIY owner who reaches Level 3 is the best upgrade lead.
- **DIY is still invite-or-checkout.** No open signup (§b.1).

### a.2 Where the gate lives: four layers, all enforced on the server

1. **Entitlement: what was bought.**
   - New table `tenant_entitlements`: `tenant_id` PK, `plan` ∈ {`diy`,`setup`,`managed`,`internal`,`demo`}, `status` ∈ {`provisioning`,`active`,`past_due`,`read_only`,`canceled`}, `seats_included`, `ai_budget_cents_monthly`, `modules` JSON (explicit booleans per `ModuleKey`), `stripe_customer_id`, `stripe_subscription_id`, `go_live_at`, `updated_by`, `updated_at`.
   - Every change also writes an `entitlement_audit` row.
   - **Only two writers:** the verified billing webhook and `/admin` operator routes. The server layer is `lib/entitlements/store.ts`.
   - **No row means no access**, except Settings › Billing and the "awaiting activation" page. This fails closed, which also removes the CC_NAV fallback for unknown tenants.
2. **Configuration: what the owner turned on.**
   - The manifest gains `departments[]` and `modules{}` toggles. The shell/IA workstream owns their shape.
   - `lib/entitlements/gate.ts` computes `effective = entitled ∩ enabled`.
   - A manifest POST (`app/api/manifest/[slug]/route.ts`) or AI-editor change that enables an un-entitled module is **rejected with 403 `module_not_entitled`**. It is not silently ignored.
   - Test: `tests/entitlements-manifest-cannot-escalate.test.ts`.
3. **Persona: who inside the tenant may see it.**
   - Extend `SurfaceCapabilities` (`lib/role-surfaces.ts:89-129`) with per-department flags, e.g. `canSeeFinanceDepartment`. Finance defaults to owner-only, reusing the `canSeeCompanyFinancials` rule, so OASIS's own books are visible only to its founders.
   - Add a `department_access` JSON on `user_profiles` so an owner can grant, say, Marketing to a contractor.
   - Unknown role falls back to `readonly`, as today.
4. **Readiness: is it connected.**
   - `required_services` is **generated** from (pack ∪ entitled modules) at pack apply and on every entitlement change. It is not hand-edited.
   - `ManifestRequiredServiceKind` (`schema.ts:393-396`) gains `oauth_connection`, `live_probe` and `milestone`.
   - Disconnected numbers render "not connected". They never render as $0.

**Enforcement points.** Each of these calls `requireModule(ctx, key)` from `lib/entitlements/gate.ts`:

| Surface | What gets gated |
|---|---|
| Server components | Each department page |
| API routes | Every route under a module (`/api/finance/*`, `/api/meta/*`, `/api/sms/*`, `/api/meetings/*`, `/api/commissions/*`) |
| OAuth start routes | You cannot connect Meta if Meta isn't entitled |
| Routine runner | Before each run, so a downgraded tenant's SMS routine stops at the next tick |
| AI runtime | `assertAiBudget()` |
| Invite creation | `app/api/team/invites/route.ts`: hard seat cap for `diy`; soft cap plus automatic extra-seat billing for `setup`/`managed` |

The layout nav filter is cosmetic only.

**Module keys** (`lib/entitlements/plans.ts`, pure, holds the per-plan defaults):
- Departments: `dept.sales`, `dept.marketing`, `dept.content`, `dept.client_success`, `dept.finance`, `dept.research`, `dept.operations`, `dept.legal`
- Modules: `mod.commissions`, `mod.bank_feeds`, `mod.accounting_sync`, `mod.meta_ads_read`, `mod.meta_ads_write`, `mod.sms`, `mod.meeting_capture`, `mod.slack_bridge`, `mod.client_portal`, `mod.esign`, `mod.helpdesk`, `mod.custom_routines`, `mod.media_generation`, `mod.benchmarks_optin`
- Chief of Staff and Settings are always on.

**Lifecycle:**
- `past_due`: 7-day grace, then `read_only`. Outward actions stop immediately.
- `canceled`: read-only for 30 days with export, then the Law 25 destruction schedule. Deletion runs need CC's confirmation at execution time.
- OASIS's own tenant is `plan='internal'`. The demo tenant is `plan='demo'`, and every moat and benchmark job excludes it.

### a.3 Finance v1 stays read-only in code, not just in policy

- **Client tenants must use a restricted key.** For any non-`internal` tenant, the Stripe connector accepts only `rk_live_`/`rk_test_` keys. Change the schema hint at `lib/tenant-integration-schemas.ts:134` and validate the prefix on the server. Setup shows the exact read scopes to tick (Charges, Customers, Subscriptions, Invoices, Balance, Payouts: Read).
- A full `sk_` key from a client is refused with an explanation. Decision 2 ("no money movement") thereby becomes a code invariant.
- Plaid is read-only products only. The adapter exposes no transfer or payment methods (`lib/finance/bank/plaid.ts`), behind a swappable `BankFeedAdapter` interface ready for Flinks or CDBA.

### a.4 AI usage caps

- **One ledger at the provider-call chokepoint.** Add `ai_usage_ledger` (`tenant_id`, `source` ∈ chat|routine|extraction|skill_ingest, `department`, `provider`, `model`, `input_tokens`, `output_tokens`, `cost_cents` at OASIS's contracted rate table, `key_source` ∈ managed|byo|subscription_connector, `created_at`). Write it in `lib/providers.ts` / `lib/cloud-tool-runner.ts` and the routine runner, not in the chat route.
  - Move `estimateCostUsd` from `app/api/chat/route.ts:910` into `lib/ai/cost.ts`.
  - Do not meter from `chat_sessions`: its totals are overwritten every turn (F9).
- **Pre-call check.** `assertAiBudget(tenantId)` compares month-to-date managed spend with the budget. When the budget is reached, the department channel says so plainly ("AI budget reached. Approve overage at cost+X% or connect your own key"). **It never falls back silently to a free or VPS model.** Free-tier data use is unverified (brief 7.6), and a silent swap would breach the DPA's no-training promise.
- **Owner controls.** Settings › Billing has an owner-set overage cap (Cook's "AI spend cap" pattern).

### a.5 Pass-through billing on OASIS's own Stripe account

**How the core fees are billed:**
- **DIY:** Stripe Checkout, subscription mode, on OASIS's account, created by OASIS's Sales department per qualified lead. Metadata `os_install_id` is set on the server; the body is never trusted.
- **Setup / Managed:** the existing Finances invoice. The one-time implementation line is paid by Wise transfer; the monthly line is a Stripe recurring link (F12).
  - The recurring link must also carry `subscription_data[metadata][os_tenant_id]` so the billing webhook can map subscription → tenant.
  - Provisioning for Setup/Managed is started by the operator at kickoff, not by a payment webhook, because Wise isn't a Stripe event. Wise payment is matched by `wise-reconcile.ts` as today.

**New verified webhook `app/api/webhooks/stripe-billing/route.ts`:**
- Own secret `STRIPE_BILLING_WEBHOOK_SECRET`, pushed with `wrangler_tool secrets-push`. Signature verified like `stripe-finance`.
- Handles `checkout.session.completed` → provision (DIY), `customer.subscription.updated/deleted` → entitlements status, `invoice.paid` / `invoice.payment_failed` → status and grace, and `invoice.upcoming` → attach pass-through items.
- **`stripe-provision` is deleted** in the same PR.

**Pass-through ledger `passthrough_usage`:** `tenant_id`, `period` (YYYY-MM), `category` ∈ {`sms_segment`, `voice_minute`, `phone_number`, `a2p_brand`, `a2p_campaign_vetting`, `a2p_campaign_monthly`, `bank_item`, `meeting_hour`, `ai_overage`}, `quantity`, `vendor_cost_cents`, `vendor_currency`, `margin_bps`, `amount_cents`, `source_ref` (unique: the vendor usage or invoice id), `status` ∈ {accrued, invoiced, void}, `stripe_invoice_item_id`.

**Collectors.** Nightly `app/api/cron/collect-passthrough-usage`, registered in `workers/oasis-cc-cron/src/index.ts` and `config/cron-registry.json`:

| Category | Source |
|---|---|
| Twilio | Usage Records per **tenant subaccount**, so per-tenant cost is exact |
| Recall.ai | Bot hours, with bots tagged by `tenant_id` at creation |
| Plaid | Active Items per month from our own `bank_connections` table. Plaid charges per Item even while it is in error, until `/item/remove` (research), so a disconnect must call `/item/remove` at once |
| AI overage | From `ai_usage_ledger` |

**Billing run.** `app/api/cron/bill-passthrough` on the 1st, or on `invoice.upcoming`:
- **Bills closed periods only.** A period (YYYY-MM) closes when the first collector run after that month ends has ingested its final vendor usage; the collector records the close (`closed_at` per tenant and period). The billing run, whichever trigger started it, selects only closed periods with `accrued` rows. `invoice.upcoming` fires while the current month is still accumulating usage, so it never bills that month: it bills any closed period not yet invoiced, and the open month waits for its own close.
- Creates Stripe InvoiceItems on the tenant's OASIS customer, idempotency key `pt-{tenant}-{period}-{category}`, so they land on the next subscription invoice. Because only a closed period is ever billed, the usage behind a key cannot change after its InvoiceItem exists. The durable guard against double billing is the ledger's `accrued → invoiced` compare-and-swap; Stripe keeps idempotency keys for only 24 hours.
- Converts currency with the existing Bank of Canada FX (`lib/founders-finances/fx-io.ts`).

**Pricing.** Default handling margin is **15%**. Cook charges carrier cost + 10%; Atlas sets ours. One-time A2P and number fees pass through at cost plus a flat handling fee, and **only after an owner approval card** (Cook does the same: "A2P registration only runs after explicit fee approval").

**What the owner sees.** Settings › Billing shows plan, next invoice, and month-to-date usage by category with vendor cost and handling %, plus owner caps for SMS, meeting hours and AI overage.

**Books.** Paid invoices already flow into OASIS's ledger through `stripe-finance`. Atlas maps pass-through revenue against the matching vendor bills so gross margin per tenant is visible.

### a.6 What Atlas must validate before any price goes public

- **Per-tenant monthly cost model.** COGS = managed model cost (from the ledger, capped by budget) + an allocated share of Turso / Worker / R2 + connector platform tiers (Xero Starter is free for 5 connections *per app*, then Core A$35/mo for 50; QBO Builder is free up to 500K reads/mo; Nango about $110/mo at 200 connections) + support hours × loaded rate. Setup adds 10-12 installer hours; Managed adds 15-25 operator hours/mo. At $2,500-3,500 for 20 h that is about $125-175/h before AI and tools. Atlas confirms margin.
- **GST/QST (F11).** A few installs cross CA$30K taxable in one quarter, which ends small-supplier status. Atlas needs to:
  1. Forecast the crossing date.
  2. Recommend voluntary registration before the first OS invoice (clean invoices, input tax credits).
  3. Get the Stripe ingest to split retainer tax (lift `RETAINER_TAX_REFUSED`), or use Stripe Tax on OS subscriptions and ingest the tax lines.

  Resold telecom is also a taxable supply; Lex and Atlas confirm.
- **Currency.** Price in USD for US tenants and CAD for Canadian tenants, or USD everywhere? This is a CC decision (§6).
- **DIY credit.** Recommendation: credit the first 30 days of DIY fees toward Setup if they upgrade within 30 days. It closes the DIY → Setup path, and Atlas checks the margin.

---

## (b) The done-for-you install (the $2,500 Setup), same engine as DIY

### b.1 Remove the open doors and replace the broken paths

| Current | Change |
|---|---|
| `/signup` open self-serve (47 of 49 tenants were self-signups) | Without a valid `invite` token it shows "OASIS OS is invite-only. Book a call" (existing `AUDIT_FUNNEL`). `/api/auth/turso-signup` refuses on the server without a token. Brand no longer defaults to "OASIS AI". |
| `lib/onboarding-gate.ts` sends fresh profiles to `/onboarding/wizard` | Sends a no-tenant profile to `/awaiting-invite`. The wizard route redirects to `/`. |
| `/onboarding/wizard` + `wizard-finalize.ts` + `ProvisioningProgress` | Retired. `ProvisioningProgress` may be reused for the owner's "setting up" view, reading real `provisioning_runs` steps. |
| `lib/client-profiles.ts:193-205` / `lib/client-provisioning.ts:41-99` brand-string matching ("Sunrise Funding" gets the SunBiz shell) | Deleted with the SunBiz retirement. The pack is always an explicit choice. |
| `stripe-provision` | Deleted; replaced by `stripe-billing` (§a.5). |
| BEA `provision_client_tenant.py`, `provision_secrets.py` | Retired with SunBiz (F15). Run as-is, they would give a new client SunBiz's shell and Solara/Helios, and write through dead Supabase auth. Keep one idea: client credentials live only in `tenant_integration_credentials`, never on a host. |
| 48 self-signup tenants currently seeing CC_NAV | Go-to-market hygiene. Freeze login and send a notice to any real third party (Yoga Tantric LLC, Promptimagica, Sarif' Ai were named in `brand-for-tenant.ts:11-18`), offering export. After 30 days, delete per Law 25. Deletion is destructive and needs CC's confirmation at execution time, through a reviewed migration or script path (exec_guard). |

### b.2 Provisioning, one server function

`lib/provisioning/provision-tenant.ts` is idempotent on `install_id`. Every step writes to `provisioning_runs.steps_json` with evidence. Callers are the `/admin/installs` "Provision" button and the DIY checkout webhook.

1. **Tenant and slug.**
   - Create the `tenants` row.
   - The operator sets the slug. It is validated against reserved slugs (the full list from the unmerged `fix/tenant-boundary-guards` b478c58b, which Phase 0 must merge) and against every existing tenant and manifest slug.
   - **The tenant slug and the manifest slug are the same string, and `custom_fields.command_center_profile_slug` is written explicitly.** This removes the class of bug in F3.
   - `purchase_status` is now read, and gates activation.
2. **Entitlements.** Insert the `tenant_entitlements` row: plan defaults from `lib/entitlements/plans.ts`, `status='provisioning'`.
3. **Manifest.** Write through `saveManifest` from the `client-os` base seed with the tenant's `tenant_id` stamped, so `crossTenantGuard` binds it and nobody else can claim the slug.
4. **Public identity.** Add the tenant to the fail-closed brand map (§6, decision 7). For pilots 1-2 this is a code PR (both stacks plus `tests/brand-identity-coherence.test.ts`).
5. **Owner-claim invite.**
   - A new `tenant_invites.kind='owner_claim'` that only provisioning code can mint. The public invite API still cannot mint owners (F5).
   - Redemption sets `is_owner=1`, `team_role='owner'` and `onboarding_completed_at=NULL`, so the owner lands in Setup mode.
   - The email goes through OASIS's transactional sender.
6. **OASIS-side install project.**
   - Create a `delivery_projects` row in the OASIS tenant with `client_tenant_id` = the new tenant and `kind='os_install'`, plus the install task template (b.5).
   - The client sees `delivery_updates` in their portal ("Your install: day 4 of 14").
   - This is OASIS dogfooding its own Client Success department.
7. **Install checklist.** Seed the `install_milestones` rows (Levels, b.4).

### b.3 The 15-minute business interview

**Implementation.** A route, `/setup/interview`, rendered by the forms engine (`components/forms/FormRenderer.tsx`) from a code-owned definition (`lib/business-profile/interview.ts`).
- Answers go to **`tenant_business_profile`** (`tenant_id` PK, `answers` JSON, `version`, `completed_at`, `completed_by`). **Nothing is thrown away.** That was the wizard's defect.
- In a Setup install, the installer drives it live on the kickoff call by screen share. In DIY, the owner fills it in.
- The website URL is fetched on the server and summarized by the managed runtime into **suggestions** the owner confirms. Nothing is committed without a click.

| Section | Questions (short) | Where the answer goes |
|---|---|---|
| 1. Business | What you sell (offers and prices); revenue band ($10-20K / $20-35K / $35-50K+); team size and roles; service area; languages (FR/EN); timezone | Pack recommendation; KPI targets; Bill 96 flag; send windows |
| 2. Customers and sales motion | Who buys; how leads arrive (referral, ads, organic, outbound, marketplace); the stages you use today (free text, mapped to pack stages); sales cycle length; who closes | Pipeline stage mapping; Sales department `setup_answers` |
| 3. Tools today | Checkboxes: GHL, Google Workspace, M365, Stripe, QBO/Xero, bank(s), Zoom/Meet, Slack/Discord, Twilio/other SMS, Meta Ads, Calendly | Generates the connections checklist and GHL import plan |
| 4. Assets and proof | Website, YouTube or podcast channel, SOP docs, sales scripts, case studies, reviews link | Skill ingestion queue (b.6) |
| 5. Taste and voice | Reuse the voice step from `oasis-client-onboarding-seed.ts`: formal / professional / friendly / casual; "anything specific"; **"what must we never say or promise"**; response speed | `tenant_voice_rules` (standards every drafting department obeys; changes need owner approval) |
| 6. Goals | 90-day goal; the one number you want to move; what "a good week" looks like | Chief of Staff goal; Today KPIs |
| 7. Authority and consent | MSA + DPA acceptance; send-on-behalf authorization; recording-notice choice; QC: s.17 PIA annex acknowledgement and "data may leave Quebec" notice; profiling features on/off (Law 25 s.8.1) | `tenant_agreements` (document id, version, **SHA-256 of the exact text shown**, signer, timestamp, IP), following the pinned-constant pattern of `CLIENT_ONBOARDING_CONSENT_TEXT` (F18) |

### b.4 Levels: progress unlocks on real milestones, checked by live probes

Definitions live in `lib/levels/milestones.ts` (pure) and the probes in `lib/levels/probes.ts`.
- Each probe writes `install_milestones` (`tenant_id`, `key`, `status` ∈ pending|met|failing|not_applicable, `evidence`, `last_checked_at`).
- A registered cron `app/api/cron/probe-milestones` re-runs them. A probe **calls the service**; key presence is not enough (F6).
- The order is **Finance-first**, because the wedge should be the first win: a numbers brief within 24-48 hours of the Stripe key. That is our version of Serge's "dental call the next day".

| Level | Milestones (all verified live) |
|---|---|
| **0 · Workspace** | Owner claimed; interview complete; MSA + DPA accepted (QC: PIA annex acknowledged); pack applied; brand and sending identity resolved |
| **1 · Know your numbers** | Stripe `rk_` key probe OK plus ≥90 days of history ingested; QBO/Xero connected **or** ≥1 month of CSV/OFX imported; first Finance brief generated **and opened by the owner** |
| **2 · Capture** | Calendar connected (list-events probe); a pack form published with ≥1 **real** submission (test submissions excluded); meeting capture connected with ≥1 meeting captured; `gmail.send` token refresh OK for the owner |
| **3 · Automate** | ≥3 routines passed a sandbox dry-run and were switched On; ≥10 approval decisions recorded; if `mod.sms`: A2P campaign approved (Twilio status probe); bridge connected (optional) |
| **4 · Compounding** | 30 days of outcome labels with ≥1 won deal **verified by payment**; weekly review routine On; if `mod.meta_ads_read`: 7 days of `ad_daily_metrics` |

Features that depend on joined data unlock with the level and explain why while locked. For example, the "angle leaderboard" needs Meta + Stripe + attribution.

**Readiness changes for OS tenants** (`lib/setup-readiness.ts`):
- Remove the bridge "fail" (226-256) and the lender check (196-224) for `client-os` tenants. The bridge is an operator tool and never client-safe.
- Replace `DEFAULT_REQUIRED_SERVICES` copy that mentions "your local bridge + CLI" (45-53).

### b.5 Operator tooling to run 5+ installs in parallel

**`/admin/installs`.**
- Access: an OASIS tenant plus a new `canRunInstalls` capability (founder or builder persona), checked on the server.
- It is a view over `delivery_projects` where `kind='os_install'`. Columns: client · plan · installer · day N/14 · current Level · **blockers auto-derived from failing probes** ("Waiting on client: QuickBooks OAuth", "A2P vetting: day 6") · next task · last client touch · go-live target.
- Per-install cockpit actions:

| Action | What it does |
|---|---|
| Open workspace as installer | Via `operator_access_grants` (`tenant_id`, `operator_user_id`, `scope`, `expires_at`, `granted_by`, `revoked_at`). 30 days for Setup, ongoing for Managed. Every action goes to `tenant_audit_log` and is shown to the client under Settings › Access log. The client can revoke it (Law 25 access limits). This replaces unrestricted operator preview for OS tenants. |
| Re-run probes | Re-checks the Level milestones |
| Apply / upgrade pack (diff preview) | Shows the change before applying |
| Draft "what we need from you" email | Generated from the failing milestones; it is an approval card, never an auto-send |
| Go-live checklist | See the list below |

**Install task template** (`delivery_tasks`, created at provisioning):

| Day | Tasks |
|---|---|
| D0 | Kickoff call + interview |
| D1 | Pack confirmed + forms placed on the website |
| D1-3 | Connection sessions (the client does the OAuth clicks, the installer guides) |
| D3-5 | Skill ingestion and approvals |
| D5-8 | Routine dry-runs |
| D8-10 | Recorded owner walkthrough |
| D10-12 | Go-live checks |
| D14 | Go-live, then 30-day hypercare |

**Go-live checklist.** All items must pass before `status='active'` and billing start:
1. **Isolation smoke** (`scripts/os/tenant-smoke.ts --tenant <slug>`): zero env-credential fallbacks resolved for this tenant, public identity resolves, no seed fallback, entitlements row present.
2. Every outward action routes through approvals.
3. DPA / MSA / PIA annex on file.
4. CASL sender ID and unsubscribe work end to end.
5. Recording notice configured.
6. QC tenant: French is on for client-facing surfaces.
7. Owner walkthrough done.
8. OASIS sign-off with name and date.

**Scripts and briefs.**
- CLI `scripts/os/provision.ts` and `scripts/os/install-status.ts --all --json`, in OCC and in TypeScript so they share the app's writers and guards. Bravo reads the JSON for the founder Today "Installs" card.
- Capacity target: installer time ≤12 h per Setup install, most of it on the calls. The waits (OAuth, A2P, Meta review) are asynchronous, which is what lets one installer run 5.

### b.6 Skills seeded from the owner's own SOPs, YouTube and playbooks

- **Inputs.** URLs are classified by `lib/founders/ingest-core.ts` (YouTube, web, etc.). Docs are uploaded to R2 through the documents store. Google Docs come in via `drive.file` plus Picker, which needs brand verification only, not CASA.
- **Processing.** A new `skill_ingest_jobs` queue runs on the **managed client runtime** (not the CC-subscription extraction daemon, F14). It emits draft skills into `tenant_skills` (`tenant_id`, `slug`, `department`, `title`, `body_md`, `source_refs`, `status` ∈ draft|active|retired, `approved_by`, `version`).
- **Approval.** Each draft becomes an approval card for the owner, or the installer in Setup, and only approved skills reach department agents. This is Cook's SKILL.md library, stored in Turso behind **Playbook**, because Node fs is empty on the Worker.
- **Rights.** The owner attests they own their SOPs and content. Third-party YouTube is distilled into the owner's own words with the source cited, never transcribed wholesale.
- **Starting point.** Each pack also ships starter skills (c).

### b.7 First routines on

Pack routines install **Off**. Each has a sandbox dry-run that sends nothing and simulates approvals. The owner can switch a routine On only after its dry-run passes. The go-live requirement is ≥3 On:
- Morning brief
- New lead → instant follow-up **draft** (approval required, quiet hours respected)
- Weekly cash brief (Finance)

---

## (c) Industry packs: one platform, differences as data

### c.1 Pack schema

The schema lives in `lib/packs/schema.ts`. Pack seeds are code-reviewed TypeScript and can move to a DB table later.

```ts
type IndustryPack = {
  id: "agency-consulting" | "home-services" | "coaching-education" | "clinic-practice";
  version: string;                       // semver; tenant_pack_installs records what was applied
  label: string; icp: string;
  departments_default: DeptKey[];        // must be ⊆ core departments; capped by entitlements at apply
  pipeline: { entity: "deal"; stages: { key: string; label: string; probability: number;
              is_won?: boolean; is_lost?: boolean; sla_hours?: number }[] };
  customer_lifecycle: { key: string; label: string }[];      // Clients tab
  forms: PackFormTemplate[];             // lib/forms/types FormStep[]; utm/ad-id capture on by default
  ticket_categories: { key: string; label: string; sla_first_response_hours: number }[];
  kpis: { key: string; label: string; department: DeptKey; source: ConnectorKey[];
          formula_ref: string; unknown_policy: "show_not_connected" }[];
  objection_taxonomy: { code: string; label: string }[];      // feeds outcome labels (d)
  skills: PackSkillTemplate[];           // body_md with {{business.*}} vars from tenant_business_profile
  routines: PackRoutineTemplate[];       // trigger, steps, approval policy; installs OFF + dry-run required
  agreements: PackAgreementTemplate[];   // Lex-reviewed e-sign templates (service agreement, SOW)
  compliance: { send_window_local: string; sms_opt_out_phrase: string; sensitive_fields_forbidden: string[] };
  levels_overrides?: Partial<Record<MilestoneKey, "not_applicable">>;
  benchmark_cohort: string;              // for opt-in aggregates only
};
```

**Rules:**
- **No tenant data inside a pack** (Cook: "templates never copy members, clients, conversations or secrets").
- **No pack-specific page kinds.** A pack may reference only core page kinds and entities.
- **Apply is idempotent and diffable.** `applyPack()` writes `tenant_pack_installs` (`tenant_id`, `pack_id`, `version`, `applied_at`, `diff_json`). An upgrade shows a merge diff. Changes to standards need separate owner approval, as in Cook Playbooks.

**`tests/packs-valid.test.ts` asserts:**
- every pack parses against the manifest schema
- every referenced page kind and entity exists (today `templates.ts` links nonexistent pages)
- every KPI names a real connector key
- every routine installs Off
- no pack routine contains an unapproved outward step

**Department agents.** New neutral templates in `lib/agents/library.ts`: `dept-chief-of-staff`, `dept-sales`, `dept-marketing`, `dept-content`, `dept-client-success`, `dept-finance`, `dept-research`, `dept-operations`, `dept-legal`. They use existing categories (F20). Tool palettes are restricted: no `bash`, `edit_file`, `search_repo` or bridge tools. The pack supplies `prompt_overlay` and `setup_answers` per department, which `lib/agent-personas.ts` already folds into the prompt.

**Retire from `templates.ts`:** `business_funding` (SunBiz), `real_estate` and `ecommerce` (outside the ICP), and `custom` (it ships Bravo/Atlas/Maven to clients). Coordinate with **APEX PR #301 `apex/industry-automations`** (per-industry automation battle cards): harvest its content into pack routines under a coord_claim lease instead of shipping a second registry.

### c.2 The first four packs, with justification

**Evidence of who Cook serves:**
- **Video:** a cleaning business ("Jack Kim / Clean Growth", AI rep "Riley"), kitchen/bath remodelers ("Andrew Dias"), solar installers ("SolarPipeline"), a dental practice (the first sales call after launch), an acupuncture clinic and fertility/IVF ad research, NY car detailing, insurance agents, a fractional-accounting firm demand signal, "Adrian Meraki Fitness", and a coaching/info program ($7,800 offer, setter + closer).
- **trycook.ai/platform:** agencies, coaches and course creators, consultants and fractional execs, local services (dental, home services, clinics), med spas.
- **Market research:** GHL's premium done-for-you niches are med-spa, legal and home services at $1,000-2,500/mo. The recommended ICP is owner-operated agencies, consultants, coaches and high-ticket local services with 1-10 staff.

| Order | Pack | Why here | Pipeline (default) | KPIs (Finance-joined) | Starter routines (all Off until dry-run) |
|---|---|---|---|---|---|
| **1** | `agency-consulting` (marketing/growth agencies, consultancies, fractional execs) | **OASIS is this ICP, so dogfood = pack 1.** Cook's core buyers. Strongest finance-pain evidence ("nearly one in five can't report margins"; 45% forecast only 1-3 months). | Inquiry → Discovery booked → Discovery held → Proposal sent → Negotiation → Won (paid) / Lost | Retainer MRR (Stripe), **profit per client** (Stripe revenue − attributed costs), proposal win rate, DSO / overdue AR, churn, 30-day cash forecast | Weekly client report draft; client health sweep; proposal follow-up draft; overdue-invoice nudge (approval); morning brief |
| **2** | `home-services` (remodelers, cleaning, solar, detailing, trades) | 4+ of Cook's visible clients. Speed-to-lead pain (HBR: 42-hour average response). Many are on GHL (the private-app import covers ≤5 agencies). SMS-heavy, so Twilio pass-through revenue. | Lead → Contacted → Estimate booked → Estimate given → Won (deposit) → Scheduled → Completed → Paid → Review requested | Speed-to-lead, estimate→close, average job value, deposits collected, cash from jobs, CPL **and cost per paid job** by channel | Instant lead follow-up draft (SMS, quiet hours, approval); estimate follow-up; review request after verified payment; weekly cash |
| **3** | `coaching-education` (coaches, course creators, high-ticket programs) | Cook's own showcase: setter + closer, a $7,800 program, call grading. Stripe payment plans make the wedge vivid (cash collected vs contracted). Meta-dependent, so it follows the Meta review. | Lead → Application → Qualified → Call booked → Showed → Closed (paid) / No-show / Lost | Show rate, close rate, **cash collected vs contracted** (payment plans), refund rate, cost per booked call and per paid enrollment | Setter drafts (approval); call review and grade; failed-installment alert; testimonial/win capture form |
| **4** | `clinic-practice` (med spa / aesthetics / wellness first; dental, physio later) | Cook: dental, acupuncture, IVF; GHL premium niche. **Gated on Lex's health-data review:** Law 25 treats health data as sensitive (express consent), and US covered entities need HIPAA/BAA, which the stack doesn't offer. v1 sets `sensitive_fields_forbidden` (no diagnoses or treatment notes in forms or tickets) and markets to aesthetics/wellness only. | Inquiry → Consult booked → Consult attended → Plan presented → Accepted (deposit) → Completed / Lost | Consult show rate, plan acceptance, revenue per client, rebook rate, review count | Consult reminder; no-show recovery draft; rebook nudge; review request |

---

## (d) The data moat

### d.1 What is captured per tenant

**Principle.** The moat is **joined, outcome-labelled records owned per tenant**, plus switching cost. It is not raw transcripts (a16z; brief 2.4).

**Storage.** These tables live wherever the data-layer workstream puts client data. The recommendation is a separate client database, so records don't sit next to operator memory.

**Table rules.** Every table has `tenant_id NOT NULL` and every index leads with it (the 183 pattern). Migration numbers are reserved with `python scripts/check_migration_collision.py reserve <n>` at build time and are not chosen here.

| Capture | Table (new unless noted) | Source | Notes |
|---|---|---|---|
| Every business-significant change | **`outcome_events`** (append-only): `tenant_id`, `subject_type` (contact / deal / customer / ticket / meeting / campaign / routine_run), `subject_id`, `event_type`, `occurred_at`, `actor` (human / `agent:<dept>` / system), `source`, `source_ref` UNIQUE per tenant, `payload`, `confidence` ∈ verified / inferred / human_confirmed | Written through an **outbox in the same write path** as the record change | Replaces best-effort `agent_events` emission for moat purposes (F10). A dropped event corrupts a label, so this path fails loud. |
| Pipeline transitions | `outcome_events` (`stage_changed`) | `lib/manifest/data.ts` status updates | Stage keys come from the pack, so labels are comparable within a pack cohort |
| Form submissions + attribution | existing `form_submissions` + **`attribution_touches`** (first/last touch: channel, utm, `fbclid`, Meta `ad_id` / `adset_id` / `campaign_id`, `creative_id`, `angle_tag`, `form_id`) | Pack forms capture utm and ad ids by default; Meta Lead Ads carry `ad_id` | Without this, "ad angle → paid" can't be joined |
| Ad spend and results | **`ad_daily_metrics`** (account, campaign, adset, ad, date, spend, impressions, clicks, leads, currency) | Meta Insights sync after App Review | Angle tags come from Marketing's creative briefs |
| Meetings + transcripts | `meetings` (per the connector workstream) + transcript object in R2 + **`meeting_insights`** (objection codes from the pack taxonomy, each with **quote spans** into the transcript; commitments; next steps) | Recall / Fathom / Meet (pulled within 30 days) | Sentiment and scoring of people count as profiling (Law 25 s.8.1), so they are **off by default** and toggled per tenant |
| Tickets from the client's customers | re-scoped `support_tickets` + `ticket_comments` + CSAT | Portal / support form | SLA timings are native metrics |
| Wins verified by payment | `outcome_events` `won` + **`payment_verified`** (Stripe charge / invoice ids, amount, currency) | Per-tenant restricted-key reconcile (F17 pattern) or QBO invoice paid | "Closed-won" without a payment match stays `inferred` |
| Approval decisions | the Feed/approvals workstream's `approvals`, which **must** record decision, `edited_payload_diff`, `decided_by`, latency | Every approval card | The best label for improving drafts: approved as-is vs edited vs sent back |
| Routine outcomes | **`routine_runs`** (dry_run flag, status, outputs ref, approvals outcome, downstream result such as `booked` within 7 days) | Routine runner | Tells us which routines actually move a KPI |

### d.2 Outcome labelling (computed, never guessed)

A registered nightly cron `app/api/cron/label-outcomes` materializes **`deal_outcome_labels`**:

| Group | Fields |
|---|---|
| Keys | `tenant_id`, `deal_id`, `contact_id`, `label_version`, `computed_at` |
| Acquisition | `channel`, `campaign_id`, `ad_id`, `creative_id`, `angle_tag`, `form_id`, `first_touch_at` |
| Response and booking | `speed_to_lead_sec`, `booked_at`, `meeting_id`, `showed` (true / false / **unknown**) |
| Objections | `objections[]` (code + quote ref + confirmed_by) |
| Deal | `proposal_sent_at`, `proposal_amount_cents`, `closed_at`, `outcome` (won / lost / open), `lost_reason` |
| Payment | `paid_verified_cents`, `first_paid_at` (Stripe/QBO match only) |
| Retention | `retained_90d`, `retained_180d` (active subscription or repeat payment), `refund_cents`, `churned_at`, `ltv_to_date_cents` |
| Gaps | `unknown_fields[]` with a reason each (e.g. "no Stripe connected", "meeting not captured") |

This is the "unknown is not zero" rule (`lib/goals/oasis-money.ts`).

Objection codes come from an LLM extraction with quote spans. The Sales department shows a one-tap "confirm objections" chip, and a confirmation upgrades `confidence` to `human_confirmed`.

### d.3 How the system gets better, per tenant first

1. **Retrieval for each department**, over the tenant's own labels and skills only:
   - **Sales:** before drafting a follow-up, retrieve "objections that preceded *won* deals in this segment, plus the rebuttal used".
   - **Marketing:** an angle leaderboard ranked by **cost per paid customer** (Meta spend ÷ Stripe-verified revenue), not CPL.
   - **Finance:** CAC payback and profit per client and per offer.
   - **Client Success:** churn precursors (ticket volume, overdue AR, meeting cadence).

   Store: `tenant_memory_notes` plus FTS/vector on libSQL. Verify FTS5/vector support on the Turso plan before building.
2. **Skill improvement loop.** A weekly "playbook review" routine proposes edits to `tenant_skills` from approval edit-diffs and outcomes. **The owner approves every change.** Standards never self-modify.
3. **Routine scoring.** Each routine card shows its downstream effect (e.g. "follow-up drafts: 41% booked within 7 days vs 22% before"), with n and date range. Nothing is shown below a minimum n.
4. **OASIS product improvement** uses only **usage metadata** (which routines get switched off, which Levels stall, approval edit rates as counts). Never content. The DPA must say this.

### d.4 Cross-tenant use: anonymized aggregate benchmarks only

- **Opt-in.** An MSA clause plus a Settings toggle (`mod.benchmarks_optin`), **default off** and revocable. The incentive is "give to get": opted-in tenants see their cohort benchmarks.
- **Only OASIS-native metrics.** Stage-to-stage conversion and timing, speed-to-lead, ticket SLA, routine outcome rates, form conversion. **Excluded forever:** anything sourced from Google APIs (Limited Use), Slack (ToS bans LLM training and bulk export), Xero (bans AI/ML training on API data), Zoom and Meet. Stripe-, QBO- and Meta-derived amounts enter only after **Lex confirms each platform's terms** allow aggregated anonymized use.
- **Anonymization.** Cohort = pack × revenue band × country. **n ≥ 10 tenants is a floor, not the test.** Aggregation alone can still identify a tenant, above all by comparing releases after one tenant opts in or revokes. Publication requires all of:
  - **A passing re-identification risk assessment** under Quebec's anonymization regulation (Law 25 s.23): done and passed before the first release, redone whenever a cohort definition or metric changes, and reassessed periodically (at least yearly). No release ships on a failed or missing assessment.
  - **Small-cohort suppression.** Suppress any cohort-metric cell with fewer than 10 tenants, or where one tenant contributes a dominant share of the underlying volume. Also suppress complementary cells, so a suppressed cohort cannot be recovered by subtracting from a published parent total.
  - **No differencing.** Publish in fixed releases (e.g. quarterly), labelled by release period, never by an exact computation timestamp. A cell whose membership changed by fewer than 3 tenants since the previous release is suppressed in the new one, so a single opt-in or revocation cannot be isolated by comparing two outputs. `n_tenants` is shown as a band (10–19, 20–49, 50+), not an exact count.
  - p25/p50/p75 only (never min or max, which are one tenant's value); no free text, no transcripts, no per-tenant rows persisted.

  Output goes to `benchmark_aggregates` (cohort, metric, percentiles, `n_tenants_band`, `release_period`). `computed_at` stays internal and is never shown to tenants.
- **Never trained into a model** and never used to write another tenant's skills. A tenant's skills are its intellectual property; a pack improvement can reuse one tenant's skill text only with written permission.
- **Legal risk this avoids.** *In re Otter.AI* (N.D. Cal., 2026-08-13) held that using recordings for the vendor's own benefit makes it a third-party eavesdropper. OASIS stays "an extension of the customer".
- **SunBiz data** (9,698 interactions, 5,461 merchant documents including bank statements in R2) belongs to the lost client. **Export to them, then delete, and never ingest into any moat or benchmark.** This follows the locked decision (harvest engines, not data) and Law 25's destroy-when-purpose-is-fulfilled rule.

### d.5 Consent, DPA and PIA artifacts OASIS must ship

Lex drafts, a licensed Quebec attorney reviews, and Maven styles the public pages.

| Artifact | Contents | Where it lives |
|---|---|---|
| **OASIS OS MSA / Terms** (French-first for QC, Bill 96 contracts of adhesion) | Service, tiers, pass-through billing, AI disclosure, no-training, liability, benchmarks opt-in clause, termination and export | Public `/terms` + `tenant_agreements` acceptance with text hash |
| **DPA** (OASIS as service provider under Law 25 s.18.3 / PIPEDA accountability) | Processing only on instructions; confidentiality; **sub-processor list with regions** (Turso US, Cloudflare, managed model provider under a no-training / zero-retention agreement, Recall, Plaid, Nango, Twilio); breach notice; deletion on termination with certificate; audit rights; **no training, no cross-tenant use except opt-in aggregates** | Signed at Level 0 |
| **s.17 PIA annex** (pre-filled) | OASIS supplies facts for the client's own PIA: data categories, US destinations, safeguards, legal framework | Delivered at the interview for QC tenants |
| **OASIS's own PIA + processing register + incident register** (s.3.8) | For OASIS's own sub-processors | Internal (Lex/CC) |
| **Privacy officer published** (Law 25 s.3.1-3.2) | Title and contact of the person in charge (CC by default as the highest authority, or delegated) | `/privacy` (the gap in F13) |
| **Privacy page corrections** | Remove the "row-level security" claim (`privacy/page.tsx:238`); correct sub-processors (`lib/legal/constants.ts:69,77` → Turso, Cloudflare Workers/R2, the actual model providers); fix the phantom doc cite (`:61`); same fix in Lex ToS §4. **Add a test** asserting the sub-processor list matches the deployed stack (extend `tests/legal-compliance-drift.test.ts`). | Phase 0 |
| **Recording notice pack** (FR/EN) | Bot display name "OASIS Notetaker (recording)", a join chat message, a calendar invite line, and a snippet for the client's own privacy notice. **All-party notice by default** (US all-party states) | Pack default |
| **End-customer notice snippet** | For the client's website and forms: their data is processed by OASIS on their behalf, including outside Quebec | Generated per tenant at go-live |
| **CASL / TCPA** | Per-contact consent ledger (express/implied + expiry), sender ID, unsubscribe honored ≤10 business days, SMS quiet hours in the recipient's timezone, STOP handling. Reuse `lib/sms/consent.ts`, `/unsubscribe` and `email_suppressions`. **Opt-in Vault is SunBiz/bluerise-only** (`lib/consent/optinvault.ts` `ConsentBrand`), so generalize it or retire it | Core |
| **Automated-decision disclosure** (s.12.1) + profiling toggle (s.8.1) | Lead scoring and objection/sentiment analysis are disclosed and can be switched off; human review available on request | Settings › Privacy |
| **Retention and destruction schedule** | Per data class; offboarding export + deletion certificate | DPA annex + an `ops` routine |
| **Finance disclaimer** | "Decision support, not accounting or tax advice" on every Finance surface (Lex wording) | Finance department frame |
| **Security overview** | An honest controls sheet: no SOC 2; encryption; tenant scoping; audit log; access grants | Sales collateral |

---

## (e) Proof and pitch

### e.1 Dogfood: OASIS is tenant #1

- **OASIS's tenant.**
  - `oasis-ai-cc` moves to `plan='internal'` with the `agency-consulting` pack.
  - Its Sales department sells OASIS OS (pipeline = pack stages).
  - Its **Clients › Projects** runs every OS install (b.5).
  - Its **Tickets** is the OS support desk. `/tickets` already is OASIS's desk for its own clients, so every DIY tenant's "Ask a human" lands there.
- **Finance.** The OASIS tenant's Finance department is today's founders ledger, gated owner-only (`canSeeFinanceDepartment` = founders only). No other tenant can ever resolve `fin_ent_oasis`. The separate Founders portal is retired as a concept.
- **What CC keeps.** Operator surfaces (Agents power-chat, Systems console) render for OASIS operators only.
- **Proof metrics** from dogfood, published internally weekly:

| Metric | Target |
|---|---|
| OASIS inbound speed-to-lead (median) | — |
| Finance brief reconciles to the ledger | 0 unexplained deltas |
| Install on-time rate | ≥80% within 14 days |
| Operator hours per install | ≤12 |
| Approvals as-is vs edited | Trend |

### e.2 Demo environment: `/demo/os`

- **A real demo tenant**, e.g. `demo-northwind` ("Northwind Renovations", a fictional home-services business), with `plan='demo'`. It runs on the **real client-os shell and real code paths**.
- **Seed script.** `scripts/os/seed-demo.ts` writes clearly labelled synthetic records under the demo `tenant_id` only.
- **Connectors in sandbox mode:**
  - Stripe **test-mode** key on the demo tenant
  - an SMS "text the rep" sandbox where nothing reaches a real phone (Cook's "Text Riley" page)
  - Meta metrics as a fixed sample snapshot, labelled "sample"
- **Access.** Anonymous visitors get a read-only demo session with a permanent "**Sample business, not real data**" banner. Approvals are simulated and writes are refused.
- **Why this doesn't break the no-mock-data rule.** The demo is labelled as a demo, and `tests/demo-tenant-isolation.test.ts` asserts that no demo row carries a non-demo `tenant_id` and that `plan='demo'` tenants are excluded from outcome labels, benchmarks, pass-through billing and Bravo's metrics.
- **`/demo/sun` is retired** (SunBiz shutdown; it demoed a paying client's CRM, which is not allowed).

### e.3 Two pilots

- **Profile:**
  - (1) an `agency-consulting` business other than OASIS
  - (2) a `home-services` business
  - Both at $10-50K/mo, already on Stripe, 1-10 staff.
- **Terms.** Setup tier at a pilot price (Atlas sets it, e.g. a reduced setup fee for 90 days) in exchange for weekly feedback, a recorded case study, and permission to publish **verified** numbers.
- **Language (decision for CC, §6).** Recommendation: pilot 1 outside Quebec, pilot 2 in Quebec **only after** French client-facing surfaces and French contracts exist. Tradeoff: a QC-first pilot tests the home market but blocks on Bill 96 work.
- **Pilot success criteria:**

| Criterion | Target |
|---|---|
| Install | ≤14 days |
| Level 1 (numbers) | ≤5 days |
| Owner weekly active | ≥4 days/week by week 3 |
| Agent drafts approved without edits or with light edits | ≥70% by week 4 |
| First verified "found money" insight (overdue AR collected, unprofitable client or offer identified, ad angle cut) | ≤30 days |
| Churn | Zero pilot churn at 90 days |

### e.4 Success metrics by phase

| Phase | Gate metrics |
|---|---|
| **0 · Safety + truth** | 0 env-fallback resolutions for non-OASIS tenants (logged counter); `stripe-provision` deleted and `stripe-billing` verified; open signup closed; privacy page and Lex ToS corrected, with the drift test green; GST/QST decision recorded by Atlas |
| **1 · Dogfood** | OASIS tenant on `internal` with pack 1; CC uses Today ≥10 of 14 days; 3 routines On after dry-run; `outcome_events` capturing 100% of stage changes (reconciled against `tenant_records` weekly) |
| **2 · Installable** | End-to-end provisioning for a throwaway tenant in CI; `/demo/os` live; billing + pass-through dry-run for one full period on test mode; DPA/MSA attorney-reviewed; packs 1-2 green in `packs-valid` |
| **3 · Pilots → GTM** | 2 pilots meeting the e.3 criteria; per-tenant gross margin ≥ Atlas's target; 5 paying tenants; 2 case studies with Stripe-verified numbers |

### e.5 The 10-minute pitch (outcomes first; the tool is "a 1% tool")

| Min | Show | Point |
|---|---|---|
| 0-1 | Their revenue band and one question: "Which of your clients or offers actually makes you money?" | The pain is visibility (Productive: financial visibility rated lowest) |
| 1-3 | `/demo/os` **Today**: overnight work by department, "needs you" approval cards, cash this week / next 30 days | One place, departments not bots, nothing goes out without approval |
| 3-5 | **Finance**: profit per client, cost per *paid* customer by channel (Meta spend ÷ Stripe-collected), overdue AR, tax set-aside | **The wedge.** Cook, GHL, Sintra and Marblism can't show this; read-only and never moves money |
| 5-7 | **Sales at work**: new leads → drafted follow-ups → approve → sent; a captured meeting → objections with quotes → coaching note | Speed-to-lead + learning from real calls |
| 7-8.5 | **Clients**: a customer's portal ticket with SLA, an agreement e-signed, a project update | Delivery and retention in the same system |
| 8.5-10 | **Their 14-day install plan**, generated live from a 3-question mini-interview; tiers; next step = kickoff | Installed, not assigned homework. Even DIY gets the same install plan and a human one click away |

### e.6 Making DIY feel done-for-you

Serge's own caveat is "99% wouldn't know what to do with it". So:
1. The interview builds the workspace for them (pack, stages, forms, voice rules).
2. The Chief of Staff drives setup. The Today brief always shows "the one thing I need from you next", derived from failing milestones.
3. Every connection has a click-by-click guide plus a live probe that says exactly what's wrong.
4. Routines are prebuilt, Off, and one dry-run away from On.
5. Starter skills arrive pre-approved from the pack. Their own SOPs become skills with one approval each.
6. The first win lands within 48 hours: the Finance brief on Stripe history.
7. "Ask an OASIS human" goes to OASIS's help desk with an SLA.
8. "Have us finish it" shows at every stall, with DIY fees credited toward Setup (§a.6).

---

## 5. Work plan and effort (human team / CC+Bravo; approval calendar time runs in parallel)

| # | Workstream | Key deliverables (paths) | Human | CC+Bravo |
|---|---|---|---|---|
| W1 | Entitlements and gating | `tenant_entitlements`, `entitlement_audit`; `lib/entitlements/{plans,store,gate}.ts`; `requireModule` in department pages, APIs, crons and OAuth starts; manifest-escalation 403; seat hard cap in `app/api/team/invites/route.ts`; tests `entitlements.test.ts`, `entitlements-manifest-cannot-escalate.test.ts` | 1-2 wks | 2-3 days |
| W2 | Billing and pass-through (money path) | `app/api/webhooks/stripe-billing` (verified) + delete `stripe-provision`; DIY Checkout; recurring-link subscription metadata; `passthrough_usage` + collectors (Twilio subaccounts, Recall, Plaid, AI) + `bill-passthrough` cron (registered); Settings › Billing; `ai_usage_ledger` + `lib/ai/cost.ts` + `assertAiBudget`; `rk_`-only Stripe for clients; tests `stripe-billing-webhook-signature.test.ts`, `passthrough-billing.test.ts`, `ai-budget.test.ts` | 3-4 wks | 1-1.5 wks |
| W3 | Provisioning and install console | `lib/provisioning/provision-tenant.ts`; owner-claim invites; invite-only `/signup` and onboarding gate; retire the wizard; `tenant_business_profile` + `/setup/interview`; `tenant_agreements`; `install_milestones` + `lib/levels/*` + `probe-milestones` cron; `/admin/installs` over `delivery_projects`; `operator_access_grants` + client access log; `scripts/os/{provision,install-status,tenant-smoke}.ts`; test `provision-tenant.test.ts` | 4-6 wks | 1.5-2 wks |
| W4 | Industry packs + department agents | `lib/packs/{schema,apply,recommend}.ts`; packs 1-2 first, 3-4 later; `tenant_pack_installs`; `dept-*` agent templates; retire old templates; harvest APEX #301 under a lease; test `packs-valid.test.ts` | 2-3 wks (+ domain research per pack) | 4-6 days |
| W5 | Skills ingestion | `skill_ingest_jobs` on the managed runtime; `tenant_skills` + approval cards; Playbook tab backed by the DB | 1-2 wks | 2-4 days |
| W6 | Data moat capture and labels | `outcome_events` outbox; `attribution_touches` in pack forms; `meeting_insights`; `routine_runs`; `deal_outcome_labels` + `label-outcomes` cron; retrieval notes. Benchmarks: design only until ≥10 tenants per cohort + Lex sign-off | 3-5 wks | 1-2 wks |
| W7 | Compliance artifacts | Privacy/ToS corrections + drift test (Phase 0); MSA, DPA, s.17 PIA annex, recording pack, end-customer snippet, retention schedule (Lex drafts); privacy officer; FR versions; attorney review | Drafting 1-2 wks; attorney review 3-6 wks calendar | Drafting 3-5 days |
| W8 | Proof: dogfood, demo, pilots | OASIS tenant → `internal` + pack 1; `scripts/os/seed-demo.ts` + `/demo/os` + `demo-tenant-isolation.test.ts`; retire `/demo/sun`; pilot runbook and case-study template | 2 wks + pilot calendar | 3-5 days |

**How this lines up with the master phases:**

| Phase | Workstreams | Human | CC+Bravo |
|---|---|---|---|
| **P0** | W1 skeleton (entitlements table + fail-closed read), W2's `stripe-provision` deletion, W3's signup closure, W7's privacy truth fixes; Atlas starts the GST/QST work; Meta/Google verifications start day 1 (other workstream) | 1-2 wks | 2-3 days |
| **P1** | W1 complete, W4 pack 1, W6 outbox, W8 dogfood, W3 console on `/projects` | 3-4 wks | ~1-1.5 wks |
| **P2** | W2, W3 end-to-end, W4 pack 2, W5, W8 demo, W7 artifacts in review | 5-7 wks | 2-2.5 wks |
| **P3** | Pilots, W6 labels, packs 3-4 | 6-10 wks calendar | 2-3 wks |

**Binding repo rules for the build:**
- `coord_claim` leases on `app/api/**` (new webhooks and crons), `database/**`, `lib/integrations/**` and `app/t/**`.
- Migration numbers reserved with `check_migration_collision.py reserve`. Candidates: `tenant_entitlements`, `entitlement_audit`, `passthrough_usage`, `ai_usage_ledger`, `tenant_business_profile`, `tenant_agreements`, `install_milestones`, `operator_access_grants`, `tenant_pack_installs`, `tenant_skills`, `skill_ingest_jobs`, `outcome_events`, `attribution_touches`, `meeting_insights`, `routine_runs`, `deal_outcome_labels`, `benchmark_aggregates`, and an `owner_claim` kind on `tenant_invites`.
- Every new cron in `workers/oasis-cc-cron/src/index.ts` **and** `config/cron-registry.json`: `collect-passthrough-usage`, `bill-passthrough`, `probe-milestones`, `label-outcomes`.
- Secrets through `wrangler_tool secrets-push`: `STRIPE_BILLING_WEBHOOK_SECRET`, Twilio master, Recall, Plaid.
- **Codex independent review (Rule 8)** on W1 (tenant boundary), W2 (money path), W3 (provisioning/auth) and W6 (new tenant tables).
- Start from a freshly fetched `main` in a new worktree. Rebase on #457/#434 first.

---

## 6. Decisions for CC (not already locked), with recommendations

1. **Privacy officer (Law 25 requires one to be published).**
   - Recommend: **CC named as person in charge**, reachable at `privacy@oasisai.work`.
   - Tradeoff: this puts CC's name on the page, but it is the legal default for the highest authority anyway.
2. **GST/QST.**
   - Recommend: **register voluntarily before the first OS invoice**, and have Stripe Tax or an ingest tax split live first (Atlas executes).
   - Tradeoff: slightly more admin now, versus a forced registration mid-quarter with re-issued invoices.
3. **Currency.**
   - Recommend: **CAD for Canadian tenants, USD for US tenants**, same numbers.
   - Tradeoff: two price books to maintain, but no FX surprise for either buyer.
4. **Pilot 2 in Quebec?**
   - Recommend: **not until French surfaces and contracts exist**. Pilot 1 is English Canada or US.
   - Tradeoff: slower proof in the home market.
5. **The 48 self-signup tenants.**
   - Recommend: **freeze + notice + export offer, delete after 30 days** (CC confirms the deletion run).
   - Tradeoff: a few real third parties lose free access they were never meant to have.
6. **Pitch guarantee.**
   - Recommend: **"Level 1 (your numbers) in 14 days or next month free"**, Setup/Managed only.
   - Tradeoff: margin risk on the install, capped at one month.
7. **Brand identity registry for 5+ parallel installs.**
   - Recommend: **after pilots, move the fail-closed map to one DB table that REPLACES both code maps** (not a seventh registry). The parity test becomes a DB-vs-deploy assertion.
   - Tradeoff: loses code review per client, gains no-deploy onboarding. Needs Codex review.

## 7. Risks to keep visible

- **Meta, Google and Twilio review calendars decide what DIY can promise.** Sell Meta features to DIY only after approval. Managed pilots use partner access meanwhile.
- **Clinic pack health-data exposure.** Gate it behind Lex. No US covered entities.
- **Managed AI budget vs real usage.** Unknown until the dogfood ledger has 30 days. Atlas re-sets budgets after P1.
- **Legal sign-off.** No sale with the current privacy page (false RLS claim) or without the DPA. This is a hard gate, not a polish item.
- **Unverified here:** whether migration 183 is live in production (the install console depends on it), and whether the target Turso plan supports FTS/vector. Check both at the start of P1.