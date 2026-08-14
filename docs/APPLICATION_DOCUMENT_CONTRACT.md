# The generated application — what a lender sees, and what they don't

**Status:** live. Enforced by `tests/application-disclosure.test.ts` and `tests/application-pdf-rendered.test.ts` in the `test:sunbiz` chain.
**Registry:** `lib/forms/application-disclosure.ts`
**Address rule:** `lib/address/us-address.ts`

---

## The problem this solves

The generated application (`doc_type: "final_application_form"`) is **one artifact with two audiences**. The merchant signs it; the lender receives it. Shop-out attaches every document on the deal by default, and the watermark guard brands only bank statements (`lib/lead-documents.ts`), so this PDF reaches a funder exactly as rendered.

That makes two questions load-bearing, and until 2026-08-13 the answers lived only in scattered code comments:

1. **What must never appear on it?** Merchant contact details, because a funder who can reach the merchant directly can go around the broker.
2. **What must always appear on it, in full?** The addresses, because a lender cannot underwrite a business it cannot locate.

Both had regressed. The email was printing. Nearly half of all business addresses were printing without a ZIP.

## Rule 1 — contact details are withheld

Declared in `lib/forms/application-disclosure.ts`. Today: **phone** (Ezra, 2026-06-24) and **email** (Ezra, 2026-08-13).

> "There's no phone number in the actual application PDF so I want the same thing for email address. It used to be like that." — Ezra, relayed by Adon, 2026-08-13

**This is not deletion.** Adon, same conversation: *"the emails need to stay."* The email and phone remain on the lead and application records and everywhere in the CRM. The registry governs one thing: what is **printed**. Redaction happens at render time only, and `tests/application-pdf.test.ts` asserts the email is still on the source record afterwards.

**The label stays, the value goes.** A withheld field still renders its labelled cell, so the document keeps its shape. Dropping the row would reflow the two-column grid and change the document.

### Why a registry instead of another `value: ""`

The phone rule was implemented as hardcoded blanks at four sites plus one type check — six places, no single source of truth, and a sibling renderer (`lib/forms/fundmate-pdf.ts`) had grown its own separate copy of the same intent. Adding email that way would have meant finding all six again, and a missed site is a silent leak of exactly the data we promised to withhold.

**To hide a new field:** add one entry to `REDACTED_FIELD_TYPES` (by form field type) or `REDACTED_ROW_LABELS` (by printed label), with a reason, who asked, and the date. Run `npm run test:sunbiz`. Nothing else — do not add a `value: ""` anywhere.

**To unhide a field:** delete its entry. That is the whole change.

Both mappers honour the registry: the form-driven one production runs, and the legacy one used whenever the tenant's `forms` row is unreadable. A rule honoured by only one of them is a leak waiting for a bad database read.

### FundMate is deliberately separate

`lib/forms/fundmate-pdf.ts` keeps its own suppression because it has a **different threat model**: that document is read by other brokers on a shared FundMate account (Adon, 2026-06-23), not by a named lender. The two policies must be able to diverge without one silently changing the other.

## Rule 2 — an address is never printed partial, and never captured partial

One implementation, `lib/address/us-address.ts`, used by every address on the document: business, owner home, partner home.

> "In the actual PDF, to include the address, it doesn't make them have to put in the city, state, and ZIP Code. Some people literally just put their street name and I'm like, 'Where the fuck do you live bro?'" — Adon, 2026-08-13

Measured on production the same day: of 1,051 application records carrying a business address, **514 had no ZIP**, and 391 of those had no state either — bare lines like `"7930 Snow View Drive"` going out to funders.

### Two different thresholds, on purpose

| | Requires | Used for |
|---|---|---|
| `isAcceptableCaptureAddress` | street + state + ZIP | **Blocking** a submission or an operator edit |
| `addressCompleteness` | street + city + state + ZIP | **Advising** — naming what is still missing |

The gate does **not** require a city, and that is deliberate. The city is the one part that cannot be parsed reliably: without a comma to mark the boundary, `"123 Main Street Miami Florida 33101"` resolves its state and ZIP correctly and still yields no city, because "Miami" is indistinguishable from more street. Gating on that would reject a real address and kill a live funding application — the worst failure this feature could have. `tests/us-address.test.ts` pins that case as a must-accept.

### Where it is enforced

- **Merchant form** — `app/api/forms/submit/route.ts` (authoritative, fail closed) and `components/forms/FormPublicClient.tsx` (inline message). Checked before the `required` guard, so an optional address may be blank but a filled one must be real.
- **Operator edit** — `components/applications/ApplicationEditForm.tsx`, on **changed fields only**. ~1,000 existing records carry a partial address; re-validating them would block an operator from editing an unrelated field on a record they did not break. An address they actually touch must come out complete, so editing can only improve the data.
- **Render** — both mappers compose the most complete line available. Nothing is invented: the module fills a part only when it can identify it.

### What is deliberately NOT done

**The PDF does not annotate what is missing.** An earlier design printed `[ZIP not provided]` on the document. That tells a funder SunBiz failed to collect basic data, which is worse for the deal than the partial line it replaces. Incompleteness is surfaced to the **operator**, never to the lender.

**Historical records are not backfilled.** 391 addresses have no recoverable city or ZIP anywhere in the system — lead records don't have them either, because the form never asked. They need operator entry or external enrichment, which is a separate decision.

## Verification

`tests/application-pdf-rendered.test.ts` renders a real PDF and extracts its text with pdfjs, then asserts on **what is actually on the page** rather than on mapped row objects. Everything else in this area asserts one step short of the truth — which is exactly how an email stayed visible on the document while the tests were green.

Both guards are proven to fire: removing a registry entry makes the rendered test report the email at its real position on the page.

## Related

`docs/PORTALS.md` (same registry + contract + enforcing-test pattern) · `docs/BUILD_ACCEPTANCE_STANDARD.md`
