# Connecting every rep's calendar without anyone clicking anything

**Who does this:** a Google Workspace **super-admin** on the domain (CC).
**How long:** about five minutes, once. New hires are covered automatically after that.

## What problem this solves

Reps schedule follow-ups on a lead. Those follow-ups only reach the phone in
their pocket if their Google Calendar is connected. There are two ways to get
there:

1. **Each rep clicks Connect** in Settings → Integrations. Works today, needs no
   setup, but it is on you to notice who never did it. A rep who skips it gets
   no phone reminders and nothing looks broken.
2. **Domain-wide delegation** (this document). One authorisation covers everyone
   on the domain, forever, including people who join later. No rep ever sees a
   connect screen.

Both can run at once. A rep's own connection always wins; delegation only fills
in for people who have not connected.

## What it is NOT

> **App passwords cannot do this.** An app password authorises IMAP and SMTP
> only. The Google Calendar API accepts OAuth bearer tokens and nothing else, so
> no app password will ever connect a calendar no matter where it is pasted.
> If someone is generating app passwords for calendar access, that effort is
> wasted. Settings says so on the page, at the point of confusion.

## Before you start: what you are granting

The service account will be able to **create, edit and delete calendar events as
any user on the domains you list**. That is genuinely powerful, so:

- the scope granted is `calendar.events` **only**, not full `calendar`. It cannot
  read or change calendar settings, sharing, or ACLs.
- the code refuses to act as any address whose domain is not in
  `GOOGLE_DWD_DOMAINS`, matched on the **full** domain. A lookalike domain such
  as `evil-oasisai.work` does not pass a check for `oasisai.work`.
- the private key is a secret. It goes in the environment, never in git.

## Step 1 — create the service account (Google Cloud Console)

1. Open the Google Cloud project that owns the app's OAuth client.
2. **APIs & Services → Library →** enable **Google Calendar API** if it is not
   already on.
3. **IAM & Admin → Service Accounts → Create service account.**
   Name it something recognisable, e.g. `oasis-calendar-reminders`.
   It needs **no project roles**. Its power comes from the domain grant, not IAM.
4. Open the new service account → **Keys → Add key → Create new key → JSON.**
   Download it. This is the only copy.
5. On the service account's **Details** tab, copy the **Unique ID** (a long
   number). That is the "Client ID" the admin console asks for in step 2.

## Step 2 — authorise it on the domain (Google Admin Console)

Must be done by a **super-admin** at [admin.google.com](https://admin.google.com).

1. **Security → Access and data control → API controls.**
2. Under *Domain-wide delegation*, click **Manage domain-wide delegation**.
3. **Add new.**
4. **Client ID:** the Unique ID from step 1.5.
5. **OAuth scopes:** exactly this, and nothing more:
   ```
   https://www.googleapis.com/auth/calendar.events
   ```
6. **Authorise.**

Grants can take a few minutes to propagate. A `unauthorized_client` error
straight after saving usually means "wait a moment", not "wrong client id".

## Step 3 — set three environment variables

In the Vercel project (Production, Preview and Development as appropriate):

| Variable | Value |
|---|---|
| `GOOGLE_DWD_CLIENT_EMAIL` | the service account address, e.g. `oasis-calendar-reminders@<project>.iam.gserviceaccount.com` |
| `GOOGLE_DWD_PRIVATE_KEY` | the `private_key` field from the JSON key file. Escaped `\n` is fine; the code unescapes it |
| `GOOGLE_DWD_DOMAINS` | comma-separated domains it may act for, e.g. `oasisai.work` |

**All three are required.** With any one missing the feature is simply off, and
reps fall back to connecting themselves. It never half-works.

Redeploy so the running app picks the variables up.

## Step 4 — prove it works before trusting it

```
node scripts/dwd_check.mjs rep@oasisai.work
```

It mints a delegated token, creates a throwaway event on that person's calendar,
reads it back, deletes it, and prints what happened. It cleans up after itself.

Run it against **one real rep** before telling the team reminders are live.
A green run is the evidence; the presence of the variables is not.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `unauthorized_client` | The client ID or the scope in step 2 does not match, or the grant has not propagated yet |
| `invalid_grant` | The address does not exist on the domain, or the key is wrong |
| `not_delegatable` | The address's domain is not in `GOOGLE_DWD_DOMAINS`. This is the guard doing its job |
| `not_configured` | One of the three variables is missing or empty |
| Reminders still absent for one rep | That rep may have their own broken connection. A personal grant wins over delegation, so disconnect it in Settings and let delegation take over |

## Turning it off

Remove the grant in step 2, or clear `GOOGLE_DWD_DOMAINS`. Reps who connected
themselves keep working; everyone else falls back to the Connect button.
