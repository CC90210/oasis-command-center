# OASIS OS: product-surface design (plan mode, 2026-09-28)

**Scope and sources.** I read the brief, all four `occ__*.json` audits and `open_decisions.json`. In OCC I re-read the shell, nav, manifest, role, chat and delivery files cited below. I looked at Cook frames f_0016, f_0082, f_0101, f_0105, f_0115, f_0123, f_0150, f_0157, f_0188, f_0192 and f_0252.

The OCC checkout is on `fix/stripe-env-fallback-oasis-only` (19c76b11), 2 commits behind origin/main. Line numbers below come from that tree and may drift a few lines on main.

**What the SunBiz shutdown changes compared with the brief.** The brief assumed a paying SunBiz client had to be shielded (a separate `client-os` portal, a portal-scoped theme, SUN_SEED left untouched). All three constraints are gone. That lets us:
- **run one shell for every tenant**, with no `ui.shell` fork;
- **re-value theme tokens globally** (still without renaming them, because `.form-light` keys off class names: `app/globals.css:563-608`);
- **reclassify SunBiz-owned generic engines as shared.** `SUNBIZ_PORTAL.owns` currently lists `lib/drips/`, `lib/esign/`, `lib/import/`, `components/{esign,drips,import}/` (`lib/portals/registry.ts:226-257`). Moving them to shared is a change to the registry, not a code extraction.

Retiring SunBiz's routes, data and daemons stays gated. The order is: export first, then CC confirms at execution time, then routes are removed.

---

## 0. Decisions this design makes (CC can veto any one)

| # | Decision | Why |
|---|---|---|
| D1 | **Four modes: Team · Growth · Clients · Money.** Money replaces Cook's Browser. Admin (OASIS operators only) and Settings are reached from the rail footer, not as mode tabs. | Finance is the wedge, so it earns a mode. Browser is deferred (XL effort, ToS risk). |
| D2 | Mode tabs sit **inside the rail header**, as in Cook (f_0101, f_0115). There is **no new top bar**. | `--sidebar-w`, the MainShell margins and the mobile offsets stay as they are (`MainShell.tsx:37-38`; `globals.css:12-19`). |
| D3 | **Chief of Staff is both the first department channel and the target of the Ask bar (⌘K).** It is the orchestrator: goals and @routing. | One place for fuzzy asks. Clients see a role name, never an agent persona. |
| D4 | **Content is merged into Marketing by default.** A separate Content department can be switched on as a module (Managed tier). **Research is not a tab in v1**; it is a module that can be switched on. | "Only necessary functionality": a $10-50K business rarely staffs these separately. Departments are config, so splitting later costs nothing. |
| D5 | **Commissions sits under Growth › Sales** as an opt-in module, not under Money. | Reps need their own commissions but must never see Money mode. |
| D6 | **"Agents" (keep list) is kept in two forms.** Everyone gets a *Departments* section, because the agents are the departments. The OASIS tenant keeps the literal operator power chat (`/agent`, ChatWidget with CLI bridge) under **Admin › Agents**. | This honours CC's keep list and his "clients never see agents". |
| D7 | UI label **"Clients"** maps to the DB entity **`customer`**. OASIS's own clients are `customer` records in the OASIS tenant with a `linked_tenant_id`. | Ends the "client = tenant vs client = row" split flagged in `occ__sunbiz-and-data-layer.json`. Add the term to `CONTEXT.md`. |
| D8 | **An unknown or unprovisioned tenant renders an empty "being set up" shell, never OASIS's nav.** | Fixes `seeds.ts:900-903` fail-open, which today serves all 48 self-signups CC_NAV. |

---

## (a) Information architecture: one shell for every tenant

### Rail anatomy (every mode)

```
┌ Workspace name ▾  (operators: tenant switcher → Admin only)   [search ⌕]
│ avatar · name · email
│ ┌──────┬────────┬─────────┬───────┐
│ │ Team │ Growth │ Clients │ Money │   ← icon over 11px label; active = fg + 2px underline
│ └──────┴────────┴─────────┴───────┘   (Money is hidden unless the viewer is an owner)
│ [ Search ]  [+]  (+ = new chat / project / routine / client, depending on mode)
│ … per-mode rows (below) …
└ footer: [Setup checklist pill until readiness = 100%]  [plug · connections dot]  [gear]  [bell]  [shield: Admin — operators only]
```

