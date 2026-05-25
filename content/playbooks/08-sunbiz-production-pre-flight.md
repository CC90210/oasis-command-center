---
title: SunBiz production pre-flight
audience: empire-operator
status: current
last_updated: 2026-05-25
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

6. **Ezra connects JotForm + Twilio** under Settings → Integration keys. Inbound forms + outbound SMS / email.

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
