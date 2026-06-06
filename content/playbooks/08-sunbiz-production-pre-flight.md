---
title: SunBiz production pre-flight
audience: empire-operator
status: current
last_updated: 2026-05-28
---

# SunBiz production pre-flight

What to do when you sit down at the Mac to pick this up — and what to verify before handing Ezra real data + credentials.

This is the **bring-up + smoke checklist**. For day-2 ops see [06-sunbiz-runbook.md](./06-sunbiz-runbook.md).

---

## Section 0 — Where things stand (snapshot at 2026-05-25)

| Surface | State | Notes |
|---|---|---|
| Sidebar IA | Live | Pipeline (Leads / Shopping Out / Applications) · Deals (Offers / Renewals / Commissions / Lenders) · System (Import / Forms / Sequences / Team / Automations / Settings) |
| Migration 064 | Applied | Lead stages slimmed 12→9; Application statuses 17→10; renewal threshold seeded |
| Welcome screen | Removed | Sun Biz operators land directly on `/t/sun` |
| Settings isolation | Live | `/t/sun/settings` routes through manifest → preview mode for non-owners (no data leak) |
| Offers / Lenders / Renewals / Shopping Out | Live (scaffold + data) | Empty-data renders full chrome; lender threads + match-fitness wired |
| Shopping Out Sender | Partial | UI + queue wired; physical SMTP fires from operator's bridge (Phase 6.3-bis pending) |
| Renewal Calculator / Lender Matching Agent / CRM Stage Engine | Live | Real, running on every relevant request |
| Email Offer Scanner / Browser Offer Extractor / Document Parser / Underwriting Agent / Renewal Reminder Agent | Planned | Honest "Planned" badges on Agents & Modules board |

