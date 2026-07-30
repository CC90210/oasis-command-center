# Email domain cutover: oasisai.work to Bluerise Business Capital

**Context (Adon, 2026-07-29):** Bluerise Business Capital is a new funding brand
with its own site at `bluerisebusinesscapital.com`. That domain is mid-warmup and
needs roughly 5 more days before drips and the bulk of the email sequences move
onto it. Until then SunBiz keeps sending. The main Bluerise website is NOT moving
to Vercel and does not need to.

This document exists so the cutover is a checklist rather than a rediscovery.

---

## The three kinds of link in an outbound email

They get conflated constantly, and they have different constraints. Only one of
them is free to point anywhere.

| # | Kind | Examples | Must it be served by the app? |
| --- | --- | --- | --- |
| 1 | **Destination / CTA** | "Apply now", "Learn more" | **No.** Can point at any website. |
| 2 | **Per-lead application link** | `data.application_url`, the resumable app | **Yes.** It is an app route carrying a signed lead id. |
| 3 | **Tracking + compliance** | open pixel, click wrapper, unsubscribe | **Yes.** They are app routes. |

Kinds 2 and 3 are the reason a hostname pointing at the app is unavoidable. An
unsubscribe link that does not reach the app does not record the opt-out, which
is a compliance failure, not a cosmetic one.

**This does NOT mean moving the website to Vercel.** It means one subdomain, for
example `go.bluerisebusinesscapital.com`, is added to the existing Vercel project
and CNAME'd to it. `bluerisebusinesscapital.com` itself stays exactly where it is
hosted, serving the marketing site, untouched.

---

## What can change today, with no Vercel and no code

`DRIP_INTAKE_URL` controls the generic CTA destination (kind 1). It is already an
environment variable. Point it wherever the funnel should start:

```
DRIP_INTAKE_URL = https://bluerisebusinesscapital.com/apply
```

That removes the most visible `oasisai.work` reference, the button merchants
actually click, without touching DNS, the app, or the code.

Caveat worth knowing: leads that already have a per-lead `application_url` keep
using it, because that link resumes their in-progress application. Only leads
without one fall back to `DRIP_INTAKE_URL`.

---

## What should wait for the cutover, and why

The tracking and unsubscribe origin (`DRIP_TRACKING_BASE_URL`) should be moved
**once**, at the Bluerise cutover, rather than to a SunBiz subdomain now.

Two reasons:

1. **A tracking domain accumulates its own reputation.** Moving it starts that
   history over. Doing it twice inside a week is worse than doing it once, and
   the second move would land during Bluerise's warmup.
2. Any `go.sunbizfunding.com` set up now is thrown away in 5 days.

Until then, drip links stay on `oasisai.work`. That is the status quo, not a
regression.

---

## Preflight: run this before and after the cutover

```
node scripts/verify-email-domain.mjs
```

Read-only, no sends, no secrets printed. Flags override the environment so the
cutover can be rehearsed from a laptop:

```
node scripts/verify-email-domain.mjs \
  --from funding@bluerisebusinesscapital.com \
  --tracking https://go.bluerisebusinesscapital.com \
  --intake https://bluerisebusinesscapital.com/apply
```

It checks SPF, DKIM and DMARC on the sending domain, whether the tracking origin
actually aligns with the visible sender, and whether the tracking host is really
attached to this Vercel project (a host that resolves but 404s on
`/api/unsubscribe` means dead unsubscribe links). Exit 1 on any failure.

**Measured 2026-07-29, before any cutover work:**

| Domain | SPF | DKIM | DMARC |
| --- | --- | --- | --- |
| sunbizfunding.com | pass | pass | `p=none`, **no `rua=`** |
| bluerisebusinesscapital.com | pass | pass | `p=none`, **`rua=` present** |

Bluerise is already correctly authenticated, and better configured than SunBiz:
it has a reporting address, so aggregate DMARC data will actually arrive. Nothing
is blocking the cutover on the DNS side.

---

## The one genuinely dangerous setting

`DRIP_SUPPRESSION_BRAND` (default `SunBiz`).

