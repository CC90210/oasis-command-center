# Text Torrent inbound webhook — setup runbook

**Goal:** get real-time inbound SMS (merchant replies) pushed from Text Torrent into oasis, instead of relying on the 30-minute poller (`/api/cron/sync-tt-inbox`).

**Status today:** the webhook is *coded and sound* but **not delivering** — either Text Torrent isn't configured to call it, or the signature it sends doesn't match what oasis expects (oasis fails closed → 403). Until it's fixed, the poller is the fallback (up to ~30 min latency, and it only ingests a thread once it's been read).

---

## 1. What oasis expects (exact, from the code — do not guess)

| Item | Value |
|---|---|
| **Method + URL** | `POST https://oasisai.work/api/webhooks/texttorrent/sms-inbound` |
| **Signature header** | `X-TT-Signature` |
| **Signature value** | `base64( HMAC-SHA256( rawRequestBody, TEXTTORRENT_WEBHOOK_SECRET ) )` |
| **Secret** | oasis env var `TEXTTORRENT_WEBHOOK_SECRET` (Vercel) — must equal the secret TT signs with |
| **Body (JSON) fields read** | `from` (prospect number), `to` (our TT DID), `message` **or** `body` (text), `message_id` **or** `messageid` (optional, for idempotency), `chat_id` (optional), `received_at` (optional) |

- The real prod URL is `${PUBLIC_APP_URL}/api/webhooks/texttorrent/sms-inbound`. Confirm `PUBLIC_APP_URL` in Vercel (prod is `https://oasisai.work`; the raw Vercel alias `https://agent-dashboard-cc90210.vercel.app` also works but is less stable — prefer the custom domain).
- oasis resolves the tenant by matching `to` against the **sending DIDs on file** (tenant default number + each rep's own number). Those are already stored, so any of your TT DIDs as the destination will resolve. A `to` that matches nothing still returns `200` (and still runs STOP-suppression) but writes no row.
- **Fails closed:** missing `X-TT-Signature`, unset `TEXTTORRENT_WEBHOOK_SECRET`, or a signature mismatch → **403** and nothing is stored. This is the most likely reason "it isn't delivering."

---

## 2. Set the shared secret in oasis (do this first)

**In the Vercel dashboard** (project `agent-dashboard`, Settings → Environment Variables), for **Production**:

```
TEXTTORRENT_WEBHOOK_SECRET = <generate a long random string>
```

Generate one **in a regular terminal**:
```bash
openssl rand -hex 32
```
Redeploy prod so the env var is live (env applies at deployment creation).

---

## 3. Register the webhook in the Text Torrent dashboard

**In the Text Torrent web dashboard** (app.texttorrent.com), find the inbound/notification webhook settings (look under Settings → Integrations / Webhooks / Notifications — TT's exact label may differ; there is **no API to configure this**, it is a dashboard task):

1. Add / enable an **inbound SMS** (message-received) webhook.
2. **Payload URL:** `https://oasisai.work/api/webhooks/texttorrent/sms-inbound`
3. **Method:** POST, content-type `application/json`.
4. **Signing secret:** paste the same value you set for `TEXTTORRENT_WEBHOOK_SECRET`.
5. Confirm TT signs the body as **HMAC-SHA256, base64-encoded**, sent in a header named **`X-TT-Signature`**.

> ⚠️ **Compatibility check — the make-or-break step.** oasis requires that *exact* scheme (HMAC-SHA256 → base64 → `X-TT-Signature`). If TT's webhook feature:
> - lets you set the header name + HMAC algorithm → set them to match above. Done.
> - signs differently (hex instead of base64, a different header name, or a different algorithm) → **tell me the exact scheme TT uses** and I'll adjust `verifyTextTorrentSignature` in `app/api/webhooks/texttorrent/sms-inbound/route.ts` (one small function) to match it.
> - can't sign at all, only send a static header/query secret → I'll switch the verifier to a constant-time compare of that shared secret instead of HMAC. Also a one-line change.

---

## 4. Verify it's actually delivering

**After configuring, send yourself a test:** text one of your TT DIDs from a phone, then check:

- **Vercel logs** (Deployments → Functions → `/api/webhooks/texttorrent/sms-inbound`): a **`200`** with `{ ok: true, lead_id, tenant_id }` = working. A **`403 Forbidden`** = signature/secret mismatch (revisit steps 2–3). A `200` with `{ ignored: "no_tenant_mapping" }` = the `to` DID isn't registered in oasis integration creds.
- The reply should appear in **Conversations** within seconds (vs up to 30 min via the poller).

**Manual signature test in a terminal** (proves oasis accepts a correctly-signed call, independent of TT):
```bash
SECRET='<your TEXTTORRENT_WEBHOOK_SECRET>'
BODY='{"from":"+15555550123","to":"<one-of-your-TT-DIDs>","message":"webhook test"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -sS -X POST https://oasisai.work/api/webhooks/texttorrent/sms-inbound \
  -H 'Content-Type: application/json' -H "X-TT-Signature: $SIG" -d "$BODY"
```
Expect `{"ok":true,...}`. If that works but real TT deliveries 403, the mismatch is on TT's signing side (step 3 compatibility).

---

## 5. Why bother (webhook vs poller)

- **Webhook (real-time):** merchant replies land in Conversations in seconds, for **every** rep's DID, read or unread.
- **Poller (`/api/cron/sync-tt-inbox`, fallback):** every 30 min, and it **skips unread chats** on purpose (so it never steals the live Jordan agent's new-reply signal) — meaning a brand-new reply to a non-Jordan rep isn't ingested until the thread is read. Fine as a backstop; not real-time.

Keep the poller running even after the webhook works — it's the safety net for any webhook delivery TT drops.
