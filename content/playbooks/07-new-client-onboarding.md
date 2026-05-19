---
tags: [onboarding, client, playbook, operator]
---

# New Client Onboarding — Operator Playbook

**Audience:** You (CC). The OASIS operator standing up a new tenant.
**When to use:** A new business has signed up. You need to get their Command Center live.
**Time:** 30 minutes end-to-end if you have their API keys in front of you.

The big insight: **most of the work is already done.** The dashboard, the agent palette, the pipeline view, the drawer, the integration store — that's all shared infrastructure. Onboarding a new client is mostly **plugging their account into yours**, not building anything from scratch.

---

## What you're actually setting up per client

Three things. That's it.

1. **A tenant row** in the shared Supabase. This namespaces all their data so SunBiz leads never mix with the next client's.
2. **Their agent palette** — which of your agents (or new ones) they get. SunBiz gets Solara + Helios. The next client might get Solara + a new sales agent named after their brand.
3. **Their API keys** for the services they use (Twilio for SMS, Gmail for outbound email, Stripe for billing if they want ARR). They paste these themselves; you never touch their credentials.

Everything else — hosting, dashboard code, encryption, drip engine, document upload, lead pipeline — is one shared deployment. New tenant = new row + new keys, not new infrastructure.

---

## Step 1 — Stand up the tenant (5 min, you)

1. From your Bravo terminal:
   ```
   python scripts/provision_client_tenant.py <slug>
   ```
   Slug examples: `sun`, `gleam`, `harbor`. Lowercase, no spaces.

2. The script seeds:
   - A `tenants` row keyed on the slug
   - A `tenant_manifests` row with the default agent palette + nav
   - An owner-role `user_profiles` row tied to whichever email the client signs up with

3. Verify: `agent-dashboard-cc90210.vercel.app/t/<slug>` loads. You'll see your dashboard chrome with the new tenant's brand placeholder.

If the script asks for an agent palette and you don't have one for this vertical yet, default to `[solara, helios]` — Solara handles ops, Helios handles sales. We'll fork them per-client when their voice diverges from SunBiz's.

---

## Step 2 — Brand the tenant (5 min, you + client)

The client's brand lives in the manifest. Two places to update:

1. **Logo:** Have the client send you a PNG/SVG. Upload it through `/settings → Branding` once they're signed in, OR drop it in their tenant manifest's `brand.logo_url` field.

2. **Display name + tagline:** Edit the manifest's `brand.name`, `brand.subtitle`, `brand.footer_tagline`. Takes 30 seconds. Vercel re-renders the chrome on next page load — no deploy required.

---

## Step 3 — Hand the client their sign-in (2 min, you)

Send them:
- The dashboard URL: `https://agent-dashboard-cc90210.vercel.app/t/<their-slug>`
- A magic-link sign-in invite from `/team → Send invite`. This drops them straight into the onboarding wizard the first time they sign in.

They land on the dashboard. They see their brand. They see Solara waiting in the agent picker.

---

## Step 4 — They paste their own API keys (10 min, them)

This is the part you used to do manually. **It's now self-serve.** The client signs in, goes to `/settings → Integration Keys`, and pastes:

| What they need | Where to get it | What it powers |
|---|---|---|
| **Twilio Account SID + Auth Token + From Number** | their Twilio dashboard → Account Info | Send SMS button on every lead |
| **Gmail App Password + From Address** | `myaccount.google.com/apppasswords` | Outbound emails (once the daemon is live) |
| **Stripe Secret + Publishable Key** (optional) | their Stripe dashboard → API keys | ARR widget on the dashboard |
| **Telegram Bot Token** (optional) | `t.me/BotFather` | Mobile push notifications |

Each row has a **Test** button that pings the provider with their key. Green check = good to go. Red X = wrong key, with the actual error. You don't need to debug — they see what went wrong.

**You never see or touch their keys.** They're AES-256 encrypted in your Supabase the moment they hit Save. Even with database access you can't decrypt them without the master key, which lives only in Vercel's env vars.

---

## Step 5 — Daemon access (one-time setup, your machine OR Adon's)

The dashboard runs in the cloud. But chat agents, drip sequences, scheduled jobs, and SMS dispatch happen on **a real machine that owns the Claude Code CLI session**. That machine is the **bridge**.

You only do this once. After that, every new client tenant inherits the same bridge.

**Whose machine runs the bridge?**

- **Current:** Yours.
- **Planned:** Adon's. He'd own the Claude Code CLI session, the agent runtime, and the daemon processes. The dashboard stays on Vercel; only the local execution moves.

**To switch the bridge to Adon's machine:**

