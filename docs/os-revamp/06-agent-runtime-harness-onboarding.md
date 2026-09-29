# OASIS OS: how the agents actually run, what a client installs, and how onboarding builds their portal

Draft for CC, 2026-09-29. Design only. Nothing in this document has been built, committed to main, or deployed.

- **Sits on top of:** `PLAN.md` and docs 00–04 in this folder.
- **Where it changes them:** it says so inline, marked **CHANGES**.
- **Code references:**
  - OCC `origin/main` at `4189719b` (after #473).
  - BEA (`C:\Users\User\Business-Empire-Agent`) at `1a21730a`.
  - Maven (`C:\Users\User\CMO-Agent`) and Atlas (`C:\Users\User\APPS\CFO-Agent`) as they are on disk today.

---

## 0. The answer in one page

CC's goal: a client signs, claims their portal, answers a Setup AI, connects their own AI account, and ends up with department agents that work like real coding harnesses on their business. OASIS does not hand-build anything and does not pay for their AI.

**The system has four parts. Each has one job.**

```
┌──────────────────────────────── PORTAL (oasisai.work, cloud) ────────────────────────────────┐
│  Tabs, records, approvals, chat. Where the owner and team see and decide everything.          │
└───────────────┬───────────────────────────────────────────────────────────────┬───────────────┘
                │ asks                                                          │ shows results,
                ▼                                                               │ approval cards
┌──────── DESK AGENT (per department, in the portal) ────────┐                  │
│  Answers in the department channel. Fast, sandboxed:        │                  │
│  reads records, drafts, proposes. No shell, no files.       │                  │
│  When a task needs real work, it files a JOB.               │                  │
└───────────────┬─────────────────────────────────────────────┘                  │
                │ agent_jobs (queue)                                              │
                ▼                                                                 │
┌──────── RUNNER (where the work happens) ───────────────────────────────────────┴───────────────┐
│  Cloud runner: an OASIS-hosted sandbox per client (always on)                                  │
│  or Desktop runner: the client's own computer, through OASIS Desktop                           │
│   1. open the client's workspace for that department:  ~/.oasis/<workspace>/<department>/     │
│   2. start the engine there with the client's BRAIN (their API key, or their own CLI login     │
│      where the provider allows it)                                                             │
│   3. the engine reads the HARNESS in that folder (rules, skills, memory, identity) and works   │
│      like a coding agent: terminal, files, scripts, skills, subagents                          │
│   4. outward actions come back as approval cards; files land in the client's Files              │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲                                             ▲
          │ HARNESS KIT (built by OASIS, versioned)     │ BRAIN (the client's own AI account)
          │ Chief of Staff / Operations  ← from Bravo   │ Anthropic API key (default)
          │ Marketing                    ← from Maven   │ OpenAI / Google key
          │ Finance                      ← from Atlas   │ their own CLI login, only where the
          │ + the client's identity layer, written by   │ provider's terms allow (see §2)
          │   the Setup AI from their answers           │
```

**The five decisions that shape everything**, each with my recommendation (details in §10):

1. **Where agents run by default: an OASIS cloud runner, with the client's computer optional.** Always on, and nothing breaks when a laptop sleeps. The desktop runner is for local files and their own browser.
2. **Whose AI pays: the client's.** They connect their own API key, as CC asked. OASIS-managed AI stays available only as a pass-through add-on, billed at cost plus margin, never absorbed. **CHANGES** decision 6 in `PLAN.md` ("managed default").
3. **Claude subscriptions:**
   - For clients, Claude runs on the client's own Claude API key, never on a claude.ai login. Anthropic forbids third-party products from offering claude.ai login without prior approval (quote in §2).
   - We apply for that approval now and build on it only if it is granted.
4. **Client harnesses are built clean, not scrubbed.**
   - A client never receives a copy of Bravo, Maven or Atlas with CC's details swapped out. The existing `scripts/scaffold.py` keeps "past client and partner names" by design, which is a confidentiality leak in a product.
   - Instead, a builder assembles each harness from an allowlist of shareable files and fails closed if anything personal slips in.
5. **Talking and working are separate:**
   - The department channel is a fast desk agent: sandboxed, cheap, and safe to run in the Worker.
   - Real harness work runs as a job on the runner.
   - This keeps doc 03 §d.4's safety rule (no shell in the portal) and still gives CC the "true coding harness" he wants, where it can run safely.

---

## 1. What already exists (verified 2026-09-29)

| Piece | Where | State | What it means for this plan |
|---|---|---|---|
| Bravo harness | BEA, 168 skills, `PERSONAL.md` germline, `brain/SOUL.md`, `brain/USER.md`, `brain/operator.profile.json`, `memory/` | Works for CC. Full of CC's identity, clients and history | Source for the Chief of Staff, Operations, Sales and Client Success packs. Not shippable as is |
| Maven harness | `CMO-Agent`, 87 skills, `brain/USER.template.md`, `operator.profile.example.json` | Works for CC. `brain/` holds CC's creative identity, clients and campaigns | Source for the Marketing pack |
| Atlas harness | `CFO-Agent`, 61 skills, same template files | Works for CC. Holds CC's tax and accounts | Source for the Finance pack |
| Two-layer rule (CORE vs PERSONAL) | `BEA/brain/PRODUCT_ARCHITECTURE.md` | Written, not enforced | The rule the Harness Kit enforces (§4) |
| Clean agent skeleton | `BEA/templates/agent-scaffold/` (SOUL/USER templates, memory, doctor, self_audit) | Exists | The base every client harness starts from |
| Token-swap "fork" | `BEA/scripts/scaffold.py` | Exists. **Keeps CC's past client and partner names on purpose** | Do not use for clients. Leak risk |
| Agent Factory setup wizard | `BEA/bravo_cli/wizard.py` (2,000+ lines: profile picker Bravo/Atlas/Maven/Aura/Hermes/Custom, keys, chat bridges, doctor) | Works locally. Writes a single `.env.agents` | Salvage its questions and doctor checks. Its secret store moves to the tenant vault |
| Setup Wizard 2.0 spec | `BEA/brain/SETUP_WIZARD_2_SPEC.md` | Deferred spec | Superseded by §6 of this doc |
| Client-ready scorecard | `BEA/brain/CLIENT_READY.md` | Sanitization 1/10, onboarding automation 0/10 | The gap this plan closes |
| OASIS Desktop (Electron) | `BEA/apps/oasis-desktop`, alpha.5 (Mac/Linux), alpha.4 (Windows) | Contract already right: "Provider connection + Runtime access = agent capability". **`desktop.manifest.json` still points at `agent-dashboard-cc90210.vercel.app`, which is dead since the Vercel billing block, so the app cannot reach the portal today.** Bridge sidecar = `bravo_cli.local_bridge` (Bravo's own code) | Becomes the Desktop runner (§5.4). Needs the URL fix, signed builds, and a client-safe sidecar |
| Desktop pairing | OCC `/desktop-link` (mints a pair code, deep link `oasis://pair?code=`), `lib/bridge-*` | Works for CC's bridge | Reused as-is for pairing a client's computer |
| Cloud agent runner | `BEA/apps/agent-runner` | Scaffold only. Supabase JWTs, never deployed | Replaced by the runner in §5.3 |
| Job queue design | Doc 03 §d.1: `agent_jobs` with a DB lease, a Worker lane and a VPS lane | Designed, not built | The spine of §5 |
| Tool sandbox for the portal | Doc 03 §d.4, `lib/ai/tools/client-safe-registry.ts` | Built (default-deny) | Kept for desk agents |
| Department channels | OCC `/team/[dept]` | **UI only.** The channel posts to the old text-only `/api/agents/chat`: no tools, data, approvals, history or metering. It resolves to a May key on a drained account, and prompts name Bravo/Maven/Atlas (verified 2026-09-29). The desk-agent route `/api/os/departments/[dept]/chat` was never built | Plan v2 F1.2 makes it honest, F5 builds the desk agent |
| AI Team page | OCC `/agents` (roster, builder, 6 templates); rail row is OASIS-only and system-surface | Built | Folds into Team (§7) |
| AI brain settings | OCC `/settings/ai`, `agent_model_config` (encrypted) | Built for keys and overrides | The brain step in onboarding writes here |
| Onboarding wizard | OCC `/onboarding/wizard`: industry → questions → agents → agent setup → brand → confirm | Built for the retired self-signup flow | Its steps become the Setup AI's structured cards (§6) |
| Business interview | Doc 04 §b.3: 7 sections into `tenant_business_profile` | Designed | The Setup AI fills exactly this (§6.3) |
| Approvals | #470 (live): every outward action is an approval card executed once | Live | Every runner action that leaves the building goes through it |
| Connections | #472 (live), one card per app (branch `feat/os-connections-one-card`, not pushed) | Live / in progress | The tools step in onboarding |
| Client records, support desk | #473 (live 2026-09-29) | Live | The Clients mode |
| Skill inventory | 168 Bravo skills classified by audience (session scratch `inventory.json`, 2026-09-29) | Bravo only | Maven's 87 and Atlas's 62 still need the same pass (§8) |

---

## 2. Hard facts the design must respect

1. **Anthropic, verbatim** (Agent SDK overview, `code.claude.com/docs/en/agent-sdk/overview`, fetched 2026-09-29):
   > "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
   - OASIS OS may not offer "sign in with your Claude plan" to power its agents unless Anthropic approves it.
   - It may run Claude on the client's own API key (Anthropic, or Claude through Amazon Bedrock or Google Vertex).
   - The same page: the SDK is governed by Anthropic's Commercial Terms "including when you use it to power products and services that you make available to your own customers".
   - Branding: we may say "Powered by Claude", but never call our product "Claude Code".
2. **Other providers, verified 2026-09-29** (research workflow `wf_f93e7e2e-98e`):
   - **Google: forbidden.** Gemini CLI "Login with Google" for consumer tiers ended 2026-06-18, and third-party software using it is a terms violation. The free Gemini API tier may have humans read inputs, so it is never used for client data. The paid tier or Vertex is fine.
   - **OpenAI: needs approval.** "Sign in with ChatGPT" plan usage launched 2026-09-29; paid or remotely hosted apps file the interest form (draft in `07-provider-applications.md`). Reusing Codex's own OAuth client in a product is not allowed.
   - **GitHub Copilot SDK: allowed.** It officially supports SaaS products running on each user's own Copilot subscription through GitHub sign-in (Advanced option; needs a runner).
   - **OpenRouter: allowed.** It has one-click OAuth (PKCE) for users to connect their own account.
   - **Anthropic, more precisely than above.** The Claude Code legal page also allows an end user to sign in to the **unmodified Claude Code binary** with their own subscription, even where a platform hosts it, as long as tokens are never collected, stored or proxied and usage is never resold. Whether that covers unattended business automation is unconfirmed; that is question 2 in `07`.
   - **The legitimate "use my existing subscription" path is inverted:** OASIS becomes a connector (remote MCP server) inside the client's own Claude or ChatGPT app.
   - API keys for every provider are fine under their API terms.
3. **CC's own accounts never power a client.** No CC subscription, no OASIS bridge (`bravo_cli` exposes bash and file writes), no CC keys. This is already law in `PLAN.md`; it is restated here because the runner makes it easy to get wrong.
4. **No client ever receives CC's or OASIS's data.** That covers identity, clients, memory, deals, voice samples and credentials. Enforced by the builder's leak scan (§4.3), not by care.
5. **An agent with a terminal is a real attack surface.** Client content (emails, web pages, form fills) is untrusted. It can try to steer the agent. Every runner is isolated per client (§9).
6. **CC, 2026-09-29: OASIS does not cover the client's AI spend.**
7. **Quebec and Canada.** Law 25 (a privacy impact assessment for data leaving Quebec, and disclosure of sub-processors) applies to where runners and model calls happen. The runner's region and sub-processors go into the DPA (doc 04 §d.5).

---

## 3. Vocabulary (so every tab, doc and screen says the same thing)

| Word | Meaning | Client sees it as |
|---|---|---|
| **Department** | A business function: Chief of Staff, Sales, Marketing, Client Success, Finance, Operations | A tab with a channel |
| **Desk agent** | The department's conversational agent in the portal | "the Marketing department" |
| **AI teammate** | A named agent the owner builds (Setter, Bookkeeper...) from a template | A teammate on the Team page |
| **Harness** | The folder that makes an agent competent: rules, skills, scripts, memory, identity | Invisible, "how your team is trained" |
| **Harness Kit** | OASIS's versioned, client-safe harness builds, one per role pack | Invisible |
| **Role pack** | The department-specific part of a harness (Finance pack from Atlas...) | Invisible |
| **Identity layer** | The client's own files in the harness: company, voice, offers, goals, preferences | "What your team knows about you" (editable) |
| **Brain** | The AI account that powers the agents | Settings › AI brain |
| **Runner** | Where jobs execute: Cloud runner or Desktop runner | Settings › Where your agents work |
| **Job** | One unit of harness work (a report, a campaign draft, a reconciliation) | A card in the Feed with its progress |
| **Service** | A client-facing packaged outcome built from skills (Brand Studio, Proposal, Market research) | A card inside a department |
| **Skill** | A reusable capability file the agent uses | Visible only when it is a Service |

**Naming rule:**
- Bravo, Maven and Atlas are OASIS's own agents and internal code names.
- Clients see department names by default, and can rename their teammates.
- Whether "Powered by Bravo/Maven/Atlas" appears as a brand is decision §10.4.

---

## 4. The Harness Kit: turning Bravo, Maven and Atlas into client products

### 4.1 Three layers per client harness

```
~/.oasis/<workspace-slug>/<department>/          (same shape on a cloud runner and a desktop)
├── ENGINE        shared by every client, updated by OASIS
│   ├── .claude/skills/…        agent-domain + tooling skills for this role (see §8 labels)
│   ├── .claude/hooks/…         the guards: secret guard, exec guard, outbound chokepoint
│   ├── scripts/…               the tool CLIs this role uses (doctor, state, sends through the portal)
│   └── HARNESS_VERSION, harness.lock
├── ROLE PACK     per department, updated by OASIS
│   ├── CLAUDE.md / AGENTS.md   the role's operating rules (generic, no CC)
│   ├── brain/ROLE.md           what this department owns, its KPIs, its approval policy
│   └── playbooks/…             industry-pack playbooks for this role
└── IDENTITY      per client, written by the Setup AI, edited by the owner, NEVER overwritten by updates
    ├── brain/COMPANY.md        what the business sells, to whom, prices, service area, team
    ├── brain/VOICE.md          tone, words to use and never use, "never promise"
    ├── brain/GOALS.md          90-day goal, the one number, what a good week looks like
    ├── brain/PREFERENCES.md    the true/false answers (e.g. "draft only, never send without me")
    ├── brain/BRAND.md          logo, colours, fonts (links to Files)
    └── memory/                 this client's own memory, starting empty
```

This is `BEA/brain/PRODUCT_ARCHITECTURE.md`'s CORE vs PERSONAL rule, made physical:
- **ENGINE + ROLE PACK:** CORE.
- **IDENTITY:** PERSONAL.
- **Update rule:** an update may replace ENGINE and ROLE PACK and never touches IDENTITY.

### 4.2 Where each role pack comes from

| Role pack | Source harness | Takes | Leaves behind |
|---|---|---|---|
| Chief of Staff | Bravo | briefing, dashboard, planning, routing, approvals etiquette, memory discipline | CC's identity, APP_REGISTRY, empire ops, cross-agent coordination with APEX, cron fleet |
| Operations | Bravo | SOPs, docs/xlsx/pdf, workspace recipes, project management | OASIS infrastructure skills (deploys, Turso, GPU box) |
| Sales | Bravo | methodology, meeting prep, proposals, booking, follow-up | `sales-closing` (written in CC's voice), OASIS outreach |
| Client Success | Bravo | health scoring, crisis response, support etiquette | SunBiz and client-specific playbooks |
| Marketing | Maven | content engine, ad formats, creative strategy, research | CC's creative identity, Maven's clients and campaigns, Vern Vell, the GPU box |
| Finance | Atlas | metrics, modelling, cash/runway, reporting | CC's tax files, accounts, investment research, trading archive |

### 4.3 How a harness is built (the pipeline)

1. **Manifest.** Each source repo gets `harness.manifest.yaml`: an allowlist of shareable paths per role, and a denylist of patterns that must never ship.
   - Nothing is shareable by default.
   - A new skill ships only after someone adds it to the list.
2. **Builder.** `harness_build --role finance --source ../CFO-Agent --version 1.2.0`:
   - copies only the allowlisted files onto `templates/agent-scaffold`;
   - renders the role's `CLAUDE.md` from a template.
3. **Leak scan (fails closed).** The build scans every shipped file and aborts on any hit for:
   - CC's names;
   - OASIS client and partner names (from the CRM and `brain/clients/`);
   - OASIS domains and emails;
   - Stripe/Turso/API key shapes;
   - dollar figures tied to OASIS;
   - file paths under `C:\Users\User`;
   - memory or session-log content.
   The scan list is generated from live data, so a new client is covered automatically.
4. **Doctor.** Before release, the build is installed into a throwaway workspace with a fake identity. The role's doctor must pass, and a smoke task per role must complete.
5. **Release.** The build is signed and uploaded to R2 as `harness-<role>-<version>.tgz` with a checksum. A row in `harness_releases` records what changed.
6. **Promote.** A release goes to OASIS's own workspace first (dogfood), then to pilot clients, then to everyone. Rollback means pinning the previous version per workspace.

### 4.4 How the harness improves over time without leaking

- Each client's harness learns in its own `memory/`. That never leaves their workspace.
- OASIS improves the ENGINE and ROLE PACKS from our own use (Bravo, Maven, Atlas keep evolving). The builder re-extracts, re-scans and re-releases.
- A client-discovered improvement comes back only as a code change OASIS writes, never by copying their memory. Same rule as the data moat, doc 04 §d.4.

---

## 5. The runtime: how one task actually runs

### 5.1 The life of a job (the zoom-in CC asked for)

Example: the owner types in **#finance**: *"Why did cash drop last month? Make me a one-page report."*

1. **Desk agent (portal, seconds).** Finance's desk agent:
   - reads the Stripe and bank metrics it is allowed to read;
   - answers what it can right away ("Cash fell $8.2K; two payouts moved to October");
   - sees the report needs harness work and files a job.
2. **Job created.** An `agent_jobs` row (doc 03 §d.1, extended):
   - `tenant_id`, `department='finance'`, `kind='harness_task'`, `harness_role='finance'`, `harness_version`;
   - `brain='byo:anthropic'`, `runner='cloud'|'desktop'`, `permission_mode='draft_only'`;
   - `inputs`, `budget_cap`, `requested_by`, `approval_policy`.
   The Feed shows "Finance is working on: cash report".
3. **Runner claims it.** The client's runner (cloud or desktop) claims the job with its runner token. Every job is re-checked against the tenant's lifecycle: a retired or paused workspace runs nothing.
4. **Workspace.**
   - The runner opens `~/.oasis/<workspace>/finance/`: "cd into the harness".
   - If the installed harness version is older than the job's, it updates ENGINE and ROLE PACK first. IDENTITY is untouched.
5. **Brain.**
   - The runner starts the engine with the client's brain. The key comes from the tenant vault into the process environment for this job only. It is never written to a file or shown to the model.
   - **Anthropic key:** the engine is the **Claude Agent SDK** (Claude Code as a library). It loads the harness folder exactly as Claude Code would: `CLAUDE.md`, `.claude/skills`, hooks, subagents.
   - **OpenAI or Google key:** a thin adapter runs the same harness with that provider's agent runtime. Capability varies; see decision §10.6.
   - **Own CLI login** (desktop only, and only if §2's terms allow): the runner launches the provider's official CLI, already logged in by the client on their own machine, in headless mode inside the harness folder.
6. **Tools.** The engine gets exactly what the job's permissions allow:
   - the harness's scripts and skills;
   - a terminal restricted to the workspace folder;
   - an OASIS **tool server (MCP)** for the client's connections. The server performs the Stripe, Gmail or Meta call with the vault key; the agent calls `stripe.list_payouts` and never sees the key.
7. **Work.** The agent works like a coding agent: reads, runs scripts, writes `report.md` and a chart, checks its numbers against `finance_get_metric`. Progress streams to the Feed card.
8. **Anything outward becomes an approval.** Sending the report to the accountant is an approval card (#470). The runner never sends, posts, spends or deletes on its own unless the owner pre-approved that exact template.
9. **Results.**
   - The report lands in the client's Files and in the channel thread.
   - The job records tokens and cost (`ai_usage_events`, `billing_mode='byo_key'`) and duration.
   - The harness's `memory/` records what it learned about this client.
10. **Done.** The Feed card flips to "Shipped", with the file and what it cost.

### 5.2 Which harness takes the task

- Chief of Staff routes goals ("get me 10 more booked calls") into department jobs. Each department runs its own harness in its own folder.
- A custom AI teammate is a role pack plus a persona overlay (name, avatar, extra rules, allowed skills and tools) that runs in its department's folder.
- A job that spans departments is split by Chief of Staff into linked jobs, one per department. They share one Feed thread.

### 5.3 Cloud runner (recommended default)

- **What:** one isolated sandbox per client workspace (a container with its own filesystem and user), on OASIS-run hardware. It claims only that tenant's jobs.
- **Two ways to build it, to prototype side by side on one department:**
  - **(a) Our own containers** on a runner VPS: the `lane='vps'` runner from doc 03 §d.1, one container per tenant. Full control; we run and patch it.
  - **(b) Anthropic Managed Agents with a self-hosted sandbox.** The same Agent SDK page lists it as "a hosted agent harness that runs the agent loop, with sessions in an Anthropic-managed cloud sandbox or a self-hosted sandbox on your own infrastructure". Less to build. Claude only, and billing runs on an API key, which is the client's in our model. To be tested: whether sessions can run on a client-supplied key.
- **Who pays for the compute:** the client, as a pass-through line (`usage_events`, doc 03 §d.3), since OASIS does not absorb AI or hosting costs.
- **Never on:** srv1723601, or any box that runs CC's own agents.

### 5.4 Desktop runner (optional)

- **What:** OASIS Desktop on the client's computer, paired through `/desktop-link`. It runs a **client runner sidecar** that claims only that workspace's jobs.
- **Gains:** local files, the client's own logged-in browser, and their own CLI login where the provider allows it.
- **Costs:** the computer must be on, and support gets harder.
- **Work before any client installs it:**
  1. Point `desktop.manifest.json` at `https://oasisai.work` (it still names the dead Vercel host).
  2. Replace the `bravo_cli.local_bridge` sidecar with a client runner that has no Bravo code, no bash-everything tool and no OASIS keys.
  3. Sign the builds on all three platforms. Windows is still on alpha.4.
  4. Enforce the workspace-folder jail and an allow-list for outbound network, exactly as on the cloud runner.
- **Setup:** **one download.** It installs the runner, the needed runtimes (Node or Python, bundled), and the harnesses for the workspace's enabled departments. It then runs the doctor and shows green or red per department in the portal.

### 5.5 What runs where (summary)

| Work | Desk agent (portal) | Cloud runner | Desktop runner |
|---|---|---|---|
| Quick answers, record lookups, drafts | ✓ | | |
| Reports, analyses, documents, spreadsheets | | ✓ | ✓ |
| Routines (scheduled) | triggers | ✓ | only while on |
| Local files, own browser | | | ✓ |
| Outward actions | proposes | proposes | proposes |
| Anything executed outward | only after approval, by the portal's executor (#470) | | |

---

## 6. Onboarding: from signed agreement to a working, branded portal

**Goal (CC):** "we don't have to do any of the onboarding." The Setup AI does the work. OASIS reviews the result on Setup and Managed tiers; it does not do data entry.

### 6.1 The path, screen by screen

| # | Step | What happens | Built on |
|---|---|---|---|
| 1 | **Agreement** | MSA + DPA signed in the portal's e-sign; SHA-256 of the exact text recorded | Harvested e-sign, doc 04 §b.3 row 7 |
| 2 | **Payment** | Stripe checkout for the tier; the verified webhook creates a provisioning grant | Doc 04 §a.5 |
| 3 | **Claim your portal** | Owner invite link → set password → workspace created by `provision-tenant` with the industry pack | Invites, `provisioning_runs` |
| 4 | **Setup AI** | A conversation plus structured cards (§6.2). Fills `tenant_business_profile`, then shows "Here's what I understood" for the owner to confirm | Doc 04 §b.3, the old wizard's steps |
| 5 | **Brain** | "Which AI account powers your team?" Guided API key (§6.4), a spend cap set by the owner, live test | `/settings/ai`, `agent_model_config` |
| 6 | **Tools** | The Connections cards for the tools the interview found, in that order, one card at a time | #472 and the one-card branch |
| 7 | **Where your team works** | Cloud (default) or This computer (download OASIS Desktop, pair) | §5.3, §5.4 |
| 8 | **Build** | The Builder job runs on the client's brain (§6.5). Progress screen: "Writing your company file... Installing Finance... Theming your portal..." | This doc |
| 9 | **First wins** | The Levels checklist with live probes; the first numbers brief within 48h of the Stripe key | Doc 04 §b.4 |

**Order matters.** The brain comes before the build because the Builder runs on the client's own AI, as CC wants. A client who stops at step 5 sees exactly that, with a one-click resume.

### 6.2 The Setup AI (what it asks and how)

A chat that feels like talking to a sharp operator. Where precision matters it uses cards, not free text: pick-lists, true/false toggles, sliders, uploads. Sections follow doc 04 §b.3, plus five this plan adds:

| Section | Asks | Writes |
|---|---|---|
| Business | offers and prices, revenue band, team, area, languages, timezone | `COMPANY.md`, pack choice, KPI targets |
| Customers and sales | who buys, lead sources, current stages, cycle, who closes | pipeline stages, Sales `ROLE.md` inputs |
| Tools today | tool checklist (with app icons) | Connections order |
| Assets and proof | website, channels, SOPs, scripts, reviews | skill-ingestion queue |
| Voice | tone, "never say", response speed | `VOICE.md`, `tenant_voice_rules` |
| Goals | 90-day goal, the one number, a good week | `GOALS.md`, Today KPIs |
| **Brand** (new) | logo upload, or "make me one" (Brand Studio logo service); colours; fonts; business name as shown | `BRAND.md`, portal theme |
| **Preferences** (new) | true/false cards, e.g. "Agents may send emails without asking me" (default **false**); "Draft social posts for my approval" (true); "Weekly finance brief on Mondays" (true); "Contact leads by text" (false until Twilio A2P) | `PREFERENCES.md`, approval policies, first routines (all start Off) |
| **Departments** (new) | which departments to turn on (tier-gated), and teammate names | enabled roles, harness installs |
| **Finance basics** (new) | fiscal year, currency, GST/QST registered, accountant's email | Finance `ROLE.md`, alerts |
| Authority and consent | send-on-behalf, recording notice, Quebec notices | `tenant_agreements` |

**Rules for the Setup AI:**
1. **It suggests; the owner confirms.** Nothing is committed without a click.
2. **It reads the owner's website first**, then pre-fills answers as suggestions ("You sell kitchen renovations from $18K. Right?").
3. **The whole interview is resumable** and can be re-opened later from Settings to change any answer. A change re-renders the identity files, and each owner-edited file keeps its edits (a three-way merge, shown before saving).
4. **It runs on the client's brain once step 5 is done.** Before that, it runs on OASIS's onboarding model, capped at a few cents per client and counted as sales cost.

### 6.3 What the answers become

- **Portal:** the name, logo and colours under "OASIS AI" (CC: keep OASIS AI on top, the client's company name under it); the industry pack's stages, forms and KPIs; the enabled departments.
- **Harness:** `COMPANY.md`, `VOICE.md`, `GOALS.md`, `PREFERENCES.md`, `BRAND.md` in every enabled department's IDENTITY layer, rendered from one profile so every department knows the same facts.
- **Policies:** approval rules per department from the preferences, and the send windows and quiet hours.
- **Routines:** the pack's starter routines, **Off**, each with a passing sandbox run, waiting for the owner's switch.

### 6.4 Connecting the brain, seamlessly

- **API key, guided:**
  1. Provider cards (Anthropic recommended; OpenAI; Google).
  2. Each card has a 4-step picture guide ("Open console.anthropic.com → API keys → Create key → paste here").
  3. A paste box that validates the key's shape before it leaves the browser.
  4. A live test call; the key is stored encrypted in the vault.
  5. The owner sets a monthly cap (suggested from their tier), and we show what a typical month costs.
- **Their own login (only if §2 allows, desktop only):** "Use the AI app already on this computer". The desktop runner checks that the CLI is installed and logged in (`claude auth status --json` is the cheap check for Claude, pattern in BEA memory) and launches it headless.
- **OASIS-managed AI (add-on):** no key needed; metered and billed on OASIS's Stripe at cost plus margin (doc 03 §d.3 already designs the metering).

### 6.5 The Builder job

The last onboarding step is itself a harness job, run by a dedicated **Setup** role pack on the client's brain:

1. Render the IDENTITY files from the confirmed profile.
2. Install the enabled role packs into the client's runner.
3. Apply the portal theme (logo, name, colours) and the industry pack.
4. Draft the starter routines and sandbox-test each one.
5. Propose the first three Services to run ("Make my logo files", "Build my proposal template", "30-day marketing plan") as approval cards.
6. Run each department's doctor and report green or red.

Each step is idempotent and resumable. A failed step shows the exact reason and a "Try again" button, never a silent skip. Setup and Managed installs get an OASIS review card on `/admin/installs` before go-live; DIY goes live directly.

---

## 7. Every tab: what it is for, and what changes

**CC's point:** "Agents" and the department chats overlap. They do. The fix is to give each surface one job:

- **Departments are where you talk and watch work happen.**
- **Team is who is on the team:** humans and AI teammates in one list, with each AI teammate's setup. No chat lives on the Team page.

| Mode | Tab | Its one job | Change |
|---|---|---|---|
| Team | Today | What needs you now, overnight results, the Ask box | Keep |
| | Feed | Every approval and every job, live | Add job progress cards (§5.1) |
| | Departments (Chief of Staff, Sales, Marketing, Client Success, Finance, Operations) | Talk to the department; its numbers, routines and Services | Add a **Services** section per department (§8) |
| | Schedule | Calendar and booked calls | Keep |
| | Projects | Delivery work | Keep |
| | Playbook | Skills, SOPs and templates the team follows | Today OASIS-only; opens to clients once skills live in the DB (doc 04 §b.6) |
| | AI Team (`/agents`) | Roster and builder | **Fold into Team:** one page with people and AI teammates. Each teammate's page covers skills, tools, permissions, where it lives (web, Slack, Telegram) and which runner. The rail row goes away |
| Growth | Pipeline, Forms, Ads, Content, Commissions, Prospects, Enablement, Objections | As in `PLAN.md` | Content and Enablement need client versions (today OASIS-only) |
| Clients | All clients, Support desk | Client records, tickets | Every client row opens its client page (fix in progress: the name on a pipeline-derived row still opens the deal) |
| Money | Overview, Analytics → + Invoices, Transactions, Bills, Reports, Taxes, Accounts | The Finance wedge | Planned (CC's backlog, 2026-09-29) |
| Settings | Profile, Team, Connections, Chat apps, **AI brain**, **Where your agents work** (new), Brand & domain, Modules, Billing & add-ons, Notifications, Data & privacy, Audit log | | AI brain and runner get their own pages; Brand & domain gains the logo service and domain setup |
| New | **Setup** (first run, then Settings › Setup) | The onboarding path of §6, resumable | New |
| Admin (OASIS only) | Operations, Automations, Health, Agent console, Fleet, Runs, Inbox, System health, **Installs**, **Harness releases** (new) | OASIS machinery | Installs and Harness releases are new |

**The click test (CC: "where it takes me and why").**
- Every row, card and link gets one sentence in `docs/os-revamp/07-click-map.md`: from where → to where → why.
- A test walks the rail and asserts every href resolves for each persona.
- This is its own task after this doc is approved.

---

## 8. Every skill, labelled

The 168 Bravo skills are classified by audience (inventory, 2026-09-29):

| Label | Count | Where it shows up | Who triggers it | Examples |
|---|---|---|---|---|
| **Service** (client-facing feature) | 17 | A card in its department with 3–5 intake questions; output to Files; checkpoints are approval cards | The owner or team, from the card or by asking | `logo-design` (Brand Studio), `proposal-generation`, `market-research`, `ceo-briefing`, `client-success` (health score), `financial-modeling`, `sop-breakdown`, `booking-management`, `meeting-automation` |
| **Agent skill** (the agent uses it on the client's work) | 54 | Invisible; listed on the teammate's page as "knows how to…" | The agent, inside jobs | Google Workspace actions (Gmail, Calendar, Docs, Sheets, Drive), `pdf`, `docx`, `xlsx`, `pptx`, `sales-methodology`, `strategic-planning`, `knowledge-compilation`, `email-safety` |
| **Harness mechanics** | 33 | Invisible; the ENGINE | The engine | memory, handoff, anti-drift, routing, skill creation, self-healing |
| **Coding tools** | 43 | Invisible; what makes it a real coding harness | The engine on jobs that build things | debugging, TDD, code review, plans, browser testing, MCP builder, frontend design |
| **OASIS-only** | 21 | Never shipped | OASIS | CC's daily planner, OASIS outreach and send gateway, computer control over Telegram, investor materials, ethical hacking, frontier radar |

**Still to do:**
- **Maven's 87 and Atlas's 61 skills** need the same pass before their role packs can be built.
- **Every skill needs a second label for its runtime:**
  - portal (prompt-only, 55 today);
  - runner (needs a CLI, a local app or scripts: 66 + 24 + 15);
  - desktop-only (needs the client's browser: 8).
- **Every skill needs a credential binding:**
  - none (66);
  - tenant connection (39);
  - operator machine (46): these need rework or stay OASIS-only;
  - OASIS-only (17).
- **Skills written in CC's voice need a neutral version** before they ship (e.g. `sales-closing`). The neutral version is then tuned by the client's `VOICE.md`.

**Services v1 (22 v1-flagged skills in the inventory, trimmed to what a $10–50K/month service business buys):**
- Brand Studio (logo, brand kit)
- Proposal and SOW
- Market research
- Weekly CEO brief
- Client health report
- 12-month financial model
- SOP writer
- Meeting prep
- Booking page

---

## 9. Security model for agents that can act

1. **One vault per client workspace** (`tenant_integration_credentials`, AES-256-GCM, encryption v2 in Phase 0). Each agent or department has a **grant list** of which connections it may use.
2. **Keys never enter a model.** Tools run server-side (the portal's tool server) or in the runner process environment for one job; nothing is written to the harness folder.
3. **The runner is a jail:**
   - one tenant per sandbox and a filesystem limited to the workspace;
   - an allow-list for outbound network (the model provider, OASIS, the client's connected services);
   - no access to other tenants, the host or OASIS secrets.
4. **Untrusted input stays data.** Emails, pages and form fills are wrapped as untrusted (`wrapUntrusted`), and the same prompt-injection rules as BEA's apply in every role pack.
5. **Approvals gate everything outward**, executed once from the approved payload (#470).
6. **Permission modes per department:**
   - draft-only (default);
   - needs approval;
   - auto for pre-approved templates.
   Shown on each teammate's page.
7. **Kill switch per workspace and per department.** Every runner checks it before each job and between steps.
8. **Signed harness and runner updates**, with a checksum checked before install, and a pinned version per workspace for rollback.
9. **Audit log.** Every job, tool call summary, approval and file is recorded against the workspace and visible to the owner.

---

## 10. Decisions for CC

Each has a recommendation and the one-line tradeoff.

1. **Default runner: Cloud.** Clients who want local files or their own browser add Desktop.
   - *Tradeoff:* we operate and bill compute; in exchange, nothing depends on the client's laptop being awake.
2. **Brain: the client's own API key by default. OASIS-managed AI as a paid add-on, billed at cost plus margin.**
   - *Tradeoff:* a short, guided "get your API key" step in onboarding, in exchange for zero AI cost exposure for OASIS.
3. **Apply to Anthropic now** for approval to offer Claude plan login. Build nothing on it until approved.
   - *Tradeoff:* no "sign in with your plan" convenience at launch; no terms risk either.
4. **Client-facing names: departments by default**, with teammates the owner can rename. Bravo, Maven and Atlas stay OASIS's internal names; optionally "Powered by OASIS agents".
   - *Tradeoff:* we don't brand-build our agent names publicly yet.
5. **Merge AI Team into one Team page** (people + AI teammates). The Departments are where chat lives.
   - *Tradeoff:* the Agents rail row disappears.
6. **Non-Claude brains:** support OpenAI and Google keys for desk agents at launch, and for harness jobs only after a 20-task comparison shows they complete the role's jobs.
   - *Tradeoff:* Claude-only harness jobs at first; honest "works best with Claude" copy.
7. **Cloud runner build:** prototype (a) our own containers and (b) Anthropic Managed Agents with a self-hosted sandbox on the Finance department, then pick on cost, control and data residency.
   - *Tradeoff:* about a week of spike before committing.

---

## 11. Build order (estimates: human team / CC+Bravo)

| Phase | Delivers | Human | CC+Bravo |
|---|---|---|---|
| R0 now | Finish Connections (one card per app), SunBiz code removal, point OASIS Desktop at oasisai.work, the click map and its test | 2 wks | 3–4 days |
| R1 Harness Kit | Manifests for Bravo, Maven, Atlas; builder + leak scan + doctor + signed release; Maven and Atlas skill classification; 6 role packs v0.1 installed on OASIS's own workspace | 4–5 wks | 1.5–2 wks |
| R2 Runner v1 | `agent_jobs` (extended), the job card in the Feed, cloud runner spike (a) vs (b), then one department end to end: Finance "cash report" (§5.1) on a BYO Anthropic key | 5–6 wks | 2 wks |
| R3 Setup AI | The §6 path: brain step, tools step, Setup AI over `tenant_business_profile`, Builder job, portal theming, resumable progress | 4–5 wks | 1.5–2 wks |
| R4 All departments | The other five departments on the runner; Services v1 cards; routines on the runner; Team page merge | 5–6 wks | 2 wks |
| R5 Desktop runner | Client-safe sidecar, signed builds for 3 platforms, jail, pairing into onboarding step 7 | 3–4 wks | 1–1.5 wks |
| R6 Pilot | Two pilot clients through the whole path with no hand-built setup; fix what they hit | calendar 4–6 wks | 1 wk of fixes |

**Critical path:**
1. R1 Harness Kit, because nothing ships to a client until the leak scan is green.
2. R2 Runner.
3. R3 Setup AI.

R0 runs now; R5 can run in parallel with R4.

---

## 12. Risks

- **Terms risk on CLI logins.** Handled by §2 and decision 3: API keys only until a provider approves.
- **Cost surprise for clients.** Harness jobs use many tokens. Mitigations: owner-set caps, a cost estimate before each large job, and a monthly summary.
- **Leaks from CC's harnesses.** Mitigations: allowlist-only manifests plus a fail-closed scan generated from live data. Never the token-swap fork.
- **Runner security.** A runner holds a client's brain and acts on their data. Mitigations: §9's jail, per-job credentials, kill switch, audit. Codex adversarial review before any client runner goes live.
- **Two sources of truth for the business profile.** The portal's `tenant_business_profile` is canonical; the harness IDENTITY files are rendered from it. An owner edit in a harness file is proposed back as a profile change, never kept silently.
- **Desktop support load.** Cloud-first keeps it small; the desktop doctor reports to the portal, so support sees what the client sees.
- **Scope.** This is several months of work (§11). The v1 sellable cut in `PLAN.md` still ships first; this plan replaces the "agents" part of it rather than adding a second track.