`/api/unsubscribe` resolves that string to a tenant (`tenants.name ILIKE`) when
it RECORDS an opt-out. If it matches no tenant, the suppression row is written
with `tenant_id = NULL`, and `checkEmailSuppressed` filters by `tenant_id`, so
the opt-out is never honored. The unsubscribe appears to work and the merchant
keeps receiving mail.

Two mitigating facts, verified 2026-07-29:

- Enforcement keys on `(tenant_id, email)` and does not consult the brand, so
  **every suppression recorded before the rebrand keeps working.**
- The value deliberately does NOT follow `DRIP_FROM_ADDRESS`. Changing who mail
  is from cannot silently repoint where opt-outs are filed.

**Decide explicitly before go-live:** if Bluerise sends as its own tenant, set
this to that tenant's exact name. If it sends under the existing tenant, leave it
alone. Confirm against the database either way.

---

## Cutover checklist (day 5, once warmup completes)

**In the DNS host for bluerisebusinesscapital.com:**

1. Create `go.bluerisebusinesscapital.com` as a CNAME pointing at Vercel.
   The apex domain and `www` stay pointed at the existing marketing site.

**In the Vercel project (oasis-command-center):**

2. Domains, add `go.bluerisebusinesscapital.com`. This attaches a hostname to the
   existing app. It does not move or affect the marketing site.
3. Environment variables:
   - `DRIP_FROM_ADDRESS = funding@bluerisebusinesscapital.com` (the real mailbox)
   - `DRIP_TRACKING_BASE_URL = https://go.bluerisebusinesscapital.com`
   - `DRIP_INTAKE_URL = https://bluerisebusinesscapital.com/apply` (or wherever
     the funnel should start)
   - `DRIP_SUPPRESSION_BRAND` — only if Bluerise is a separate tenant. See the
     warning above; getting this wrong breaks opt-outs silently.
4. Redeploy so the new values are picked up.

   Setting `DRIP_FROM_ADDRESS` moves the From address, the `List-Unsubscribe`
   mailto and the synthesized `Message-Id` domain together, because all three
   derive from it. That mattered: before this they were three separate literals in
   three files and would have kept saying `sunbizfunding.com` on Bluerise mail.

   Note the per-tenant mailbox lookup (`getSubmissionsFrom`) still wins at send
   time when it resolves, so the actual sending mailbox credentials are configured
   where they always were; `DRIP_FROM_ADDRESS` is the identity everything else is
   derived from.

**Before the first real send from the new domain:**

5. Confirm `bluerisebusinesscapital.com` has SPF, DKIM and DMARC published. The
   sending domain changing means its authentication has to exist independently of
   sunbizfunding.com. Advisory, but a send from an unauthenticated domain during
   warmup is an expensive mistake.
6. Confirm the From address moves at the same time. If the From becomes Bluerise
   while links stay on `oasisai.work`, the original mismatch is simply rebuilt
   under a new brand.

**Verify:**

7. Send one drip to a seed address. Check that the unsubscribe link, the tracking
   pixel and the CTA all resolve to Bluerise hosts, and that clicking unsubscribe
   actually records the suppression.

---

## Safety properties already built in

- **Unset is the status quo.** With `DRIP_TRACKING_BASE_URL` unset, every URL
  behaves exactly as it does today. The code is already merged-safe.
- **Invalid values fall back rather than break.** A malformed origin resolves to
  the platform origin instead of emitting dead links in live mail.
- **The click allowlist reads the same variable**, so a link minted on the new
  host is never downgraded to the safe default.
- **Cold outreach is unaffected.** It stays on the platform origin by design so
  its domain reputation remains isolated from the drip sending domain.
- **Sends record the origin they used.** `metadata.tracking_base` stores the
  resolved origin per message, so telemetry rebuilt after the cutover still
  reconstructs pre-cutover messages correctly.

---

## Naming note

The variable is `DRIP_TRACKING_BASE_URL`, keyed to the sending PATH rather than
to a brand. That is deliberate: the sending brand is changing, and a brand-keyed
name would have made this rebrand a code change instead of a config change.