Latest production: [`agent-dashboard-sigma-eight.vercel.app`](https://agent-dashboard-sigma-eight.vercel.app) on commit `52f206e`.

---

## Section 1 — Mac bring-up (start here on a fresh laptop)

```bash
# 1. Get both repos. Dashboard + agent-intel are independent — keep them
#    in sibling directories the way Windows has them.
mkdir -p ~/APPS && cd ~/APPS
git clone https://github.com/CC90210/oasis-command-center.git
cd ~ && git clone https://github.com/CC90210/CEO-Agent.git Business-Empire-Agent

# 2. Dashboard install. pnpm or npm both work; node 20+ required.
cd ~/APPS/oasis-command-center
npm install

# 3. Pull the .env from your password manager (or 1Password / file
#    sync — DON'T commit it). Place at the repo root as `.env.local`.
#    Required keys for the dashboard:
#      NEXT_PUBLIC_SUPABASE_URL
#      NEXT_PUBLIC_SUPABASE_ANON_KEY
#      SUPABASE_SERVICE_ROLE_KEY
#      BRAVO_FIELD_ENCRYPTION_KEY     (encrypts per-tenant API keys at rest)
#      VERCEL_TOKEN                    (only for `vercel ls` / inspect)

# 4. Verify the basics in one pass.
npm run typecheck   # tsc --noEmit
npm run lint        # eslint . — should report 0 warnings, 0 errors
npm run test:sunbiz # sunbiz-import-routing + auth-routing + middleware-prefix

# 5. Local preview (optional — production already runs on Vercel).
npm run dev
# Open http://localhost:3000/t/sun and confirm the dashboard renders.
```

For the **agent-intel repo** (`Business-Empire-Agent`):

```bash
cd ~/Business-Empire-Agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
# .env.agents lives at the repo root — same idea, pull from password manager.
# Required for migration apply / state sync:
#   BRAVO_SUPABASE_URL
#   BRAVO_SUPABASE_SERVICE_ROLE_KEY
#   SUPABASE_ACCESS_TOKEN
```

---

## Section 2 — Production smoke checklist

Open [`agent-dashboard-sigma-eight.vercel.app`](https://agent-dashboard-sigma-eight.vercel.app/t/sun) signed in as the empire operator (CC). Click every item below; each should match the right column.

| Click | Expected |
|---|---|
| `/t/sun` (dashboard) | SunBizHeroKpis (Hot leads / Missing info / In motion / Funded this month) + SunBizActionBand (Renewal alerts / Offers needing review / Shopping out 7d) — all zeros in preview, real counts when signed in as Ezra |
| Pipeline → **Leads** | 9-stage chevron pipeline. Imported / Not Interested / Approved should NOT appear |
| Pipeline → **Shopping Out** | 4-step workflow (Pick app → Pick lenders → Attachments → Send). Empty app picker in preview |
| Pipeline → **Applications** | 10-status pipeline. Click any row → detail drawer with Owner address block + Shop Out button |
| Deals → **Offers** | View toggle (Accordion / Kanban). Kanban shows the 8-column lifecycle scaffold even with zero deals |
| Deals → **Renewals** | 4 KPI cards + grouped rows with progress bars + Needs Data badges + wired tel:/mailto: buttons |
| Deals → **Commissions** | Generic ManifestTable (commission entity) |
| Deals → **Lenders** | Empty directory table with column headers + filter chips + "+ New lender" button |
| System → **Import** | LeadsImportClient — CSV paste flow |
| System → **Forms** | Top-level forms page |
| System → **Sequences** | Drip sequence list + "Computer not connected" banner if bridge offline |
| System → **Team** | Team management page |
| System → **Automations** | Order: "Describe an automation" → Agents & Modules (8 entries) → Cron jobs manager |
| System → **Settings** | Preview mode with 5 empty scaffold cards (Branding / Team / Devices / AI setup / Integration health). NO leak of CC's Devices or AI keys |

**Drawer pop test** — on Shopping Out, click any application row. The LeadDetailDrawer should pop with the same Owner / Bank / Lenders / Documents / Notes tabs you see on Leads/Applications. Close (Esc) → drawer dismisses, Step 2 lender picker stays primed.

**No duplicate-headers test** — Offers / Lenders / Shopping Out / Renewals should each show ONE "Offers" / "Lenders" / etc. title (the catch-all renders it; inner components don't duplicate).

---

## Section 3 — Hand-over to Ezra (when you're ready for real data)

Ezra signs in as `Submissions@sunbizfunding.com`:

1. **Grant Ezra owner role on the SunBiz tenant.** Without this, his Settings won't show Devices / AI setup / Team. Run from `Business-Empire-Agent`:
   ```sql
   -- Replace <sun-tenant-id> with the value from `SELECT id FROM tenants WHERE slug = 'sun'`
   UPDATE public.user_profiles
      SET is_owner = true, team_role = 'owner'
    WHERE email = 'Submissions@sunbizfunding.com'
      AND tenant_id = '<sun-tenant-id>';
   ```
   Run via Supabase SQL Editor (Management API) — apply_migration.py blocks UPDATE statements outside a `DO $$` block, and this is too small to justify a migration file.

2. **Ezra signs in → lands on `/t/sun`** (welcome screen is removed).

3. **Ezra navigates to Settings → Devices (Advanced)** → mints a pair code.

4. **VPS bring-up** for the bridge daemon (24/7 Sun Biz operations):
   ```bash
   # On the VPS, as the deploy user:
   git clone https://github.com/CC90210/CEO-Agent.git Business-Empire-Agent
   cd Business-Empire-Agent
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r scripts/requirements.txt
   # Pull the same .env.agents (Ezra's password manager copy).
   # Pair the bridge with the code Ezra minted in step 3:
   python scripts/bridge_setup.py pair <pair-code-from-step-3>
   pm2 start scripts/bridge_runner.py --name sunbiz-bridge --interpreter python
   pm2 save && pm2 startup
   ```
   Once paired + running, the Sun Biz Settings → Devices section shows the VPS as "Online" with a recent ping. Sequences + cron jobs + the Shopping Out physical SMTP send now fire automatically.

5. **Ezra connects an AI provider** under Settings → AI setup. OpenRouter is the easiest single key. Without this, Solara / Helios chat doesn't have a model.

6. **Ezra publishes his first form on `/forms`** for inbound lead capture, then connects Twilio under Settings → Integration keys for outbound SMS. Email goes through the shared Gmail submissions mailbox — no additional setup.

7. **Ezra creates his first lender** under Deals → Lenders → "+ New lender". Without at least one lender, Shopping Out has nothing to rank.

8. **Ezra imports his lead backlog** under System → Import. CSV paste with the existing legacy-stage mapping (migration 064 aliases preserve compatibility — old "Approved" → "Submitted" etc.).

---

## Section 4 — Known gaps (operator-visible honesty)

These are surfaced on the Agents & Modules board with "Planned" badges. Document for Ezra so he doesn't expect them on day one:

- **Email Offer Scanner** — Phase 6.4. No daemon yet polls Gmail for inbound lender offers; operator captures terms manually under Offers.
- **Browser Offer Extractor** — Phase 6.5. Velocity / lender portal links from emails aren't auto-extracted.
- **Application Document Parser** — Phase 7.x. Bank statements / application forms aren't auto-parsed for revenue / NSF / deposit consistency; operator enters in the Bank tab.
- **Underwriting Agent** — Phase 6.6. Shopped-out → funded tracking with rate / term / commission projection. Manual for now.
- **Renewal Reminder Agent** — Phase 8.2. Daily 9am sweep + Telegram alert. Manual review of Renewals page for now.
- **Shopping Out Physical SMTP** — Phase 6.3-bis. The route queues `application_lender_threads` at `status='pending'`. Until the bridge handler ships, the operator runs `python scripts/send_gateway.py send` per thread, or triggers via Solara chat. Marked "Partial" (amber) on the status board.

When CC's back from Montreal, Phase 6.3-bis is probably the highest-leverage next ship — closes the only Live-vs-Partial gap on the Shopping Out path.

---

## Section 4.5 — Audits to run on each pre-flight (added 2026-05-28)

These caught two real issues during the 2026-05-28 pass — the SunBiz cron leak and BRAVO Sleep's silent failure. Run them whenever you sit down to a fresh session, especially after a multi-day gap.

| Check | Command | Pass condition |
|---|---|---|
| SunBiz crons live in the right table | `.venv/bin/python scripts/integrations/supabase_tool.py select cron_jobs --columns "name" \| grep -i "sunbiz\|solara\|helios"` | Empty output — none should appear in the empire table. They belong in `tenant_cron_jobs` for the SunBiz tenant. |
| BRAVO Sleep last run status | `.venv/bin/python scripts/integrations/supabase_tool.py select cron_jobs --eq '{"name": "Bravo — Sleep Agent (Memory Consolidation)"}'` | `last_result` does NOT start with `ERROR:`. If it does, the script can't reach `ANTHROPIC_API_KEY` — check `scripts/bravo_sleep.py:225-235` and `scripts/lib/secret_loader.py` are in sync. |
| OASIS automations tab clean | Open `https://agent-dashboard-sigma-eight.vercel.app/automations` signed in as CC | Only empire agents (Bravo / Atlas / Maven / Aura) render. No "SunBiz" / "Solara" / "Helios" group should be visible. |
| Playbook page clean | Open `/playbook` signed in as CC | The "Operating manual" section lists `New Client Onboarding` but NOT `SunBiz production pre-flight`, `SunBiz Runbook`, `Customer Onboarding Script`, or any "Meet Solara" link. |
| OASIS settings clean for SunBiz operator | Open `/t/sun/settings` as Ezra | Renders the SunBiz tenant's branding / team / integrations only. No CC empire data leaks in. |

If any audit fails, see Section 10 for the architectural rules and Section 4 (Known gaps) for in-flight work.

## Section 5 — If something breaks

| Symptom | First thing to check |
|---|---|
| Vercel deploy fails | `npx vercel inspect <deployment-url>` for build logs. Most common: missing env var on Vercel project |
| Build warnings in Vercel | `npx eslint .` locally — must match Vercel's `npm run lint` (which is `eslint .`) |
| Sun Biz dashboard empty when Ezra is signed in | Ezra's `user_profiles.tenant_id` doesn't match the Sun Biz tenant. Verify with `SELECT email, tenant_id, is_owner FROM user_profiles WHERE email ILIKE '%sunbiz%'` |
| Settings shows operator's data inside `/t/sun/settings` | `resolveDataTenant` returning non-null for the wrong user. Check `lib/manifest/tenant-scope.ts` matched correctly |
| Drawer opens but no data | `/api/leads/<id>/detail?entity=application` returning 401 / 404. Check the API route + tenant scoping |
| Bridge offline despite running | `bridge_lock.py status --agent solara --json`. Multi-host arbitration may have stalled — `release` then `acquire` |

---

## Section 6 — Cross-tenant isolation (2026-05-25 hardening pass)

Every shared surface audited; per-leak fix + commit:

| Surface | Leak | Closed by |
|---|---|---|
| AgentsModulesStatusBoard | SunBiz funding modules on OASIS view | `b283c14` slug-gate via `MODULES_BY_TENANT` |
| CronJobsManager | Empire C-suite groups (Bravo/Atlas/Maven/Aura) on tenant view | `58fd7d8` agentKeys-driven groups |
| DescribeAutomationFlow | "Bravo's reasoning" label | `c78c798` agent_key driven |
| Layout brand resolution | profile.brand won over manifest.brand on tenant routes | `f608c5c` pathOverrideSlug gate |
| Layout primaryAgent | same shape | `f608c5c` |
| Sidebar / SidebarShell defaults | "OASIS AI" hardcoded fallback | `f608c5c` -> "Command Center" |
| FormPublicClient footer | "Powered by OASIS AI" | `f608c5c` removed |
| 8 shared route bullets + ComingSoon body | SunBiz/Solara copy | `f554b6b` |
| ComingSoon folder location | `components/sunbiz/` — name lied | `4b68d09` moved to `components/` |
| Reasoning page EmptyState | "your Bravo terminal" | this commit |
| Tenant Settings route | top-level /settings rendered operator data | `24fa69b` Option A |
| Tenant Automations route | top-level /automations same shape | `d94fefe` Option A |

## Section 7 — Data layer hardening (2026-05-25)

| Issue | Closed by |
|---|---|
| Migration 064 silently no-op'd (queried `tenants.slug='sun'` but actual slug is `submissions`); 10 stuck application statuses (`approved`, `submitted_to_underwriting`) | `c088dab` (migration 066) — correctly resolves via `tenant_manifests` |
| Ezra has no `is_owner=true` on Sun Biz tenant — Settings → Devices hides | `c088dab` migration 066 idempotent grant |
| `drip_sequences` table was empty for Sun Biz despite seed updates | `3bdb437` (`scripts/reconcile_sunbiz_sequences.py`) inserted all 8 |
| `tenant_manifests` row for slug='sun' status | `3bdb437` (`scripts/diag_manifest_drift.py`) — no row exists, in-code SUN_SEED is live (no drift to fix) |
| send_gateway BRAND_IDENTITY missing 'sunbiz' — outbound emails to lenders used OASIS footer | `4e91145` added sunbiz brand + `shop_out_sender` picks via tenant slug |
| Lead drawer missing Kixie click-to-call | `4b68d09` Call button + `kixie:` URL scheme |

## Section 8 — How to diagnose data visibility issues

If a tenant operator reports "I imported X but nothing shows up":

```bash
cd ~/Business-Empire-Agent
python scripts/diag_lead_visibility.py
```

Output groups by (tenant slug → entity_type → stage/status). Stages outside the post-064 visible set are flagged `[HIDDEN]`. If imports landed under the wrong tenant_id (signed-in-user mismatch), it shows in the source breakdown. If stages are stuck at retired values, run migration 066 again — it's idempotent.

For drip sequences:

```bash
python scripts/reconcile_sunbiz_sequences.py --dry-run   # report only
python scripts/reconcile_sunbiz_sequences.py             # apply changes
```

For manifest DB-row vs in-code drift:

```bash
python scripts/diag_manifest_drift.py
```

## Session lineage (so the next agent has context)

Commits shipped in the 2026-05-24 → 25 session — all on `main`, both repos:

| Repo | SHA | What |
|---|---|---|
| Business-Empire-Agent | `c86443a` | Migration 064 — SunBiz Jordan/Oasis restructure (applied) |
| Business-Empire-Agent | `42722a2` | State sync (post-ship) |
| oasis-command-center | `0dc7d32` | Core restructure (24 files) |
| oasis-command-center | `6775ef9` | Codex P2 fixes (5 bugs) |
| oasis-command-center | `965f4b6` | Self-review gap fixes (Shopping Out attachments + template sync) |
| oasis-command-center | `b7cddbe` | Duplicate-header + renewals_v2 + automations reorder |
| oasis-command-center | `3e9e121` | Renewals shared module extraction |
| oasis-command-center | `14ffbc2` | fmtCurrency/initialsOf consolidation |
| oasis-command-center | `8653d75` | Honest "Partial" label for Shopping Out Sender |
| oasis-command-center | `d4e63be` | Sequences bridge-online banner |
| oasis-command-center | `3775a11` | Shop-Out drawer pop + Underwriting/Renewal-Reminder modules |
| oasis-command-center | `8953fca` | Preview-mode scaffolds (Offers/Renewals/Lenders/Shopping Out) |
| oasis-command-center | `21c2409` | SunBizActionBand zero-count band |
| oasis-command-center | `24fa69b` | Tenant-scoped Settings (Option A infrastructure) |
| oasis-command-center | `708629e` | PREVIEW_SECTIONS DRY |
| oasis-command-center | `40cedc9` | Welcome screen redirect → /t/sun |
| oasis-command-center | `2527b7e` | Auth chooser fix (operator routing v1) |
| oasis-command-center | `93140e1` | Auth chooser hardening (positive OPERATOR_HOME match) |
| oasis-command-center | `52f206e` | All 5 Vercel build warnings cleared |
| Business-Empire-Agent | `2204ebc` | Phase 6.3-bis — shop_out_sender + migration 065 |
| Business-Empire-Agent | `c088dab` | Migration 066 — fixes 064's tenant lookup + remaps 10 stuck Sun Biz apps |
| Business-Empire-Agent | `4e91145` | Per-tenant brand identity in send_gateway + shop_out_sender |
| Business-Empire-Agent | `3bdb437` | Drip reconciler + manifest drift checker |
| Business-Empire-Agent | `3e3c917` | Migrations 067/068 + shop_out_sender claim-state hardening |
| oasis-command-center | `fee64a4` | Cross-tenant isolation polish — automations + leads drawer |
| SunBiz-Agent | `845a563` | Mirror Phase 6.3-bis + isolation hardening from CEO-Agent (caught up 10 days of drift) |

## Section 9 — VPS deployment readiness (2026-05-25)

CC's deploy target is a Linux VPS running the SunBiz daemon stack. Three things make a VPS bring-up safe: a daemon inventory you can predict, idempotent migrations you can re-apply, and an environment template that matches what the daemons actually read.

### Daemon inventory (which PM2 entries the SunBiz VPS should run)

`ecosystem.config.js` branches per-platform via `IS_WIN` / `IS_MAC` / `IS_LINUX`. On Linux, the **default** `pm2 start ecosystem.config.js` would currently start every daemon NOT gated by `IS_WIN` — including `bravo-telegram`, which would conflict with Windows. Use `--only` on the VPS, not the default boot.

**Run on VPS:**

| Daemon | Why | Manifest key (cron-poll dispatch) |
|---|---|---|
| `event-router` | V6 Apex Phase 3 cross-agent event bus tail — feeds /feed on the dashboard | — (PM2-daemon, not cron-dispatched) |
| `sequence-runner` | Drip-campaign engine — SunBiz drip enrollment + execution | `sequence_runner_loop` |
| `lender-response-classifier` | Closes the loop on lender shop-out replies (5-min poll) | `lender_response_classifier_loop` |
| `claude-bridge-ping` | Heartbeat to `/api/bridge/ping` + tenant cron poller | — (PM2-daemon) |
| `shop_out_sender` (cron-driven) | Bridge-side SMTP sender for `application_lender_threads`. Not in ecosystem.config.js; fires via the dashboard's tenant cron poller using manifest key `shop_out_sender_loop` | `shop_out_sender_loop` |

**Do NOT run on VPS:**

| Daemon | Why |
|---|---|
| `bravo-scheduler` | Empire-only — gated by `IS_WIN`; never starts on Linux anyway |
| `bravo-telegram` | Single-bridge invariant — same `TELEGRAM_BOT_TOKEN` from two hosts = random message routing. Telegram routing stays on Windows |
| `claude-bridge` | Dev-tool for Bravo's localhost:9100 chat HTTP server — unrelated to SunBiz operator workflows |
| `dashboard-email-consumer` | Empire-only — gated by `IS_WIN`; the SunBiz operator drawer sends through send_gateway via `shop_out_sender`, not this consumer |

VPS boot command:

```bash
pm2 start ecosystem.config.js --only event-router,sequence-runner,lender-response-classifier,claude-bridge-ping
pm2 save && pm2 startup
```

### Migration order

Idempotent (re-runnable) per audit on 2026-05-25:

| File | Idempotency mechanism |
|---|---|
| `042_tenant_forms.sql` | 7 × `IF NOT EXISTS` |
| `043_drip_sequences.sql` | 7 × `IF NOT EXISTS` |
| `044_lender_shopout.sql` | 4 × `IF NOT EXISTS` |
| `064_sunbiz_restructure.sql` | `DO $$ ... $$` block; UPDATEs target old-shape rows only |
| `065_shop_out_thread_send_context.sql` | 2 × `IF NOT EXISTS` |
| `066_sunbiz_remap_stuck_records.sql` | `DO $$` block; fails LOUDLY on prod if SunBiz tenant is unseeded (intentional) |
| `067_sunbiz_stage_remap_fix.sql` | `DO $$` block; graceful bail on dev environments without tenant |
| `068_shop_out_sender_claim_state.sql` | `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`; `ADD COLUMN IF NOT EXISTS`; `CREATE INDEX IF NOT EXISTS` |

Apply in numeric order:

```bash
cd ~/SunBiz-Agent   # or CEO-Agent on the VPS — same files mirrored 2026-05-25
for f in 042 043 044 064 065 066 067 068; do
  python scripts/apply_migration.py database/${f}_*.sql --supabase-project sunbiz
done
```

### Operator-facing runbook

`SunBiz-Agent/docs/VPS_BRINGUP.md` (committed 2026-05-25) walks Ezra (or anyone) through cold-starting a VPS in eight steps: clone → setup wizard → env from template → doctor → migrations → PM2 → save → smoke-test. The runbook is the operator-readable counterpart to this section.

## Section 10 — Three-repo split: what lives where (updated 2026-05-28)

**Major architectural shift completed 2026-05-28**: dual-storage is dead.
The bridge now resolves SunBiz scripts via the multi-root manifest
(`scripts/lib/agent_roots.py::resolve_sunbiz_root`) so SunBiz daemons
live in SunBiz-Agent ONLY. CEO-Agent's `scripts/` no longer carries
SunBiz copies. Commits sealing this transition: `6b9cefc8` (relocate),
`8c959e8d` (round 2 — strip 21 more files), `a10b6abd` (cross-platform
fallback), `f025952d` (multi-root manifest), `fdf141a5` (shared sibling
resolver in `lib/agent_roots`).

### Repo responsibilities (canonical)

| Repo | GitHub remote | Purpose | Canonical for |
|---|---|---|---|
| `~/CEO-Agent` (Mac) / `~/Business-Empire-Agent` (Win) | `CC90210/CEO-Agent` | Empire substrate + PM2 runtime + bridge dispatch | V6 state DB, retrieval, guards, event bus, `ecosystem.config.js`, `send_gateway.py` (empire chokepoint), CC's bridge + Telegram + scheduler, sibling-root resolver |
| `~/oasis-command-center` (Mac) / `~/APPS/oasis-command-center` (Win) | `CC90210/oasis-command-center` | Multi-tenant dashboard | All Next.js UI for every tenant — manifest-driven, no per-tenant dashboard repos |
| `~/SunBiz-Agent` | `CC90210/SunBiz-Agent` | SunBiz-specific business logic + VPS deploy | **Sole canonical home** for SunBiz daemons, migrations, cron registry, and runtime. The bridge dispatches against this root via `SUNBIZ_AGENT_ROOT` env var (auto-resolved by `lib/agent_roots.py`). |

### What lives in SunBiz-Agent (and ONLY there)

- All SunBiz business-logic scripts: `shop_out_sender.py`, `sequence_runner.py`, `lender_response_classifier.py`, `underwriting/*`, `renewal_reminder.py`, `follow_up_generator.py`, `cold_outreach_runner.py`, `daily_plan_generator.py`, `underwriting_orchestrator.py`, `diag_lead_visibility.py`, `diag_manifest_drift.py`, `reconcile_sunbiz_sequences.py`.
- `scripts/core/cron_registry.py` — canonical SunBiz cron schedule (added 2026-05-28). Seeds `tenant_cron_jobs` rows scoped to the SunBiz tenant. Dispatched by `claude-bridge-ping`'s tenant cron poller, NOT by the empire `bravo-scheduler`.
- SunBiz migrations: `database/042_tenant_forms.sql`, `043_drip_sequences.sql`, `044_lender_shopout.sql`, `064_sunbiz_restructure.sql` through `069_sunbiz_meeting2_expansion.sql`.
- SunBiz PM2 ecosystem (`ecosystem.config.js` at SunBiz-Agent root).
- SunBiz operator docs: `docs/DAEMON_PLAYBOOK.md`, `docs/VPS_BRINGUP.md`, `docs/ARCHITECTURE.md`.

### What stays in CEO-Agent (and ONLY there)

- `scripts/integrations/send_gateway.py` (multi-tenant chokepoint — SunBiz brand identity is selected by tenant slug inside).
- `scripts/integrations/*` (everything else there is empire-wide).
- `scripts/state/*`, `scripts/core/*` (V6 substrate).
- `scripts/lib/agent_roots.py` (the sibling-root resolver — every CEO-Agent script that needs to reach SunBiz-Agent imports from here).
- `scripts/_bridge_manifest.json` (bridge-side script discovery — multi-root aware).
- `ecosystem.config.js` for empire daemons (bravo-scheduler, bravo-telegram, claude-bridge, claude-bridge-ping, dashboard-email-consumer).

### Cron / automation separation (the 2026-05-28 leak fix)

**Empire (`public.cron_jobs`) vs Tenant (`public.tenant_cron_jobs`):**

- `public.cron_jobs` — empire-only. Seeded by `~/CEO-Agent/scripts/core/cron_engine.py` SEED_JOBS. Dispatched by `bravo-scheduler` (Windows-only). Visible on CC's OASIS `/automations` (operator-only via `isOperatorEmail` gate).
- `public.tenant_cron_jobs` — tenant-scoped. Seeded by per-tenant cron registries (`SunBiz-Agent/scripts/core/cron_registry.py` for SunBiz, similar for any future tenant). Dispatched by `claude-bridge-ping`'s tenant cron poller. Visible on `/t/<slug>/automations` ONLY.

**Hard rule — SunBiz cron entries MUST NEVER appear in CEO-Agent's `SEED_JOBS` array.** If you find one, delete it and re-home it in SunBiz-Agent's `cron_registry.py`. Three SunBiz rows leaked into `cron_jobs` between 2026-05-25 and 2026-05-28 (migration 069 era); rendered on CC's `/automations` under the "Bravo (CEO)" group; deleted + re-homed to `tenant_cron_jobs` on 2026-05-28.

**Defense-in-depth (so a future leak can't render visibly):** `oasis-command-center/app/api/cron-jobs/route.ts` defines `EMPIRE_AGENT_ALLOWLIST = {bravo, atlas, maven, aura}` and filters every empire row whose `inferEmpireAgentKey()` result isn't in the set. SunBiz/Solara/Helios rows that somehow land in `cron_jobs` will still be invisible to CC's UI. Run the `npm run test:sunbiz` suite plus a quick `/automations` smoke test after any change to `cron_engine.py` to verify.

### Operational protocol — when you touch SunBiz code

1. Edit + commit + push **in SunBiz-Agent**. That's the canonical home.
2. If the change is a new script that needs scheduled execution: add an entry to `~/SunBiz-Agent/scripts/core/cron_registry.py` and run `python scripts/core/cron_registry.py seed`.
3. If the change touches the multi-root resolver contract (script name, manifest key): update `~/CEO-Agent/scripts/lib/agent_roots.py` and `_bridge_manifest.json` in the same session.
4. Smoke-test from CEO-Agent: `python -c "from lib.agent_roots import resolve_sunbiz_root; print(resolve_sunbiz_root())"` should print the SunBiz-Agent path.

### Verification

```bash
# 1. No SunBiz daemons left orphaned in CEO-Agent
ls ~/CEO-Agent/scripts/follow_up_generator.py 2>/dev/null || echo "OK — relocated"
ls ~/CEO-Agent/scripts/daily_plan_generator.py 2>/dev/null || echo "OK — relocated"
ls ~/CEO-Agent/scripts/renewal_reminder.py 2>/dev/null || echo "OK — relocated"

# 2. SunBiz cron registry is in place
ls ~/SunBiz-Agent/scripts/core/cron_registry.py && echo "OK — registry exists"
python ~/SunBiz-Agent/scripts/core/cron_registry.py list

# 3. No SunBiz rows in the empire cron_jobs table
cd ~/CEO-Agent
.venv/bin/python scripts/integrations/supabase_tool.py select cron_jobs \
  --columns "name" | grep -i "sunbiz\|solara\|helios" || echo "OK — none leaked"

# 4. EMPIRE_AGENT_ALLOWLIST is in place in the dashboard
grep -n "EMPIRE_AGENT_ALLOWLIST" ~/oasis-command-center/app/api/cron-jobs/route.ts
```

All four checks should pass cleanly. Any failure indicates the leak prevention has regressed.
