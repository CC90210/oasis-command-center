# Changelog

## 2026-09-16 — Complete automation inventory and verified controls

### Added
- Scheduled-job cards now show the scheduler's next run and successful last result.
- Automation toggles now commit the scheduler flag, authoritative readback, and before/after audit receipt in one transaction on both Turso and the explicit legacy rollback backend.
- Ledger-safe Turso migrations 108 and 110 ship the durable owner column plus complete Bravo, Atlas, Maven, and Aura reconciliation; migration 174 adds the service-role-only atomic toggle RPC required before selecting the retired Supabase rollback lane. Their canonical operations copies live in CEO-Agent.

### Fixed
- CC's canonical operator login can no longer be shadowed by a configured legacy email alias, restoring all Empire jobs to `/automations`.
- Empire inventory failures now surface as errors instead of returning a plausible tenant-only list.
- Empire toggle lookup, update, and readback are tenant-scoped; the UI only reports success for the authoritative returned state.
- Tenant booleans and JSON-shaped run results are normalized before rendering, so SQLite values cannot create false toggle failures or blank the inventory.
- Agent catalogue cron highlights now name registered Bravo, Atlas, and Maven jobs instead of stale or fictitious schedules.

## 2026-09-14 — OASIS sales operations refinement

### Changed
- Website Starter now uses the $500 setup and $150 monthly entry offer, with rep compensation calculated from fully collected setup revenue at 15% to open, 25% to close, or 35% to source and close.
- Leads is the unassigned prospect pool; claiming or assigning a qualified prospect moves it into Pipeline at Assigned with a verified sales owner.
- Background workers are grouped by where they run and whether the dashboard can control them.

### Fixed
- Verifying the full setup payment now marks the lead Won and creates the matching accrued commission ledger entries as one guarded operation.
- Today and Commissions use the same tenant-scoped attribution and direct-report rules, including complete outstanding balances and separate currencies.
- Paid, founder-handoff, and delivery records can no longer expire back into the prospect pool when an old claim timestamp ages out.
- Email fallback reservations cannot be drained by a worker while the portal is attempting the same direct send.

### Security
- OASIS worker inventory, health records, rep rosters, pipeline reads, and commission reads are isolated by exact tenant and automation profile.

## 2026-07-21 — Leads, Applications, and merchant intake

### Added
- Merchants can include an optional website URL in the full funding application.
- Lead and application detail drawers have a draggable, collapsible summary area above Activity, Owner, Lenders, Bank, BGC, Docs, and Notes.

### Fixed
- Declining a lead from its detail drawer transfers it into the Applications pipeline at Declined instead of leaving it on the Leads board.
