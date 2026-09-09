---
title: The OASIS booking link
date: 2026-09-09
tags: [oasis, booking, email, marketing, runbook]
---

# The booking link

Everything that says "pick a time" reads ONE value. There is no hardcoded
fallback any more, on purpose.

## What broke (2026-09-09)

`https://calendar.app.google/tpfvJYBGircnGu8G8` was hardcoded as the default in
two modules. That appointment schedule had been deleted. Rendering it gives:

> **Appointment not found** — The appointment may have been deleted or the link
> may be incorrect

It was live in three places at once:

| Surface | What the prospect saw |
|---|---|
| Rep's quick email (pipeline) | "grab a 15-minute slot here" → error page |
| Qualified-lead booking email (automatic) | "Pick a time that works here" → error page |
| Public site `/contact` and `/work` | "Book a call" / "Pick a time" → error page |

**Nothing detected it, and one check actively hid it.** `smoke-website-sales.ts`
asserted the URL *started with* `https://calendar.app.google/` — which stayed
true the entire time the page behind it was dead. A shape check cannot tell you
whether anyone can book.

## Setting a working link

1. In Google Calendar (the account that should own the bookings), open
   **Create → Appointment schedule**, set the availability, and save.
2. Open the schedule and copy its **public booking link**.
3. Set it on the Vercel project (`agent-dashboard`) as
   `NEXT_PUBLIC_BOOKING_URL`, for Production and Preview, then redeploy.
   It is `NEXT_PUBLIC_` because the public marketing pages read it at build
   time; the other three keys below are legacy aliases, still honoured.
4. **Verify it before it reaches anyone** — see below.

Resolution order (`lib/booking-link.ts`), first non-empty wins:

```
NEXT_PUBLIC_BOOKING_URL
NEXT_PUBLIC_FOUNDER_BOOKING_URL
OASIS_FOUNDER_BOOKING_URL
BOOKING_LINK
```

## Verifying

**An HTTP request cannot tell you if a booking link works.** Google returns
`200 OK` with a 42KB JavaScript shell for a deleted schedule and renders
"Appointment not found" client-side. The served HTML does not contain that
string. Any curl-based or fetch-based health check will report a dead link as
healthy — that is not a gap in the checker, it is the wrong instrument.

Verify by **rendering** it: open the link in a browser (or drive it headlessly)
and read what is on the page. If it shows a month grid with selectable times,
it is live. If it shows "Appointment not found", it is not.

## What happens with no link

Absent is a supported state, not a broken one. Every surface degrades to
something that still works:

- **Rep's quick email** — asks the prospect to reply with a couple of times
  ("Fifteen minutes is plenty"). A reply books a meeting just as well as a
  calendar page does.
- **Qualified-lead email** — same ask, and the subject changes to
  "when suits you?" instead of "pick a time".
- **`/contact`** — the "Book a call" card is not rendered; the email card is.
- **`/work`** — "Book a call instead" is not rendered; "Start the audit" is.

## The retired URL is refused by name

`RETIRED_BOOKING_URLS` in `lib/booking-link.ts` contains the dead address. Even
if it is set in an env var it resolves to "". It is the most likely value for
someone to paste back while fixing this — it is in git history, in sent emails,
and in whatever note it gets copied from — and refusing it means that restore
fails loudly instead of quietly resuming the outage.

Remove it from that list only when the link is verified working again.

Pinned by `tests/lead-quick-email-delivery.test.ts`.
