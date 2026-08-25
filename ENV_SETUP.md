# Environment variables

The Command Center reads env vars from `.env.local` in local dev (auto-loaded by
Next.js — never committed) and from the Vercel project's Environment Variables
in production. There is **no** `.env.agents` loader anymore — the dashboard is
fully standalone.

## Required

| Variable | Value | Notes |
|---|---|---|
| `BRAVO_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Server-side Supabase URL |
| `BRAVO_SUPABASE_SERVICE_ROLE_KEY` | service role JWT | Server-only; never expose to the browser |
| `BRAVO_SUPABASE_ANON_KEY` | anon JWT | Server uses this for unauthenticated reads; also mirrored to `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `BRAVO_ANTHROPIC_API_KEY` _or_ `ANTHROPIC_API_KEY` | Anthropic API key | Required for AI lead scoring + chat tool runner |
| `BRAVO_FIELD_ENCRYPTION_KEY` | random 32+ byte string | Generate with `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Rotating this orphans every encrypted DB field, so set once and treat like a master secret. |
| `CRON_SECRET` | random secret | Required to authorize `/api/cron/*` requests in production |

### Account-security email (required for Turso password reset)

Password resets use a dedicated company-domain transactional identity. They do
not fall back to e-sign, outreach, tenant SMTP, or personal Gmail credentials.
When the dedicated `AUTH_*` set is absent, the existing company-domain
`GMAIL_USER` + `GMAIL_APP_PASSWORD` Google Workspace identity is accepted as a
strict compatibility path; consumer domains such as gmail.com are rejected.

| Variable | Notes |
|---|---|
| `AUTH_SMTP_HOST` | SMTP host for the approved account-security mailbox/provider |
| `AUTH_SMTP_PORT` | Usually `465` (TLS) or `587` (STARTTLS) |
| `AUTH_SMTP_SECURE` | Optional; defaults to `true` for port 465 and `false` otherwise |
| `AUTH_SMTP_USER` | Provider login; consumer-email identities are rejected |
| `AUTH_SMTP_PASSWORD` | SMTP password/API credential |
| `AUTH_FROM_EMAIL` | Approved company-domain From address, normally `security@oasisai.work` |
| `AUTH_FROM_NAME` | Optional; defaults to `OASIS AI Account Security` |
| `AUTH_ALLOWED_FROM_DOMAINS` | Optional comma-separated sender-domain allowlist for dedicated `AUTH_*` providers; defaults to `oasisai.work`. The `GMAIL_*` compatibility path remains pinned to `oasisai.work`. |

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are auto-derived
from the `BRAVO_*` variants in [next.config.js](next.config.js); set them
explicitly only if you want different values for browser vs server.

## Optional

| Variable | Default | Purpose |
|---|---|---|
| `OPERATOR_EMAIL` | _unset_ | Single-tenant fallback email for `getActiveProfile()`. Only consulted when `OPERATOR_EMAIL_FALLBACK_ENABLED=true`. Leave unset on multi-tenant deploys. |
| `OPERATOR_EMAIL_FALLBACK_ENABLED` | _unset_ | Set to `"true"` ONLY for single-tenant dev. On a multi-tenant deploy the fallback returns the operator's profile to anyone who hits an unauthed render — cross-tenant leak. Default is fail-closed (return null on no session). |
| `ADMIN_EMAILS` | _empty_ | Comma-separated list of admin emails |
| `OPERATOR_TIMEZONE` | `America/Toronto` | Server-side TZ for cron + date formatting |
| `NEXT_PUBLIC_OPERATOR_TIMEZONE` | `America/Toronto` | Browser-side TZ for the live clock |
| `PUBLIC_APP_URL` | `https://agent-dashboard-cc90210.vercel.app` | Used by CLI pair / provisioning routes |
| `BRAVO_DASHBOARD_URL` | falls back to `PUBLIC_APP_URL` | Pairing flow alias |
| `CRON_ALLOW_LOCAL` | _unset_ | Set to `"1"` to bypass cron auth in local dev |
| `STATE_API_URL` | `http://state-api:8500` | Optional state-api sidecar; `/system-health` falls back to Supabase mirror if unset |
| `EMPIRE_DATA_BACKEND` | `supabase` | Switch to `turso` to enable libSQL fallback |
| `TURSO_DB_PATH` / `TURSO_DB_URL` / `TURSO_AUTH_TOKEN` | _unset_ | Required when `EMPIRE_DATA_BACKEND=turso` |

## Optional — AI provider fallbacks

The `/api/usage` and operator-credential routes look up these "platform default"
keys when a tenant hasn't supplied their own. Leave unset for tenant-only mode.

| Variable | Provider |
|---|---|
| `PLATFORM_DEFAULT_ANTHROPIC_API_KEY` | Anthropic |
| `PLATFORM_DEFAULT_OPENAI_API_KEY` | OpenAI |
| `PLATFORM_DEFAULT_OPENROUTER_API_KEY` | OpenRouter |
| `PLATFORM_DEFAULT_GOOGLE_API_KEY` | Google |

## Optional — SMS webhooks

| Variable | Purpose |
|---|---|
| `TWILIO_AUTH_TOKEN` | Validates `/api/webhooks/twilio/sms-inbound` signatures |
| `TEXTTORRENT_WEBHOOK_SECRET` | Validates `/api/webhooks/texttorrent/sms-inbound` |

## Optional — Override approval HMAC

| Variable | Purpose |
|---|---|
| `OASIS_PROFILE_ID` | Tenant ID for the override approver flow |
| `OASIS_OUTBOUND_HMAC_SECRET` | Signs Approve/Deny callbacks on `/overrides` |

## Optional — UI feature flags

| Variable | Default | Effect |
|---|---|---|
| `NEXT_PUBLIC_TOOL_TIMELINE` | _on_ | Set to `"false"` to hide the chat tool timeline |
| `NEXT_PUBLIC_VERIFY_ACTIONS` | _on_ | Set to `"false"` to skip action-verification UI |

## Optional — Filesystem inbox fallback (legacy)

The agent-inbox layer falls back to filesystem reads under the agents' repos
only when the Supabase inbox is unavailable. These paths default to siblings of
this repo and almost never need to be set explicitly.

| Variable | Default |
|---|---|
| `BRAVO_REPO_ROOT` | `path.resolve(process.cwd(), "..", "..")` |
| `BRAVO_REPO` | `~/Business-Empire-Agent` |
| `MAVEN_REPO` | `~/CMO-Agent` |
| `ATLAS_REPO` | `~/APPS/CFO-Agent` |
| `AURA_REPO` | `~/AURA` |
| `LIFE_PRESERVATION_REPO` | `~/life-preservation` |

## Local setup

1. Create `.env.local` at the repo root
2. Paste the **Required** keys above, filling in values
3. `npm install && npm run dev` — opens at http://localhost:3100

`.env.local` is gitignored by Next.js defaults. Do not commit it.

## Vercel setup

The Vercel project `agent-dashboard` (org `cc90210`) already holds production
env values. After `vercel link`:

1. Go to https://vercel.com → `agent-dashboard` → Settings → Environment Variables
2. Confirm the **Required** keys above are present for **Production** and **Preview**
3. `vercel --prod` to deploy

## Why service role (not anon) on the server?

Every page renders on Vercel's server runtime via React Server Components. The
service role key never reaches the browser. Interactive features that need
RLS-aware behavior swap to per-request anon-key clients.

## Related
- [[README]]