### TEAM (landing mode)
| Row | Route | Notes |
|---|---|---|
| Today | `/` | **KEEP** (redesign §c) |
| Feed | `/feed` | badge = approvals waiting (red) |
| Schedule | `/schedule` | **KEEP** (rebuild §c) |
| Projects | `/projects` | **KEEP** (re-scoped: this tenant's projects, internal and per client) |
| Playbook | `/playbook` | **KEEP** (skills and SOP library §c) |
| **Departments ▾** (sentence-case group, collapsible) | | this section **is** "Agents" |
| Chief of Staff | `/team/chief-of-staff` | always on |
| Sales | `/team/sales` | always on |
| Marketing | `/team/marketing` | always on (includes content unless the `content` module splits it) |
| Client Success | `/team/client-success` | always on |
| Finance | `/team/finance` | module `finance` + owner only |
| Operations | `/team/operations` | owner/admin; **Operations redefined** (routines, connection health, imports) |
| Legal | `/team/legal` | module `legal` (off by default) |
| Content / Research | `/team/content`, `/team/research` | modules, off by default |
| **Chats ▾** | `/chats/[id]` | private 1:1 chats, auto-titled (existing `chat_sessions`), last 8 |

Each department row shows a trailing red pill (needs-you count) or a grey last-activity date, as in Cook f_0101.

### GROWTH (the tools the departments operate)
| Group | Row | Route | Gate |
|---|---|---|---|
| Sales | Pipeline | `/pipeline` | **KEEP**; stages come from the industry pack |
| | Conversations | `/growth/conversations` | SMS, email and DM inbox (harvested) |
| | Calls | `/growth/calls` | scheduled calls now; recordings and audits once module `meetings` is on |
| | Enablement | `/growth/enablement` | module `enablement` (on for OASIS) |
| | Commissions | `/growth/commissions` | module `commissions` (opt-in) |
| | Prospects | `/web-leads` | OASIS tenant only (module `prospects`) |
| Marketing | Forms | `/forms` | **KEEP**; a Funnel view lives inside |
| | Campaigns | `/growth/campaigns` | tabs: Email · SMS · Sequences |
| | Ads | `/growth/ads` | module `ads`; honest "Connect Meta" empty state |
| | Content | `/growth/content` | review queue, library, performance |

### CLIENTS (the business's own customers)
| Row | Route | Gate |
|---|---|---|
| All clients | `/clients` | |
| Support desk | `/clients/support` | badge = SLA breaches |
| Agreements | `/clients/agreements` | e-sign |
| Meetings | `/clients/meetings` | module `meetings` (Phase 3) |
| Portal | `/clients/portal` | module `portal` (settings and "preview as client") |
| **Recent ▾** | `/clients/[id]` | the last 8 client records viewed or pinned (Cook's per-client list) |

### MONEY (owner only; module `finance`)
Overview `/money` · Transactions `/money/transactions` · Invoices `/money/invoices` · Bills `/money/bills` · Reports `/money/reports` · Taxes `/money/taxes` (Taxes is hidden when the tenant's jurisdiction has no tax pack) · Accounts `/money/accounts` (bank, Stripe and QBO connection status).

### SETTINGS (gear; own rail when inside `/settings`)
Profile · Team · Connections · AI brain · Brand & domain · Modules · Notifications · Billing · Data & privacy · Audit log · Devices (operator only).

### ADMIN (shield; OASIS operators only: `isOperatorEmail` + OASIS tenant + founder persona + a server `requireOperator()` on every page)
Systems · Health · Automations · Agents (fleet + power chat) · Tenants (provisioning, manifest editor) · Event log (cross-tenant) · Retirement (SunBiz runbook status).

### Customer-facing portal (separate full-bleed layout, customer magic-link auth)
`/portal`: the customer's Projects and updates · Requests (tickets) · Agreements to sign · Files · Invoices (pay link through the tenant's Stripe) · Shared thread.

### Route mapping table

Verdicts: KEEP · RENAME · MERGE · MOVE (new path; old path redirects) · SETTINGS · ADMIN · CUT (redirect) · RETIRE (SunBiz funding code: export, then CC confirms, then delete) · HARVEST (generic SunBiz engine moved into core).

| Current route / surface | Verdict | New home (label) | Notes / evidence |
|---|---|---|---|
| `/` Today | KEEP, redesign | Team › Today | Replace the persona dispatch (`app/page.tsx:136-202`) with `components/os/today/*`. Remove the SunBiz redirect `app/page.tsx:83-88` **at retirement**. Strip the operator copy at `FounderToday.tsx:336,340,350`. |
| `/schedule` | KEEP, rebuild | Team › Schedule | Today it is localStorage-only with Shabbat seeded (`lib/schedule/model.ts:158-175`). Reconcile APEX PR #287 `/calendar` first. |
| `/pipeline` (+`[id]`, `/new`) | KEEP, redesign | Growth › Sales › Pipeline | Drop the non-OASIS redirect to `/t/<slug>/leads`. Stages come from the manifest pipeline config; OASIS's 14 stages (`lib/oasis-stage-meta.ts`) become OASIS config. |
| `/forms` (+`[id]/edit`) | KEEP | Growth › Marketing › Forms | Add a Funnel tab (views, submits, booked, won). Remove the "Supabase migration 042" copy (`app/forms/page.tsx:101-112`). |
| `/f/<tenant>/<form>[/<token>]` | KEEP (public contract) | unchanged | Generalize the support form per tenant (`lib/delivery/support-form.ts:38-40` is pinned to `oasis-ai-cc`). |
| `/agent` | KEEP (split, D6) | Departments section (everyone) + Admin › Agents › Chat `/admin/agents/chat` | `/agent` sends operators to `/admin/agents/chat` and everyone else to `/team/chief-of-staff`. MainShell's `isOwnAgentChatPath` moves with it (`MainShell.tsx:75-77`). |
| `/agents` | ADMIN | Admin › Agents | Removes the second ChatWidget mount (`app/agents/page.tsx:225-250`). |
| `/playbook` (+`/deals`, `/script`, `/automations`, `/business`, `/prompts`, `/drills`, `/onboarding`, `/client-deploy`, `/[slug]`) | KEEP, rebuild | Team › Playbook | OASIS markdown becomes rows in the OASIS tenant's `playbook_docs` (fs reads at `lib/playbooks.ts:13,25` are empty on the Worker). `/playbook/security` goes to Admin. The SunBiz `sun-*` branch is RETIRED. |
| `/feed` | KEEP, rebuild | Team › Feed | Remove `"/feed": "/operations"` from `middleware.ts:180`. |
| `/reasoning` | MERGE | Department panel "Suggested asks" + decisions shown in the channel | Redirect to `/team/chief-of-staff`. Reuse `lib/quick-actions.ts` and `components/AgentDecisionsCard.tsx`. |
| `/operations` | ADMIN (move) | Admin › Systems | Bridge heartbeats, CLI probe and warm pool. The client-facing "Operations" becomes the Operations department. |
| `/automations` | SPLIT | Clients see Routines (department panels + Team › Operations); cron, the Python drafter and workers go to Admin › Automations | `AutomationsContent.tsx` stays admin-only. |
| `/health` | MERGE | Admin › Health; client-safe checks go to Operations › Connections health; the stale-lead alert becomes a Sales routine | Drop the "Quiet shop-outs" card (`health/page.tsx:414-416`) at retirement. |
| `/analytics` | MERGE + CUT | Money › Overview (money); Sales and Marketing department Numbers (funnel, sources) | Delete the fake-MRR path at `lib/queries.ts:1010-1025`. |
| `/projects` (+`[id]`) | KEEP, re-scope | Team › Projects + the client record's Projects tab | Generalize `DELIVERY_TENANT_ID` (`lib/delivery/rules.ts:18`) to the session tenant and add `customer_id`. |
| `/tickets` (+`[id]`) | REBUILD | Clients › Support desk `/clients/support` | Same store, SLA and comments. `tenant_id` = the business; the requester is its customer. |
| `/settings` | SPLIT | Settings rail (see (a)) | `SettingsContent.tsx` is broken into per-section pages. |
| `/settings/audit-log` | KEEP | Settings › Audit log | Absorbs `/runs`. |
| `/settings/devices/install`, `/desktop-link`, `/download` | ADMIN / operator-only | Settings › Devices (operator only) | The bridge is never client-facing. |
| `/web-leads` (+`[id]`, `/pipeline`) | KEEP (OASIS only), RENAME | Growth › Sales › **Prospects** | Label was "Leads". APEX is active on it (#462); lease required. |
| `/commissions` | MOVE (opt-in) | Growth › Sales › Commissions `/growth/commissions` | `maySeeCommissionSurface` is unchanged (`role-surfaces.ts:454-458`). |
| `/training` (+sub), `/objections` (+`/practice`) | MERGE | Growth › Sales › Enablement (tabs Training · Objections · Roleplay) | APEX-built; coordinate. |
| `/founders/finances` (+`accounts`, `bills`, `invoices`, `reports`, `settings`, `taxes`, `transactions`) | MOVE | Money mode (OASIS tenant first, owner only) | Stays keyed to `fin_ent_oasis` until the Finance domain re-tenants `fin_*`. |
| `/founders/marketing` (+`library`, `train`, `performance`, `asset/[id]`) | MOVE | Growth › Marketing › Content (OASIS tenant); `train` goes to Playbook › Skills ("Teach from a URL") | Client tenants get the same tool with tenant-scoped assets in Phase 2. `/arthrisil` becomes a brand group inside OASIS Content. |
| `/founders/growth` (+`organic`, `paid`, `outreach`, `connections`) | CUT | Rebuilt as Growth › Marketing › Ads | Placeholders behind `MARKETING_SHELL_ACTIVE=false` (`registry.ts:134`). |
| `/client-portal` | REBUILD | `/portal` (customer) + `/clients/portal` (settings) | The fake ROI (events × 5 min) is cut. |
| `/team` | SETTINGS | Settings › Team `/settings/team` | `app/team/page.tsx` redirects. `/team/[dept]` is a new route beside it. |
| `/integrations` | CUT | Settings › Connections | Change the redirect target in `middleware.ts:181`. |
| `/onboarding/welcome` | SETTINGS | Settings › Profile + a first-login checklist on Today | |
| `/onboarding/wizard`, `/onboarding` | REBUILD / CUT | Admin › Tenants › Provision (done-for-you) | The wizard never links the manifest to the tenant (`wizard-finalize.ts:86-150`). |
| `/signup` | GATE | Invite or checkout token only | Remove brand-text shell matching (`lib/client-profiles.ts:193-219`). |
| `/invite/[token]`, `/login` | KEEP (restyle) | unchanged | |
| `/configure`, `/start` | CUT | `/start` goes to `/login`; the marketing header gets Sign in | Developer install funnel is the wrong buyer. |
| `/runs` | MERGE | Settings › Audit log | No persona gate today. |
| `/inbox`, `/system-health` | CUT | Admin › Systems | No persona gate; fs-backed. |
| `/interactions/[id]` | MERGE | Client record › Activity (drawer) | Still reads the legacy `leads` table (`:72`). |
| `/sign/[token]`, `/unsubscribe`, `/api/webhooks/*`, `/api/cron/*` | KEEP (public contracts) | unchanged | |
| `/t/[slug]/*` catch-all, `/editor`, `/agent/[agent]` | KEEP engine, ADMIN | Admin › Tenants (preview, manifest editor) | The OS adds no routes under `/t`. OS pages always take the tenant from the session. |
| `/t/[slug]/marketplace` | CUT (client nav) | Admin only | Clients never pick agents. |
| **SunBiz harvest** | | | |
| `/sequences` (+`[id]/edit`), `lib/drips/**`, `drip_*`, crons `enroll-drips`/`dispatch-drips` | HARVEST | Growth › Marketing › Campaigns › Sequences; Sales "follow-up sequence" routines | Reclassify `lib/drips/` as shared. FUNNEL/stage lists come from the manifest. |
| `/t/sun/conversations` (`conversations` kind), `conversation_threads/events`, `channel_accounts` | HARVEST | Growth › Sales › Conversations | `components/conversations/**` is **APEX-owned**; handoff needed. Twilio is the client transport. |
| `/t/sun/calls`, `call_appointments`, `scheduled_calls` | HARVEST | Growth › Sales › Calls + Schedule | |
| `/t/sun/campaigns`, `/email-blast`, `components/campaigns/**` | HARVEST / MERGE | Growth › Marketing › Campaigns | APEX-owned UI. The Constant Contact OAuth pattern is kept. |
| `/sms` | MERGE | Composer inside Conversations | Keep `/api/sms/*`. |
| `esign` kind, `lib/esign/**`, `components/esign/**` | HARVEST | Clients › Agreements | Reclassify as shared. |
| `/import`, `/t/sun/import`, `lib/import/**` | HARVEST | Settings › Data › Import + "Import clients/leads" action in Operations | Reclassify as shared. |
| `/metrics`, `/drip-tracker`, `lib/metrics/**` | HARVEST / MERGE | Marketing Numbers + Campaigns › Performance / Sequences › Activity | `FUNNEL_ORDER` (funding) comes from the manifest. |
| `lib/lead-documents.ts`, `r2-storage.ts`, `document_extraction_jobs` | HARVEST | Files tab (client record, project) | |
| `lib/tenant/public-identity.ts`, `lib/email/brand-for-tenant.ts`, unsubscribe, `email_suppressions` | HARVEST (core) | Settings › Brand & domain | The brand map becomes DB-backed and stays fail-closed (other domain). |
| `lib/health/**`, `health_check_runs` | HARVEST | Operations dept (client-safe) + Admin › Health | |
| `/demo/sun` + `lib/sunbiz-demo-data.ts` | RETIRE → rebuild | Later: generic `/demo` sample workspace (Phase 3 sales asset) | Keep the pattern, drop the SunBiz data. |
| Helios SMS reply agent (`sms_agent_*`) | HARVEST pattern | Sales "AI setter" (approval-gated) | Persona and prompts retired. |
| `/t/sun` dashboard, `/templates`, `/renewals`, `/funded-deals`, `/offers`, `/lenders`, `/applications` (+`[id]/shop-out`), `/contacts`, `/embed`, `/t/sun/{leads,shopping-out,applications,offers,renewals,commissions,lenders}`, `lib/{lenders,underwriting,renewals,applications,clair,background-check,cold-outreach}/`, `lib/sunbiz-*`, `components/{sunbiz,lenders,underwriting,shop-out,shopping-out,offers,renewals,applications}/`, `/api/merchants/*`, `agents.config.json` (SunBiz rep PII), `SUN_SEED`, `SUN_PROFILE`, `SUNBIZ_PORTAL`, Kixie/TextTorrent webhooks + crons | RETIRE | Redirect to `/`. Code is deleted after export and CC's confirmation. Tables are dropped by a reviewed migration. | First repoint `lib/setup-readiness.ts:221` (the `/lenders` CTA). |
| `/t/suga/*`, `SUGA_SEED`, `SUGA_NAV`, `SUN_NAV` | CUT | none | Dead arrays (`nav-config.ts:157-264`). No `suga` tenant exists. |

---

## (b) Department-tab anatomy and the v1 department list

### Standard anatomy: `/team/[dept]` → `components/os/department/DepartmentTab.tsx`

```
┌ Header: # Sales   ● Working | ● Needs you (3) | ○ Not connected      [⚙ channel settings] [Overview ⇥]
├───────────────────────────────────────────────┬───────────────────────────────┐
│ CHANNEL (main)                                 │ OVERVIEW PANEL (320px, collapsible;
│  Slack-style rows, no bubbles                  │  becomes a sheet on mobile)
│  • human msgs · agent msgs with "Worked 2m14s ·│  1. Needs you (top 3 approval cards,
│    Used Proposal skill · Pulled Stripe" chips  │     inline Approve / Send back) → "All in Feed"
│  • cards: Goal · Approval · Routine · Call     │  2. Numbers (3-4 KPI tiles, unknown ≠ 0)
│    recorded · Deliverable (rev n)              │  3. Routines (name · plain-English trigger ·
│  • threads (right drawer), Team-only toggle    │     On/Off/Testing · last run)
│ Composer: "Message #sales — use @ to mention"  │  4. Connections (chips with status → Settings)
│  [+ attach] [Message ▾ / Plan] [send]          │  5. Suggested asks (from lib/quick-actions.ts)
└───────────────────────────────────────────────┴───────────────────────────────┘
```

Outputs and deliverables have no separate sub-tab. They appear as cards in the channel and in Feed filtered by department ("See all in Feed"). That keeps one destination per department.

The header never shows an agent name or persona. `manifest.agents[].display_name` may rename the department, for example "Front Desk" for Client Success.

**KPI tiles.** Every tile uses the "unknown is not zero" pattern from `lib/goals/oasis-money.ts`: an em dash or "Not connected" with a Connect link, never $0.

| Department | Gate | KPIs (3-4) | Default routines (all start **Off**; dry-run before On) | Connections |
|---|---|---|---|---|
| **Chief of Staff** | always | Goals on pace x/y · Approvals waiting · Overdue tasks | Morning brief (weekdays 7:30) · Weekly goals review (Mon) | Slack/Discord notify, Google Calendar |
| **Sales** | always | New leads 7d · Median speed-to-lead · Calls booked 7d · Win rate 30d | Speed-to-lead reply (event: new lead → draft → approval) · Stale-deal sweep (daily, idle >14d) · Call prep (event: call booked) | gmail.send, Twilio, GHL (import), Calendar |
| **Marketing** | always | Leads by source 7d · Cost per lead · Ad spend 7d · Form conversion | Meta ads daily check · Weekly winning-ads report · Competitor ad breakdown (weekly) · Content ideas (weekly) | Meta Ads, Instagram (Zernio), Constant Contact |
| **Client Success** | always | Open tickets / SLA breaches · Avg first response · Projects on track · At-risk clients | Ticket triage (event: ticket created) · SLA watch (reuse `lib/delivery/sla-cron.ts`) · Meeting recap (event: call recorded) · Weekly client health | Recall/Fathom, Zoom, Meet, Twilio |
| **Finance** | module `finance`, owner only | Cash on hand · Collected this month · Overdue receivables · Runway (months) | Daily cash snapshot · Monday money brief · Overdue-invoice reminder drafts · Month-end close checklist | Stripe (restricted key), QBO/Xero, Plaid (Trial), CSV/OFX |
| **Operations** (redefined) | owner/admin | Routines healthy x/y · Connections healthy x/y · Failed runs 24h · Imports pending | Connection health (hourly, system) · Failed-run digest (daily) | all (read-only status) |
| Legal | module `legal` (off) | Out for signature · Expiring in 30d | Contract renewal watch | e-sign |
| Content / Research | modules (off) | Posts scheduled / Research briefs | Daily reel ideas / Competitor sweep | Zernio, research fetch |

**Why this set.**
- **Chief of Staff** is needed as the router: Goal cards, @delegation, and the Ask bar target.
- **Sales, Marketing and Client Success** cover what every $10-50K service business runs.
- **Finance** is the wedge.
- **Operations** is CC's word. It is also where Routines and connection health live without exposing plumbing. The internals (bridge, CLI, heartbeats) are Admin only.
- **Legal, Content and Research** are opt-in so the default rail stays at six departments.

**Agent binding.** A new `manifest.os.departments[]` entry binds `department_key → agent_slug`.
- Client tenants bind neutral templates (`dept.sales` and so on) in the new `lib/os/department-personas.ts`. These carry no CC or OASIS strings, reuse `IDENTITY_LOCK_OVERLAY` (`lib/agent-personas.ts:466`) and the library categories (`lib/agents/library.ts:18-35`).
- The OASIS tenant binds its existing personas: Chief of Staff→bravo, Marketing→maven, Finance→atlas (Atlas owns the numbers).
- The mechanism is the same for both; only the config differs.

---

## (c) Surface designs

### Today (`/`)
Cook's Home (f_0016) was adapted to "Today". It uses one component tree, with persona decided by what data each block may fetch (`capabilitiesFor`).

1. **Greeting line and composer.** "What should the team work on today?" posts to the Chief of Staff channel as a new thread and supports @mentions. Suggested-ask chips sit underneath.
2. **Needs you.** Up to 5 approval cards with inline Approve · Send back · Open, then "All N in Feed →". Always first.
3. **Overnight.** One compact card per enabled department: a status dot, "did" (count plus a one-line summary from the `agent_events` projection via `lib/event-projection.ts`), and "waiting" (count). The card links to `/team/<dept>`.
4. **Right column:**
   - *Today's schedule*: next 3 calendar events, or a "Connect Google Calendar" empty state.
   - *Goal pace* (owner): reuse `components/GoalCountdownCard.tsx`.
   - *Cash* (owner, finance module): reuse the money loader, with a "Not connected" state.
   - *Setup checklist* until readiness is complete: reuse `lib/setup-readiness.ts`.
5. **Persona variants:**
   - A sales rep sees their own leads needing action, their calls today and their approvals.
   - A client-success member sees tickets near SLA and projects due.
   - Readonly sees the same blocks with the actions removed.

This replaces `FounderToday`, `RepToday`, `ManagerToday`, `MarketingToday` and `DeliveryToday` with `components/os/today/{TodayPage,AskComposer,NeedsYouList,DepartmentOvernightCard,ScheduleGlance,CashGlance,SetupChecklist}.tsx`. Their permission-scoped reads in `lib/queries.ts` are reused.

### Feed and approvals (`/feed`)
- **Top:** a department "stories" row (All · Chief of Staff · Sales · Marketing · CS · Finance · Ops) as in f_0157, filter tabs **Needs you · All · Shipped**, and search.
- **Card:** department icon, title, revision ("v2"), the requesting department, when, and a full preview (email or SMS body, post creative, ad set shown as PAUSED, document).
  - Actions: **Approve · Send back** (a note is required and goes back to the agent) **· Comment · Share with client** (only if the card is linked to a client and the portal is on) **· Open in channel**.
- **After Approve,** the card shows the executed result: "Sent ✓ 10:42" or "Failed: Twilio 21610, recipient opted out". It never claims success on its own.
- **Batch mode** is for setter SMS (Cook "7 APPROVALS"). Items are reviewed one after another with J/K, and A/S are keyboard shortcuts.
- **The same approval object renders in three places:** the channel (card), Today (Needs you) and Slack/Discord (buttons).
- **Data:** a new `approvals` table (see (f)). The Feed list is `approvals ∪ deliverable events` projected per tenant, filtered by `correlation_id` until `agent_events` gets a `tenant_id` (`app/api/event-feed/route.ts:70-73`). The operator cross-tenant branch (`:39`) is used **only** by Admin › Event log.

### Clients mode
**`/clients` list.** Columns: Name · Status (the industry pack's customer lifecycle, e.g. Onboarding / Active / Paused / Past) · Owner · Open tickets · Active projects · Last touch · Health · Value (owner only). A "Won" stage in Pipeline offers "Convert to client", which creates a `customer` record linked to the lead.

**Client record `/clients/[id]`.**
- **Header:** name, company, status, owner, portal badge. Actions: Message · New ticket · New project · Send agreement.
- **Tabs:**
  - **Overview:** Client Success agent summary, key facts, next meeting, open items.
  - **Channel:** customer channel. It is team-only by default; if the portal is on it becomes the shared thread with a Team-only toggle, as in f_0123.
  - **Projects**, **Tickets**, **Meetings** (module), **Agreements**, **Files** (R2).
  - **Activity:** timeline of `lead_interactions`, form submissions, tickets, meetings and payments.
  - **Billing:** owner only; Stripe and ledger lines for this client.

**Support desk `/clients/support`.**
- Views: Open · Breaching · Waiting on client · Resolved.
- Ticket detail: public reply vs internal note, AI draft reply (approval-gated), linked client and project.
- Intake: per-tenant public form `/f/<tenant>/support`, the portal's "New request", and later email-in.
- Reuse `lib/delivery/{store,rules,sla-cron,support-intake,notify}.ts`. Change the viewer model in `lib/delivery/access.ts` from "founder vs client workspace" to "team member vs portal client".

**Agreements `/clients/agreements`.** Envelope list (draft/sent/viewed/signed/declined), created from a Playbook template, or "Draft with Legal" if the Legal module is on. It uses the harvested `lib/esign`, and the public `/sign/[token]` is unchanged.

**Portal.** `/clients/portal` holds the settings: modules, branding and "Preview as client". The customer-facing `/portal` is described in (a).

**Help from OASIS.** The client workspace's own "Get help from OASIS" button (footer bell menu) opens the OASIS tenant's support form prefilled. OASIS's vendor support thereby becomes just the OASIS tenant's instance of the same desk.

### Schedule (`/schedule`)
- **Tabs: Calendar · Booking links.**
- **Calendar:** a week view merging Google Calendar events (`lib/integrations/google-calendar.ts`, per-user OAuth), booked calls (`call_appointments`), project and task due dates, and optionally routine run times.
- **Personal time blocks** persist server-side in a new `schedule_blocks` table (tenant_id, user_id). The hard-coded Shabbat seed becomes a user-level "recurring blocks" preference that CC re-applies to himself.
- **Booking links:** availability plus public booking pages over `bookings`/`booking_slots`. The setter books into these.
- **Meeting capture:** events with a Meet or Zoom link show a "Record with notetaker" toggle (Phase 3, announced bot, bilingual notice).
- **Coordination:** reconcile APEX PR #287 first. It touches `nav-config.ts`, `role-surfaces.ts` and `Sidebar.tsx`.

### Playbook as a skills library (`/playbook`)
- **Tabs: Skills · SOPs · Templates.**
- A skill card shows: name, when to use it, steps, which departments use it, source (you / an agent / an OASIS pack), and last used.
- Agents read skills through retrieval. When an agent proposes a new skill, it posts a "Save as skill" approval card (Cook f_0150).
- **Storage:** new `playbook_docs` (tenant_id NOT NULL, kind, slug, title, body_md, departments_json, source, version, updated_by).
- **Content:** OASIS's `content/playbooks/*.md` is imported as OASIS-tenant rows. Industry packs seed skill packs. Uploading a PDF creates a `.md` twin (Phase 3).

### Routines UX
- **Where:** each department panel lists its own routines. Team › Operations lists all of them.
- **Card (f_0188):** a trigger chip (SCHEDULE / EVENT·NEW LEAD / MANUAL), step count, department chip, a plain-English schedule ("Weekdays at 8:00 AM, Montreal"), last run and a toggle. Cron syntax never appears in client UI.
- **Built from chat (f_0192):** the user states the deliverable, how to QA it and the output.
  1. The agent drafts a spec (trigger → Get data → AI task → Quality check → Output: post to channel / create approval / update record).
  2. It posts a Routine card: "Off: it has never run · **Test it**".
  3. The dry run executes with outward tools in simulate mode ("nothing real is sent") and shows its outputs.
  4. A pass enables **Turn on** (owner/admin). A fail leaves it Off, with the reason.
- **v1 steps are a list, not a graph.**
- **Triggers:** Schedule · Event (new lead, form submitted, ticket created, call recorded, invoice overdue, payment received) · Manual. Inbound webhook is admin only.
- **Execution:** one Worker cron route `/api/cron/routines-tick` every minute dispatches due routines. It is registered once in `workers/oasis-cc-cron/src/index.ts` and `config/cron-registry.json`, never one cron per routine.

### Connections hub (`/settings/connections`)
- **Grouped by purpose:**
  - Money: Stripe, Bank (Plaid / QuickBooks / Xero / CSV-OFX)
  - Calendar & email: Google Workspace
  - Meetings: Zoom, Meet, Recall, Fathom
  - Messaging: Twilio SMS, Slack, Discord
  - Ads & social: Meta Ads, Instagram
  - Import: GoHighLevel, CSV
- **Each card shows:**
  - Status: Connected · Needs attention · Not connected · **Pending platform approval** (e.g. "Meta review in progress; pilot through partner access").
  - Which departments use it.
  - Its scope, stated plainly: "Read-only" / "Can send (every send needs your approval)".
  - Last sync, pass-through cost where one applies (a Twilio number at cost plus margin), and Connect / Reconnect / Disconnect.
  - For Setup and Managed tiers: "OASIS connects this during your install".
- **Registry filter:** add `audience: "client" | "operator"` to `lib/integrations-registry.ts`, so kraken, oanda, obsidian and the like (`:66-540`) never render for clients.
- **Storage:** `tenant-integration-store`. The env-fallback fix is Phase 0 (`tenant-integration-store.ts:190-193`).

### Settings split
| Section | Content (source) |
|---|---|
| Profile | `/onboarding/welcome` fields + password + personal Google OAuth (`PersonalIntegrationsPanel`) |
| Team | invites, roles, department access (`app/team/page.tsx`, `lib/team.ts`) |
| Connections | hub above |
| AI brain | managed default / BYO key / per-department model, spend cap, usage meter (`agent_model_config`) |
| Brand & domain | logo, accent, sending domain, portal domain |
| Modules | Finance · Commissions · Legal · Content · Research · Ads · Meetings · Portal toggles, with tier gating |
| Notifications | Slack/Discord/email digests, per-department approval routing |
| Billing | OASIS OS tier + pass-through usage |
| Data & privacy | export, delete, retention, Law 25 privacy officer contact |
| Audit log | `/settings/audit-log` + the `/runs` stream |
| Devices | operator only (bridge pairing) |

### Admin (operators only)
| Page | Source |
|---|---|
| Systems | `/operations` contents (workers, bridge, CLI probe, warm pool, raw activity tape), `/inbox`, `/system-health` |
| Health | `/health` |
| Automations | `AutomationsContent` (cron manager, Draft-with-AI Python, background workers) |
| Agents | `/agents` fleet + `/admin/agents/chat` (the persistent ChatWidget, `advanced_picker`) |
| Tenants | workspace list, provisioning runs, `/t/<slug>/editor`, read-only preview |
| Event log | operator branch of `/api/event-feed` |
| Retirement | SunBiz export/delete checklist state |

---

## (d) Dark theme spec

**Approach.** Convert the palette to CSS variables with `<alpha-value>`, then re-value it globally. There are **no token renames**: that would touch about 300 files, and `.form-light` depends on the class names (`globals.css:571-578`). With SunBiz shut down, no paying tenant needs a portal-scoped fork. The same variables later let `manifest.brand.primary_color` (`schema.ts:61-62`, currently unused) set `--c-accent` per tenant with one line in `layout.tsx`.

**`tailwind.config.ts:16-49`** becomes, for example, `bg: { DEFAULT: "rgb(var(--c-bg) / <alpha-value>)", … , rail: "rgb(var(--c-rail) / <alpha-value>)" }`. Add `hairline: "rgb(255 255 255 / 0.07)"` and `active: "rgb(255 255 255 / 0.06)"`. Leave `ops.*` and `signal.*` untouched (marketing).

| Token | Now | New (`--c-*` in `globals.css :root`) | Role |
|---|---|---|---|
| html/body ground (`globals.css:23`) | #020409 | **#030304** | window ground = rail |
| `bg.rail` (new) | none | **#030304** | rail + mobile bar (Cook: rail on pure black) |
| `bg.DEFAULT` | #06070a | **#0a0a0b** | the floating content canvas |
| `bg.deep` | #0a0c10 | **#070708** | inputs, menus |
| `bg.panel` | #0e1014 | **#0e0e10** | cards on the canvas |
| `bg.raised` | #15181e | **#131315** | raised cards |
| `bg.elev` | #1c2028 | **#18181b** | popovers, hover elevation |
| `bg.border` | #22262e | **#202024** | solid borders (legacy) |
| `hairline` (new) | none | **rgb(255 255 255 / .07)** | every OS divider and border |
| `bg.hover` | #1a1d24 | **#161619** | row hover |
| `fg.DEFAULT` | #faf9f5 | **#ededef** | primary text |
| `fg.muted` | #9ca0a8 (blue-grey) | **#a0a0a7** (neutral) | inactive rail rows, secondary text |
| `fg.dim` | #5b6068 | **#75757d** (≥4.5:1 on canvas) | meta, icons |
| `fg.faint` | #3a3d44 | **#45454b** | decorative only |
| `accent` | #3b82f6 | unchanged (var) | primary action, focus, links only |
| unread / needs-you pill | accent | **status.hot #ef4444** | Cook's red counters |

**`globals.css` retune.** Hard-coded hexes are replaced with the variables:
- `select option` (`:43-47`), scrollbar (`:96-102`), `.input/.textarea/.select` (`:174-189`, now `bg-deep` + hairline + accent/60 focus with no glow ring), `.label` (`:191-195`, sentence case 12px instead of uppercase tracking);
- `.btn-primary` (`:197-209`, flat accent with no gradient or glow), `.btn-secondary` (`:210-219`), `.mdx-content` (`:135-171`).

The `.bubble-*`, `.chat-*` and `.agent-*` styles stay, because only the operator ChatWidget uses them.

**Removed from the OS shell:** body `grain` (`layout.tsx:371`), `.top-glow` (`Sidebar.tsx:397`), the active-row `shadow-glow` bar and inset blue ring (`Sidebar.tsx:586,591`), and `scan-line` / `card-glow` / `shadow-ironman` in OS components.

**Layout rules (from f_0016, f_0101, f_0115, f_0123):**
- **Canvas:** `<main>` gets `md:p-2 md:pl-0`. The inner wrapper is `rounded-xl border border-hairline bg-bg min-h-[calc(100dvh-1rem)]`. The rail sits directly on the ground with **no right border**; the canvas edge is the separation. This happens in `MainShell.tsx:37-42,112-135`, and the ChatWidget overlay offsets at `:152` gain `md:top-2 md:right-2 md:bottom-2`.
- **Content header:** 44px, hairline bottom. On the left, a 13px breadcrumb "Workspace › Page" (fg-muted, current page in fg). On the right, the **Ask** button (sparkle icon, opens the Ask drawer) and page actions.
- **Rail:** 240px (keep `--sidebar-w: 15rem`).
  - Rows are `h-8 px-2.5 gap-2.5 rounded-lg`, 14px weight 500. Inactive rows are fg-muted with dim 16px icons at stroke 1.75. The **active row is `bg-active text-fg` with no blue.**
  - Group headers are sentence case, 12.5px, fg-dim, with a chevron (replacing the 10px uppercase header at `Sidebar.tsx:524`).
  - Trailing meta is 11px tabular.
- **Mode tabs:** 4 equal columns, 18px icon over an 11px label, inactive fg-dim, active fg with a 2px fg underline.
- **Type scale:** page title 20/28 semibold (-0.01em) · section 14 semibold · body 14/22 · secondary 13/20 fg-muted · meta 12/16 fg-dim tabular · chips 10.5px uppercase with 0.06em tracking (chips only, e.g. SCHEDULE / INBOUND). Keep the system font stack (the zero-webfont first paint noted in `tailwind.config.ts:93-97`).
- **Density:** cards `rounded-xl p-4 bg-bg-panel border-hairline` with no shadow. Table rows 36-40px with hairline separators and no zebra striping. Channel rows use a 28px avatar, name 14 semibold plus meta 12 dim, and body 14/1.55. Hover toolbar: react · reply · pin · delete. Team-only messages get an eye-off label and a 2px amber left rule.
- **Motion:** 120-160ms opacity and transform only.

---

## (e) Nav plumbing: one manifest-driven model

**Today there are three sources.** `nav-config.ts` arrays are live only through seeds (`seeds.ts:97,263`). `SUN_SEED` has an inline nav. DB rows override seeds (`loader.ts:60-65`). Unknown slugs fall back to `OASIS_SEED` (`seeds.ts:900-903`). Founders rows are injected in `layout.tsx:306-335`, and persona href allowlists run last (`role-surfaces.ts:567-722`).

**Target: nav is computed, not stored.**

```ts
// lib/os/types.ts (shared)
export type OsSection = "team" | "growth" | "clients" | "money" | "settings" | "admin";
export type ModuleKey = "finance"|"commissions"|"legal"|"content"|"research"|"ads"|"meetings"|"enablement"|"prospects"|"portal";
export type DepartmentKey = "chief_of_staff"|"sales"|"marketing"|"client_success"|"finance"|"operations"|"legal"|"content"|"research";
export type OsNavEntry = {
  id: string; href: string; label: string; icon: NavIconKey;
  section: OsSection; group?: string;            // "Sales" | "Marketing" | "Departments" | "Recent"
  department?: DepartmentKey; module?: ModuleKey;
  audience?: "everyone" | "owner" | "manage" | "operator";
  oasisOnly?: boolean; badgeKey?: string;
};
// manifest.os (new block in TenantManifest)
os?: { tier: "diy"|"setup"|"managed"|"internal"; industry_pack: string; modules: ModuleKey[];
       departments: { key: DepartmentKey; enabled: boolean; agent_slug: string; display_name?: string;
                      prompt_overlay?: string; tool_palette?: string[]; visible_to_roles?: string[] }[];
       nav_overrides?: { hide?: string[]; rename?: Record<string,string> }; finance_viewers?: string[] };
```

**`buildOsNav({ manifest, persona, capabilities, isOperator, tenantSlug })` (pure):**
1. Start from `OS_NAV_CATALOG`.
2. Drop entries whose module is not in the resolved modules (`manifest.os.modules` ∪ tier defaults).
3. Drop entries whose department is disabled, or not in `PERSONA_DEPARTMENTS[persona]` / `visible_to_roles`.
4. Apply the audience rule:
   - owner: `canSeeWorkspaceMoney`
   - manage: owner/admin
   - operator: `canSeeAdmin`
5. Drop `oasisOnly` entries unless `isOasisSurfaceTenant`.
6. Apply `nav_overrides`.
7. Run **`filterNavForPersona` last** (defence in depth; every route still has its own server gate).
8. Group by section. **Sections with zero rows are not rendered.** Money disappears for non-owners.

**No manifest row → `UNPROVISIONED_SEED`:** Today (a "Your workspace is being set up by OASIS" card) plus Settings › Profile. It never contains OASIS rows.

**Active mode (client side, in `OsRail`).** A longest-prefix match of the pathname over all entries gives the section, reusing the logic at `Sidebar.tsx:299-314`. When nothing matches, the last mode is kept from sessionStorage. Clicking a mode tab goes to its first row: Team→`/`, Growth→`/pipeline`, Clients→`/clients`, Money→`/money`.

**Files to change**
| File | Change |
|---|---|
| `lib/os/{types,nav,modules,departments,department-personas,industry-packs}.ts` (new, shared) | Catalog, `buildOsNav`, `TIER_MODULES` (diy/setup/managed/internal), department catalog (KPIs, default routines, connections), neutral personas, and packs: `service_general` default, `agency`, `home_services`, plus an OASIS website-sales pack holding the 14 stages as data. |
| `lib/nav-config.ts` | Keep the `NavItem` / `NavIconKey` types and add `section?`. Add icons: Home, Rss (Feed), CalendarDays, FolderKanban, Library, Hash, Wallet, Receipt, Scale, LifeBuoy, Handshake, Shield. **Delete `SUN_NAV` and `SUGA_NAV` now** (dead). Delete `CC_NAV` and `WEBDEV_NAV` at cutover. |
| `lib/manifest/schema.ts` | Add `ManifestOsConfig` + parser (`parseUi` is at `:796`; add `parseOs`). `NAV_ICON_KEYS` (`:514`) gains the new icons. Add page kind `department`. Remove the `shopping_out` / `offers_v2` / `lenders_v2` / `renewals_v2` kinds at retirement. Logo keys `sunbiz` / `suga` parse as `custom`. |
| `lib/manifest/seeds.ts` | Replace with `OASIS_TENANT_SEED` (oasis-ai-cc, tier internal, modules incl. prospects / enablement / commissions / finance) and `UNPROVISIONED_SEED`. `getSeedManifest(unknown)` returns `UNPROVISIONED_SEED` (D8). Delete `SUN_SEED` / `SUGA_SEED` (the SUN one after retirement). |
| `lib/manifest/loader.ts` | `manifestNavToNavItems` is replaced by `buildOsNav`. Once the Phase-0 slug guard (b478c58b) merges, load by the session tenant id. |
| `lib/manifest/templates.ts`, `wizard-finalize.ts` | Retire the `business_funding` template. Templates become industry packs that feed Admin › Tenants › Provision. |
| `lib/client-profiles.ts`, `lib/client-provisioning.ts` | Delete `SUN_PROFILE`, `SUGA_PROFILE`, `getClientProfileSlugForBrand` (`:193-219`) and the brand-text matching. Provisioning sets `custom_fields.os_pack` explicitly. |
| `lib/role-surfaces.ts` | See the four changes below the table. |
| `app/layout.tsx` | Build the nav through `buildOsNav`. Remove the founders injection (`:306-335`, replaced by Money and Content), the SunBiz demo labels (`:418-421`) and `grain` (`:371`). Pass `sections` and `canSeeAdmin`. |
| `components/Sidebar.tsx` → `components/os/OsRail.tsx` (+ `ModeTabs`, `RailGroup`, `RailRow`, `RailFooter`) | Remove `BrandMark` sunbiz/suga (`:494-512`). Move the agent/bridge dots (`:447-479`) to Admin only. Keep prefetch off with warm-on-intent (`:564-583`). Badges come from a deferred `/api/shell/badges`. |
| `components/SidebarShell.tsx` | Mobile bar `bg-bg-rail border-hairline` (`:74`). The drawer shows the mode tabs. |
| `components/MainShell.tsx` | Canvas styling, `ContentHeader` + `AskDrawer` mount (lazy latch pattern `:102-104`). The ChatWidget path moves to `/admin/agents/chat`. |
| `middleware.ts` | `REDIRECT_MAP` (`:179-192`): remove `/feed`; add every CUT/MOVE row from (a). |
| `lib/portals/registry.ts` | Delete `SUNBIZ_PORTAL`. Add the harvested dirs to `SHARED_PREFIXES`. Add `lib/web-leads/`, `lib/website-sales`, `lib/training/` to `OASIS_PORTAL.owns`, so the OS core can never import OASIS-only code. Retire `FOUNDERS_NAV` once Money and Content ship. |

**`lib/role-surfaces.ts` changes:**
1. `capabilitiesFor` (`:473-489`) drops the OASIS-only clause on money **only after `fin_*` is tenant-scoped**. Add `canSeeWorkspaceMoney` (true owner or `finance_viewers`), `canSeeAdmin` (operator + OASIS + founder) and `canManageWorkspace` (owner/admin).
2. Replace `canSeeSystemSurfaces` usage (the worker leak at `:317-333`) with those flags.
3. Replace the four href allowlists (`:567-677`) with `PERSONA_DEPARTMENTS` plus rewritten allowlists over the new hrefs.
4. Add a client-tenant role menu (Owner · Admin · Member with departments · Read-only). The sales titles stay OASIS-only (`:171-180`).

**Tests to add or update:**
- `tests/os-nav.test.ts`:
  - an unknown tenant yields only the unprovisioned rows and none of the old CC_NAV hrefs;
  - a client tenant never sees Admin, Prospects, Enablement or Devices;
  - a non-owner gets no Money section;
  - Commissions appears only with the module;
  - a sales persona sees only Sales and Chief of Staff departments;
  - every catalog entry has a module or department owner.
- `tests/manifest-fallback-fail-closed.test.ts`
- `tests/os-modules-tiers.test.ts`
- `tests/nav-icons-sync.test.ts`: each icon key exists in `NavIconKey`, `NAV_ICON_KEYS` and the `OsRail` icon map.
- `tests/os-redirects.test.ts`: every `REDIRECT_MAP` target exists under `app/`.
- `tests/os-route-gates.test.ts`: a static scan that every `app/admin/**` page calls `requireOperator()`, every `app/money/**` page calls `requireWorkspaceMoney()`, and every `app/team/[dept]` page checks department access.
- `tests/theme-tokens.test.ts`: every tailwind color var is defined in `globals.css`, and the `.form-light` selectors still name existing token classes.
- Update `tests/role-surfaces.test.ts`, `tests/portal-boundaries.test.ts`, `tests/shell-boundary.test.ts` and `tests/client-surface-isolation.test.ts`.

---

## (f) Chat and channel build path

**Base.** Build on `components/agents/AgentChat.tsx` (421 lines), `lib/providers.ts` `streamChat`, `lib/cloud-tool-runner.ts`, `lib/chat-sse-helpers.ts` and `lib/chat-persistence.ts`. **Do not touch the 4,170-line ChatWidget**; it becomes operator-only in Admin.

`/api/agents/chat` imports `operatorPlatformFallback` (`route.ts:38`). The client channel runtime must use the managed-runtime key or a BYO key, never operator platform keys. It must also hard-refuse the bridge/CLI mode for any non-OASIS tenant (the ChatWidget defaults to `cli`).

**Tables** (new Turso migration; reserve the number with `check_migration_collision.py reserve <n>`; `tenant_id NOT NULL` with tenant-led indexes, following `183_delivery_and_support.turso.sql`):
- `channels`: id, tenant_id, kind (`department|customer|project|dm`), department_key, customer_id, project_id, name, visibility (`team|shared_with_customer`), bridge_json, archived_at. Index (tenant_id, kind, department_key).
- `channel_messages`: id, tenant_id, channel_id, thread_root_id, author_type (`user|agent|customer|system`), author_user_id, author_agent_key, author_display, body_md, **visibility (`channel|team_only`)**, mentions_json, source (`app|slack|discord|email|sms|portal`), source_ref, card_json (goal / approval / routine / call / deliverable), run_json (worked_ms, skills_used, tool_steps, error), created_at, edited_at, deleted_at. Indexes (tenant_id, channel_id, created_at) and (tenant_id, thread_root_id).
- `channel_reads`: PK (tenant_id, channel_id, user_id), last_read_message_id. Unread counts come from it.
- `approvals`: id, tenant_id, department_key, kind (`send_email|send_sms|publish_post|create_ad_paused|deliverable|routine_enable|…`), status (`pending|approved|sent_back|executed|failed|expired`), payload_json (redacted preview), target_ref, customer_id, revision, requested_by_agent, decided_by, decided_at, note, channel_message_id, idempotency_key, result_json. **This table is shared with the AI-runtime and Feed design**: one table, not two.
- Existing `chat_sessions` / `chat_messages` stay as private "Chats". Private history is **not** migrated into shared channels (privacy semantics, `api/chat/sessions/route.ts:75-79`).

**APIs:**
- `GET/POST app/api/channels/route.ts` (list with unread; channels are auto-created per enabled department at provisioning)
- `GET/POST app/api/channels/[id]/messages/route.ts`
- `GET app/api/channels/[id]/stream/route.ts` (SSE agent turn)
- `POST app/api/channels/[id]/read/route.ts`
- `POST app/api/approvals/[id]/{approve,send-back,comment}/route.ts`

Live refresh uses `lib/realtime/nudge-store.ts` with a new scope kind `channel:<id>` / `feed`, polled by `use-nudge-poll.ts` (8s, pauses on hidden tabs).

**Components** (`components/os/channel/`): `ChannelView`, `MessageRow`, `ThreadDrawer`, `Composer` (with @-autocomplete, extending `components/chat/SlashCommandMenu`), `cards/{GoalCard,ApprovalCard,RoutineCard,CallCard,DeliverableCard}`, `RunChips` ("Worked for 2m14s · Used X skill"), `TeamOnlyToggle`.

**@mention routing** (`lib/os/mentions.ts` + `lib/os/agent-router.ts`):
- A message in a department channel goes to that department's agent unless it only @mentions humans.
- An `@Sales`-style mention anywhere triggers that agent to reply **in-thread** with the host channel as context. It only resolves if the department is enabled and the viewer may address it.
- With no clear owner, **Chief of Staff** answers. It creates a Goal card and may @delegate. Agent-to-agent mentions are limited to depth 2 with a loop guard (same agent + thread + 5 min).
- Every outward-effect tool goes through an **approval-gated wrapper**: it creates an `approvals` row and posts an ApprovalCard, and never executes directly.
- Agents show errors and retries honestly (Cook f_0171 / f_0192 pattern).

**Team-only visibility:**
- Messages in `shared_with_customer` channels default to `channel` visibility for humans.
- **Agent replies default to `team_only` until someone uses "Share with client"** (an approval). Agents never speak to a customer unreviewed.
- The portal API filters `visibility='channel'` server-side, as a WHERE clause in the query, not in the UI.

**Long turns.**
- v1 on the dogfood tenant streams SSE from the request (`maxDuration` 300, like `/api/agents/chat`).
- Phase 2 moves agent turns to a Cloudflare Queue or Durable Object runtime (AI-runtime domain). That runtime writes `channel_messages` incrementally, so a turn survives navigation without a persistent client widget.

**Slack/Discord bridge** (decision 3: notification + approval surface; native channels stay the system of record):
- Per-channel "Connect to Slack/Discord" lives in the channel ⚙ menu. The link is stored in `channels.bridge_json`, the credentials in `tenant_integration_credentials`.
- **Out:** approval cards (with Approve / Send back buttons), Needs-you digests and routine failures.
- **In:** thread replies are mirrored as `source='slack'` messages ("VIA SLACK" tag) through the Events API push. Never poll: non-Marketplace apps get 1 request/min on history.
- Interactive clicks call the same approvals API.
- Files: `lib/integrations/slack/{client,oauth,blocks}.ts`, `app/api/integrations/slack/{start,callback}/route.ts`, `app/api/webhooks/slack/{events,interactions}/route.ts` (signed, under the public `/api/webhooks/` prefix, `middleware.ts:108`), `lib/os/bridge/fanout.ts`, and the Discord equivalents.
- The dormant `BEA/gateway/adapters/slack.js` is CC's and is not reused.

---

## Component and file change list (by workstream)

Every workstream below that touches a shared or unmapped file needs a lease first (`coord_claim.py acquire`): `Sidebar.tsx`, `SidebarShell.tsx`, `MainShell.tsx`, `app/layout.tsx`, `app/page.tsx`, `lib/nav-config.ts`, `lib/role-surfaces.ts`, `tailwind.config.ts`, `app/globals.css`, `app/api/**`, `database/**`. The APEX-owned `components/{conversations,campaigns}/**` need a handoff. Web-leads, training and objections are APEX-built, so coordinate.

| WS | Files (new = N) | Tests |
|---|---|---|
| W1 Nav plumbing | N `lib/os/*`; `lib/nav-config.ts`, `lib/manifest/{schema,seeds,loader,templates}.ts`, `lib/client-profiles.ts`, `lib/client-provisioning.ts`, `lib/role-surfaces.ts`, `lib/portals/registry.ts`, `app/layout.tsx` | os-nav, fallback-fail-closed, modules-tiers, nav-icons-sync, role-surfaces, portal-boundaries |
| W2 Shell + theme | `tailwind.config.ts`, `app/globals.css`, N `components/os/{OsRail,ModeTabs,RailGroup,RailRow,RailFooter,ContentHeader,AskBar,AskDrawer}.tsx`, `SidebarShell.tsx`, `MainShell.tsx`, `components/Card.tsx` | theme-tokens, shell-boundary; screenshot pass on /, /pipeline, /web-leads, /forms, /f/* (light and dark) |
| W3 Routes + redirects | `middleware.ts`, N `app/team/[dept]/page.tsx`, `app/team/page.tsx`→redirect, N `app/{growth,clients,money,admin}/**` shells, delete `app/{feed/refresher,runs,inbox,system-health,configure,contacts,embed}`; RETIRE set after export | os-redirects, os-route-gates |
| W4 Channels + dept tab | N migration `NNN_os_channels.turso.sql`; N `app/api/channels/**`, `app/api/approvals/**`; N `components/os/department/*`, `components/os/channel/*`; N `lib/os/{mentions,agent-router,approval-gate}.ts`; `lib/realtime/nudge-store.ts` | channel-tenant-scope (every query filters tenant_id), team-only-portal-filter, mention-routing, approval-gate (no outward tool runs without an executed approval), no-bridge-for-client |
| W5 Feed + approvals | `app/feed/page.tsx` (rebuild), N `components/os/feed/*`, `app/api/event-feed/route.ts` (the operator branch moves to Admin only) | feed-tenant-scope, approval-idempotency |
| W6 Today | `app/page.tsx`, N `components/os/today/*`; retire `components/today/*` after parity | today-capability-fetch (money blocks do not fetch without the capability) |
| W7 Clients | N `app/clients/**`, `app/portal/**`; `lib/delivery/{rules,access,store,support-form,support-intake}.ts` (+`customer_id`); `app/projects/**`, `app/tickets/**`→redirect | delivery-access (team vs portal client), support-form-per-tenant, portal-visibility |
| W8 Money (move) | N `app/money/**` wrapping `app/founders/finances/**` components; `registry.ts` | finances-surface (updated), money-gate |
| W9 Schedule | `app/schedule/page.tsx`, `components/schedule/*`, `lib/schedule/model.ts` (Shabbat moves to a preference); N `schedule_blocks` migration | schedule-server-persistence |
| W10 Playbook | `app/playbook/**`, `lib/playbooks.ts` (DB, not fs); N `playbook_docs` migration + OASIS import script | playbook-tenant-scope |
| W11 Routines | N `components/os/routines/*`, `app/api/routines/**`, `/api/cron/routines-tick` + `workers/oasis-cc-cron/src/index.ts` + `config/cron-registry.json` | routine-starts-off, dry-run-no-side-effects |
| W12 Connections hub | `lib/integrations-registry.ts` (`audience`), N `app/settings/connections/page.tsx`, `components/os/connections/*` | registry-client-audience |
| W13 Settings + Admin | split `components/settings/SettingsContent.tsx` into N `app/settings/*/page.tsx`; N `app/admin/**` (move operations/health/automations/agents), `lib/operator-gate.ts` (`requireOperator`) | os-route-gates |
| W14 Slack/Discord bridge | N `lib/integrations/{slack,discord}/*`, `app/api/integrations/**`, `app/api/webhooks/{slack,discord}/**`, `lib/os/bridge/fanout.ts` | webhook-signature, bridge-no-training-export |

---

## Phasing and effort (human team / CC+Bravo; app-review calendar time runs in parallel)

| Phase | Workstreams | Human team | CC+Bravo |
|---|---|---|---|
| **0 Safety** (other domains; UI blocked on it) | slug guard b478c58b, env fallback, stripe-provision, persona gates, signup gate, rebase #457/#434, resolve #287, triage the ribbon worktree | 1-2 wks | 2-3 days |
| **1 Shell on the OASIS tenant** | W1, W2, W3 (non-retirement), W6, W5, W4 (Chief of Staff + Sales + Marketing channels, SSE runtime), W8 move, W13 Admin move | 5-7 wks | 1.5-2 wks |
| **1b SunBiz retirement (UI side)** | redirects and code deletion after export and CC's confirmation; `registry.ts` reclassification | 1 wk | 1-2 days |
| **2 Client-ready** | W7, W9, W10, W11, W12, W14, remaining departments, Content tool tenant-scoped, Finance re-tenant (Finance domain) | 10-13 wks | 4-5 wks |
| **3 Pilots** | meetings module, Ads (after Meta review), portal polish, generic `/demo`, Codex audit of every tenant-isolation diff (Rule 8) | 6-10 wks (mostly approvals) | 2-3 wks + calendar |

Individual estimates:
| Workstream | Human team | CC+Bravo |
|---|---|---|
| W1 | 1.5-2 wks | 2-3 days |
| W2 | 1-1.5 wks | 1.5-2 days |
| W3 | 1 wk | 1 day |
| W4 | 3-4 wks | 1-1.5 wks |
| W5 | 1.5-2 wks | 3-4 days |
| W6 | 1 wk | 1.5-2 days |
| W7 | 4-5 wks | 1.5-2 wks |
| W8 (move only) | 1 wk | 1-2 days |
| W9 | 1.5 wks | 3 days |
| W10 | 1.5-2 wks | 3-4 days |
| W11 | 3 wks | 1 wk |
| W12 | 1.5 wks | 3 days |
| W13 | 1.5 wks | 3 days |
| W14 | 2-3 wks | 1 wk |

---

## Risks and ordering constraints
1. **Money capability flip.** `canSeeCompanyFinancials` loses its OASIS-only clause only after `fin_*` carries `tenant_id` and every read filters on it. Flipping earlier would let a client owner read OASIS's ledger (`chart.ts:23` hard-wires `fin_ent_oasis`).
2. **Feed and Today attribution.** These need department attribution on `agent_events`, which has no `tenant_id` and scopes by `correlation_id` (`tests/agent-events-tenant-scope.test.ts`). Emit `publisher_agent = dept:<key>` from day one; the data-layer domain adds the column.
3. **Retirement is destructive.**
   - Remove the `app/page.tsx:83-88` redirect, `SUN_SEED` and the `/t/sun` kinds only after the export is verified and CC confirms at execution time.
   - Deactivate SunBiz user accounts in the same step.
   - The VPS daemons (srv1723601) are blocked on CC re-adding an SSH key in hPanel.
4. **Rep impact.** The OASIS reps and APEX use `/pipeline`, `/web-leads`, `/training` and `/objections` daily. Theme and nav cutover changes their chrome. Old paths keep resolving through redirects, and nav allowlists are rewritten in the same PR as `role-surfaces` (the "invisible surface" failure noted at `nav-config.ts:215-220`).
5. **Worktree hygiene.** The main checkout is on a merged branch. Start from a freshly fetched main in a new worktree. The ribbon worktree holds 56 uncommitted files touching `app/layout.tsx`; triage it before W1 and W2.