# Changelog

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
