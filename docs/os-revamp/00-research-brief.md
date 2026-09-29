# OASIS Command Center revamp: decision brief (plan mode, 2026-09-28)

Path shorthand used below: **OCC** = `C:\Users\User\APPS\oasis-command-center`, **BEA** = `C:\Users\User\Business-Empire-Agent`, **CMO** = `C:\Users\User\CMO-Agent`, **CFO** = `C:\Users\User\APPS\CFO-Agent`, **LEX** = `C:\Users\User\APPS\Lex-Agent`. Video timestamps come from Serge Gatari's "10,000 Hours of Running a 1-person $16M AI Business in 34 minutes". Frames are about 3 s early versus the HD file (the ch4 check found f_0145 labelled 14:24 = HD 14:27).

**Bottom line (5 lines)**
1. **What Cook is.** A Slack-style workspace. Four top modes: Team, Growth, Clients, Browser. Each department is a channel, and that channel is the agent. There is a Feed where deliverables get approved, Projects (brief + files + memory), Routines built from chat, a Skills library stored as SKILL.md files, and an approval card in front of every outward action. It is **acquisition-heavy, with no Finance department and no bank connection**.
2. **What OASIS already has.** Most of the back-end parts exist, but they are wired to OASIS or SunBiz. The one piece that is truly productizable is the **manifest engine (`/t/[slug]`)**, which SunBiz already runs on. Today a self-serve client lands on CC's own nav, because the seed fallback in `OCC/lib/manifest/seeds.ts:900-902` catches them. I verified that line.
3. **What actually blocks a client launch is not the UI.** Three things do: tenant safety (the env-credential fallback, an unsigned webhook, a slug-claim hole, no row-level security); the lack of a client AI runtime; and connector approval lead times (Meta 3-8 wks, Google restricted scopes 6-12 wks plus an annual CASA assessment, Zoom 3-6 wks, Slack Marketplace about 2-3 months, Twilio A2P 1-3 wks per tenant).
4. **The wedge is Finance, "the OS that knows your numbers."** Cook, GHL, Sintra and Marblism have no live finance. OCC already has a live double-entry ledger, but only founders can use it.
5. **Recommended path.** Build a new `client-os` portal and manifest seed behind a `ui.shell` flag, and dogfood it on CC's own tenant. SunBiz stays untouched. Phase 0 is tenant-safety fixes, and it comes before any UI work.

---

## 1. Cook AI anatomy

Tags used: **[SEEN]** means it appears on screen, with a frame or timestamp. **[SAID]** means it is transcript only.

### 1.1 Information architecture [SEEN]
```
Sidebar header: user card → 4 mode tabs  Team | Growth | Clients | Browser   (+ "Agency" tab when Agency mode is on — docs, trycook.ai/docs/white-label)
TEAM mode
  Home ("What can I help you with today?" composer + model picker + Chats / Routines / Performance tabs + card grid)  [01:30 f_0016; f_0090]
  Feed (badge "2+")  ·  Projects  ·  Search [+]
  DEPARTMENTS (avatar + '#' = channel; red unread pill or grey M/D)  [01:30 hd01/c90_sidebar.png]
     Chief of Staff · Research · Marketing · Sales · Client Success · Systems · Content
  CLIENTS: colour-coded folders named after TEAM MEMBERS (Haissam, Alberto, Austin, Rayyan)
     → per-client '#' channels, many Discord-bridged (e.g. "# Marc Logan")  [f_0103, f_0118]
  Channels · Chats (auto-titled)  ·  footer: Learn Cook, gear, bell
GROWTH mode (client switcher scopes everything: workspace or any client — GHL sub-account-like)  [f_0106, f_0113]
  Sales: Leads (2.6K) · Lists · Analytics · Conversations · AI sales rep · Scheduling · Sales Calls · Calendar
  Marketing: Funnels · Ads · Emails · Texting · Campaigns · Sequences · Forms (+ Content per docs)
CLIENTS mode (per client)  [f_0115, f_0104]
  About · Performance · Tasks · Routines · Calls · Portal · Experiences · Agreements · Social · Reviews · Custom Values · Integrations
  Client profile tabs: Overview · Offer · Intake · Knowledge · Meetings · Integrations · Activity · Files
  "+ Add client" scaffolds Org Drive/clients/<slug>/ + a starter OFFER.md
BROWSER mode: built-in agentic browser (desktop app), logged-in "Default" profile, AI Agent side panel  [f_0086-f_0089]
```
The other surfaces:
- **Feed** holds deliverables with Approve / Send Back / Chat / Comment / "Share with client", revision numbers, and a stories-style department filter [f_0080-0085, f_0157].
- **Projects**: "A brief, files and routines kept together for one piece of work. Every chat you start in a project reads all of it." Each has Instructions, a workspace-shared MEMORY, and CONTEXT with a meter ("In context: 196K / 200K"). Every PDF gets an auto-generated editable `.pdf.md` twin [HD s_055 ≈24:52; f_0250-0255].
- **Goals** appear as "Goal posted" cards when a department accepts a task [f_0074, f_0080].
- **Skills & Plugins**: agents write skills to `skills/<name>/SKILL.md` on the shared drive, and every agent picks them up on its next turn. Plugins are either workspace-wide (Slack, Gmail, Messenger via Zernio) or "PER CLIENT" (Instagram) [f_0146-0150].
- **Routines** has a card grid (trigger chip, category chip, "Running", last run). The node editor is built on React Flow and has 15 step types, a Quality gate with pass/fail branches, and "Do several at once". Triggers are SCHEDULE, EVENT·CALL RECORDED, INBOUND webhook and Manual. New routines start **Off** and run a sandbox test first ("nothing real is sent") [f_0187-0202].

**Department count conflicts.** The video shows 7 departments. trycook.ai lists **8** (it adds Support) and says Systems and Content are "head-only" [trycook.ai/platform]. The grey "6/10, 7/5, 9/4" labels are **not explained**. The strongest reading is last-activity dates (M/D), because client rows show "9/9" and "Fri" in the same column.

### 1.2 Agent and department model
- **A department is an agent is a channel. There is no agents directory** [SEEN f_0074]. Work is addressed with `@Department` in any channel ("Message #research — use @ to mention"). Research is "one agent" [SAID 07:19].
- **Chief of Staff** is the orchestrator. It turns fuzzy asks into Goal cards ("launch both NOW" → "Goal posted: New York detailing lead audit") [SEEN f_0074]. It also posts "Call recorded" cards into client channels and DEGRADED sync alerts into #systems [SEEN f_0101, f_0103].
- **Team-only threads** appear inside client-visible channels, marked "Team only · hidden from client". This is how the operator questions the Client Success agent about a client without the client seeing it [SEEN f_0123; SAID 12:11].
- **Transparency and honesty.** Each reply shows "Worked for 6m 52s", "Used Watch video skill" chips, and tool-step chips ("Pulling Marc's ad metrics"). Replies report errors and retries. Agents refuse to fake work: "I can't honestly send you a link", "QA failed ... I did not present it as finished", "I did not import him as a lead", "Do not invent a case study" [SEEN f_0171, f_0087, s4/tb].
- **Models.** Each chat has a model picker (the "Gemini 3.8 Flash" and "GPT-6 Astra" labels were read off the screen). Customers bring their own ChatGPT plan, with a metered fallback: "Your ChatGPT plan hit its usage limit, so this reply used the workspace default model (metered)" [SEEN f_0087, f_0215].
- **Approvals.** "Agent action" cards come from "Orchestrator". Ads are created **PAUSED** inside an existing ad set, with the note "No existing live ads were changed" [SEEN f_0214-0215]. The setter's SMS and WhatsApp messages each need a tap to approve ("7 APPROVALS") [SEEN f_0243].

