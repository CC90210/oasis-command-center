# OASIS OS — rebuild the Command Center into one AI business operating system

**Product.** OASIS AI's own product (OASIS AI Solutions, co-owned by CC and Adon). The working name is **OASIS OS**. CC withdrew the separate-brand idea on 2026-09-28 ("keep it as oasis"). It lives in the OASIS Command Center repo (`C:\Users\User\APPS\oasis-command-center`), on OASIS's infrastructure, with OASIS's own workspace as the first user.

**Sources behind this plan**
- **Research workflow `wf_1a8b11dd-e1a`**, 20 agents:
  - 8 chapter-by-chapter frame analyses of Serge Gatari's Cook AI video, plus a full-transcript read
  - a crawl of trycook.ai, market research and connector feasibility
  - 5 audits of the Command Center and 2 of the other agents' back-end code
- **Design workflow `wf_20896627-edb`**: 4 domain designs (product surface; data and safety; connectors, AI and finance; offer and onboarding). I merged them myself after the synthesis and critic agents hit the usage limit.

**First execution step.** Copy the brief and the four design documents (in session scratch: `research/brief.md`, `design/*.md`) to `oasis-command-center/docs/os-revamp/`. They hold the full file:line detail, the route-by-route mapping and the table DDL that this plan summarizes.

## Execution status (2026-09-28 21:50 UTC, before CC re-entered plan mode)
- ✅ **SunBiz global kill switch ON** (`pause_controller.py pause global`, record `9d57f852…`).
- ✅ **SunBiz operating mode = `silent`** (record `dc75572c…`), so the cap is 0 on every Python / VPS `send_gateway` path. Both are reversible with `resume global` / `set-mode standard`.
- ✅ **Verified:** 0 SunBiz outbound between 21:50 and 22:10 UTC.
- ⚠️ **The freeze is not complete yet.** The Worker's TypeScript drip dispatcher never reads the kill switch (`lib/drips` has no `kill_switch` reference). It stops only on `DRIPS_CIRCUIT_OPEN=1`, `DRIPS_LIVE`≠1, or a disabled sequence. The 10 enabled SunBiz sequences and 730 queued runs will still send when due. **The first action after approval** is to disable the SunBiz sequences, cancel the queued runs (compare-and-swap) and disable the 6 crons; then set `DRIPS_CIRCUIT_OPEN=1`.
- Nothing else has run. No code, deploy or commit.

## CC's product direction (follow-up, 2026-09-28) — what we are building for
1. **A business operating system, organized by department**: Sales, Marketing, Finance, Operations, Client Success (and Chief of Staff as the coordinator).
   - OASIS already has substantial working functionality. The job is to **re-present it in a cleaner UI** that shows how capable and seamless it is.
   - Then deepen it to **real-world, present-day business depth**, above all in Marketing (**real Meta ads control**) and Finance.
2. **Everything OASIS uses internally becomes available to every client** (the Founders marketing and finances tools, pipeline, forms, automations).
   - OASIS keeps its own unique tabs (Founders), and those same tools ship to clients in generalized form.
3. **The agents meet the team where it already works:**
   - **Slack:** add an agent to your channels next to your human employees.
   - **Telegram**, and the web app.
   - The client chooses; the same agent harness sits behind every surface.
   - **OASIS's own Telegram bridges** (`telegram_agent.js`, `coordination_agent.js`) remain CC's personal channel and are **not** repurposed.
4. **Building an agent is easy.** Owners create and tune AI teammates inside the app, and replace work over time. Human employees and agents share the same channels.
5. **Plug and play with the tools they already use.** Connections show **each app's real icon**, look professional, and connect in one click. **Settings is rebuilt** around this.
6. **OASIS's own apps as add-ons:** **OASIS Whispr** (local dictation), **OASIS Vision** (intelligence console), and future OASIS apps.

---

## 🚨 Urgent — found during research, act on day 0

1. **SunBiz is still sending.** Re-verified live at 21:44 UTC: **325 outbound messages in the last 7 days, the latest at 2026-09-28 18:50 UTC**, mostly "Viewed application nudge" drips. 10 sequences are enabled, 730 drip runs are pending, and 6 tenant crons are enabled. The SunBiz VPS `send_gateway` is also still alive. These are the former client's merchants, being messaged under a relationship we no longer have.
2. **`/api/quests` is public.** It shows 55 of CC's active-task rows to anyone on the internet (`middleware.ts:80`, `app/api/quests/route.ts`).
3. **Operator status comes from an unverified email.**
   - `isOperatorEmail` trusts the session email (`lib/operator-credentials.ts:29-41`).
   - Signup sends no confirmation email.
   - So anyone who registers an unclaimed admin or operator alias becomes an operator across every tenant.
4. **`/api/state-health` shows operator data to any signed-in member**: Bravo's session-log summary and working memory. `/system-health` has no access check.
5. **Sensitive data at rest:**
   - 753 SunBiz applications hold full SSNs in plaintext.
   - About 4,088 bank statements sit in R2.
   - The master encryption key is also on the SunBiz VPS, which we can't SSH into.
6. **An agent with no tool list gets every tool.** That includes the bash and file-write tools on CC's machine and `get_credential` (`lib/manifest/schema.ts:105-108`, `lib/cloud-tool-runner.ts`).
7. **14 AI call sites run on CC's personal Claude subscription** through `lib/subscription-infer.ts` (SMS reply agent, drips, routine AI steps, lead scoring). Harvesting those engines unchanged would run client work on CC's plan.
8. **The privacy page makes false statements.** It claims row-level security (`app/(marketing)/privacy/page.tsx:238`), and it lists Supabase and Vercel as sub-processors (`lib/legal/constants.ts`). No privacy officer is named. **We can't sell until this is fixed.**

**Approving this plan is CC's go for the reversible Day-0 steps below.** Every destructive or outward-facing step still asks CC separately when it runs.

---

## Context

**What's wrong with it today.** The Command Center grew into three things at once: CC's internal cockpit, a separate funding-shop product for SunBiz, and a half-built self-signup SaaS.
- CC's sidebar has about 19 rows grouped by build history.
- Agents are exposed as their own concept.
- Operator plumbing is visible to users.
- The code forks per client (CC_NAV, WEBDEV_NAV, SUN_NAV, SUGA_NAV, the founders portal).
- A new tenant lands on CC's own navigation.

