# Changelog

## 2026-10-15 — Funnel wiring: sales desk alerts, resume link, honest redirects

### Added
- New-lead alerts (started, completed, call booked, offer-page lead) go to the **sales desk**, a Telegram group CC and Adon both read, through a new `sales` lane reached only via `pushWorkspaceAlert(tenant, text, { desk: "sales" })`. With `OASIS_SALES_TELEGRAM_CHAT_ID` unset the lane delivers to CC's chat as before; a group the bot was removed from falls back to CC's DM in the same lane and says what to fix.
- Alerts read "unbooked - needs follow-up" until a time is picked, show a booked call in Toronto time, and link the lead in Command Center.
- The audit confirmation email carries a signed link (`/f/oasis-ai-cc/ai-audit/<token>?book=1`) that reopens the inline calendar for a lead who finished the form and closed the tab. The free-community invitation rides the same email only when email marketing consent was ticked for that address.
- Lead page: a Funnel band (stage, booked call with Meet link or "Unbooked", budget, timeline, campaign, keyword, offer) and readable revenue / team labels. Leads also store `budget`, `timeframe` and `phone_e164` (the canonical form, beside the phone as typed).
- Sales department: an "Inbound leads" tile for the warm-inbound queue (untouched vs booked), for the viewers who already see that queue.
- Migration `bravo__224` adds `call_appointments.offer_label` so a booking keeps the offer's name across retries and reschedules.

### Changed
- `/vsl` is a temporary (302) redirect decided on every request: the router form when it is live, the AI audit otherwise, query string (utm_*, kw, cat, gclid) carried through. It replaces the 10-12 permanent redirect, which sent ad traffic to a disabled draft and would have been cached by browsers for good.
- A bare `/go/community` no longer 404s: it defaults to OASIS's audit funnel, logs the click even with no visit id (server-made id, no IP), records `?from=`, and still reaches the lounge if the form is switched off.

### Fixed
- `offer-pages-access` pinned a 2026-10-08 timestamp against a 7-day freshness window and went red for every PR on 2026-10-15.

## 2026-10-12 — OASIS funnel capture and inline founder booking

### Added
- AI Audit, COMMAND, and FLEET funnel completions can reveal live CC-and-Adon availability inline, create a verified Google Meet event, and mirror the appointment into Command Center Schedule.
- Funnel submissions now carry explicit `inbound_lead`, `audit_requested`, and `meeting_booked` lifecycle receipts, plus durable Sales events and `calendar_booking` interactions.
- Turso migrations `bravo__222` and `bravo__223` link Schedule rows to their provider receipt and serialize every active OASIS founder interval, including overlapping 45-minute calls on the 30-minute grid.

### Fixed
- Public funnel answers now normalize revenue band, website, team size, bottleneck, and current tools into the CRM lead record and expose them in Pipeline detail.
- The audit form includes current tools, `/vsl` resolves to the live OASIS router, and the unbooked community fallback keeps its tracked save-basin event.
- Public booking duration now follows the offer: 15 minutes for AI Audit and 45 minutes for COMMAND/FLEET discovery calls.

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