### 1.3 Client-context model ("200+ CLIENT CONTEXT AT ALL TIMES") [SEEN f_0103]
- **Mechanism [SEEN f_0101 10:00].** A background job, `cook-sync`, pushes `clients/<slug>/client.json` (about 22 keys) from what looks like a **git-backed brain repo**. It also syncs offers (59), profiles to Drive (72) and fields (71-72). The sha advances only when the sync certifies completion. Failures post DEGRADED to #systems with counters (offerFailed, fieldsFailed, unmapped client "kevin-muganza").
- **Inputs:**
  - Discord chats, bridged both ways and tagged "VIA DISCORD"
  - Zoom recordings plus transcripts
  - Google Meet and phone meetings in the client profile
  - Conversations inbox and AI setter DMs
  - Meta ad metrics
  - Org Drive creatives
  - Whop payments (used to verify deals)
  - Call scores saved to `<client>/sales-call-scores.json`
  [SEEN f_0094-0097, f_0104, f_0129; SAID 10:44-11:36]
- **Access pattern.** A chained query in the client's channel went from "which creative?", to 7-day Meta metrics (CTR 3.31%, CPL $9.93), to a sales-objection diagnosis, to a coaching playbook for the client [SEEN f_0122-0144].
- **Data-model hints from the screens:** Workspace → Client {slug, lifecycle, "Watch 47" score (meaning unknown), owner folder} → Channel / Message {visibility team_only, source DISCORD} → CallRecording / Meeting / Deal / Deliverable {revision, approval state} / Skill / MemoryNote {id "#x17hp1"} / Routine / RoutineRun.