**What Cook AI shows.** A business modelled as **departments**. Each department is a channel, and the channel is the agent: you `@mention` the department, never a bot. One brain holds every customer's context.
- **Skills** are SKILL.md files, **tools** come in as plugins, and **routines** are built by describing them in chat. Routines start Off and pass a sandbox test first.
- **A human approves** every outward action. Ads are created **PAUSED**.
- Serge calls the tool **"a 1% tool"**: most owners can't run it themselves. So he sells done-for-you. That validates the Setup and Managed tiers.
- Cook has **no finance and no bank data**. That is our wedge.

**Outcome.** One industry-agnostic, plug-and-play OS for service businesses doing $10–50K/month. It covers outreach → lead → nurture → book → call → close → invoice → onboard → deliver → support → retain → collect.
- Department agents work behind department tabs.
- Industry differences are **data** ("industry packs"), never code forks.
- OASIS runs its own business on it first.

## Decisions locked (CC, 2026-09-28)

| # | Decision | Choice |
|---|---|---|
| 1 | Offer | **DIY** $497/mo (self-connect, no setup fee) · **Setup** $2,500 done-for-you install + $997/mo · **Managed** $5,000 setup + $2,500–3,500/mo (OASIS runs ads, setter and content). Telecom, bank-connection and meeting-bot costs pass through at cost + margin. **Atlas validates unit economics before anything is published.** |
| 2 | Finance v1 | **Read-only** bank connections + Stripe + AI CFO view. **No money movement.** Client Stripe accepts only restricted `rk_` keys. |
| 3 | Comms | **Native department and customer channels** are the system of record. **Slack and Telegram are full two-way agent surfaces in v1**: the client picks, and their team talks to the agents there. Discord, Microsoft Teams and WhatsApp come later. OASIS's personal Telegram bridges stay separate. |
| 4 | Brand | **OASIS AI**; the product is **OASIS OS**. A final product name can come later: it lives in the manifest/brand config, so changing it touches no code. |
| 5 | First buyer | **Direct service businesses doing $10–50K/mo.** One workspace per business. **Clients** is the owner's own customers. **Invite-only** signup with a done-for-you install. `tenant_id` goes on everything so agency sub-accounts can be added later. |
| 6 | AI brain | **Managed default** (OASIS-hosted, paid model API under a no-training agreement). Plus **BYO key**, and later an official "connect your plan". **Never CC's personal subscription. Never the bash bridge for clients.** |
| 7 | SunBiz | **Shut down.** Harvest the generic engines (code only, never data). Retire the funding code, integrations, VPS daemons and data (export first). **One platform for every industry.** |
| 8 | Nav (CC) | Keep **Today, Schedule, Pipeline, Forms, Agents, Playbook**. Department tabs are the agents. Hide the plumbing. **Commissions** is opt-in. **Tickets** is for clients' customers. Strip everything else that isn't necessary. Darker UI, no gray rail. |

**Design decisions this plan adopts** (from the four designs; each is a sensible default and CC can veto any):
- **D1. Four modes: Team · Growth · Clients · Money.**
  - Money replaces Cook's Browser, because Finance is the wedge.
  - The Browser mode is deferred: large effort and terms-of-service risk.
  - The mode tabs sit in the rail header as in Cook; no new top bar.
