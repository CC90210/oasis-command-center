# Email authentication setup — sunbizfunding.com (for Conaugh / CC)

**Why this matters (30 seconds):** our automated follow-up emails send from
`submissions@sunbizfunding.com`. A live check on 2026-07-14 found the domain is
**missing DKIM** and has DMARC set to monitor-only. Without DKIM, Gmail/Yahoo
treat our mail as weakly authenticated, which sends more of it to spam and, at
volume, can get the whole domain flagged. The fix is ~10 minutes in the Google
Admin console + DNS. Nothing here touches money, deals, or customer data.

There are **3 records**. SPF is already done. You need to add **DKIM** and
upgrade **DMARC**.

---

## 1. Turn on DKIM (Google Admin console) — the important one

1. Go to **admin.google.com** → **Apps** → **Google Workspace** → **Gmail** →
   **Authenticate email**.
2. Select the domain **sunbizfunding.com**.
3. If it shows "Generate new record": set **DKIM key bit length = 2048**,
   prefix/selector = **google** (the default), click **Generate**.
4. Google shows you a **DNS TXT record** — a host name and a long value starting
   `v=DKIM1; k=rsa; p=...`. Copy both. (Leave this tab open.)
5. Publish it in DNS (wherever sunbizfunding.com's DNS is managed — GoDaddy /
   Cloudflare / Namecheap / etc.):

   | Type | Host / Name | Value |
   |------|-------------|-------|
   | TXT | `google._domainkey` | *(paste the exact value Google gave you — starts `v=DKIM1; k=rsa; p=…`)* |

6. Back in the Admin console, click **Start authentication**. (It may say
   "cannot find record" for up to an hour while DNS propagates — that's normal;
   click it again later.)

## 2. Upgrade DMARC (DNS) — add reporting

Replace the current `p=none` DMARC record with this (adds a reports mailbox so
we can watch for problems). If `dmarc-reports@sunbizfunding.com` doesn't exist,
use any inbox you check, or create the alias.

| Type | Host / Name | Value |
|------|-------------|-------|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@sunbizfunding.com; adkim=r; aspf=r; pct=100` |

(We keep `p=none` for now — monitor only, zero delivery risk — and tighten it
over the next ~90 days once reports look clean. See "Later" below.)

## 3. SPF — already correct, just confirm

There should already be one TXT record at the root (`@` / `sunbizfunding.com`):

```
v=spf1 include:_spf.google.com ~all
```

If it's there, do nothing. **Don't add a second SPF record** (two SPF records
breaks authentication). If you also send through another service later, add its
`include:` into this same line.

---

## How to confirm it worked

From anyone's terminal (no login/secrets needed):

```
node scripts/verify-email-auth.mjs
```

It prints PASS/FAIL for SPF, DKIM, DMARC. All three PASS = done. (Or check any
free "MXToolbox DKIM lookup" for `google._domainkey.sunbizfunding.com`.)

Tell Adon/APEX once it's green — that's the signal to start ramping the drip
email volume.

---

## What you do NOT need to do

- **One-click unsubscribe** (the Gmail/Yahoo requirement) is handled in our
  code, not DNS — no action for you.
- No changes to the sending mailbox, passwords, or the app itself.

## Later (APEX will drive this, ~over 90 days)

Once DMARC reports show our real mail passing, we step the policy up for
stronger protection: `p=none` → `p=quarantine` (pct 10→100) → `p=reject`. That's
a series of small DNS edits APEX will hand over one at a time — no rush, and
nothing else changes.