1. Install Claude Code CLI on Adon's machine. He signs in with his own Anthropic account so chat usage bills under him.
2. Clone the agent repo. The bridge daemon lives in `bravo_cli/bridge_chat_server.py`; the per-tenant cron poller in `scripts/event_router.py`; the override consumer in `scripts/exec_override_consumer.py`.
3. Copy your `.env.agents` file onto his machine via USB or 1Password (it carries the master keys; never commit it).
4. From the dashboard, sign in as the operator, go to `/settings/devices/install`, click **Pair a machine**, copy the pair code.
5. On Adon's machine, run the pair script (the install page shows the exact command — it's a one-liner).
6. Start the daemons under PM2 so they survive reboots:
   ```
   pm2 start scripts/event_router.py            --name event-router      --interpreter python -- loop --interval 3
   pm2 start scripts/exec_override_consumer.py  --name override-consumer --interpreter python -- loop --interval 5
   pm2 save
   pm2 startup
   ```
7. Reload the dashboard. Footer should flip to `LOCAL BRIDGE ONLINE`.

Adon's machine now runs every tenant's daemons. SunBiz today, the next client tomorrow, all from the same machine. No new install per client.

---

## Step 6 — Test the loop (5 min, you + them)

Three quick checks, in order:

1. **Lead creates:** They go to `/t/<slug>/leads/new`, fill in a fake business, save. It appears in the **Imported** stage on the pipeline view. If not — the tenant_id isn't wired; check `user_profiles.tenant_id` in Supabase.

2. **CSV import:** They drop a CSV with a `Stage` column on `/t/<slug>/import`. Rows land in the right stage sections. If everything lands in Imported, the CSV's stage values don't match — show them the Stage column from your sample CSV (`Hot Lead`, `Missing Info`, etc.).

3. **SMS send:** They open a lead, type a test message in the SMS composer, hit Send. The test message lands on the phone they have access to. If it fails with `missing_twilio_credentials`, they haven't pasted the From Number yet (it's required, not optional).

Email send is gated on the daemon listener landing (Day-1 post-launch task on Bravo's queue). Until then they use the chat agent for email, which writes through the existing send_gateway pathway.

---

## What you specifically own per client

- The tenant row + the manifest (you stand it up once)
- The agent palette tuning (one-time, you decide which agents they need)
- Brand assets going into the manifest (logo, taglines)
- Pair the bridge once if a new machine is hosting

## What they own (self-serve)

- Their own API keys (every integration in Settings)
- Their team invites (`/team`)
- Their drip sequences (`/sequences`)
- Their forms (`/forms`)
- Their leads, applications, offers, funded deals

---

## What to NOT promise

- **Per-tenant custom domains** — they sign in at `agent-dashboard-cc90210.vercel.app/t/<slug>`. Custom domains are possible but a separate setup (Vercel domain config + DNS); price it separately.
- **Per-tenant Supabase projects** — they share yours. If a client has compliance requirements that need their own DB, that's a real engineering project (multi-day, billable). Default is shared.
- **24/7 SLA on chat** — the bridge is on one machine. If Adon's machine reboots, chat is offline until PM2 brings the daemons back up. Usually 60 seconds. Worth saying out loud at sign-up.

---

## When something breaks

- **Settings → Integration Keys shows "Integration store not initialised":** Migration 058 wasn't applied to the Supabase project. From your Bravo terminal: `python scripts/apply_migration.py database/058_tenant_integration_credentials.sql`. (Done as of 2026-05-19 for the Bravo project — only re-run on a fresh Supabase project.)

- **Cross-tenant data leaks:** Always go to Settings first — the agent palette is the canary. SunBiz shouldn't see Bravo/Atlas/Maven; OASIS shouldn't see Solara/Helios. If it leaks, `profile.agents_enabled` got polluted from prior testing. Fix on `user_profiles.agents_enabled` directly.

- **"Send SMS" returns missing_twilio_credentials:** Client hasn't pasted all three Twilio fields. Send them back to Settings.

- **Save Profile errors out:** Open the browser console. If it's a downstream component throwing, the SafeBoundary catches it inline — the error text under the failing card names what broke. If error.tsx is showing, the throw is server-side; check Vercel function logs.

---

## TL;DR — the new client onboarding loop

1. `provision_client_tenant.py <slug>`
2. Drop their logo + tagline into the manifest
3. Magic-link invite
4. Walk them through pasting API keys in Settings
5. Test the SMS send + lead create + CSV import
6. Done

The bridge is one-time. The Supabase migration is one-time. Everything else is per-tenant data, self-serve.