### 1.4 Skills, tools, routines
- **Skills** come from three sources: the founder's own IP ("seven-figure sales playbook", "Google doc salesletter skill"), expert YouTube videos ("Watch video" skill → audit → `meta-thunderdome-testing`, `meta-pixel-conditioning`), and format skills (`/chat-ads` iMessage ads, clipping) [SEEN f_0090, f_0152, f_0156; SAID 14:45-15:34].
- **Routines seen running:** Call reviews (on the call-recorded event), Brain digest (inbound webhook), Client activity digest (weekdays ×4), Product issue sweep, Daily reel ideas, Daily long-form video ideas (posts to #marketing with outlier multipliers 46.8x/19.4x/15.2x), Chat cleanup, Meta Ads Daily Check, Morning briefing, Client health sweep, and per-client daily digests [SEEN f_0187-0191, f_0203].
- **Built from chat [SAID 19:05-19:25; SEEN f_0192].** The user states the deliverable, how to QA it, and the output spec. The agent builds the graph, sandbox-tests it, and **leaves it disabled if the test doesn't pass**.

### 1.5 Sales and appointment-setting engine
- **The human setter is augmented, not replaced** [SAID 24:05-26:08]. Ermal's cap went from about 100-200 DMs a day to "the entire CRM". A human approves every message.
- **"The Setter" is a Project** [SEEN f_0250-0255]. It holds a system prompt ("protect the closer's calendar"), 9 context docs, and a 6-state SOP: DESTINATION → GAP → INTENT → FIT → PATH → BOOK. The rule is "A booked call is not the KPI. A qualified show is." There is a six-step follow-through after booking (partner on the call, pre-call material, group chat, advisor hello, verify they consumed the material, day-of confirmation) [SEEN HD s_086-089].
- **Other pieces:**
  - An **AI sales rep persona** answers DMs in Growth › Conversations ("Mia from Clean Growth") [SEEN f_0145].
  - A **"Text Riley" sandbox** page lets prospects demo the client's SMS rep with no real phone involved [SEEN f_0238].
  - A **call-audit agent** grades every closer's call out of 100 and writes a Google Doc [SEEN f_0095].
  - **Closed-won posts** verify payment in Whop and list action items with an owner and a due date [SEEN f_0096-0097].
- **Caution [SEEN f_0145].** The AI rep replied warmly to what is plainly a Meta-impersonation phishing DM. There is no spam gate. OASIS should classify inbound before any auto-reply.

### 1.6 Business thesis [SAID, all self-reported and unverified]
- "Intelligence becomes labor" [00:54]. A company is "people organized to repeatedly create value", and a one-person AI company still needs insights, tools, skills (an action → data → feedback loop) and coordination (goals + time) [02:36-07:06].
- **Sell outcomes, not AI.** Cook is "a 1% type of tool; 99% wouldn't know what to do with it" [31:31-31:59]. The play is done-for-you retainers of $500-3K/mo with a full-AI back end [30:48-31:29]. The team has zero CSMs [28:50], one growth consultant ships 5+ client campaigns a day [32:52], and Cook is "only for clients" so far [30:21].
- **Credibility flags:**
  - The canvas title says "$5m/year" while the video title says "$16M".
  - The payroll figures ($3.1M in 2024, $2.8M in 2025) rest only on P&L screenshots.
  - "One-person" is contradicted by the named humans: setter Ermal, engineers Rayyan and Ryan, Austin, the growth consultants, "my team".
  - "Fourth iteration" does not square with "rebuilt six times in <6 months" [27:41].
  - The Cook Browser benchmarks are self-published best-of-N runs (Odysseys scored 95.6% best-run but 70.8% first-run).

---

## 2. trycook.ai product, pricing, integrations, and market map

### 2.1 Product and pricing [trycook.ai/pricing, /docs]
| Tier | Price | Includes |
|---|---|---|
| Acquisition | **$197/mo** (no annual price, no trial) | **Research department only**, 1 workspace, 1 client, 1 seat, 10K credits (extra $10 per 1K); funnels, CRM, AI rep and automations are **read-only** |
| Agency | **Not published**, "Book a call" | All 8 departments, 45K credits, unlimited clients and seats, white-label, sub-accounts, resell-a-plan, "We move you across ourselves" |
| Usage | $10 per 1K credits; texting number ≥$25/mo; WhatsApp ≥$5/mo; A2P registration $20 once; call minutes at carrier cost + 10% | An owner-set AI spend cap |
| Reseller rules | Agencies set their own price; public floor **$97/mo**; no lifetime deals | Stripe Connect products with a markup % |
| Legacy | Truth Engine $97/mo or $497/yr (still live) | A "$7.8K/yr" 2.0 license appears only in a search snippet. **Unverified.** |

- **Onboarding.** Sign-in says "limited beta, access by invitation". Then a 15-minute interview (business, assets, taste, optional kickoff call), then **Levels**: Acquisition → Launch → Scale. Levels unlock automatically on real milestones, and the plan caps how high you can go [docs/levels].
- **Integrations marketed:** GHL, Meta (their own app), Google (Ads, Calendar, Gmail, Drive, Sheets), Slack, Discord, Zoom (booking through Nylas), Fathom, PostHog, Hyros, Airtable, Stripe Connect (**reselling only**), Telegram, Lark, Cook-as-MCP for Claude, Instagram per client, Messenger via Zernio, Intercom and Outlook cards, SimpleTexting.
- **Not found:** bank feeds, QuickBooks/Xero, Google Meet, HubSpot, a ticketing object, a named telecom provider.
- **Security.** "We do not use your content to train models." No SOC 2 or HIPAA claims. Hosting is US: Convex, Vercel, Railway, Cloudflare. Terms are under Quebec law.
- **Weaknesses:**
  - The brand is inconsistent ("Your AI Marketer" versus "AI OS for Agencies"; the plan pages contradict each other).
  - Their own status JSON shows the site at **92.79% uptime over 30 days**.
  - The desktop app is Mac and iPhone only.
  - There are no independent reviews.
  - Pricing has shifted three times.

### 2.2 Market map (verified on vendor pages unless marked)
| Segment | Players and price anchors | Finance? |
|---|---|---|
| AI-OS / "AI employees" | Cook $197 to custom; Sintra $15.60-48.50/mo; Marblism $24-44; Lindy $29.99-199.99/user; Motion $19-29/seat (AI Employee tiers unverified); Relevance (sales-led); Taskade $10-100 | None (Sintra's "P&L calculator" is a template with no live data) |
| All-in-one CRM | GHL $97/$297/$497 + AI Employee $50-97 per location; HubSpot Starter $7-20/seat, Pro about $1,300/mo + $1.5-3K onboarding (third-party); Attio $0-99/seat; Day.ai per-agent pricing ($20M Series A) | Payments only |
| Delivery / portal | Kajabi $143-399; Circle $89-419; Assembly $29+; Vendasta $99+ (AI receptionist $199 setup) | Payments only |
| AI finance | QBO agents (Finance AI on Advanced only); Digits $65-250 (**US-only**); Puzzle $30-360; Zeni bookkeeping $549-799, CFO $1,599 + $2K setup (**US startups**); Pilot CFO $1,750-5,250; Fathom HQ $450/25 companies; cfo.ai "Ari" (launched 2026-09-10, price undisclosed) | Yes, but startup- or accountant-shaped |

### 2.3 The finance wedge
- **No AI-OS product joins money data to operating data** (Stripe + bank + ad spend + pipeline + delivery load, per client).
- **Evidence the pain is real (Productive's agency report):**
  - Owners rate "Financial visibility, cash flow and sales" as their **lowest** area.
  - "Nearly one in five can't report [margins] at all."
  - 45% forecast only 1-3 months ahead [productive.io/reports/agency-industry-report].
- **Canada angle.** Digits and Zeni are US-only. OASIS is Montreal-based and Atlas already has GST/HST/QST logic (`CFO/cfo/gst_hst.py`).
- **Affordability.** At about 13-19% net margin (Promethean), a $10K/mo business keeps about $1.3-1.9K/mo. Price has to scale with the revenue band.

### 2.4 What is commoditized versus defensible
- **Commoditized:**
  - persona "AI employees"
  - lead-response SMS/voice AI (GHL sells unlimited for $97 per location)
  - CRM, funnels, portals, meeting notes
  - ledger categorization
  - connector lists (MCP is table stakes)
- **Defensible, most durable first:**
  1. A per-client system of record that joins money and operations, where switching cost is the moat. a16z argues raw "data moats" are weak [a16z.com/the-empty-promise-of-data-moats].
  2. Records labelled by outcome (ad angle → booked → objection → closed → paid in Stripe → retained). Raw transcripts are not a moat.
  3. A done-for-you install plus an operator. GHL's #1 complaint is complexity: Capterra ease-of-use 3.7, "setting up a phone number for SMS took us 5 weeks".
  4. Canadian and Quebec compliance.
  5. Approval rails, which are necessary but not unique.
- **Evidence gap.** Reddit and G2 blocked automated access, so the owner-pain evidence comes from surveys and reviews. A manual pass is needed before the pitch deck.

---

## 3. Current OASIS Command Center inventory

**CC's live sidebar today.** Tenant `oasis-ai-cc` uses `OASIS_AI_CC_SEED` = WEBDEV_NAV (`OCC/lib/manifest/seeds.ts:260-264`), plus the Founders group injected at `OCC/app/layout.tsx:306-335`. That makes about 19 rows in 5 groups: Operations (Today, Schedule, Pipeline, Forms, Agents, Playbook) · System (Operations, Automations, Health, Analytics, Projects, Tickets, Settings) · Leads (Leads, Commissions) · Training (Training, Objections) · Founders (Marketing, Finances). The groups follow build history, not departments.

**Nav plumbing.** Nav comes from `getManifest()`: a DB row first, then the seed (`OCC/lib/manifest/loader.ts:60-65`). **Any unknown slug falls back to OASIS_SEED = CC_NAV** (`seeds.ts:900-902`, verified). **SUN_NAV and SUGA_NAV in `lib/nav-config.ts` are dead arrays.** SunBiz renders `SUN_SEED` (`seeds.ts:345-413`); a live read found no `sun` manifest row, only a stale `sunbiz` row from 2026-07-07 that is not rendered. Suga has no tenant.

| Route | What it is today | Maturity | Call |
|---|---|---|---|
| **Today** `/` | Persona dispatcher (Founder/Rep/Manager/Marketing/Delivery Today); SunBiz redirected to `/t/sun` at `app/page.tsx:77-88` | live | **KEEP, redesign** as the cross-department morning brief. Strip operator copy ("n8n inbound bridge", "run: python scripts/..." at `components/today/FounderToday.tsx:336,350`) |
| **Schedule** `/schedule` | Weekly planner in browser **localStorage only**; Shabbat blocks seeded (`lib/schedule/model.ts:158-175`) | partial | **KEEP name, REBUILD** on the Google Calendar adapter (`lib/integrations/google-calendar.ts`) + `call_appointments`. Reconcile with APEX PR #287 (`/calendar`) first |
| **Pipeline** `/pipeline` | OASIS 14-stage website-sales board (`lib/oasis-stage-meta.ts`); others redirected to `/t/<slug>/leads` | live | **KEEP, redesign.** Stages from the tenant manifest (`pipeline_entity`), with OASIS as one config. Shares `LeadPipelineView` with SunBiz |
| **Forms** `/forms`, `/f/...` | Multi-step builder, branding, HMAC lead links, uploads; 5,167 SunBiz submissions | live, most mature | **KEEP** as Marketing › Funnels & Forms. The `/f/<tenant>/<form>[/<token>]` URL format is **frozen** (sunbizfunding.com 307-forwards to it). Remove the "Supabase migration 042" copy (`app/forms/page.tsx:101-112`) |
| **Agents** `/agent` | Persistent 4,170-line `ChatWidget` in MainShell; private 1:1 per (tenant, user, agent) | live | **KEEP for OASIS operators.** Clients get no "Agents" tab: department tabs embed a pinned agent (picker hidden via `manifest.ui.advanced_picker`) plus one Ask bar |
| **Playbook** `/playbook` | OASIS manual read from repo markdown (`lib/playbooks.ts:13,25`); has a SunBiz branch | live | **KEEP, redesign** into a tenant-owned SOP/skills library stored in Turso (Cook Skills analog). Keep the SunBiz branch |
| Operations `/operations` | Bridge heartbeats, local CLI probe, warm pool, activity tape | live | **HIDE (admin only).** Move into the founder Systems console. The client-facing "Operations" becomes the **Operations/Systems department** (routines, connection health) |
| Automations `/automations` | Cron manager + "Draft with AI" Python + workers; the same component renders `/t/sun/automations` | live | **KEEP, redesign** as plain-English **Routines** per department. Cron and Python stay admin-only. Must not regress SunBiz |
| Health `/health` | Outcome checks, failed crons; shows the SunBiz "Quiet shop-outs" card on the OASIS page (`health/page.tsx:414-416`) | live | **MERGE** into the Systems console. Cold-lead alerts move to Sales |
| Analytics `/analytics` | OASIS money is honest. **Non-OASIS tenants see hand-typed MRR, a $5K default target and synthetic history** (`lib/queries.ts:1010-1025`) | partial | **MERGE** into Finance / Sales / Marketing. Delete the fake-MRR path |
| Projects `/projects` | OASIS-as-vendor delivery board (`DELIVERY_TENANT_ID` hard-coded, `lib/delivery/rules.ts:17-18`) | live | **KEEP, redesign** under Client Success. Generalize so each tenant runs delivery for *its own* customers |
| Tickets `/tickets` | OASIS's help desk for its own clients; support form pinned to `oasis-ai-cc` (`lib/delivery/support-form.ts:38-47`) | live (inverted) | **REBUILD** as a help desk for **clients' customers**. Reuse the SLA, intake and visibility code |
| Commissions `/commissions` | OASIS comp ledger (frozen rates, verified collection) | live | **OPT-IN module**, configurable per tenant, under Finance/Sales |
| Settings `/settings` | Profile, team, credentials, AI setup, devices. Connector registry is empire-internal (kraken, oanda, obsidian...; `lib/integrations-registry.ts:66-540`) | live | **SPLIT** into Settings + a first-class **Connections** hub. Bridge and Devices go to admin |
| Training / Objections | Rep curriculum + AI roleplay; objection library with a human approval gate (built by APEX) | live | **MERGE** into Sales › Enablement |
| Leads `/web-leads` | OASIS prospecting pool (about 20.8K lines); APEX is active (PR #462 opened today) | live | **KEEP OASIS-only** as Sales › Prospects. Coordinate before moving it |
| `/founders/finances` | Live double-entry ledger, Stripe/Wise ingest, invoices, GST/QST. Owners-only by email (`lib/founders-finances/access.ts:22-25`), `fin_ent_oasis` hard-wired (`chart.ts:23`) | live | **Foundation for the Finance department.** Re-tenant it; this is money-path work |
| `/founders/marketing` | Asset review queue, URL ingest, Zernio performance | live | **Seed for the Content department** (moving it means leaving the founders portal) |
| `/founders/growth` | Placeholders behind `MARKETING_SHELL_ACTIVE=false` | stub | **REBUILD** as Marketing › Ads / paid |
| `/client-portal` | "ROI dashboard". The cron is not scheduled; the table has no Turso migration; messages_handled is never written; hours are estimated as events × 5 min; errors are swallowed into [] | partial | **REBUILD** on measured events, and fail loudly |
| `/onboarding/wizard` | Saves a manifest under a free slug but **never links it to the tenant**. The client lands on CC_NAV and most answers are discarded (`lib/manifest/wizard-finalize.ts:86-150`) | partial (broken) | **REBUILD** as a done-for-you provisioning flow |
| `/signup` | Open self-serve; `purchase_status` never read; brand defaults to "OASIS AI"; brand-text matching can hand a "Sunrise Funding" the SunBiz shell (`lib/client-profiles.ts:193-205`) | live | **Gate** behind invite or checkout |
| `/configure`, `/start`, `/download`, `/desktop-link` | Developer funnel: `irm ... CEO-Agent/install.ps1 \| iex` | live/partial | **CUT or hide.** Wrong buyer, and it clones CC's repo |
| `/feed`, `/integrations` | Middleware redirects them (`middleware.ts:179-181`) | dead | **CUT** (the FounderToday link still points to /integrations) |
| `/runs`, `/inbox`, `/system-health`, `/reasoning` | Audit, agent inbox (reads operator fs), guard monitor, quick actions. **The first three have no persona gate** | partial/dead | **CUT or MERGE.** Keep the `/t/sun/reasoning` manifest kind |
| `/agents` | Fleet dashboard; mounts a **second** ChatWidget (possible double stream, not reproduced) | live | **HIDE (admin only)** |
| `/lenders`, `/offers`, `/funded-deals`, `/contacts`, `/embed`, `/applications` (index) | ComingSoon stubs; the real ones are `/t/sun/*` | stub | **CUT → redirect.** Repoint `lib/setup-readiness.ts:221` first |
| `/t/[slug]/*` | Manifest engine (22 page kinds, AI editor, marketplace); SunBiz runs on it | live | **KEEP. This is the foundation** for department tabs |

---

## 4. Gap matrix

Effort is rough: **S** ≈ 2-3 days for a human team / hours for CC+Bravo · **M** ≈ 1-2 wks / 1-3 days · **L** ≈ 3-6 wks / 1-2 wks · **XL** ≈ quarter / 3+ wks. Approval calendar time is **not** included.

| Cook capability | OASIS equivalent (route/file) | Status | Reuse path | Effort |
|---|---|---|---|---|
| Top workspace modes (Team/Growth/Clients) | Only Founders section chips (`components/founders/FoundersSectionNav.tsx`) | missing | New TopBar in `app/layout.tsx:390-455`; add a `section` field to NavItem/ManifestNavItem; rail becomes contextual | M |
| Department channel = agent, @mention, unread | `/agent` private 1:1 chat (`app/api/chat/sessions/route.ts:75-79`) | partial | New `channels` + `channel_messages` tables (tenant_id NOT NULL). Build on `components/agents/AgentChat.tsx` + `lib/providers.ts` + `lib/cloud-tool-runner.ts`, **not** the 4,170-line ChatWidget | L |
| Chief of Staff router + Goal cards | Bravo persona (CC-specific, `lib/agent-personas.ts:16`); `revenue_goals`; seed `task` entity | partial | Neutral persona templates (marketplace categories `lib/agents/library.ts:18-35`); goal entity in `tenant_records` | M |
| Team-only thread visibility | None | missing | `visibility` column on channel_messages | S |
| Feed: Approve / Send Back / Share with client | Founders marketing review queue; `/operations` tape (admin-gated); `lib/event-projection.ts` | partial | `agent_events` projection + review state; persona-aware feed | M |
| Approval cards on outward actions | SunBiz SMS draft approvals (`app/api/conversations/drafts/[id]/route.ts:29` SunBiz-only); `send_gateway` | partial | Generalize the draft-action pattern into an `approvals` table | M |
| Projects (brief + files + memory + context meter) | `/projects` is a delivery board (different concept) | missing | New "Project context" entity + R2 files + a memory table; reuse the `.md` extraction idea | M |
| Skills library (SKILL.md, agents write them) | 164 `BEA/skills/*/SKILL.md`; Playbook markdown | partial | Tenant skill store in Turso behind the **Playbook** tab | M |
| Routines (chat-built graph, sandbox test, starts off) | Cron manager + AI Python draft; `lib/workflow-steps/*` exists but is **dead code** | partial | `tenant_cron_jobs` + revive the workflow steps + a dry-run mode | L |
| Clients axis (per-client channels, profile tabs, OFFER.md) | client = tenant (manifest); delivery `client_tenant_id` rows | partial | Decide the model (decision #8); build the Clients tab over `tenant_records` | L |
| Growth CRM (Leads, Conversations, AI sales rep, Scheduling) | Pipeline, Conversations (APEX-owned), Helios, Kixie/TextTorrent | partial | Manifest `pipeline_entity` + `conversations` kinds; neutral sales-rep persona | M |
| Funnels + Launch checklist | Forms engine (live) | have/partial | Add booking step + per-funnel conversion analytics | M |
| In-app Meta Ads (live metrics, create PAUSED) | Maven `CMO/ad-engine/scripts/meta_ads_engine.py` (injectable creds, CFO gate); nothing in OCC | missing (OCC) | Meta OAuth + Insights sync (port logic to TS) | L |
| Sending domain + templates per tenant | `send_gateway` + fail-closed brand map (needs a **code deploy per tenant**, `BEA/scripts/lib/tenant_brand.py:48-52`) | partial | DB-backed brand registry that stays fail-closed | M |
| In-app texting + A2P | Twilio per-tenant paste + signed inbound (`lib/sms-direct-twilio.ts`) | partial | Twilio ISV subaccounts + A2P wizard (Trust Hub API) | L |
| Call recordings → call audits | Kixie recordings/transcripts in `lead_interactions` (SunBiz only) | partial | Recall.ai (interim) → Zoom / Meet APIs | M-L |
| Meetings ledger | Calendar event + Meet link creation only | partial | Calendar read + `meetings` entity | M |
| Client Success risk digest | `BEA/scripts/client_health.py` (**cross-tenant query at :294**) | partial | Rebuild tenant-scoped over `tenant_records` + tickets + meetings | M |
| Memory recall notes | mem0 local (no tenant partition) | missing | Per-tenant memory table + retrieval | M |
| Agentic browser | CloakBrowser/Playwright on CC's machine | missing | **Defer** (ToS and security heavy) | XL |
| Model picker, BYO plan, metered fallback | BYO API key only; platform keys are operator-only (`lib/operator-credentials.ts:29-55`) | partial | Managed metered runtime + BYO key (decision #7) | M |
| Client portal / "Share with client" | `/client-portal` (fake ROI), delivery client view, e-sign (tenant-scoped, live) | partial | Rebuild on measured events | M |
| White-label / sub-accounts / resell | Manifest brand (`primary_color` unused by the shell) | partial | Later; only if agency mode is chosen | L |
| Levels / progressive unlock | `lib/setup-readiness.ts` (`required_services`) | partial | Readiness checklist as onboarding | S |
| **Finance department (Cook has none)** | `lib/founders-finances/*` (live, OASIS-only) | have (OASIS) | Re-tenant `fin_*` (no tenant_id; the CHECK constraint needs a table rebuild) | L |
| **Legal (Cook has none)** | Lex prompts (`LEX/skills/*`) + OCC e-sign | partial | Lex drafting → e-sign envelope | M |

---

## 5. Connector matrix

| Connector | Exists in OCC/BEA? (path) | Per-tenant? | Feasibility and approvals | Difficulty | Recommended approach |
|---|---|---|---|---|---|
| **Meta Marketing API + Lead Ads** | Not in OCC (`app/founders/marketing/page.tsx:322-336`). Maven: `CMO/ad-engine/scripts/meta_ads_engine.py` (injectable token; spend gate pinned to CC's pulse file :154); legacy SunBiz engine | No | Business Verification + App Review (ads_read, ads_management, leads_retrieval, pages_*) + Tech Provider Access Verification (about 5 d) + access tier. **About 3-8 wks.** Quick path: client adds OASIS's Business Manager as a partner, then use a system user (Limited tier) | hard | **Native.** Start verification on day 1; partner-access pilot meanwhile |
| Meta Ad Library API | No (manual screenshots only) | n/a | Identity confirmation (1-2 wks). **Returns no US/Canada commercial ads, only EU/UK** | medium, low value | Skip. Research agent uses the web UI (ToS risk) or EU-only data |
| Gmail **send** (`gmail.send`, sensitive) | `OCC/app/api/auth/google-oauth/{start,callback}` (per-user, one shared OASIS Google client) | Yes (per user) | Sensitive verification 1-4 wks. **Today's flow also requests restricted `gmail.readonly`** (`start/route.ts:37-49`), so narrow it | medium | Native; drop readonly for client tenants |
| Gmail **read** (restricted) | Same flow; IMAP App Password path (`app/api/agents/operator-email/connect-imap`) | Yes | Restricted verification + **annual CASA** (about US$540-4,500/yr); **6-12 wks**; 100-user cap until verified | very hard | **Defer.** App Password IMAP for pilots only |
| Google Calendar | `OCC/lib/integrations/google-calendar.ts` (`calendar.events`, Meet links) | Yes | Sensitive verification 1-4 wks | medium | Native (reuse). Powers Schedule |
| Google Drive | None in OCC; `BEA/scripts/integrations/google_tool.py` uses CC's keyring | No | `drive.file` + Picker needs brand verification only; full Drive is restricted + CASA | medium | Native with `drive.file` |
| Google Meet transcripts | Link creation only | No | Meet REST API with sensitive scopes; entries deleted after **30 days**; needs Business Standard+ | medium | Native, pull within 30 d (avoids CASA) |
| Zoom | None anywhere | No | Marketplace review needed for any other account (about **3-6 wks**); S2S apps can't list recordings | hard | **Recall.ai interim** → native Zoom after pilots |
| Slack | `BEA/gateway/adapters/slack.js` (dormant skeleton, "Do not start it") | No | Non-Marketplace apps throttled to **1 req/min** on history; Marketplace needs 5 workspaces + about 2-3 months; **ToS bans LLM training / bulk export** | hard | Native, as a **notification + approval surface** only, not a data source |
| GoHighLevel | **None anywhere** | No | Private app installs to ≤5 agencies with no review; Security Review beyond that | medium | Native OAuth as an **import/sync source** (clients already live there) |
| Stripe | OCC tenant key paste + `/v1/account` test (`lib/tenant-integration-schemas.ts:129-137`); every consumer is OASIS-only; finance webhook uses one global secret | Store yes, use no | Restricted key: days. Stripe App OAuth: public review about 4 bd. Connect only if moving money | easy | **Read-only restricted key now**, Stripe App later |
| Plaid | None (wizard writes keys nobody reads) | No | Trial plan: 10 production Items free; security questionnaire for OAuth banks; mostly credential-based in Canada | medium | Pilot via Trial, **read-only** |
| Flinks | None | No | Sales contract, monthly minimum, 1-yr term, about 4-8 wks | hard | Only if Quebec volume justifies it |
| Wise | `BEA/scripts/integrations/wise_tool.py`, `OCC/lib/founders-finances/wise-io.ts` (OASIS env token) | No | Third-party OAuth needs a Wise partnership; clients would paste a read-only token | very hard | OASIS-only; skip for clients |
| QuickBooks Online | None | No | App assessment 1-3 wks (unlisted); Builder tier free (500K reads/mo) | medium | Native; **cheapest path to clients' reconciled bank data** |
| Xero | None | No | Starter free (5 connections); AU$35/mo for 50; **bans AI/ML training on API data** | medium | Native (confirm agent-reasoning is allowed) |
| Twilio SMS | OCC per-tenant paste, live probe, signed inbound (`lib/sms/twilio-inbound.ts`) | Yes (manual) | Per-tenant A2P brand + campaign (US$4.50-46 + $15 vetting + $1.50-10/mo); **1-3 wks per tenant**; Canada→Canada should use verified toll-free | hard | Native ISV subaccounts; route GHL tenants through GHL's numbers |
| Calendly / Cal.com | None | No | No formal review; Calendly webhooks need a paid plan | easy | Native (or via Nango) |
| Fathom / Fireflies | None | No | No review; free API | easy | Native (cheap meeting capture where clients already use them) |
| Recall.ai | None | n/a | No per-platform review; $0.50/hr + $0.15/hr transcription | medium | **Interim universal meeting capture** with a visible, announced bot |
| Discord | BEA gateway skeleton | No | Bot install | medium | Defer unless the ICP runs on Discord (Cook's does) |
| Instagram / Messenger (Zernio) | `BEA/scripts/integrations/instagram_dm_poller.py` (**OASIS tenant hard-coded :117**); Maven `late_tool.py` | No | Late API key (OASIS's) | medium | Per-tenant Zernio profile later |
| Constant Contact | `OCC/app/api/integrations/constant-contact/*` (tenant OAuth popup) | Yes | Live | done | **Template for every new tenant OAuth** |
| Kixie / TextTorrent | OCC, SunBiz-shaped; **global webhook secrets** | Partial | n/a | n/a | Leave to SunBiz |

**Unified-API vendors.** Nango pay-as-you-go runs about $110/mo at 200 connections and is the best fit for the long tail, **used with OASIS's own OAuth apps**. Pipedream is $99-150/mo (acquired by Workday). Composio has a free tier; fine for prototyping, but its consent screen says "Composio". **Avoid Merge** (about $13K/mo at this scale). No vendor removes Google CASA, Meta review or Zoom review.

---

## 6. Empire back-end coverage per department

| Department tab | What can power it now | Gaps |
|---|---|---|
| **Today / Chief of Staff** | Bravo: `BEA/scripts/daily_brief.py`, `ceo_dashboard.py`, `snapshots/briefing_snapshot.py`, `autonomous_agent.py`, `email_brain.py` routing; OCC FounderToday | Everything goes to CC's Telegram and is OASIS-scoped; personas are CC-specific |
| **Sales** | `send_gateway.py` (production, 4,603 lines), `email_engine.py`, `inbound_classifier.py`, `lead_engine.py`, `auto_score_leads.py`, `booking_engine.py`, `book_discovery_call.py`, IG DM setter suite, `outreach_engine.py`, `proposal_generator.py`, `contract_tool.py`; OCC Pipeline, Conversations, Helios | OASIS tenant hard-coded (`inbound_classifier.py:96-99`, `instagram_dm_poller.py:117`, `funnel_sync.py:50`); `booking_engine` has 0 tenant refs; no GHL or Zoom |
| **Marketing** | Maven ad-engine Meta client (injectable creds + CFO gate), `google_ads_engine.py`, adgen pipeline (brand-agnostic), advertorial builder; BEA `marketing_publish_drain.py`, `sync_post_analytics.py`; OCC Forms, Constant Contact | **Paid ads dormant since 2026-05-04** (`CMO/brain/STATE.md:19`); metrics arrive by manual CSV; spend gate pinned to CC's `cfo_pulse.json`; no per-tenant OAuth |
| **Content** | Maven autonomous carousel posting (production; live commit 660a740 2026-09-28), 35 Remotion comps, Higgsfield (guarded), Wan 2.2 on GPU (Apache-2.0, client-safe); OCC `/founders/marketing` | Late accounts hard-coded to CC (`CMO/scripts/schedule_posts.py:137-145`); one GPU queue; CC's logins; organic learning loop has never run in production |
| **Research** | `BEA/scripts/research_fetch.py` ladder, lead scrapers; Maven `social_reach_tool.py`, `competitor_sweep.py`, `adgen_harvest.py` | `competitive_intel.py` stale since 2026-04-27; NotebookLM session expired; no per-tenant research store; spends OASIS credits |
| **Client Success** | `email_brain.py` support triage, `extraction_consumer.py`, OCC delivery/tickets + e-sign; Maven onboarding/churn prompt skills | No help desk for clients' customers; no meeting capture; `client_health.py:294` is cross-tenant |
| **Finance** | OCC `lib/founders-finances/*` (live ledger); Atlas `CFO/scripts/oasis_finance.py`, receipts ingestion (production), `cfo/gst_hst.py`, threshold scanner (daily); BEA `stripe_tool.py` / `wise_tool.py` | Founders-only; Atlas client is on **unmerged branch `fix/atlas-toggle-records-intent`** (7 ahead) with crons unregistered; no bank aggregator; tax is Canada sole-prop only (no QC income tax in `finance/tax.py`, no US); **Bravo never reports MRR, so Atlas owns this tab's numbers** |
| **Legal (opt-in)** | Lex: 3 prompt skills, NDA + SOW templates, UPL gate (`LEX/brain/COMPLIANCE.md`); OCC e-sign (tenant-scoped, live); BEA `casl_compliance.py` | Lex is prompt-only (3 commits, last 2026-08-08), **disabled** in the OASIS seed (`OCC/lib/manifest/seeds.ts:64`), `send_gateway.py` is a stub, and its schema targets Supabase RLS (dead since the Turso cutover) |
| **Operations / Systems** | `BEA/scripts/core/cron_engine.py` (37 jobs), `provision_client_tenant.py`, `provision_secrets.py`, Turso tenant guard, `integration_health.py`, wrangler deploy; OCC `tenant_cron_jobs`, Worker cron (29 routes) | Empire cron lane pinned to CC's tenant (`cron_engine.py:1153,1172`); Python harness is **one tenant per host**; `BEA/apps/agent-runner` is "scaffold only, not deployed"; `bravo_cli/bridge_tools.py` exposes bash and file writes, so it is **never client-safe** |

---

## 7. Hard constraints and risks

**7.1 SunBiz (paying client) and APEX-shared surfaces**
- SunBiz runs on the same deploy and on shared components: root layout, Sidebar, MainShell, ChatWidget, `/agent`, `/playbook` (SunBiz branch), `/forms` (`SunBizFormsClient` when the slug is `sun`), `/sequences`, `/team`, `/metrics`, `/templates`, `SettingsContent` (`components/settings/TenantSettings.tsx:26`), `AutomationsContent` (`components/automations/TenantAutomations.tsx:17`), and `LeadPipelineView`. Live volume: 9,698 lead_interactions, 5,518 drip runs, 1,769 lender threads, 1,564 leads.
- **The palette is static hex in `tailwind.config.ts:16-49`.** Re-valuing tokens restyles SunBiz. **Do not rename tokens:** SunBiz's light public form keys off class names (`app/globals.css:563-608`). Scope the new theme with portal-keyed CSS variables.
- Ownership (`brain/OWNERSHIP_MAP.yaml`):
  - `app/t/**`, `app/api/**`, `lib/drips/**`, `lib/integrations/**`, `components/leads/**` and `database/**` are **shared** and need a `coord_claim` lease.
  - `components/conversations/**` and `components/campaigns/**` are **APEX-owned**.
  - `lib/nav-config.ts`, `lib/role-surfaces.ts`, `components/Sidebar.tsx`, `app/page.tsx` and `tailwind.config.ts` are unmapped, which means shared.
- **The portal boundary test** (`tests/portal-boundaries.test.ts`) fails on cross-portal imports. Reusing founders Finance/Content or SunBiz drips/e-sign needs a new `client-os` portal plus extraction into shared code, not just new nav rows.

**7.2 Tenant isolation (fix before any outside client)**
- **No row-level security.** Production is Turso (`EMPIRE_DATA_BACKEND=turso_cloud`). Isolation is hand-written `.eq('tenant_id', …)`: 861 of about 1,447 `.from(` calls.
  - `lead_interactions.tenant_id` is nullable, with 752 NULL rows.
  - `agent_events` has **no tenant_id column** (it uses `correlation_id`).
- **Credential env fallback is on for all services except Stripe.** Verified at `OCC/lib/tenant-integration-store.ts:84,190-193`. A new tenant with no keys of its own could send through SunBiz's or OASIS's Kixie, TextTorrent, Gmail, Late, Telegram or n8n env accounts. Which env vars are actually set in production is **unverified** (secret_guard).
- **Unsigned provisioning webhook.** `OCC/app/api/webhooks/stripe-provision/route.ts` has no signature check and "simulate[s]" progress (verified). `/api/webhooks/` is public by middleware contract (`middleware.ts:108`).
- **Manifest slug-claim hole.** The first writer can claim any slug with no manifest row; `PROTECTED_SLUGS` covers only default/oasis/sun/suga (`lib/manifest/guards.ts:19-24,67-81`). The fix, **b478c58b, sits on an unmerged branch with no PR**: `fix/tenant-boundary-guards`, worktree `C:/Users/User/APPS/occ-tenant-boundary-guards`.
- **Default fallback.** Every unknown tenant renders CC_NAV (`seeds.ts:900-902`, verified). About 48 self-signup tenants see it today.
- **Missing persona gates** on `/runs`, `/inbox`, `/reasoning` and `/system-health`. The worker persona has `canSeeSystemSurfaces=true` (`lib/role-surfaces.ts:317-333`). Hiding a nav row is not enforcement.
- **`GET /api/goals`** returns the company revenue goal to any member, including commission-only reps (`app/api/goals/route.ts:20-33`).
- **Encryption key.** One master key, `BRAVO_FIELD_ENCRYPTION_KEY`, protects every tenant's credentials, with no rotation path (`lib/field-encryption.ts:8-20`).

**7.3 Turso**
- Use a new-table pattern: `tenant_id NOT NULL`, indexes lead with tenant_id (as `database/turso/183_delivery_and_support.turso.sql` does).
- Migration numbers are reserved with `python scripts/check_migration_collision.py reserve <n>`.
- SQLite cannot alter a CHECK constraint, so generalizing `fin_entities` (owner_key IN ('cc','adon')) needs a table rebuild.
- The OCC database (262 tables) also holds Bravo's substrate and CC's side projects: memories, coord_claims, `oasis_movies_*`, auth tables. Client data would sit next to operator memory. Consider a separate client database.
- Unverified: whether migration 183 is live (docs still say "not deployed"). `client_roi_snapshots` has no Turso migration.

**7.4 Cloudflare Worker deploy**
- One deploy ships every portal.
- Playbook and the agent inbox read Node fs at runtime (`lib/playbooks.ts:13,25`), which is empty on the Worker, so tenant-editable content must live in the DB.
- Every new cron must be registered in `workers/oasis-cc-cron/src/index.ts` and `config/cron-registry.json`.
- **Stack is Next ^15.5.18 / React ^19 / Tailwind ^3.4** (`package.json:46,50,72`, verified), **not Next 14** as `CLAUDE.md` says. No shadcn/radix.

**7.5 In-flight work (rebase or resolve before touching the shell)**
- **OCC checkout** is on `fix/stripe-env-fallback-oasis-only`, which is already merged as #459 (verified). The local `origin/main` ref is 20732c31 (2026-09-27). One agent's dry-run fetch saw remote main at aaa06b5a, so **start from a freshly fetched main in a new worktree**.
- **Open PRs:**
  - **#457** `fix/revenue-readiness-20260923`: 70 files; touches `app/t/[slug]/[...path]/page.tsx`, `ChatWidget.tsx`, `/pipeline`, `/import`.
  - **#434** per-company health and send flags.
  - **#287** APEX `/calendar`: edits `nav-config.ts`, `role-surfaces.ts`, `Sidebar.tsx`.
  - **#462** APEX, active today.
  - #315, #301, #391, #284/#283, #236.
- **Worktrees:**
  - `fix/tenant-boundary-guards`: 5 commits, **no PR**.
  - `C:/Users/User/APPS/oasis-cc-ribbon-final`: **56 files of uncommitted work** on `app/signup/page.tsx`, `app/layout.tsx`, `lib/manifest/tenant-scope.ts`, `lib/tenant-integration-schemas.ts`. Triage it first.
- **Atlas:** `CFO` branch `fix/atlas-toggle-records-intent` is unmerged.
- **BEA:** uncommitted changes in `bravo_cli/*` and `email_*`. `apps/oasis-movies` is untracked; keep it far away from the OASIS client brand.

**7.6 Compliance**
- **Recording.**
  - Canada Criminal Code s.184 is one-party consent, but the recorder must be a participant.
  - Quebec Law 25 needs notice and a stated purpose (s.8.1 profiling disclosure plus an opt-out; s.12.1 human review of automated decisions).
  - US all-party-consent states apply (CA, FL, IL, MD, MA, MT, NH, PA, WA and others).
  - **In re Otter.AI (N.D. Cal., 2026-08-13):** wiretap and BIPA claims survived because the vendor trained on recordings. OASIS must stay "an extension of the customer": **no cross-tenant training**. Use a visible, announced bot and bilingual notices.
- **Law 25 s.17.** Any personal information leaving Quebec (Turso has no Canadian region; the Worker, LLMs, Recall, Plaid and Nango are US) needs a privacy impact assessment plus a written agreement. Ship an s.17 PIA annex and a DPA with every Quebec client, and publish OASIS's privacy officer. Fines run up to C$10M or 2% of turnover.
- **Bill 96.** French UI for Quebec tenants, French-first contracts of adhesion, French invoices.
- **CASL.** A consent ledger per contact (implied consent expires after 2 yrs or 6 mo), sender ID, unsubscribe honored within 10 business days. **TCPA / A2P:** written consent, quiet hours in the recipient's timezone, and the FCC revocation rules (vote on 2026-09-30).
- **Bank data.** The Consumer-Driven Banking Act has Royal Assent (2026-03-26) but **Phase 1 has no in-force date**, and the ban on screen scraping is enacted but not yet in force. Build read-only only, behind a swappable adapter.
- **Platform no-training clauses** (Google Limited Use, Zoom, Slack, Xero, WhatsApp) mean the data moat has to be **per-tenant retrieval, not a pooled model**.
- **Free-tier model data use** is unverified (`memory/feedback_client_products_use_free_models_on_vps.md:22`). Don't put client personal information into free tiers that train on prompts.

**7.7 App-review lead times (calendar time, runs in parallel)**
| Item | Lead time |
|---|---|
| Meta Business Verification + App Review + Tech Provider verification | 3-8 wks (one developer reported 84 days after repeated rejections) |
| Google brand + sensitive scopes (Calendar, Meet, gmail.send) | 1-4 wks |
| Google restricted scopes (Gmail read, full Drive) + CASA | 6-12 wks, then an annual renewal |
| Zoom Marketplace | 3-6 wks |
| Slack Marketplace | about 2-3 months (5 workspaces first) |
| Twilio A2P per tenant | 1-3 wks (short codes 12-16 wks) |
| QuickBooks assessment | 1-3 wks; Plaid paid production 1-3 wks; Flinks 4-8 wks |

**7.8 AI runtime**
- CC's rule is that client products never run on his Claude subscription; use Gemini or free models on the Hostinger VPS behind an adapter (`CMO/scripts/lib/cli_llm.py`).
- Today ChatWidget defaults to `cli` mode (`components/ChatWidget.tsx:742-747`).
- The bridge is gated to slug `submissions` or the operator (`lib/bridge-proxy.ts:253`).
- Platform keys are operator-only.
- The hosted runner (`BEA/apps/agent-runner`) is not built.
- Result: **no managed client AI path exists yet.**

**7.9 Conflicts and thin evidence to keep in mind**
- **Cook claims:**
  - 7 departments in the video versus 8 on the site.
  - Grey counter meaning is unknown.
  - Agency price is unknown; the "$7.8K/yr" figure is unverified.
  - Revenue, payroll and "one-person" claims are self-reported and contradicted by the named staff.
  - Browser benchmarks are best-of-N.
- **SunBiz nav source.** The shell agent could not confirm whether SunBiz renders from the DB row or the seed. The data-layer agent's **live read** resolves it: `SUN_SEED`, with a stale `sunbiz` row that is not rendered.
- **Domain.** oasisai.work **lapsed 2026-08-06** when the card expired (`memory/pattern_cloudflare_zone_active_is_not_domain_registered.md`). The site was live again by 2026-09-24, but the memory index still lists it as "BLOCKED on CC". Re-verify renewal, card, MX/TXT and the Google Cloud billing account before tying the product brand to the domain.
- **Doc drift:**
  - `BEA/brain/CAPABILITIES.md:518` says funnel_sync syncs to GHL. It doesn't.
  - The "12 cron jobs" count is really 37.
  - APP_REGISTRY calls the OCC database Supabase.
  - The CLAUDE.md stack is wrong (see 7.4).
- **Market evidence.** Reddit and G2 were blocked. Motion and Day.ai pricing are third-party figures. Plaid's per-Item price is visible only in the production application.

---

## 8. Recommended target information architecture (draft)

**Principles**
- One shell for the client OS, delivered as a new `client-os` portal plus a seed behind `ui.shell='departments'`.
- CC's tenant dogfoods it first. **SunBiz keeps `SUN_SEED` untouched.**
- Departments are the interface. Clients never see an "Agents" concept.
- Every number is live or shows "not connected". Never a fake $0.
- Every outward action produces an approval card.

```
TOP BAR:  [Workspace]  Today | Team | Growth | Clients   ......  [Ask / ⌘K → Chief of Staff]  [bell]  [avatar]
          (+ Admin — OASIS operators only; never rendered for client tenants)

TODAY (landing)                                   ← KEEP "Today"
  Morning brief: one card per department — "did overnight" / "needs you"
  Needs you: approvals queue (Approve · Send back · Comment · Share with client)
  Today's schedule (Google Calendar) · Goals & pace · Cash snapshot (Finance)

TEAM  (left rail; the tab IS the agent)
  Feed (deliverables + approvals)  ·  Schedule ← KEEP  ·  Projects  ·  Playbook ← KEEP (SOPs + skills)
  DEPARTMENTS
    Sales            Marketing        Content          Client Success
    Finance  ★wedge  Research         Operations (CC's "Operations" redefined: routines, connection health)
    Legal (opt-in)
  [OASIS tenant only: Agents ← KEEP (operator power chat)]

GROWTH  (the tools departments operate)
  Sales:     Pipeline ← KEEP · Conversations · Booking & Calendar · Sales calls
             Enablement (Training + Objections) · Commissions (opt-in) · [OASIS only: Prospects = /web-leads]
  Marketing: Funnels & Forms ← KEEP (Forms) · Ads · Email · Texting · Campaigns & Sequences

CLIENTS  (the business's OWN customers)
  Customer list → per customer: Overview · Projects · Meetings · Tickets · Files · Agreements (e-sign) · Portal
  Support desk (all tickets, SLA)  ← Tickets rebuilt for clients' customers

SETTINGS:  Profile · Team · Connections (plug-and-play hub) · AI brain · Brand · Billing · Audit log
ADMIN (OASIS operators only):  Systems console (Operations internals + Health + Agents fleet + Automations internals)
                               · Founders Finances · Founders Marketing
```

**Department tab anatomy (every department uses the same frame)**
1. **Header:** department name and status (working / needs you / not connected). No agent name.
2. **Channel:** chat with the department agent. It can @mention other departments, has a team-only toggle, and shows "worked for" plus skill chips.
3. **Needs you:** that department's pending approvals.
4. **Output:** deliverables and routine results.
5. **Numbers:** 3-4 KPIs from connectors, using the "unknown is not zero" pattern (`OCC/lib/goals/oasis-money.ts`).
6. **Routines:** plain-English recurring jobs with on/off and last run; each starts Off and passes a dry-run first.
7. **Connections** this department relies on.

**Theme.** Change the sidebar from `bg-bg-panel` (#0e1014, on a #020409 page) to near-void, following the Cook reference (a pure-black rail and hairline borders) (`OCC/components/Sidebar.tsx:349`, `SidebarShell.tsx:74`). Re-value, don't rename, the tokens. Retune the hard-coded hex in `globals.css` (inputs, buttons, chat bubbles). The marketing `ops.*` palette (`tailwind.config.ts:58-74`) is a ready-made darker reference.

**Phasing (human team / CC+Bravo; approval calendar time runs in parallel)**
- **Phase 0, safety** (1-2 wks / 2-3 days):
  - Merge `fix/tenant-boundary-guards`.
  - Make the env fallback OASIS/SunBiz-only for every service.
  - Sign or delete `stripe-provision`.
  - Add persona gates to `/runs`, `/inbox`, `/reasoning`, `/system-health`.
  - Fix `client_health.py:294`.
  - Close open signup.
  - Rebase on #457/#434; resolve #287.
  - Triage the uncommitted ribbon worktree.
  - **Day 1:** start Meta Business Verification and Google brand verification.
- **Phase 1, shell on OASIS's own tenant** (3-4 wks / about 1 wk):
  - `client-os` portal, seed and flag; top bar; dark tokens.
  - Today brief; Team departments with channels on `AgentChat`; Feed with approvals.
  - Cut the dead routes.
- **Phase 2, connectors and wedge** (4-6 wks / 1.5-2 wks):
  - Connections hub with the no-review connectors: Stripe restricted key, Calendar, gmail.send, GHL private app, Fathom/Recall, QBO/Xero, Plaid Trial.
  - Re-tenant the Finance cockpit read-only, with Atlas as data owner.
  - Rebuild Tickets for clients' customers.
  - Managed AI runtime.
- **Phase 3, pilots** (6-10 wks, mostly approvals):
  - Meta Ads, Meet transcripts, Twilio ISV/A2P, the Routines builder, the client portal.
  - Two done-for-you pilot clients.
  - Codex audit of every money and tenant-isolation diff (Rule 8).
