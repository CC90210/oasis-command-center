# Email compliance classification — SunBiz outbound

**Purpose:** minimize the unsubscribe exposure merchants see to the legal floor, without hurting deliverability. This document records which sends carry a visible opt-out and why.

> **This is not legal advice.** The transactional-vs-commercial classification below is the load-bearing judgment; it should be reviewed by counsel. The classification only holds while the copy stays true to it (see "Guardrails").

## Governing law

- **CAN-SPAM (US) governs.** SunBiz is a US brand (sunbizfunding.com) emailing US merchants via US sending infrastructure (Gmail SMTP + Vercel). CASL's jurisdictional hook is a message "sent using a computer system located in Canada"; our sending infra is US, and even where CASL might reach, the CRTC foreign-bound-message exemption drops the s.6 unsubscribe requirement for mail accessed abroad that complies with the recipient country's law (CAN-SPAM). We comply with CAN-SPAM; CASL is not the controlling regime for these sends.
- **CAN-SPAM opt-out exemption:** email whose *primary purpose* is **transactional or relationship** is exempt from the opt-out requirement. Relevant categories: (1) facilitating, completing, or confirming a transaction the recipient **already agreed to enter into**; (3) providing account/loan/ongoing-commercial-relationship information.
- **Commercial email** (primary purpose = advertising/promotion) **requires** a working opt-out.
- **Gmail/Yahoo bulk-sender rules (2024, enforced Nov 2025):** a `List-Unsubscribe` header with RFC 8058 one-click, SPF/DKIM/DMARC, and spam-complaint rate < 0.3% (target < 0.1%). The header **reduces** spam complaints (recipients use it instead of "report spam") — so we keep it on **all** mail, including transactional.

## The rule we apply

| Class | Visible in-body footer | `List-Unsubscribe` header (hidden) |
|---|---|---|
| **Transactional / relationship** | **None** (not legally required) | **Kept** — one-click, protects inbox placement |
| **Commercial / promotional** | **Minimal** footer link (required) | Kept — one-click |

Rationale for keeping the header on transactional mail (Adon's call): the header is invisible in the body, cuts spam complaints, and keeps deliverability strong. Stripping it would forfeit that for no legal gain.

## Classification by send path

**Transactional** (drop footer, keep header) — merchant is in an application they started with us:

| Sequence (`drip_sequences.email_class = 'transactional'`) | Trigger stage |
|---|---|
| Inquiry Welcomer | hot_lead |
| Follow-up sequence | follow_up |
| Viewed application nudge | viewed_application |
| Sent application — 24h reminder | sent_application |
| Missing info — chase + book call | missing_info |
| Signed application — bank statements nag | signed_application |
| Submitted — underwriting wait | submitted |

Also transactional (relationship): submissions@ direct rep 1:1 email, shop-out to lenders, forms next-steps / completion / e-sign.

**Commercial** (keep minimal footer + header) — re-soliciting a cold/dead/ghosted lead, or pure outreach:

| Path | Notes |
|---|---|
| Declined — 1-month check-back (`email_class = 'commercial'`) | re-engaging a dead lead |
| Default — 60-day soft check-in (`commercial`) | re-solicitation |
| Cold outreach (`lib/integrations/cold-sending.ts`) | pure prospecting; postal address + reply-STOP in `COLD_FOOTER`, one-click header |
| Constant Contact blasts | CC-managed footer + unsubscribe |
| Ghost re-engage, "new-month better offer" (when built) | commercial |

## How it's enforced (code)

- `drip_sequences.email_class` (migration 119) drives the drip executor: `lib/drips/executor.ts` passes `unsub: email_class === 'transactional' ? 'none' : 'footer'` to `buildTrackedHtml` (`lib/email/tracked-html.ts`). `unsub:'none'` omits the visible footer; the `List-Unsubscribe` header is still emitted for both classes.
- One-click: the `List-Unsubscribe` header points at **`/api/unsubscribe`** (not the `/unsubscribe` page), which accepts the RFC 8058 one-click POST (email/brand/token in the query, `List-Unsubscribe=One-Click` body). The visible footer link still points at the human `/unsubscribe` page.

## Guardrails

- **Transactional copy must stay non-promotional.** A promotional pitch ("get funded fast, best rates") in an otherwise-transactional email flips its primary purpose to commercial under the CAN-SPAM test, which would require an opt-out. Keep transactional emails focused on the application step (the missing item, the next action). "Missing info — chase + book call" in particular must chase the item, not pitch.
- **Never remove the opt-out on commercial mail**, and never break the one-click endpoint. `checkEmailSuppressed` stays fail-closed on every path; suppressions are honored within 48h.
- **Re-review on any new sequence** — set its `email_class` deliberately (default is `commercial`, so a new sequence never silently loses its opt-out).