- **D2. Chief of Staff** is both the first department and the target of the Ask bar (⌘K). It routes goals and @mentions.
- **D3. v1 departments.** Always on: Chief of Staff, Sales, Marketing (includes content), Client Success. Owner-gated: **Finance**, **Operations**. Opt-in modules: Legal, Content, Research. Six departments by default.
- **D4. "Agents" (from CC's keep list) becomes the AI Team, for everyone.**
  - **Roster:** each department's lead agent plus any custom AI teammates the owner builds.
  - **Builder:** extends the existing `components/marketplace/CustomAgentBuilder.tsx`.
  - **Where each agent lives:** the web channel, Slack channels, Telegram.
  - Department tabs still show their lead agent as the channel, so the default experience stays department-first.
  - OASIS operators keep the power chat (ChatWidget + CLI bridge) under **Admin › Agents**.
- **D5. "Clients" maps to a `customers` table.** It is a first-class table, not a JSON column.
- **D6. An unknown or unprovisioned tenant fails closed** to a "being set up" shell. It never sees OASIS's nav.
- **D7. Entitlements live in a new `tenant_entitlements` table** that only operators and the verified billing webhook can write.
  - Access = what was **bought ∩** what the manifest turns on **∩** what the persona may see.
  - Checked on the server in every page, API route, cron, OAuth start, routine run and AI call.
  - The manifest can't grant entitlements, because the tenant can edit it (`app/api/manifest/[slug]/route.ts:112-137`).
- **D8. Separate product database.** A new Turso DB `oasis-os` plus an R2 bucket `oasis-os-files`, created before the first outside pilot writes data.
  - `bravo` keeps Bravo's operator memory only.
  - A `dbFor(tenantId)` layer can later route a Managed or regulated client to its own database.

---

## Target product

### Shell: one rail for every tenant (dark, Cook-style)
```
┌ Workspace ▾                                   [⌕]
│ ┌──────┬────────┬─────────┬───────┐
│ │ Team │ Growth │ Clients │ Money │   (Money: owners only)
│ └──────┴────────┴─────────┴───────┘
│ TEAM:    Today · Feed · Schedule · Projects · Playbook · AI Team (Agents)
│          Departments ▾  Chief of Staff · Sales · Marketing · Client Success · Finance · Operations
│          Chats ▾ (private 1:1)
│ GROWTH:  Sales ▸ Pipeline · Conversations · Calls · Enablement* · Commissions* · Prospects (OASIS only)
│          Marketing ▸ Forms (Funnels) · Campaigns (Email · SMS · Sequences) · Ads* · Content
│ CLIENTS: All clients · Support desk · Agreements · Meetings* · Portal* · Recent ▾
│ MONEY:   Overview · Transactions · Invoices · Bills · Reports · Taxes · Accounts
└ footer:  [Setup checklist]  [Connections ●]  [⚙ Settings]  [🔔]  [🛡 Admin — OASIS operators only]
           (* = module / tier gated)
```

**Theme.** Convert the Tailwind palette to CSS variables and re-value them **globally**. Tokens are never renamed; `.form-light` depends on the class names.
- **Rail and window:** `#030304`. **Canvas:** `#0a0a0b`, a floating rounded panel with a hairline border (`rgb(255 255 255/.07)`). **Panels:** `#0e0e10`.
- **Text:** `#ededef` / `#a0a0a7` / `#75757d`.
- **Active row:** a neutral `rgba(255,255,255,.06)`, with no blue.
- **Counters:** red pills, as in Cook.
- **Remove:** grain, top glow, the glow bars and gradient buttons.
- Full spec: the `ia-ux` design, section (d).

**Department tab** (`/team/[dept]`, same frame everywhere). The header shows a status, never an agent persona.
- **Channel:** @mention other departments, threads, a **Team-only** toggle, and "Worked 2m · Used X skill" chips.
- **Overview panel:**
  1. **Needs you**: that department's approval cards.
  2. **Numbers**: 3–4 KPIs; unknown shows as "Not connected", **never $0**.
  3. **Routines**: each with On/Off/Testing and its last run.
  4. **Connections** this department depends on.
  5. **Suggested asks.**

**Approvals everywhere.** Every outward action goes through the same flow:
1. It creates an `approvals` row **bound to a `payload_hash`**. Editing the payload creates a new approval.
2. The same card shows in the channel, on Today, in the Feed and in Slack.
3. The server executes the stored payload exactly once, re-checking tenant lifecycle, consent and brand first.
4. The card then shows the real result ("Sent ✓" or "Failed: opted out"). It never claims success on its own.

**Other surfaces**
- **Today:** Ask composer → Needs you → one "overnight" card per department → schedule, goal pace, cash, and the setup checklist.
- **Feed:** Needs you / All / Shipped, with a department filter and batch approve (J/K keys).
- **Clients:** customer list → record tabs: Overview, Channel, Projects, Tickets, Meetings, Agreements, Files, Activity, Billing. Plus a support desk with SLA, e-sign agreements, and a customer portal with magic-link login.
- **Money:** today's founders Finances suite, moved; OASIS only until `fin_*` is re-tenanted.
- **Playbook:** Skills, SOPs and Templates, stored in the DB (the filesystem is empty on the Worker). Agent-proposed skills need approval.
- **Routines:** plain-English cards. Build one from chat → dry run (nothing real sent) → turn On.
- **AI Team** (the "Agents" tab): a roster card per agent showing avatar, name, department, where it lives (web · Slack · Telegram), autonomy and last activity.
  - **"New teammate"** starts from a template (Setter, Support rep, Bookkeeper, Media buyer, Content producer, Project manager) or from scratch.
  - It picks: role instructions; skills from the Playbook; tools from the client-safe registry only; the connections it may use; autonomy (draft-only / needs approval / auto for pre-approved templates); and its homes, e.g. **"Add to Slack #sales"** or **"Available on Telegram"**.
  - A **Test chat** runs in the sandbox before it goes live.
- **Connections hub (Settings), rebuilt around the tools owners already use:**
  - An **app grid with each app's real logo**: Slack, Google Workspace, Meta, Stripe, QuickBooks, Xero, GoHighLevel, Zoom, Calendly, Twilio, Telegram and the rest.
  - "Your tools" first, pre-filled from the install interview ("What do you use today?"), then a searchable catalog.
  - One-click connect. Each app page says in plain English what OASIS can read and do, which departments use it, and its live status ("Verified 5 m ago").
  - Review-gated apps show "Coming soon", or "Connected by OASIS" for partner access.
- **Settings, rebuilt:** Profile · Team (humans + AI Team) · Connections · **Chat apps** (Slack / Telegram) · AI brain · Brand & domain · Modules · **Billing & add-ons** · Notifications · Data & privacy · Audit log.
- **Add-ons (OASIS's own apps):** OASIS Whispr (local dictation for Windows), OASIS Vision (desktop intelligence console), and future OASIS apps.
  - Each is a catalog card with its icon, a description, an install link or download, and an entitlement (`addon.whispr`, `addon.vision`).
  - Pricing is set by Atlas. The apps stay local-first and never touch client data.
- **Admin** (operators only, `requireOperator()` by auth id): Systems (the old Operations internals, `/inbox`, `/system-health`), Health, Automations internals, Agents fleet + power chat, Tenants/Installs, Event log, Retirement.

### Route disposition (summary; full table in `docs/os-revamp/ia-ux.md` §a)
| Verdict | Routes |
|---|---|
| **KEEP / redesign** | `/` Today · `/schedule` (rebuild on Google Calendar + `call_appointments`; reconcile APEX #287) · `/pipeline` (stages from the pack) · `/forms` + `/f/<tenant>/<form>` (URL format frozen) · `/playbook` (move to the DB) · `/projects` (generalize off `DELIVERY_TENANT_ID`) |
| **REBUILD** | `/tickets` → Clients › Support desk (for clients' customers) · `/feed` · `/client-portal` → `/portal` (drop the fake ROI) · `/onboarding/wizard` → Admin › Installs |
| **SPLIT / MOVE** | `/agent` (Departments for everyone + Admin power chat) · `/automations` (Routines for clients, cron internals to Admin) · `/settings` (per-section pages + Connections) · `/founders/finances` → Money · `/founders/marketing` → Growth › Content · `/commissions` → Growth › Sales (opt-in) · `/training` + `/objections` → Enablement · `/web-leads` → Prospects (OASIS only) |
| **MERGE / ADMIN** | `/operations`, `/health`, `/agents`, `/inbox`, `/system-health`, `/runs` (→ Audit log), `/reasoning` (→ Chief of Staff) · `/analytics` → Money + department Numbers (**delete the fake-MRR path** `lib/queries.ts:1010-1025`) |
| **CUT** | `/integrations`, `/configure`, `/start`, `/download`, `/desktop-link` (operator-only), `/founders/growth` placeholders, `/contacts`, `/embed`, the SUN_NAV/SUGA_NAV dead arrays |
| **HARVEST from SunBiz** (code, never data) | drips/sequences, the Conversations inbox (APEX-owned, needs an ack), Campaigns (APEX-owned), the SMS compliance layer (consent, quiet hours, STOP), e-sign, documents + R2 + extraction queue, import, metrics, health checks, the brand/unsubscribe/CASL layer, the manifest engine, the demo-shell pattern → `/demo/os` |
| **RETIRE** (after export + CC's go) | lenders, offers, funded deals, renewals, shop-out, underwriting, funding applications, CLEAR/background checks, Kixie/TextTorrent, `SUN_SEED`/`SUGA_SEED`, the Solara/Helios personas, `/api/pg` |

---

## Architecture pillars (what gets built, and what it reuses)

1. **Nav, entitlements, packs.**
   - `lib/os/{types,nav,modules,departments,department-personas}.ts`. `buildOsNav()` is a pure function: catalog → entitlements ∩ modules → departments/persona → sections. The persona filter runs last; every route still has its own server gate.
   - `lib/entitlements/{plans,store,gate}.ts` with `requireModule()`.
   - `lib/packs/{schema,apply}.ts`: versioned, code-reviewed TypeScript packs holding stages, forms, KPIs, starter skills, routines and objection taxonomies.
   - Packs, in order: **agency-consulting** (OASIS dogfoods it) → **home-services** → coaching-education → clinic-practice (the last only after Lex reviews health data).
2. **Channels and approvals.**
   - New tables: `channels`, `channel_members`, `channel_messages` (visibility `internal|client`; source `native|slack|discord`), `channel_bridges`, `approvals`, `approval_events`, `deliverables`, `feed_items`.
   - Built on `components/agents/AgentChat.tsx`, `lib/providers.ts`, `lib/chat-sse-helpers.ts` and `lib/realtime/nudge-store.ts`.
   - **The 4,170-line ChatWidget becomes operator-only.**
3. **Managed AI runtime.**
   - `lib/ai/infer.ts` `inferForTenant()`: only OASIS may take the subscription path. A lint test forbids any other import of `subscription-infer`, and the 14 callers are migrated.
   - A dedicated Anthropic API workspace under a DPA and no-training terms.
   - Tables: `ai_usage_events`, `tenant_ai_budgets` (reserve before the call, settle after, return 402 at the cap, **never quietly downgrade**) and `model_prices`.
   - Tool sandbox `lib/ai/tools/client-safe-registry.ts`: read / draft / execute (server-only). **Default-deny**, no bridge tools, no credential tools.
   - Untrusted content is wrapped with `wrapUntrusted`, and a Haiku spam/phishing gate sits before any auto-drafted reply.
   - Background work: an `agent_jobs` queue with a DB lease, dispatched by `/api/cron/dispatch-agent-jobs`, plus a separate tenant-safe **VPS runner lane** (not srv1723601) for yt-dlp, Remotion and GPU jobs.
4. **Connections.**
   - `lib/connections/{registry,oauth,token-store,health,popup}.ts`, generalized from the Constant Contact pattern.
   - Tables: `tenant_connections` (state only; secrets stay in `tenant_integration_credentials` under **encryption v2**), `oauth_states` (single-use), `connection_health_checks`, `provider_webhook_routes`.
   - Token refresh uses a compare-and-set lease so two refreshes can't race.
   - A card turns green only after a live probe passes, and each card shows which departments use it.
   - **Real app icons:**
     - Each `ProviderDef` in `lib/connections/registry.ts` gains `icon` (an SVG asset under `public/connectors/`) and `brandColor`.
     - The source is Simple Icons (CC0) or each vendor's official brand kit, used per its brand guidelines ("works with" usage, no implied endorsement).
     - A test asserts every client-visible connector has an icon.
5. **Finance, the wedge.**
   - Re-tenant `fin_*` with `ALTER TABLE ADD COLUMN tenant_id` plus the abort triggers already used in migrations 149/150/156/159/162. **No table rebuild.**
   - Thread a `FinanceScope{tenantId,entityId}` through every `*-io.ts` file. `stripeClientFor(scope)` refuses one Stripe account on two tenants.
   - **Two book modes:** mirror QuickBooks/Xero when the client has it, otherwise OASIS "management books" from Stripe + Plaid + CSV.
   - **AI CFO views:** cash, P&L, MRR/churn, runway, AR aging, and **profit per client** (revenue − attributed ad spend − delivery load).
   - The model only narrates numbers returned by `finance_get_metric()`; **Atlas owns the metric definitions and golden fixtures.**
   - Every Finance surface carries "Decision support, not accounting or tax advice" (Lex wording).
6. **Clients, delivery, meetings.**
   - Tables: `customers`, `customer_contacts`, `portal_access`, `tickets` (ports of 183's `support_tickets`), `projects`/`project_tasks`/`project_updates`, `files` (with a `.md` twin), `meetings` + `meeting_transcripts` + `call_scores`, and a `consent_ledger`.
   - Meeting capture: **Recall.ai as the interim universal notetaker** (visible bot, bilingual notice, transcript only, media deleted), plus Fathom/Fireflies import, then native Zoom/Meet.
7. **Messaging.**
   - One chokepoint: `lib/messaging/send.ts` `canSend()`. It checks, in order: the tenant switch; suppression (fails closed); consent for commercial messages; quiet hours in the recipient's timezone; a 24h cap; the CASL footer; approval for AI free text.
   - Twilio **ISV sub-accounts + an A2P/toll-free wizard**. GHL tenants send through GHL's own phone.
8. **Routines.**
   - Tables: `routines`, `routine_runs`, `routine_step_runs`. Revive the dead `lib/workflow-steps/*` and add `quality_gate`, `approval` and `meta_propose` steps.
   - Sandbox mode uses the `SendResult` dry-run shape. **A routine can't turn On without a passing sandbox run.**
9. **The data moat.**
   - `outcome_events`: an append-only outbox in the same write path; loud on failure.
   - `attribution_touches`: UTMs, fbclid and ad ids on every funnel.
   - A nightly `deal_outcome_labels` job over ad angle → booked → objection (with quote spans) → closed → **paid (verified in Stripe)** → retained.
   - **Retrieval stays within each tenant. No cross-tenant training.** Benchmarks come only later: opt-in, k≥10, OASIS-native metrics only.
10. **Chat-app bridges: Slack and Telegram as two-way agent surfaces** (new, per CC's direction).
    - **Shared core:** `lib/os/bridges/{router,identity,render}.ts`.
      - An inbound message becomes a `channel_messages` row with `source=slack|telegram`.
      - It is routed to the bound agent (the same harness, sandbox and approvals as the web app).
      - The reply goes back out, and approval cards render as native buttons.
      - The identity link (`external_identities`, a one-time link code) makes the agent act with **that human's role**. Unlinked users get a polite "link your account" reply and no data.
    - **Slack** (one OASIS OS Slack app, OAuth install per workspace, distributed unlisted in v1; Marketplace listing later):
      - Each agent posts under its own name and avatar (`chat:write.customize`).
      - Team members reach agents by `@OASIS`, by DM, by `/oasis <dept> …`, or in **channels bound to a department or teammate** ("Add to Slack #sales" in the AI Team).
      - Events API push only, never history polling (unlisted apps are limited to 1 req/min on history).
      - We store only messages in bound channels or that address the agent. **Nothing is used for training or bulk-exported** (Slack API terms).
      - Channels shared with outside organizations (Slack Connect, `is_ext_shared`) never receive team-only data.
      - Files: `lib/integrations/slack/{client,oauth,blocks}.ts`, `app/api/integrations/slack/{start,callback}`, `app/api/webhooks/slack/{events,interactivity}` (signing secret + 5-minute timestamp window).
      - The BEA `gateway/adapters/slack.js` skeleton is not reused.
    - **Telegram:** one OASIS OS bot. Generalize the existing link-code flow (`app/api/telegram/link-code` + `app/api/telegram/webhook`, SunBiz's bot today) to multi-tenant.
      - A 1:1 DM talks to Chief of Staff, or `/sales`, `/marketing`, etc.
      - Group chats: add the bot and bind the group to a department.
      - Inline keyboards for approvals.
      - Setup/Managed tenants may bring a **branded bot token** stored in their vault. The webhook secret is per bot.
    - **OASIS's personal Telegram bridges stay untouched and separate** (they run on CC's machine with operator tools; clients never route through them).
11. **AI Team builder.**
    - Extend `CustomAgentBuilder.tsx` and `lib/agents/library.ts` with: department, avatar, skills, a tool palette (client-safe registry only, default-deny), connections, autonomy level, homes (web / Slack channel ids / Telegram), and a sandbox test chat.
    - Templates ship in the industry packs.
    - Every teammate runs on the same managed runtime and metering, and counts against the tier's AI budget.
12. **Marketing: real Meta ads control** (beyond insights).
    - A live campaign → ad set → ad table with spend, CPL and cost per **paid** customer.
    - Actions, **each an approval card with projected spend checked against the owner's monthly cap**:
      - pause/resume
      - budget increase/decrease
      - duplicate a winner
      - launch a new ad (created PAUSED, then activated by a second approval)
      - kill fatigued ads
    - The winning-ads report and competitor breakdowns run as routines. Every creative gets a tracked funnel.
    - Delivered through the partner-access pilot first, then Facebook Login after App Review.
13. **Data placement.**
    - Every new table: `tenant_id NOT NULL`, tenant-leading indexes, no enum CHECK constraints (the 183 convention).
    - All access goes through `lib/os/db.ts` `tenantScoped(ctx)`, with `tenantId` from the session only.
    - A **write guard in the TypeScript Turso adapter** (P0-16), plus an in-memory libSQL **isolation harness** that runs every repository function for tenant A against tenant B.

---

## Phased roadmap (estimates: human team / CC+Bravo; approval calendars run in parallel)

### Day 0 — stop the bleeding (hours; reversible; covered by plan approval)
*Steps 2 and the silent-mode half are already done (see Execution status). Step 1 is next.*
1. **SunBiz outbound freeze (C-1).** Script `scripts/sunbiz-freeze.ts`, dry run then `--apply`:
   - disable the 10 sequences
   - cancel the 730 pending runs with a compare-and-swap
   - disable the 6 crons
   - cancel future scheduled sends and calls
2. **Python kill switch:** `pause_controller.py pause global --tenant aa04fa1f… --reason "SunBiz retired 2026-09-28"`, then silent mode.
3. **Worker secrets:** `DRIPS_CIRCUIT_OPEN=1` (no other tenant has sequences) and `LIVE_SEND_{TEXTTORRENT,KIXIE,CONSTANT_CONTACT}=0`.
4. **Silence the SunBiz health and Telegram lanes** so the freeze doesn't page anyone.
5. **Lock down `/api/quests`** (require auth, or delete it if OASIS Town is dead).
6. **Operator alias audit.** `scripts/audit-operator-emails.ts` prints only whether each alias is set and whether a live auth user exists; it never prints values. Remove any alias that has no auth user.
7. **Gate `/api/state-health` and `/system-health`** to operators.
8. **Re-verify oasisai.work:** renewal, card, MX/TXT records, Search Console.

**Gate:** 1 h and again 24 h later, SunBiz outbound since the freeze = **0**, pending drip runs = 0, and an unauthenticated `/api/quests` request returns 401.

### Phase 0 — safety, in-flight triage, day-1 applications (2–3 wks / 4–6 days)
**Coordination**
- Post to APEX via `agent_activity.py post --mirror`: the SunBiz retirement, holds on #463, and a request for an ack on harvesting `components/{conversations,campaigns}`.
- Take `coord_claim` leases on shared paths.
- Start from a **fresh worktree off remote main** (5db8551a+).

**In-flight triage**
- **Land:** #457; #434 (per-tenant send flags; drop its SunBiz cron commit); the guard cherry-picks b478c58b and 7c3a484d; #107.
- **Salvage the local-only `oasis-cc-ribbon-final` worktree:** first save an encrypted patch to scratch, then land the per-user agent authorization and the signed website-sales Stripe webhook (Codex review on the latter).
- **Reconcile:** #287 goes into the Schedule rebuild. #463: strip the retired-surface edits and move its migration into `database/turso/`.
- **Close:** SunBiz-only PRs.
- **Worktrees:** remove the 15+ stale ones (the removal command refuses dirty trees, which is the safety net).

**Tenant-safety fixes P0-1…P0-16** (full list in `docs/os-revamp/data-safety-sunbiz.md` §2):
- Env-credential fallback becomes an allowlist by OASIS tenant **id**, for every service. A decryption failure never falls back to env.
- Delete `stripe-provision`.
- Slug-claim guard, plus a fail-closed NULL-tenant branch and protected slugs.
- `UNPROVISIONED_SEED` for unknown slugs.
- `requireOperator()` by auth id on every admin surface, backed by a `platform_operators` table.
- `/signup` requires an invite or a provisioning-grant token; brand-text shell matching is deleted.
- Gate `/api/goals`.
- `lead_interactions`: `send_gateway` refuses to write without a tenant, the 752 rows are backfilled, and a NOT NULL trigger is added.
- `agent_events` gets a `tenant_id` column.
- **Encryption v2:** key id + AAD, keyring, rotation script, Python parity.
- `client_health.py:294` gets a tenant filter.
- The bridge becomes operator-only.
- The Turso adapter gets a write guard.

**AI and tool safety**
- `inferForTenant()`, the lint test, and migration of the 14 callers.
- Tool palettes default to deny.
- OAuth state gets its own secret and is single-use.

**Truth and compliance fixes**
- Correct the privacy page and the Lex ToS: no RLS claim, the real sub-processors, the missing doc citation. Extend `tests/legal-compliance-drift.test.ts`.
- Publish the privacy officer.

**Scaffolding:** a `tenant_entitlements` table that fails closed (no row = no access). Extend `check_migration_collision.py` to OCC's migration directories (a shared tool; see Needs from CC).

**Day-1 applications, owned by CC, run in parallel:**
- Meta Business Verification + app + Tech Provider verification
- Google brand + sensitive-scope verification (`calendar.events`, `gmail.send`, Meet)
- Twilio ISV Trust Hub profile
- Intuit app assessment, Xero app, Plaid Trial
- Recall account + DPA
- Zoom General app, and a Slack app (unlisted)
- Anthropic DPA + a dedicated workspace
- FR-first ToS/Privacy/DPA drafts (Lex drafts, a Quebec attorney reviews)

**Gate:**
- The new tests are green: `env-fallback-oasis-only`, `manifest-unknown-slug-fail-closed`, `admin-surfaces-operator-only`, `signup-invite-only`, `field-encryption-v2`, `os-tool-sandbox`, `no-subscription-infer-outside-router`, `legal-compliance-drift`.
- `npm test` and `npm run build` pass.
- A Codex independent review has been done on every isolation diff.

### SunBiz retirement track (parallel with Phases 0–1; runbook in `docs/os-revamp/data-safety-sunbiz.md` §4)
| Step | What | Flag |
|---|---|---|
| C-2 | VPS srv1723601: stop and remove **only** `/srv/sunbiz/**`, its 13 PM2 apps and the `jarvis` Docker containers (the box is shared). Afterwards check for `(deleted)` process working directories and leftover listening ports. **Blocked on CC re-adding the SSH key in hPanel.** | destructive, CC go |
| C-3a | `scripts/tenant-export.ts`: an export driven by a table registry, covering every SunBiz row (including the 753 SSNs and all R2 documents), encrypted with a passphrase CC holds. It becomes the reusable Law 25 offboarding tool. | reversible |
| C-3b/c | Hand the export to the former client per the contract. Then delete in order: credentials → R2 → rows → drop funding-only tables by reviewed migration. **`/unsubscribe` and the sunbiz/bluerise brand entries stay live until 2026-11-27** (CASL 60 days). The tenant row is kept as a `retired` tombstone, with an offboarding certificate. | destructive, outward, CC go |
| C-4 | Delete the SunBiz Worker secrets. **Rotate** the OASIS secrets that sat on the VPS (HMAC, cron, **field-encryption key**). Deactivate the 4 SunBiz users (never deleted). Revoke the bridge pairing. Ask the former client to rotate their own accounts. | outward, CC go |
| C-5 | sunbizfunding.com and bluerisebusinesscapital.com: transfer to the former client or take down. | outward, CC go |
| C-6 | Code: remove the SunBiz cron routes (`CRON_TABLE` + `cron-registry.json` in lockstep); harvest the generic engines (reclassify in `lib/portals/registry.ts`, strip the SunBiz defaults); delete the funding-only code and 38 tests; archive the BEA SunBiz scripts in `scripts/_archive/sunbiz/`. | reversible until deploy |
| C-7/8/9 | Archive the SunBiz-Agent repo. Update the brain/docs/memory files (APP_REGISTRY, CONTEXT.md, OWNERSHIP_MAP via lease + APEX ack; "never couple OASIS and SunBiz" becomes "never couple tenants"). Get APEX's ack via the coordination table. | — |

**Gate:** per table, `COUNT(*) WHERE tenant_id=SunBiz` = 0; the R2 prefix is empty; `git grep -i sunbiz` finds only the brand-map entries until 2026-11-27; the Worker `GET /` lists only the kept crons.

### Phase 1 — the new shell, dogfooded on OASIS's own tenant (5–7 wks / 1.5–2 wks)
- **W1 nav plumbing:** `buildOsNav`; manifest `os` block; OASIS tenant → `plan='internal'` + agency-consulting pack; delete CC_NAV/WEBDEV_NAV at cutover; rewrite `role-surfaces` allowlists in the same PR.
- **W2 shell + theme:** `components/os/{OsRail,ModeTabs,RailGroup,RailRow,RailFooter,ContentHeader,AskDrawer}`, `tailwind.config.ts` variables, `globals.css` retune, `MainShell` canvas.
- **W3 routes + redirects:** `middleware.ts` `REDIRECT_MAP`, the new `app/{team,growth,clients,money,admin}` shells.
- **W4 channels:** Chief of Staff, Sales and Marketing channels with SSE streaming on the managed runtime.
- **W5 Feed + approvals, W6 Today.**
- **W8:** move Money from founders Finances (OASIS only). **W13:** move Admin, and **rebuild Settings**: per-section pages, plus the Connections app grid with real icons (UI first; live connectors land in Phase 2).
- **AI Team roster** (read-only in Phase 1): department lead agents shown as teammates; the builder comes in Phase 2.
- **Outcome capture:** the `outcome_events` outbox on stage changes.

**Gate:**
- **CC uses Today on ≥10 of 14 days.**
- Tests green: `os-nav` (an unknown tenant sees no OASIS rows; no Money for non-owners), `os-route-gates`, `theme-tokens`, `os-redirects`, `channel-tenant-scope`, `approval-gate` (no outward tool runs without an executed approval).
- The OASIS reps' daily paths (`/pipeline`, `/web-leads`, `/training`) still work through redirects.
- Screenshot pass on `/`, `/pipeline` and `/forms`, in both themes, plus the public `/f/*`.
- Codex review.

### Phase 2 — client-ready: the sellable v1 (12–16 wks / 5–7 wks)
**Workstreams (ordered by dependency):**
- **Product DB split (D8).** Create `oasis-os` → 15-minute write freeze → copy → verify row counts + PK hashes → flip config → old tables read-only for 14 days.
- **Connections framework + Wave 1** (see below).
- **Managed AI runtime:** metering, budgets, sandbox, `agent_jobs`, VPS runner lane. **Default-model eval:** a 50-task comparison on the OASIS tenant.
- **Finance re-tenant + AI CFO views + alerts,** with Atlas fixtures and Atlas sign-off.
- **Clients:** `customers`, the support desk (per-tenant support form), projects, agreements (harvested e-sign), `/portal`.
- **Schedule rebuild** (Google Calendar, booking links, `schedule_blocks`).
- **Playbook:** `tenant_skills` + skill ingestion from the owner's SOPs and YouTube (on the managed runtime, owner approval per skill).
- **Routines engine** (sandbox → On).
- **Messaging:** the `canSend` chokepoint + consent ledger + Twilio ISV/A2P wizard.
- **Meta ads control:** partner-access pilot + insights sync + Lead Ads webhook, then the campaign table with approval-gated pause/resume, budget changes, duplicate-winner and launch (PAUSED → activate), plus a creative scorecard (cost per **paid** customer).
- **Funnels:** a booking step, `funnel_touches`, per-funnel analytics.
- **Chat apps (two-way):**
  - A Slack app: install → bind channels to departments or teammates → agents reply in channels and threads with their own name and avatar → approvals as buttons.
  - A Telegram bot: link code → DM or bound group.
  - The identity link maps each Slack/Telegram user to their OASIS role. Execute-once approvals; signed webhooks.
- **AI Team builder:** templates, skills, tools (default-deny), connections, autonomy, homes, sandbox test chat.
- **Add-ons catalog:** OASIS Whispr and OASIS Vision cards with entitlements and a download/install flow.
- **Entitlements complete + billing:** a verified `stripe-billing` webhook (idempotent, creates a provisioning grant) + pass-through usage billing on OASIS's Stripe.
- **Provisioning:** `provision-tenant.ts`, owner-claim invites, the 15-minute interview (`tenant_business_profile`), Levels probes, `/admin/installs` over `delivery_projects` (`kind='os_install'`), `operator_access_grants` with a client-visible access log.
- **Demo:** `/demo/os` as a real demo tenant ("Northwind Renovations") with **labelled** synthetic data and test-mode Stripe.
- **Compliance pack:** MSA/DPA/s.17 PIA annex/recording notice (FR/EN), in attorney review.

**v1 sellable cut (the scope line — everything else waits):**
- Departments: Chief of Staff, Sales, Marketing, Client Success, Finance, Operations.
- Forms + funnels, pipeline, sequences, the conversations inbox, the support desk, projects, agreements, the portal.
- Finance on Stripe `rk_` + CSV/OFX + QuickBooks/Xero (+ Plaid Trial).
- Wave-1 connectors (with real app icons), approvals, routines, and the done-for-you install.
- **Agents in Slack and Telegram, the AI Team builder, Meta ads control, and the add-ons catalog.**

**Explicitly after v1:** Discord, Microsoft Teams and WhatsApp bridges; a per-tenant branded Slack app; Content/Research as separate departments; native Zoom/Meet (Recall covers the gap); cross-tenant benchmarks; the Browser mode; the clinic pack; the subscription connector; white-label/agency sub-accounts; invoicing inside the client's own Stripe.

**Gate:**
- CI provisions a throwaway tenant end to end.
- `tests/os-tenant-isolation.test.ts` is green across every repository.
- A tenant smoke run shows 0 env-fallback resolutions.
- Billing and pass-through dry-run for a full period in test mode.
- The finance mirror equals QuickBooks report totals (sandbox), and the OASIS MRR equals the Stripe dashboard.
- DPA/MSA attorney-reviewed.
- Codex review on the money, auth and isolation diffs.

### Phase 3 — pilots → launch (6–10 wks calendar / 2–3 wks)
- Wave 2 goes live as approvals land: Meta self-serve connect, Google verified (lifting the 100-user cap), Meet transcripts, Zoom, Twilio per tenant.
- Meeting capture on Recall. Outcome labels and the per-tenant retrieval loop.
- Packs: home-services next.
- **Two Setup-tier pilots:** an agency/consultancy (outside Quebec first), then a home-services business. Quebec only once French client-facing surfaces and contracts exist.

**Pilot success criteria:**

| Criterion | Target |
|---|---|
| Install | ≤14 days |
| Level 1 ("know your numbers") | ≤5 days |
| Owner active | ≥4 days/week by week 3 |
| Drafts approved without heavy edits | ≥70% by week 4 |
| First verified "found money" insight | ≤30 days |
| Churn at 90 days | Zero |
| Pilots → paying | 5 paying tenants; 2 case studies with Stripe-verified numbers |

**Critical path:** Day-0 freeze → Phase-0 safety → Phase-1 shell → DB split → connections + AI runtime → provisioning/billing → pilots. The long poles are calendar, not code: **Meta review (3–8 wks), Google verification (1–4 wks), Twilio A2P (1–3 wks per tenant), attorney review (3–6 wks)**. All of them start on day 1. **Totals:** roughly 5–6 months for a 3-engineer team; roughly 10–13 weeks of CC+Bravo time to pilot-ready.

---

## Connector waves (details: `docs/os-revamp/connectors-ai-finance.md`)
| Wave | Connectors | Why this wave |
|---|---|---|
| **1: no review** (weeks 1–4 of Phase 2) | **Slack app (unlisted, two-way agents)** · **Telegram bot** · Stripe restricted key · Google Calendar + `gmail.send` (pilot mode, ≤100 users until verified) · Drive `drive.file` · GoHighLevel private app (≤5 installs) · Calendly/Cal.com · Fathom/Fireflies · Recall.ai · QuickBooks (sandbox → production after assessment) · Xero Starter · Plaid Trial (10 Items) · CSV/OFX · **Meta via partner access** (client adds OASIS's Business Manager as partner → system user, Limited tier) | Value in about 2 weeks while reviews run |
| **2: review-gated, submitted day 1** | Meta Login for Business + Lead Ads · Google sensitive (verified) · Meet transcripts · Zoom Marketplace · Twilio ISV per tenant · Late/Zernio per-tenant profile · Ad Library (EU/UK only) | Lands as approvals clear |
| **3: deferred** | Gmail read (restricted + CASA, $540–4,500/yr) · Stripe App OAuth · Slack Marketplace · Flinks · Google Ads · Discord · subscription AI connector | Pull only on demand |

- **Competitor research, honestly scoped:** the Meta Ad Library API returns **no US or Canadian commercial ads**. The Research routine combines manual Ad Library captures (vision teardown), landing pages via `research_fetch`, YouTube via `competitor_sweep.py` on the VPS runner, and EU/UK API data. **No automated scraping of the Ad Library UI.**
- **Maven's Meta engine is pinned to Graph v20**, which research says stopped working 2026-09-24. Port only the endpoint knowledge to TypeScript, with a version constant.

## Tiers → capabilities (details: `docs/os-revamp/offer-onboarding-moat.md` §a)
| | DIY $497 | Setup $2.5K + $997 | Managed $5K + $2.5–3.5K |
|---|---|---|---|
| Install | Self, guided (same engine) | OASIS installer, 14 days + 30-day hypercare | Installer + named operator |
| Departments | Six core | Six core | Six core + OASIS operates ads, setter and content |
| Meta | Read insights after App Review | + create PAUSED with approval | OASIS runs it (partner access meanwhile) |
| SMS | ISV sub-account or bring your own; owner runs the A2P wizard | OASIS files A2P | Same |
| Custom routines | Pack routines only | ✓ | OASIS maintains them |
| Seats / AI budget | 3 (hard cap) / ~$40 | 10 / ~$100 | 25 / ~$300 |

Seat counts and AI budgets are placeholders until Atlas validates them. The plan caps modules, never Levels. Levels unlock on **live-probed milestones**, Finance first: a numbers brief within 48 h of the Stripe key.

---

## Risks
- **Tenant leak.** One missed `tenant_id` filter or leaked token → mitigated by D8 (DB split), the P0-16 write guard, the isolation harness and Codex review.
- **Money-capability flip.** Money must stay OASIS-only until every `fin_*` read filters `tenant_id`. `chart.ts:23` hard-wires `fin_ent_oasis`.
- **Calendar risk on approvals.** Sell only what is approved. DIY gets Meta features only after App Review.
- **AI cost vs price.** Unknown until 30 days of dogfood metering. Atlas resets budgets after Phase 1, and the cap refuses rather than downgrading.
- **Cross-agent collisions.** APEX is active on shared shell files (#463, #287, #462). Mitigated by leases, landing #463 before the theme work, and reviewing APEX PRs with `cross_agent_review.py`.
- **Rep disruption.** OASIS reps use `/pipeline`, `/web-leads` and `/training` daily. Old paths redirect, and the allowlists are rewritten in the same PR.
- **Compliance.** Law 25 s.17 (all sub-processors are in the US), Bill 96 (French for QC), CASL/TCPA, recording consent (*In re Otter.AI*). Mitigated by the compliance pack; **no sale before the DPA exists and the privacy page is truthful.**
- **Clinic pack / health data.** Gated behind Lex; no US HIPAA-covered entities.

## Verification (how we prove each phase)
- **Every phase:** `npm test` + `npm run build` in OCC; the named new tests; `python scripts/harness_eval.py`; a Codex independent review via `codex-companion.mjs` run from the OCC repo on money, auth, isolation and deletion diffs (Rule 8); the four-line report.
- **Live checks after deploy:**
  - `wrangler_tool.py deployments --app oasis-command-center` confirms the live version.
  - `curl --ssl-no-revoke` confirms public routes (`/f/*`, `/unsubscribe`, `/sign/*`) still answer.
  - CC's own browser covers the auth-gated pages.
  - The Worker `GET /` lists the expected crons.
- **Isolation:** `tests/os-tenant-isolation.test.ts` (in-memory libSQL, tenants A/B); `scripts/os/tenant-smoke.ts --tenant <slug>` before every go-live (0 env fallbacks, identity resolves, entitlements present, no seed fallback).
- **SunBiz:** the outbound-since-freeze = 0 query at 1 h and 24 h; per-table zero counts after deletion; an empty R2 listing; an offboarding certificate in `tenant_audit_log`.
- **Finance:** Atlas golden fixtures in OCC CI (`tests/finance-os/metric-definitions.test.ts`); OASIS MRR equals the Stripe dashboard; the QuickBooks sandbox mirror equals report totals.

## Needs from CC (the recommended default applies unless CC overrides)
1. **Day 0:** approving this plan = go for the reversible SunBiz freeze and the security lockdowns above.
2. **SunBiz end-of-mandate** (confirm with Adon as co-owner): the effective end date; export handed to the former client, then OASIS's copies deleted (**default**); their two websites transferred to them (**default**); whether to scrub the SunBiz name from code (default: no).
3. **Re-add the SSH key** in hPanel → srv1723601, so the VPS daemons can be torn down. Until then the freeze and key rotation neutralize the box.
4. **oasisai.work**: confirm renewal and card, because Meta and Google verification need it.
5. **Accounts and documents for the day-1 applications:** Meta Business Verification documents, Anthropic DPA + workspace, Twilio ISV, Intuit/Xero/Plaid/Recall signups.
6. **Privacy officer:** CC named, at `privacy@oasisai.work` (**default**).
7. **GST/QST:** register voluntarily before the first OS invoice (**default**; Atlas executes).
8. **The 48 self-signup tenants:** fail-closed page now; freeze + notice + export offer; delete after 30 days (CC confirms the deletion run).
9. **Shared-tool change:** extend `check_migration_collision.py` to OCC's migration directories (Rule 10 needs a yes).
10. **VPS for the new runner:** name the box; srv1723601 is not recommended.
11. **Defaults kept unless overridden:**
    - Finance: QuickBooks/Xero mirror first, OASIS management books otherwise.
    - Recording: transcripts only, media not retained, 12-month retention.
    - Slack: one OASIS OS app with per-agent names and avatars, unlisted in v1 (Marketplace listing once 5 workspaces run it).
    - Telegram: a shared OASIS OS bot by default; a branded bot token for Setup/Managed on request.
    - Add-ons: OASIS Whispr and OASIS Vision priced by Atlas, sold as separate line items.
    - Pilots: first one outside Quebec.
    - Currency: CAD for Canadian tenants, USD for US tenants.
    - Pitch guarantee: "Level 1 in 14 days or next month free" (Setup/Managed).

## Execution kickoff (after approval)
1. Save memories: OASIS OS decisions; SunBiz retired 2026-09-28; the urgent findings. Then `state_sync.py --note`.
2. Copy the research brief and the four designs to `oasis-command-center/docs/os-revamp/`.
3. Run Day 0. Then Phase 0 in a fresh worktree, with leases, the APEX notice and TodoWrite tracking.
4. At each phase end: tests, build, live checks, Codex audit, the four-line report, and `bravo: sync` commits.
