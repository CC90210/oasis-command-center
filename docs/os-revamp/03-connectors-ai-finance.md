# OASIS OS design for Connections, AI runtime, Finance and Messaging

This is a plan-mode design. Nothing was edited, committed or deployed. Paths below use these prefixes:
- **OCC** = `C:\Users\User\APPS\oasis-command-center`
- **BEA** = `C:\Users\User\Business-Empire-Agent`
- **CMO** = `C:\Users\User\CMO-Agent`
- **CFO** = `C:\Users\User\APPS\CFO-Agent`

Every code claim was re-read in source during this session and is cited as file:line.

## Summary
1. **One Connections hub on the existing credential vault.** It uses `tenant_integration_credentials` plus the Constant Contact popup pattern, extended with a `tenant_connections` state table, single-use OAuth state, a token refresh that cannot race, and per-connection health checks. The six product-defining connectors are built natively, and the long tail can later be switched to Nango behind the same interface. **Completeness 9/10.**
2. **The AI brain is a managed, metered Claude API tool loop inside the Worker, with no shell and no filesystem.** A database-leased job queue runs background work. A second, tenant-safe runner on the VPS handles jobs that need binaries such as yt-dlp and Remotion. BYO key is supported; the subscription connector comes later. **Completeness 8/10.**
3. **Finance is re-tenanted without rebuilding any table.** The work is `ALTER TABLE … ADD COLUMN tenant_id` plus triggers, a pattern the repo already uses. Client books are a read-only mirror of QuickBooks/Xero when the client has them, and OASIS's own ledger when they don't. Atlas owns the metric definitions; the model only narrates numbers that code computed. **Completeness 8/10.**
4. **Messaging runs through one gate.** Every SMS or email passes through a consent ledger, quiet hours and per-tenant send switches. Twilio uses ISV sub-accounts plus an A2P wizard, and Canada-to-Canada traffic uses verified toll-free numbers. Slack and Discord are notification and approval surfaces only.
5. **I found four blockers in code that the brief does not list.** They are covered in §0 and must go into Phase 0.

---

## 0. New findings that change the plan (verified this session)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **14 AI call sites run on CC's Max subscription.** `inferText` → `queueInfer` → local Claude CLI. The callers include `lib/sms/reply-agent.ts`, `lib/workflow-steps/ai-agent.ts`, `lib/sequence-rotation-compose.ts`, `lib/ai-lead-scoring.ts`, `lib/ai-automation-drafter.ts` and `lib/ai-conversation-summarize.ts`. | OCC `lib/subscription-infer.ts:1-33,37,60-75`; `lib/workflow-steps/ai-agent.ts:23,33`; `lib/sms/reply-agent.ts:4`; grep: 15 importing files | Harvesting SunBiz's drip, SMS-reply and routine engines "as-is" would put client work on CC's personal subscription, which breaks locked decision #6. A tenant-aware `lib/ai/infer.ts` router plus a lint test must land before any engine is harvested. |
| F2 | **An agent with no tool palette gets every tool.** That includes the tools routed to CC's machine through the bridge (`bash`, `write_file`, `run_script`, `send_email`) and `get_credential`, which returns decrypted vault secrets to the model. Unknown slugs fall back to `OASIS_SEED`. | OCC `lib/manifest/schema.ts:105-108`; `lib/cloud-tool-runner.ts:216-230, 569-800` (`defer: true`), `:2151-2160`; `lib/manifest/seeds.ts:900-903` | Client tenants must be **default-deny**: an agent with no palette gets no tools, bridge-routed tools can never be allowed, and credential tools are never offered. Today the only filter is "is the bridge offline", which is not a security boundary. |
| F3 | **A decryption failure silently switches to platform env credentials.** A corrupt tenant row resolves to the env credential. The cipher has no key id and no additional authenticated data (AAD, extra data bound to the ciphertext), so an encrypted value copied from tenant A to tenant B still decrypts. | OCC `lib/tenant-integration-store.ts:223-233`; `lib/field-encryption.ts:8-20, 37-45` | Phase 0: make decryption fail closed, and add a v2 envelope with a key id and AAD bound to `tenant|service|field`. |
| F4 | **`tenant_cron_jobs` run on the paired local bridge daemon, not in the cloud.** | OCC `app/api/cron-jobs/poll/route.ts:1-17` | Routines need a cloud executor, which is the job queue in §4. Clients cannot depend on a paired machine. |
| F5 | **Maven's Meta engine is pinned to Graph `v20.0`.** Research says v20 stopped working 2026-09-24. Token refresh writes to `.env`, and the spend gate is CC's pulse file. | CMO `ad-engine/scripts/meta_ads_engine.py:70, 154, 1389-1404` | Port only the endpoint knowledge to TypeScript, with a version constant in a registry. Nothing is reused as a running service. |
| F6 | **The Finance Stripe client is effectively single-tenant.** There is one global key getter, a single-slot account cache keyed by the key's last 6 characters, and global unique indexes on Stripe ids. | OCC `lib/founders-finances/stripe-io.ts:53-62, 111-128`; `180_founders_finances.turso.sql:363-370` | Thread a finance scope through all `*-io.ts` files. Key the cache by (tenant, sha256 of the key). Reject a Stripe account that is already connected to another tenant. |
| F7 | **The Constant Contact template has three gaps:** the OAuth state secret falls back to the master encryption key; state is replayable for 15 minutes (there is no single-use nonce); and tokens are saved in 3 separate writes. | OCC `app/api/integrations/constant-contact/authorize/route.ts:29,33-37`; `callback/route.ts:26,41-44`; `lib/integrations/constant-contact/store.ts:36-38` | The generic OAuth module fixes all three, using `setUserIntegrationBundle`'s atomic write (`lib/user-integration-store.ts:183-191`) as the model. |
| F8 | **`BEA/apps/agent-runner` spawns CLI processes and verifies Supabase JWTs.** | BEA `apps/agent-runner/README.md:6-25`; `src/spawner.ts:1,38,64` | Do not revive it for clients. Borrow only its SSE and session ideas. |
| F9 | **`cli_llm.py` tries Claude first by default.** | CMO `scripts/lib/cli_llm.py:3-5, 40` | Its adapter pattern is fine, but the default is client-unsafe. |

Ownership (BEA `brain/OWNERSHIP_MAP.yaml:85-118`):
- Paths that are **shared and need a `coord_claim` lease**: `app/api/**`, `lib/integrations/**`, `lib/sms/**`, `database/**`, and the unmapped `lib/tenant-integration-store.ts`, `lib/providers.ts`, `lib/cloud-tool-runner.ts` and `lib/founders-finances/**`.
- **Bravo-owned**: `lib/manifest/**`, `components/settings/**`, `lib/founders/**`.

---

## (a) Connections hub architecture

### a.1 Principles
1. **A tenant never borrows another account's credentials.** Env fallback becomes an allowlist that only the OASIS tenant can use. The code already has a hook for this: `OASIS_OWNED_ENV_FALLBACK_SERVICES` at OCC `lib/tenant-integration-store.ts:190-203` applies it to Stripe only. With SunBiz shut down, the Kixie and TextTorrent fallbacks at `:91-107, 141-146` get deleted once its daemons are stopped.
2. **OASIS-owned OAuth app credentials come from Worker secrets only**, never from the tenant store with env fallback. Today Constant Contact's app credentials resolve through the tenant store (`constant-contact/store.ts:44-49`).
3. **Minimum scopes, requested incrementally by department.** Google uses `include_granted_scopes=true`, so turning on Marketing asks only for what Marketing needs.
4. **Green means proven.** A card turns green only after a live probe passes. Presence-only tests show "Saved, not verified". Today Late, Kixie, SMTP and TextTorrent pass their test on presence alone (`app/api/integrations/keys/test/route.ts:91-112`).
5. **Every connection shows which departments use it**, and each department tab shows the connections it depends on.

### a.2 Data model (new tables all carry `tenant_id NOT NULL`, and every index leads with `tenant_id`)
- **`tenant_connections`**:
  - Columns: `id, tenant_id, provider, scope_kind ('tenant'|'user'), user_id NULL, auth_kind ('oauth2'|'restricted_key'|'api_key'|'system_user'|'app_install'|'nango'), external_account_id (acct_ / realmId / locationId / act_ / team_id / item_id), external_account_label, granted_scopes_json, scope_set_version, status ('pending'|'connected'|'degraded'|'expired'|'revoked'|'error'|'pending_review'), token_version INTEGER, refresh_lease_until, last_health_at, last_health_verdict ('healthy'|'degraded'|'down'|'unknown'), last_health_detail, consecutive_failures, connected_by, connected_at, revoked_at, created_at, updated_at`.
  - Constraint: `UNIQUE(tenant_id, provider, external_account_id, user_id)`.
  - Exclusive providers (Stripe, QBO, Xero, Plaid items, Meta ad accounts, the Twilio sub-account) also get a partial unique index on `(provider, external_account_id)`, so one Stripe account cannot feed two tenants' books (see F6).
- **Secrets stay where they are**, in `tenant_integration_credentials` and `user_integration_credentials`, under the v2 encryption envelope. `tenant_connections` holds no secrets.
- **`oauth_states`**: `nonce PK, tenant_id, user_id, provider, scope_set, pkce_verifier_enc, created_at, consumed_at`. It is single-use: the callback does `UPDATE … SET consumed_at=now WHERE nonce=? AND consumed_at IS NULL` and must affect exactly one row. This closes the F7 replay.
- **`connection_health_checks`**: `tenant_id, connection_id, checked_at, verdict, latency_ms, error_code, detail`. Append-only, trimmed to 30 days.
- **`provider_webhook_routes`**: `provider, external_key (acct_/page_id/locationId/realmId/xero tenant/Recall bot id/Twilio AccountSid/Slack team_id), tenant_id, connection_id`. This generalizes `channel_accounts`, which already maps numbers to tenants (OCC `lib/sms/twilio-inbound.ts:95-129`).
- **Audit**: every connect, refresh, scope change, revoke, health flip and agent use is written to the shared audit log, with actor, tenant and provider.

### a.3 Code layout (reuse first)
| File (new unless stated) | What it does | Reuses |
|---|---|---|
| `lib/connections/registry.ts` | `ProviderDef {id, label, wave, auth_kind, scopes:{base[], byDepartment{}}, departments[], probe(), webhook?: {verify(), route()}, passThroughMeter?}` for client tenants | Operator-only catalog stays in `lib/integrations-registry.ts` |
| `lib/connections/oauth.ts` | `startAuthorize()` / `completeCallback()`: HMAC-signed and single-use state, PKCE where the provider supports it, a dedicated `CONNECTIONS_OAUTH_STATE_SECRET` with **no fallback** | `constant-contact/authorize` + `callback` + `app/api/auth/google-oauth/start` |
| `lib/connections/popup.ts` | `connectionPopupResult(provider, status, reason)` | `lib/integrations/constant-contact/popup.ts:14-58` (script-safe JSON, nonce CSP) |
| `lib/connections/token-store.ts` | `getAccessToken(tenantId, connectionId)`: if expired, take a compare-and-set refresh lease (`UPDATE tenant_connections SET refresh_lease_until=?, token_version=token_version+1 WHERE id=? AND token_version=? AND (refresh_lease_until IS NULL OR refresh_lease_until<now)`), then refresh and save atomically. The loser of the race re-reads. Refresh failures fail closed: status becomes `expired` and the owner is notified. This matters for QBO, Xero and GHL, whose refresh tokens rotate. | `constant-contact/client.ts:74-88` (fail-closed refresh); new `setTenantIntegrationBundle` cloned from `user-integration-store.ts:183-191` |
| `lib/connections/health.ts` | Per-provider probes and verdict merging | `app/api/integrations/keys/test/route.ts` `runProbe`; `lib/integrations/google-token-probe.ts`; `lib/integrations/workspace-connection-status.ts` |
| `app/api/connections/[provider]/{authorize,callback,test,disconnect,status}/route.ts` | One dynamic route set for all providers | — |
| `app/api/cron/connection-health/route.ts` | Every 15 min; batches tenants, runs probes, flips status and alerts Operations and the owner | Registered in `workers/oasis-cc-cron/src/index.ts` and `config/cron-registry.json` |
| `app/(os)/settings/connections/page.tsx` and `components/connections/{ConnectionsHub,ConnectionCard,ScopeDisclosure,DepartmentChips,PendingReviewBadge}.tsx` | Cards grouped by department: "Used by: Marketing, Finance", plain-English scopes, "Verified 5 m ago", "Waiting on Meta review, using partner access" | Settings is Bravo-owned (`components/settings/**`) |
| `lib/setup-readiness.ts` (extend) | The readiness checklist driven by manifest `required_services` becomes the "connect your stack" step of the done-for-you install | `lib/manifest/schema.ts:393-429` |

### a.4 Safety fixes that belong in Phase 0 (my domain)
1. **Env fallback is default-deny, scoped by tenant ID and by service.** `tenantMayUseEnvFallback(tenantId)` is true only for an exact tenant ID in `OASIS_ENV_CREDENTIAL_TENANT_IDS`, never a slug match such as `isOasisSurfaceTenant(slug)` (a slug is display text a workspace can claim). A fallback exists only for a (service, field_key) pair listed in the explicit `ENV_FALLBACKS` allowlist; anything unlisted is DB-only. OAuth app credentials are not on that allowlist: Constant Contact's `client_id` / `client_secret` move out of `ENV_FALLBACKS` and are read from Worker secrets directly (principle 2). Test: `tests/env-fallback-oasis-only.test.ts`, a matrix of every `ENV_FALLBACKS` service against OASIS and non-OASIS tenant IDs, plus an assertion that no OAuth app credential is in the allowlist.
2. **Decryption failures fail closed** with the status `credential_unreadable`, never the env value (fixes F3).
3. **Encryption v2.**
   - Format: `v2:<kid>:<iv>.<tag>.<ct>`, with AAD = `${tenant_id}|${service}|${field_key}`.
   - Keys come from a keyring secret, `BRAVO_FIELD_ENCRYPTION_KEYS` (JSON `{kid: secret}`). v1 values still decrypt.
   - A batch rewrap route, `/api/internal/crypto/rewrap`, re-encrypts old values.
   - Finance tokens (Stripe restricted keys, Plaid, QBO, Xero) use their own key id, `fin`.
   - Test: an encrypted value copied to another tenant must fail to decrypt.
4. **A dedicated OAuth state secret for each flow**, with no fallback to the field-encryption key.
5. **Per-tenant send switches.**
   - Add `tenant_send_controls (tenant_id, channel, mode 'dry_run'|'live'|'paused', set_by, reason)`.
   - `isDryRun(channel, tenantId)` in `lib/integrations/send-mode.ts:67-76` becomes: global `BRAVO_FORCE_DRY_RUN` still clamps everything, and otherwise a send is live only if **both** the global setting and the tenant row say live.
   - Coordinate with PR #434 (per-company send flags) instead of duplicating it.
6. **AI routing guard (F1).**
   - New `lib/ai/infer.ts` `inferForTenant()`. Only OASIS-surface tenants may take the subscription path (for internal use); every other tenant goes through the managed API (§d).
   - `tests/no-subscription-infer-outside-router.test.ts` fails if any file other than `lib/ai/infer.ts` imports `bridge-infer` or `subscription-infer`.
   - Migrate the 14 callers.
7. **Tool sandbox default-deny (F2).** See §d.4.

### a.5 Scope minimization (what each department asks for)
| Provider | Requested for client tenants | Never requested (v1) |
|---|---|---|
| Google | `openid email` + `calendar.events` (Schedule/Sales) · `gmail.send` (Sales/Client Success, per user) · `drive.file` + Picker (Content/Playbook) · `meetings.space.readonly` (Wave 2) | `gmail.readonly/modify` and full `drive` (restricted scopes + CASA). The builder refuses `gmail.readonly` for non-OASIS tenants; today it is always requested (`start/route.ts:37-49`) |
| Stripe | Restricted key with **read** on Charges, Customers, Invoices, Subscriptions, Products/Prices, Balance, Balance Transactions, Payouts, Refunds, Disputes, Events | Any write. A full `sk_live_` key is rejected for client tenants |
| QBO | `com.intuit.quickbooks.accounting` (Intuit has no read-only accounting scope, so our client issues GET only, enforced in code and by test) | Payments scopes |
| Xero | Granular `*.read` scopes + `offline_access` (confirm current scope names when building) | Write scopes |
| Meta | `ads_read`, `ads_management` (create PAUSED only), `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `pages_manage_metadata` | `instagram_content_publish` (Content, later), `business_management` unless App Review demands it |
| GHL | Read: contacts, opportunities, calendars/events, conversations, locations. Write (`conversations/message.write`, `contacts.write`) only when the tenant turns on "send through GHL" | Workflows write, payments |
| Slack | `chat:write`, `commands`; v1.1 adds `app_mentions:read` + message events for **bridged channels only** | Any use of `conversations.history`/`replies` (avoids the 1 req/min throttle and the Slack terms of service ban on training and bulk export) |
| Twilio | Sub-account credentials only; OASIS's parent credentials never leave the platform code | Parent credentials in `ENV_FALLBACKS` (name them `TWILIO_ISV_*`, not `TWILIO_*`) |

### a.6 Department → connection map
| Department tab | Required | Optional |
|---|---|---|
| Today / Chief of Staff | none (reads the other departments) | Google Calendar, Slack |
| Sales | CRM (native Pipeline, or GHL) | Calendar, gmail.send, Calendly/Cal.com, Twilio or GHL SMS, meeting capture |
| Marketing | Forms (built in) | Meta Ads + Lead Ads, Google Ads (W3), Ad Library (EU), Late |
| Content | none | Drive `drive.file`, Late/Zernio |
| Client Success | none (tickets/forms built in) | Recall/Fathom/Fireflies/Zoom/Meet, gmail.send, Twilio |
| Finance (owner-only) | at least one of Stripe restricted key, QBO/Xero, CSV/OFX, Plaid | Meta spend (for CAC) |
| Research | none | Ad Library (EU/UK), public web |
| Operations | none | Slack/Discord (alerts); surfaces health for all connections |

### a.7 Native vs Nango
**The rule.** Build natively when a connector is any of: product-defining; finance-sensitive; needs webhooks we must verify ourselves; or needs a platform review that OASIS must own anyway. Use Nango (with OASIS-owned OAuth apps) only for long-tail, read-mostly connectors that at least 3 tenants have asked for.

**Recommendation.** Start with no vendor, and put `auth_kind:'nango'` behind the registry so switching later needs no UI change. Nango costs about $110/mo at 200 connections, but it becomes another US sub-processor in every Law 25 s.17 privacy impact assessment (PIA). **Completeness 8/10.**

| Native | Nango candidate (later) |
|---|---|
| Stripe, Google, Meta, GHL, Twilio, QBO, Xero, Plaid, Recall, Slack, Zoom (moat), Calendly, Fathom/Fireflies (small REST + webhooks) | Cal.com OAuth, HubSpot, Pipedrive, Microsoft 365/Outlook, Notion, Airtable, Discord (if requested) |

---

## (b) Connector wave plan

### b.1 Day-1 paperwork, started in parallel with Phase 0 (calendar time, owned by CC)
1. **Re-verify oasisai.work first.** It lapsed on 2026-08-06. Check renewal, the card on file, MX/TXT records and Search Console ownership. Meta Business Verification and Google brand verification both need the domain and legal pages.
2. **Publish FR-first legal pages**: ToS, Privacy Policy with the Google Limited Use disclosure and a "no training" statement, the DPA, and the name of the Law 25 privacy officer.
3. Submit **Meta** Business Verification, create the app, request Tech Provider verification, and prepare App Review screencasts.
4. Submit **Google** brand verification plus sensitive scopes (`calendar.events`, `gmail.send`, `meetings.space.readonly`).
5. Create the **Zoom** General app and start the listing; submit when the Recall pilot shows demand.
6. Set up **Twilio** ISV: OASIS Primary Customer Profile in Trust Hub.
7. **Intuit** app assessment questionnaire; **Xero** app; **Plaid** Trial team; **Recall** account plus DPA.
8. **Slack**: create the app now for unlisted installs; the Marketplace is not required for v1.

### b.2 Waves
| Wave | When | Connectors | First client value |
|---|---|---|---|
| **W0 safety** | weeks 0-1 | §a.4 fixes; the Connections framework skeleton | — |
| **W1 no-review** | weeks 1-4 | Stripe restricted key · Google Calendar + `gmail.send` (pilot mode, capped at 100 users with the "unverified app" screen until sensitive review passes) · Drive `drive.file` · GHL private app (≤5 agencies) · Calendly / Cal.com (key) · Fathom / Fireflies · Recall.ai · QBO (sandbox now, production after the 1-3 wk assessment) · Xero Starter (≤5) · Plaid Trial (10 Items) · CSV/OFX · Meta **partner-access pilot** | about week 2: Finance cockpit on Stripe + CSV; Recall notes; GHL sync |
| **W2 review-gated (submitted on day 1)** | goes live as each approval lands, weeks 3-12 | Meta FB Login for Business + Lead Ads (3-8 wks) · Google sensitive verified (1-4 wks) · Meet transcripts (2-4 wks) · Zoom Marketplace (3-6 wks) · Twilio ISV (2-4 wk build, then 1-3 wks per tenant) · Slack approvals (unlisted, no review) · Late/Zernio per-tenant profile · Ad Library API (EU/UK, 1-2 wks identity check) | Meta self-serve connect; SMS per tenant |
| **W3 deferred** | on demand | Gmail read + CASA (6-12 wks, US$540-4,500/yr) · Stripe App OAuth (about 4 business days per version) · Slack Marketplace (5 workspaces, then about 2-3 months) · Flinks (4-8 wks plus contract) · Google Ads (developer-token access; unverified timing) · Discord · subscription AI connector | — |

### b.3 Meta partner-access pilot path (Meta ads visible early)
1. **Client grants partner access.** In the client's Business Settings → Partners → Add, they enter OASIS's Business ID and grant the ad account (analyst to advertiser level) and the Page (Leads access).
2. **OASIS binds a system user.** In OASIS's Business Manager, a system user (employee role) is assigned the shared assets, and a token is generated for OASIS's app with `ads_read` and `ads_management`. The token is stored per tenant with `auth_kind:'system_user'` and the ad account id as `external_account_id`.
3. **Limits.** This works immediately for assets shared with OASIS's Business Manager, but only at Limited-tier rate limits. The sync budgets itself from the `X-Business-Use-Case-Usage` header.
4. **Unverified.** Whether leadgen webhooks for a partner-shared Page are delivered before App Review needs a live test.
5. **Pilot label.** The card says "Managed by OASIS (partner access)". Leaving means removing OASIS as a partner, and the "Disconnect" button explains that step.
6. **Moving to self-serve.** Once App Review passes, Facebook Login for Business moves tenants to their own grant, and the system user path remains for Managed-tier clients.

### b.4 Twilio (automated responses, follow-ups, notifications)
**Provisioning (ISV model)**
- The parent account (secret `TWILIO_ISV_ACCOUNT_SID/AUTH_TOKEN`, never in `ENV_FALLBACKS`) creates one sub-account per tenant at install.
- The sub-account SID and token are stored as `service='twilio'` with `managed_by='oasis_isv'`. `channel_accounts` rows are written automatically, and the inbound webhook URL is set on the tenant's Messaging Service.

**A2P wizard (`app/(os)/settings/connections/texting/page.tsx`)**
1. Business info: legal name, BN-9 or EIN, address, website, authorized rep.
2. The Trust Hub Secondary Customer Profile is created.
3. Brand registration: low-volume standard (US$4.50) or standard (US$46 including vetting).
4. Campaign: use case (`CUSTOMER_CARE`, `ACCOUNT_NOTIFICATION` or `MIXED`), sample messages, and an opt-in description whose screenshot URL points at the tenant's OASIS form consent checkbox.
5. Numbers: Canadian tenants default to a **toll-free number + Toll-Free Verification** for Canada-to-Canada traffic. 10DLC is added only when texting US recipients.
6. Status is tracked in `sms_registrations (tenant_id, kind brand|campaign|tollfree_verification, twilio_sid, status, submitted_at, decided_at, rejection_reason, fee_cents)`, polled hourly by `/api/cron/sms-registration-status`.
7. The UI states plainly: "Texting pending carrier approval (1-3 weeks)".

**Tenants on GHL** send through GHL's LC Phone via its conversations API. That keeps A2P registration on the client's own GHL account, and no ISV setup is needed.

**Inbound**
- Keep `/api/webhooks/twilio/sms-inbound`.
- Resolve the tenant by the To number (`lib/sms/twilio-inbound.ts:95-129`), then verify with **that sub-account's** token (`verifyTwilioSignature`, `:70-89`) and assert that `AccountSid` equals the stored sub-account SID.
- STOP, HELP and natural-language opt-outs use `lib/sms/compliance.ts:64 detectOptOut`.

**Consent ledger (harvested from SunBiz, now generic)**
- `contact_consents (tenant_id, record_id, channel sms|email|voice, address_hash, address_last4, consent_type express|implied_purchase|implied_inquiry, source form_id|import|manual|inbound, proof_json {submission_id, ip, checkbox_text_version, captured_at}, jurisdiction CA|US|other, expires_at, revoked_at, revoked_via)`.
- Implied consent expires after 2 years from a purchase or 6 months from an inquiry.
- `suppressions (tenant_id, channel, address_hash, reason, source, created_at)` replaces the SunBiz-named `sunbiz_phone_suppressions` read at OCC `lib/lead-interactions-queries.ts:90`, and later `email_suppressions`.
- SunBiz's own rows are exported and deleted with its data (CC confirms at execution time).

**One send chokepoint: `lib/messaging/send.ts` `canSend(tenant, record, channel, purpose: transactional|commercial)`**
1. The tenant send switch is `live`.
2. Not suppressed. A check error fails closed, same semantics as `checkPhoneOptOut`, `lib/lead-interactions-queries.ts:74-97`.
3. Commercial messages need unexpired consent. Transactional messages skip that requirement but still honor STOP.
4. **Quiet hours.** The default window is 09:00-20:00 in the recipient's local time, which sits inside every federal window and the strictest state ones. The zone comes from `lib/tcpa-window.ts`. When its fallback flag `usedFallback` is set, the send is held and flagged, not guessed. Per-state limits use `lib/sms/compliance.ts:146-168`. Replies inside a conversation the customer started are exempt, configurable per tenant.
5. Per-contact 24h cap (`maxMessagesPer24h`).
6. CASL sender ID plus a bilingual opt-out footer (`withSmsFooter` in `lib/sms/reply-agent.ts:28`).
7. **Autonomy**, reusing the `off|propose|execute` enum from `reply-agent.ts:31`. AI-written free text creates an approval card unless the tenant has explicitly allowed auto-send for a routine whose sandbox run passed. Pre-approved templates send automatically.
8. Re-check the FCC opt-out revocation rules after the 2026-09-30 vote.

**Automations**
- Auto-response: inbound message → spam/phishing classifier (Haiku; Cook's rep answered a phishing DM) → template or draft reply.
- Follow-ups: the harvested `lib/drips/*` running as routines.
- Notifications: appointment reminders, which are transactional.

**Billing.** Segments, numbers, brand and campaign fees go to `usage_events`, passed through at cost plus margin.

---

## (c) Marketing department

### c.1 Meta ads
**Tables** (money is integer cents, following the OCC rule; Maven's `metric_daily` uses REAL at CMO `state/migrations/004_ad_experiments.sql:70-87`):
- `ad_accounts`
- `ad_entities (tenant_id, platform, level campaign|adset|ad, external_id, parent_external_id, name, status, objective, daily_budget_cents, creative_ref, synced_at)`
- `ad_insights_daily (tenant_id, platform, level, external_id, date, spend_cents, impressions, clicks, leads, purchases, revenue_cents, actions_json, source 'meta_api', captured_at, PK(tenant_id,platform,level,external_id,date))`
- Ports of the adgen ledger: `ad_creatives`, `ad_experiments`, `ad_fatigue_events`, `ad_lessons` (from `negative_knowledge`).

**Sync**
- `/api/cron/sync-ad-insights` runs hourly in the Worker; it is pure fetch.
- It pulls account-level insights with `level=ad&time_increment=1` for the last 7 days, plus a 90-day backfill on first connect.
- `META_GRAPH_VERSION` lives in `lib/marketing/meta/client.ts` and is never left pinned to v20 (F5).

**Lead Ads**
- `/api/webhooks/meta/leadgen` verifies `X-Hub-Signature-256` with the app secret.
- `page_id` resolves the tenant via `provider_webhook_routes`, then `leads_retrieval` fetches the lead.
- The lead is written to `tenant_records` plus a `contact_consents` row from the form's consent question, and routed to Pipeline.

**Create PAUSED, then approve, then activate**
1. The agent tool `meta_propose_ad` only writes an `approvals` row with `kind 'meta.ad.create'`. The payload is the exact spec (existing ad set id, creative, copy, destination funnel URL with `utm_content={ad_id}`), and status is always **PAUSED**.
2. When the owner approves, server code executes that stored payload. It is bound to a `payload_hash` and never regenerated by the model.
3. The server diffs the account before and after, and the approval card shows "No existing live ads were changed" only if the diff proves it.
4. Activation is a **second** approval, `meta.ad.activate`, showing projected spend.
5. It is checked against `tenant_spend_policies.monthly_ad_spend_cap_cents`, set by the owner. This replaces CC's `cfo_pulse.json` gate at CMO `ad-engine/scripts/meta_ads_engine.py:154`.
6. Maven's `create_campaign` already defaults to PAUSED (`:786-817`); keep that default.

**Winning-ad analytics** (`lib/marketing/creative-scorecard.ts`)
- Rank creatives by cost per qualified show and cost per **paid** customer, not by CTR.
- The funnel chain is: ad → `funnel_touches` → lead → booked → showed → won → Finance payment.
- Use empirical-Bayes shrinkage, ported from Maven's `content_scorecard.py` method, and label every ranking with its sample size.
- Fatigue is flagged when frequency rises while CTR decays, recorded in `ad_fatigue_events`. Losing angles are recorded in `ad_lessons`, the "negative knowledge" that never gets deleted.

### c.2 Competitor research, designed around what the API actually allows
The Ad Library API returns **no US or Canadian commercial ads**, only EU/UK commercial ads plus political ads. The research agent therefore combines:
1. **Manual capture.** An owner or OASIS operator pastes Ad Library URLs or screenshots. A vision teardown extracts hook, offer, angle, CTA and format.
2. **Automated public signals.** Competitor landing pages go through the `research_fetch` ladder. Their YouTube channels are swept with `competitor_sweep.py`, which uses yt-dlp (CMO `scripts/competitor_sweep.py:10-31`), and public X/LinkedIn/YouTube posts are read with `social_reach_tool.py`. That tool does **not** read IG, TikTok or Facebook (CMO `scripts/social_reach_tool.py:15-18`).
3. **The EU/UK API** for competitors who advertise there.
4. Optionally, a licensed ad-intelligence vendor as a pass-through add-on (pricing and terms unverified).

We do **not** automate scraping of the Ad Library web UI; that is a likely Meta terms-of-service risk, and it is CC's call.

- Tables: `competitors (tenant_id, name, domains_json, handles_json, verified)` and `competitor_observations (tenant_id, competitor_id, source manual_capture|landing_page|youtube|eu_ad_library, url, captured_at, media_r2_key, extracted_json, epistemic_status observed|hypothesis)`.
- A weekly digest routine goes to #research and #marketing.

### c.3 A funnel for every creative
- The Forms engine stays, and the `/f/<tenant>/<form>` URL format is frozen.
- Add a `booking` step kind: slots from Google Calendar free/busy or a Calendly/Cal.com embed. It creates `call_appointments` plus a calendar event through a **parameterized** `lib/integrations/google-calendar.ts`, which today is hard-coded to the 15-minute OASIS audit (`:2, 24, 27, 464-467`).
- Capture UTMs, `fbclid` and `gclid` on submit; Maven lists UTM capture as a gap. Add a `/api/f/beacon` view beacon.
- `funnel_touches (tenant_id, form_id, session_id, utm_*, fbclid, gclid, ad_external_id, landing_url, step_reached, submitted_at, booked_at)`.
- Per-funnel analytics: views → starts → submits → booked → showed → won → paid, broken down by `utm_content` (the ad id).
- Meta Conversions API later: server-side, consent-gated, hashed identifiers.

### c.4 Content pipeline
- v1: port the founders asset review queue (OCC `lib/founders/marketing-queries.ts`, `ingest-core.ts`) to tenant-scoped `content_assets`, `content_reviews` and `content_publish_intents`.
- The Content agent writes briefs and copy on the managed runtime.
- Renders run on the VPS runner (`render` lane), from Remotion's generic templates.
- GPU (Wan) is Managed tier only, through a claim on the single GPU queue.
- Publishing goes through a per-tenant Late/Zernio profile: OASIS key, usage passed through, approval always required before publishing.

### c.5 What runs where
| In the Worker (ported to TypeScript) | Tenant-safe VPS runner (Python, Maven code pinned) |
|---|---|
| Meta Graph client: insights, entity CRUD with PAUSED only, leadgen fetch, token exchange (logic from `meta_ads_engine.py:590-1343`) · creative scorecard and fatigue math · funnel analytics · Late REST calls · Ad Library EU queries | `adgen_harvest.py` (Reddit/YouTube/Exa) · `competitor_sweep.py` (yt-dlp) · `social_reach_tool.py` · `teardown.py` · Remotion renders · Wan jobs. Each receives validated parameters from a job row, never a model-written command line |

---

## (d) AI runtime

### d.1 Where it runs
| Option | Completeness | Tradeoff |
|---|---|---|
| **A (recommended).** Interactive turns stream from Worker routes (I/O-bound, fits Workers). Background work goes through an `agent_jobs` table with a database lease, claimed every minute by `/api/cron/dispatch-agent-jobs` using the `claimed_at` lease pattern from `database/turso/173_scheduled_sends_claimed_at.turso.sql:4-12`. Each job checkpoints about every 60-90 s and resumes on the next tick. A separate VPS runner claims `lane='vps'` jobs through `/api/internal/jobs/{claim,complete}` with its own bearer token. | 8/10 | No new infrastructure (`wrangler.jsonc` has no queues or Durable Objects today). Latency is up to 1 minute. |
| B. Cloudflare Queues or Workflows | 7/10 | Durable steps, but a new binding and deploy surface. Revisit above about 50k jobs a month. |
| C. Revive `BEA/apps/agent-runner` | 3/10 | It spawns CLI processes and verifies Supabase JWTs (F8). |

**`agent_jobs`**
- Columns: `id, tenant_id, department, kind (routine_run|meeting_process|insights_sync|research_sweep|render|async_task), lane worker|vps, status queued|claimed|running|waiting_approval|succeeded|failed|canceled, priority, run_after, claimed_at, claimed_by, attempts, max_attempts, idempotency_key, input_json, output_json, error, budget_micro_usd, spent_micro_usd, created_by, timestamps`, with `UNIQUE(tenant_id, idempotency_key)`.
- Fair share: at most K running jobs per tenant.

**VPS runner**
- PM2 namespace `oasis-os-runner`, memory cap set, never run `pm2 restart all`.
- Its env file holds runner-scoped secrets only: its bearer token, an R2 token limited to one bucket prefix, and the Exa key. No Turso admin credentials, and none of CC's keys.
- Do not use srv1723601, the SunBiz box being decommissioned whose SSH key access is blocked. CC must name the box.

### d.2 Model API (managed default)
- **Provider.** Anthropic API under Commercial Terms, in a **dedicated workspace** (for example `oasis-os-clients`) with its own key in the Worker secret `OASIS_MANAGED_ANTHROPIC_API_KEY` and a workspace spend limit as a backstop.
- **Data terms.** Sign the DPA and confirm no-training and retention terms in writing. Fable 5.1 is not eligible for zero data retention (ZDR); it requires 30-day retention.
- **Location.** Pin `inference_geo:"us"` and record that in the PIA. No Canadian inference region is claimed.
- **Other providers.** Stay available through `lib/providers.ts`, **paid tiers only**; Gemini's free tier may train on prompts.
- **Stale model list.** `lib/providers.ts:78-166` still lists Sonnet 4.6, Opus 4.7, GPT-5.4 and Gemini 2.5. Move model ids into one registry, `lib/ai/model-registry.ts`.

**Prices (Anthropic list, skill cache dated 2026-06-24):**

| Model | Input $/1M tokens | Output $/1M tokens |
|---|---|---|
| `claude-opus-5` | $5 | $25 |
| `claude-sonnet-5` | $2 | $10 |
| `claude-haiku-4-5` | $1 | $5 |

Cache reads cost about 0.1× the input price.

**Cost per department turn**, assuming about 8K tokens of cached system prompt and skills, 4K uncached input and 1.5K output:
- Opus 5: about **$0.06**.
- Sonnet 5: about **$0.025**.
- At 50 turns a day, that is about $90/mo (Opus 5) or $37/mo (Sonnet 5) per tenant, before routines. Tool loops multiply this by about 3-5×.

**Decision for CC.** The default model is CC's cost call. My recommendation:
- Run a 50-task eval on the OASIS tenant in Phase 1 and compare cost per *completed* task.
- Start department chat on Sonnet 5 or on Opus 5 at `low`/`medium` effort, whichever wins that eval.
- Use Opus 5 for Finance analysis and routine building.
- Use Haiku 4.5 for classification (spam gate, intent routing).
- Atlas turns the measured cost into the per-tier AI allowance.

### d.3 Per-tenant metering and spend cap
- **`ai_usage_events`**: `tenant_id, user_id, department, session_id|job_id, provider, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micro_usd, billing_mode managed|byo_key|subscription, created_at`. It is written from the usage totals the loop already tracks (`totalIn/totalOut`, `lib/cloud-tool-runner.ts:2100-2106`).
- **`model_prices`**: provider, model, per-token prices, `effective_from`.
- **`tenant_ai_budgets`**: `tenant_id, period_month, included_micro_usd (tier), hard_cap_micro_usd (set by owner), soft_alert_pct, spent_micro_usd, reserved_micro_usd`.
- **Before each call**, reserve the worst case with `UPDATE … SET reserved=reserved+? WHERE spent+reserved+? <= cap`. The worst case covers input and output: the counted input tokens priced at the higher of the base-input and cache-write rates (a call may write the cache; cache-read discounts are known only afterwards), plus `max_tokens` × output price. Every model call in a tool loop is its own call and takes its own reservation before dispatch; one reservation never covers a whole loop. The hard-cap check is on the full reservation. **After** each call, settle to the actual cost from its usage (release the reservation, add the real spend).
- **At the cap**, return HTTP 402 `ai_budget_exhausted` with honest copy: "This month's AI budget is used. The owner can raise it." Fall back to the tenant's own key if one is configured. **Never quietly downgrade to a free model.**
- A generic **`usage_events`** table (SMS, numbers, Recall hours, Plaid Items, transcription) feeds the monthly pass-through line items on OASIS's own Stripe. Atlas sets the margin per tier.

### d.4 Tool sandbox (no shell, no filesystem)
**`lib/ai/tools/client-safe-registry.ts`** is an explicit allowlist in three classes:
- **read**: records, finance metrics, ad insights, meetings retrieval, `web_fetch` behind the existing DNS-aware SSRF guard (`lib/cloud-tool-runner.ts:1750-1880`).
- **draft**: creates an `approvals` row and has no side effect.
- **execute**: server-only, runs only from an approved payload, and is never callable by the model.

**Never offered to client tenants:**
- any tool marked `defer: true` (tools that run on CC's machine through the bridge)
- `get_credential` / `add_credential`
- `http_post`
- `load_skill` in its bridge form; it is replaced by a cloud skill reader over the tenant's skill store

**Enforcement**
- For tenants with `ui.shell='departments'`, a missing palette means `[]`.
- `ToolContext.tenantId` always comes from the session, never from model input.
- Third-party content is wrapped with `lib/llm-input-boundary` `wrapUntrusted` / `INJECTION_GUARD`.
- Test `tests/os-tool-sandbox.test.ts`: no client palette contains a bridge-routed or credential tool, and an unknown slug gets no tools.

### d.5 A department agent is configuration
Add a `departments[]` block to the manifest:

`{key, label, persona_template_id, skills[], tools[], connections_required[], connections_optional[], model_policy {tier, effort}, approval_policy, routines[], kpis[]}`

- Neutral persona templates live in `lib/os/departments/*.ts`, seeded from the marketplace categories in `lib/agents/library.ts:18-35`. The CC-specific strings in `lib/agent-personas.ts` are not exposed to clients.
- The chat engine is built on `components/agents/AgentChat.tsx`, but its backend is extended: `/api/agents/chat` today streams **without tools** and resolves the "bravo" config row (`app/api/agents/chat/route.ts:160-195, 247`). The replacement is `/api/os/departments/[dept]/chat`, which runs the Anthropic tool loop (`streamAnthropicWithTools`) with the tool sandbox above.

### d.6 BYO key and subscription connector
- **BYO key** reuses `agent_model_config` and `lib/chat-auth.ts:8-29`, with `billing_mode='byo_key'`. It is metered for visibility but not charged, and uses the same sandbox.
- **Subscription connector (later).**
  - Only through an official provider OAuth that permits third-party apps, once its terms are confirmed.
  - Never through the `bravo_cli` bridge, which exposes bash and file writes (`BEA/bravo_cli/bridge_tools.py:236-266, 639`). Never by pasting session cookies.
  - It uses the same fallback semantics as Cook: when the plan's limit is hit, switch to the metered managed model with a visible notice.
- **Free VPS models (Gemini-first; `cli_llm` pattern with Claude removed)** are allowed only for low-risk internal OASIS routines that contain no client personal information.

### d.7 Routines engine
1. **Triggers**: schedule (`tenant_cron_jobs`, now executed by `dispatch-agent-jobs` instead of the local bridge, F4); events from an `os_events` table (`call.recorded`, `form.submitted`, `ticket.created`, `payment.received`, `lead.created`); a signed per-routine inbound webhook; manual.
2. **Steps**: revive the dead `lib/workflow-steps/*` registry (`run-step.ts:26-33`). Change `ai-agent.ts` to use `inferForTenant` (F1). Add step kinds `quality_gate` (a rubric with pass/fail branches), `approval`, `sms_send` and `meta_propose`.
3. **New tables**: `routine_runs` and `routine_step_runs`. There is no workflow-runs table today.
4. **Sandbox mode**: side-effecting steps return the `SendResult` dry-run shape (`lib/integrations/send-mode.ts:25-34`), and record writes are captured as a diff. The model calls are real and metered.
5. **New routines start Off.** Turning one on requires its last sandbox run to have passed the quality gate. A routine that fails its test stays Off.

---

## (e) Finance department (the wedge)

### e.1 Re-tenanting `fin_*` without a table rebuild
**Why no rebuild is needed.** `fin_entities` only constrains `owner_key` for *personal* books. A client's business entity (`kind='business'`, `owner_key NULL`) already passes the CHECK (`180_founders_finances.turso.sql:21-31`).

**Migration M-FIN-1** (number reserved with `check_migration_collision.py reserve`):
1. `ALTER TABLE <each fin_* table> ADD COLUMN tenant_id TEXT` on every entity-keyed table: entities, settings, accounts, journal entries and lines, contacts, categories, rules, tax codes, invoices and lines, bills and lines, attachments, imports, bank transactions, payments, subscriptions, recurring items, audit log, plus `stripe_account_id` on `fin_stripe_events`.
2. Backfill the OASIS entities with the OASIS tenant id.
3. Add triggers, a pattern already used in migrations 149, 150, 156, 159 and 162:
   - `BEFORE INSERT … WHEN NEW.tenant_id IS NULL` → abort.
   - `BEFORE INSERT … WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM fin_entities WHERE id=NEW.entity_id)` → abort.
   - `BEFORE UPDATE OF tenant_id` → abort.
   - `BEFORE UPDATE OF entity_id … WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM fin_entities WHERE id=NEW.entity_id)` → abort. Without it, an update that changes only `entity_id` passes both checks above and attaches the row to another tenant's entity.
   - Use `IS NOT`, not `<>`: for an unknown `entity_id` the subquery is NULL, `<>` yields NULL, and the trigger would let the row through.
4. Add indexes `(tenant_id, entity_id, …)`.
5. Replace the global unique indexes on Stripe ids (`:363-370`) with `(entity_id, stripe_*)` versions. This is `DROP INDEX`, not `DROP TABLE`; confirm exec_guard allows it, and get Codex review.

**Exceptions**
- `fin_fx_rates` stays global reference data.
- `fin_owner_equity_events` stays OASIS-only because of its CHECK (`:408-411`).
- `fin_bank_transactions.currency` is limited to CAD and USD (`:311`), which is acceptable for v1.
- Entity slugs are namespaced `t_<tenant>_business`, because `slug` is globally UNIQUE.

**Code changes**
- A `FinanceScope {tenantId, entityId}` is threaded through every `*-io.ts` file. `BUSINESS_ENTITY_ID` has 26 references in 9 files.
- `stripeSecretKey()` / `financeTenantId()` (`stripe-io.ts:53-62`) become `stripeClientFor(scope)`.
- The account cache is keyed by (tenant, key hash).
- Access: the founder email map (`access.ts:22-25`) becomes a per-tenant `finance.view` capability (owner plus explicit grants) in `lib/role-surfaces.ts`. `canAccessEntity` (`:70-76`) stays for personal books, so CC and Adon see their own personal books inside the OASIS tenant.
- **OASIS's books become the OASIS tenant's owner-only Finance department**, and the Founders portal route redirects there.

### e.2 Two book modes (decision for CC; I recommend both, A first)
- **A. Accounting-connected (QBO/Xero present).** QBO/Xero is the source of truth, mirrored read-only into `fin_ext_snapshots (tenant_id, provider, report ProfitAndLoss|BalanceSheet|AgedReceivables|CashFlow, period, payload_json, fetched_at)`, plus `fin_ext_invoices` and `fin_ext_bills`. Stripe adds live MRR and churn; Plaid adds real-time cash. **No OASIS journal**, so there are never two conflicting sets of books. **Completeness 9/10.**
- **B. OASIS management books (no accounting system).** The re-tenanted ledger is fed by Stripe, Plaid and CSV/OFX through the existing rules engine (`lib/founders-finances/rules.ts`, `import-parse.ts`). It is labelled "management view, not your tax books". The OASIS tenant stays on B with the full suite, including invoicing.
- **In v1, clients get no invoicing, payment links or bill pay.** Those are writes to the client's money systems; v2 adds them via a write-scoped restricted key.

### e.3 Data sources
- **Stripe restricted key**:
  - Poll `/v1/events` every 10 min on a cursor (Events read) into the existing idempotent `handleStripeEvent` (`stripe-ingest.ts:911`), so no per-tenant webhook secret is needed.
  - First connect backfills via `reconcileStripe`.
  - The pinned-account confirmation ("This key belongs to acct_X, Name. Is this your business?") reuses `stripe-io.ts:139-170`.
  - Verify that a restricted key can read `/v1/account`; if not, pin the account id from the first event.
- **QBO**: Change Data Capture (CDC) sync plus the Reports API; webhooks verified with the `intuit-signature` HMAC.
- **Xero**: the Reports API; webhooks verified with the `x-xero-signature` HMAC and the intent-to-receive check. **Confirm with Xero that agent reasoning is allowed** under its no-AI-training clause.
- **Plaid** (Trial, 10 Items):
  - Link token → exchange → `bank_connections (tenant_id, provider, item_id, institution, cursor, status, error_code)`.
  - `/transactions/sync` on a cursor; webhooks verified with the `Plaid-Verification` JWT.
  - **Disconnect calls `/item/remove`.** Plaid bills per Item until then, and Law 25 requires destruction.
- **CSV/OFX/QFX**: the tenant uses the existing parser (dedupe hash, max 5K rows).
- **Swappable adapter** `lib/finance-os/bank/adapter.ts {linkStart, exchange, sync, balances, remove}` for plaid, csv, flinks, and a future CDBA-accredited provider.

### e.4 AI CFO views (`app/(os)/finance/*`, pure cores reused)
| View | Computation (deterministic code) | Reused |
|---|---|---|
| Cash | Plaid or QBO bank balances + Stripe balance; always shows "as of" and source | `metrics.ts`, `fx.ts` |
| P&L | QBO/Xero report, or ledger `profitAndLoss` | `reports.ts:82` |
| MRR / churn | `summarizeMrr` over `fin_subscriptions`; new daily `fin_mrr_snapshots` table so churn = MRR canceled ÷ MRR at start of month | `mrr.ts:62-103` |
| Runway | cash ÷ trailing 3-month net burn; shows "not burning" when profitable | — |
| AR | `arAging` over QBO/Xero invoices or Stripe open invoices | `reports.ts:320-349` |
| Per-customer profitability | revenue per customer − attributed ad spend (`funnel_touches` → `ad_insights_daily`) − delivery load (tickets, meetings and project hours × tenant-set cost rate) − pass-through costs. Every assumption is labelled | `metrics-core.ts:114 collectedByCustomer`; new `customer_identity_links (tenant_id, record_id, provider, external_customer_id, match_method, confidence)` |

- Every KPI returns `{value|null, status live|stale|not_connected|error, as_of, source}`, following "unknown is not zero" (`lib/goals/oasis-money.ts:39-44`).
- **Alerts** (`finance_alerts`, daily at 12:00 UTC, with backoff dedupe in the style of Atlas's threshold scanner): cash below N weeks of burn; AR more than 30 days past a threshold; MRR down more than X% week over week; `invoice.payment_failed` (a card only, never an automatic action); unusual transactions; GST/QST small-supplier threshold (`tax.ts:106`); ad spend pacing against the cap.

### e.5 Ownership, advice wording and compliance
- **Atlas owns the numbers.**
  - Metric definitions live in `CFO/docs/FINANCE_OS_METRICS.md`, with golden fixtures that OCC CI runs (`tests/finance-os/metric-definitions.test.ts`).
  - The Finance agent's only numeric tool is `finance_get_metric(metric, period)`, which returns values with their source. The model narrates and never calculates.
  - Bravo never reports MRR. The Today cash card renders directly from the Finance module.
  - Atlas's own client code is still on the unmerged `fix/atlas-toggle-records-intent` branch; merge it before depending on it.
- **Advice wording.** "Decision support, not accounting, tax or legal advice", in FR and EN, reviewed by Lex (UPL gate, `LEX/brain/COMPLIANCE.md`). It appears in the Finance header and the footer of every AI CFO answer. Tax is limited to threshold watching and period summaries, with no filing.
- **Law 25 s.17.** Build a finance PIA annex template plus the DPA. Bank data flows through Plaid, Turso (AWS us-east), Cloudflare and Anthropic, all in the US. The owner accepts a disclosure (`privacy_disclosures` row) before connecting a bank.
- **Retention and access.** Tokens are destroyed on disconnect. Synced transactions are purged at termination or at the configured retention. Every agent read of finance data is written to the immutable `fin_audit_log` (actor `agent:finance` plus the tool). Finance data is never used for training.
- **Commissions (opt-in).** A manifest flag `modules.commissions`. It is OASIS-only in v1, reusing the ledger and payout workflow from migrations 154 and 162, and is generalized per tenant later.

---

## (f) Meetings capture and the data moat

- **Interim capture: Recall.ai.**
  - `/api/cron/schedule-meeting-bots` runs every 10 min. For tenants with meeting capture on, it reads the next 24h of Calendar events through our existing `calendar.events` grant and schedules bots for meetings that match the rules: an external attendee, a Zoom/Meet/Teams link, not private, the host opted in.
  - The bot is named "{Business} Notetaker (recording)" and posts a bilingual chat notice on join (confirm Recall supports this). Tenants also get a snippet to add to their invites.
  - All-party consent is the default everywhere. Any objection removes the bot. Opt-outs are stored in `meeting_capture_optouts (tenant_id, email_hash)`.
  - The Recall webhook is verified with its documented signature scheme; unsigned calls are rejected.
  - On completion: fetch the transcript → R2 at `oasis-os/{tenant_id}/meetings/{id}/transcript.json` → **delete the media at Recall** (transcript only by default).
- **Imports.** Fathom (OAuth or key) and Fireflies (key) feed the same pipeline. The client stays the recording party.
- **Later, native.** Zoom via a General app (`recording.transcript_completed`, `x-zm-signature`, URL validation). Meet via `meetings.space.readonly` transcript entries, pulled within 30 days.
- **`meetings` table**: `tenant_id, source, external_id, title, started_at, duration_s, host_user_id, customer_record_id, attendees_json (names + hashed emails), consent_method bot_visible|chat_notice|invite_notice, transcript_r2_key, summary_md, action_items_json, outcome_labels_json, retention_until, deleted_at`.
- **Processing job**: summary, action items, objections, wins and a sales-call score.
  - Sentiment and voice profiling are **off by default**; they count as profiling under Law 25 s.8.1.
  - Any automated decision about a person gets human review (s.12.1).
- **The moat is per-tenant retrieval.**
  - `knowledge_chunks (tenant_id, source_type meeting|ticket|form|win|doc, source_id, text, embedding)`. Turso vector columns need confirming; FTS5 is the fallback.
  - `retrieve(tenantId, q)` is the only reader, and `tenantId` is mandatory.
  - Outcome labels join the chain ad angle → booked → objection → closed → paid in Stripe.
  - **No cross-tenant training**, because of the Otter ruling and the Google, Zoom, Slack and Xero terms. Cross-tenant benchmarks come later, only from first-party aggregates, with tenant opt-in and at least 10 tenants per bucket.
- **Retention**: transcripts kept 12 months by default, configurable per tenant; `/api/cron/retention-purge` runs daily.

---

## Messaging and comms (locked decision #3)
- **System of record.** `channels` and `channel_messages` come from the shell workstream and use `visibility` (including team-only). This domain adds:
  - `channel_bridges (tenant_id, channel_id, provider slack|discord, external_team_id, external_channel_id, mode notify|two_way)`
  - `external_identities (tenant_id, provider, external_user_id, user_id, linked_at)`, linked through a one-time `/oasis link` magic link, which avoids asking for `users:read.email`
  - `notification_routes (tenant_id, audience owner|team|department:<k>|customer:<id>, channel, target_ref, event_filter)`. This is the per-tenant version of the explicit Telegram lanes, keeping the rule that one lane never falls back to another (`lib/notify/telegram.ts:41-44, 57-64`).
- **Slack as the approval surface.**
  - Block Kit Approve / Send back buttons go to `/api/webhooks/slack/interactivity`, verified with `X-Slack-Signature` v0 and a 5-minute timestamp window.
  - The server maps the clicker to their linked OASIS user, runs the same permission check as the app, and executes the approval exactly once through the approval state machine.
  - Team-only threads are never mirrored.
  - In v1.1, Slack replies come back as `channel_messages` labelled "via Slack", using events only, never history backfill.
- **`approvals` contract (shared with the Feed workstream)**: `tenant_id, department, kind, title, preview_json, payload_json, payload_hash, risk low|outbound|spend|data, requested_by, status pending|approved|sent_back|expired|executed|failed, decided_by, decided_via app|slack|discord, decided_at, execution_result_json, expires_at, idempotency_key`.

---

## Connector table

| Connector | Wave | Auth | Tables / files | Department | Approval clock | Verification |
|---|---|---|---|---|---|---|
| Stripe (read-only restricted key) | 1 | `rk_live_` key pasted by client, read-only permissions; `sk_` rejected | `tenant_connections`, vault (key id `fin`), `fin_*`+`tenant_id`, `fin_stripe_events`; `lib/connections/providers/stripe.ts`; `app/api/cron/sync-stripe-events` | Finance, Sales, Today | none (days) | probe → pinned-account confirm; `tests/connections/stripe-rak.test.ts` (rejects `sk_`, blocks the same account on a 2nd tenant); OASIS-tenant MRR equals the Stripe dashboard |
| Stripe App OAuth | 3 | Stripe App OAuth | same | Finance | about 4 business days per version; 25-account test cap | signed webhook on a test account |
| Google Calendar | 1 pilot, then 2 | OASIS OAuth client, `calendar.events` (incremental) | `user_integration_credentials`, `call_appointments`; parameterized `lib/integrations/google-calendar.ts` | Schedule/Today, Sales, Client Success | sensitive 1-4 wks (100-user cap until then) | `google-token-probe` healthy; create and cancel an event on a sandbox calendar |
| Gmail send | 1 pilot, then 2 | `gmail.send` only (no readonly for clients) | `lib/integrations/gmail-oauth-send.ts` | Sales, Client Success | sensitive 1-4 wks | scope-builder test (never readonly for a non-OASIS tenant); dry-run then live send to a seed inbox |
| Gmail read | 3 | restricted + CASA | — | Client Success | 6-12 wks + annual CASA | deferred (App Password IMAP for pilots) |
| Drive | 1 | `drive.file` + Picker | `knowledge_chunks`, R2 | Content, Client Success, Playbook | brand verification only | picked file retrievable in its own tenant only |
| Google Meet | 2 | `meetings.space.readonly` + Workspace Events | `meetings`, R2 | Client Success, Sales | 2-4 wks | transcript entries pulled within 30 d |
| GoHighLevel | 1 (≤5 agencies) | Marketplace private app OAuth, location token | `tenant_records` (source=ghl), `call_appointments`, `provider_webhook_routes` | Sales, Marketing | none ≤5; Security Review beyond | double import is idempotent; webhook signature check (confirm scheme) |
| Calendly / Cal.com | 1 | OAuth 2.1 / API key | `call_appointments` | Sales, Schedule | none / Cal.com OAuth admin approval | signed webhook creates booking |
| Fathom / Fireflies | 1 | OAuth or key / key | `meetings` | Client Success, Sales | none | webhook → `meetings` row with source |
| Recall.ai | 1 | OASIS API key + our calendar read | `meetings`, `meeting_capture_optouts`, `usage_events` | Client Success, Sales | vendor DPA only | test call: visible bot, bilingual notice, transcript in R2, media deleted |
| QuickBooks Online | 1 (sandbox) | Intuit OAuth2, GET-only in code | `fin_ext_*`, `tenant_connections` (realmId) | Finance | assessment 1-3 wks | sandbox P&L mirror equals QBO report totals |
| Xero | 1 (≤5) | OAuth2 read scopes + `offline_access` | `fin_ext_*` | Finance | Starter none; Core certification | demo company parity; written confirmation that agent reasoning is allowed |
| Plaid | 1 (Trial) | Link → `access_token` (key id `fin`) | `bank_connections`, `fin_bank_transactions` | Finance | Trial same day; paid 1-3 wks | sandbox sync cursor idempotent; `/item/remove` on disconnect |
| CSV / OFX / QFX | 1 | upload | `fin_imports`, `fin_bank_transactions` | Finance | none | `import-parse` fixtures, dedupe |
| Flinks | 3 | Flinks Connect | `bank_connections` | Finance | 4-8 wks + contract | — |
| Meta (partner pilot) | 1 | client adds OASIS BM as partner → system user token | `ad_accounts`, `ad_entities`, `ad_insights_daily` | Marketing, Finance (CAC) | immediate (Limited tier) | 7-day insights match Ads Manager |
| Meta Ads + Lead Ads | 2 | Facebook Login for Business | same + leadgen webhook | Marketing, Sales | Business Verification + App Review + Tech Provider: 3-8 wks | Lead Ads Testing Tool lead → `tenant_records`; `X-Hub-Signature-256` test |
| Meta Ad Library | 2 (EU/UK only) | identity-confirmed user token | `competitor_observations` | Research | 1-2 wks | EU query returns ads |
| Twilio (ISV) | 2 | sub-account + Trust Hub + A2P / toll-free verification | `sms_registrations`, `channel_accounts`, `contact_consents`, `suppressions`, `usage_events` | Sales, Client Success, Marketing | build 2-4 wks; 1-3 wks per tenant | inbound verified with sub-account token; STOP → suppression → send blocked (test) |
| Slack | 2 (unlisted from day 1) | OAuth v2: `chat:write`, `commands` | `channel_bridges`, `external_identities`, `notification_routes` | all (surface), Operations | none unlisted; Marketplace about 2-3 months | double-click Approve executes once |
| Zoom | 2 | General OAuth app | `meetings` | Client Success, Sales | 3-6 wks | URL-validation + `recording.transcript_completed` |
| Late / Zernio | 2 | OASIS key + tenant profile | `content_publish_intents` | Content | none | post scheduled to a sandbox profile |
| Google Ads | 3 | OAuth + developer token | `ad_*` (platform=google) | Marketing | developer token review (unverified) | — |
| AI managed | 0-1 | OASIS key in a dedicated Anthropic workspace | `ai_usage_events`, `tenant_ai_budgets`, `model_prices` | all | DPA only | budget reservation race test; cap → 402 |
| AI BYO key | 1 | `agent_model_config` | same | all | none | existing `test-connection` |
| AI subscription | 3+ | official provider OAuth only | `ai_subscription_links` | all | provider terms | — |

---

## Build plan and effort (human team / CC+Bravo; approval calendar time runs in parallel)

| Workstream | Human team | CC+Bravo |
|---|---|---|
| W0 safety (env deny, decryption fail-closed, encryption v2 + rewrap, single-use state, tenant send switches, `inferForTenant` + 14 callers, tool default-deny) | 2 wks | 3-4 days |
| Connections framework (tables, generic OAuth, compare-and-set token store, health cron, hub UI) | 3-4 wks | 5-7 days |
| W1 connectors (Stripe, Google split, GHL, Calendly/Cal.com, Fathom/Fireflies, QBO/Xero, Plaid/CSV) | 6-8 wks | 2-2.5 wks |
| Managed AI runtime (adapter, metering/budgets, sandbox, department chat, `agent_jobs`) | 4-5 wks | 1.5-2 wks |
| Routines (workflow-steps revival, runs, sandbox, quality gate, triggers) | 3-4 wks | 1 wk |
| Finance re-tenant + AI CFO views + alerts + Atlas fixtures | 5-6 wks | 1.5-2 wks |
| Twilio ISV + A2P wizard + consent ledger + chokepoint | 3-4 wks | 1-1.5 wks |
| Meta (partner pilot, insights, leadgen, PAUSED approvals, scorecard) | 4-5 wks | 1.5 wks |
| Funnels analytics + competitor research + content queue port | 3-4 wks | 1 wk |
| Meetings (Recall pipeline, consent, retrieval) | 2-3 wks | 4-5 days |
| Slack bridge (notify + approvals + linking) | 2 wks | 3-4 days |
| VPS runner (internal claim API, PM2, allowlisted binaries) | 1.5-2 wks | 3-4 days |
| Compliance pack (PIA annex, DPA, bilingual notices; Lex review then lawyer) | 2 wks | 2-3 days drafting |
| **Total** | about 14-16 wks (3 engineers) | about 8-10 wks |

**Repo rules at execution time**
- Lease every shared path with `coord_claim`.
- Reserve these migration groups: M-CONN, M-AI, M-FIN, M-MSG, M-MKT, M-MEET.
- Register every new cron in `workers/oasis-cc-cron/src/index.ts` and `config/cron-registry.json`. Cloudflare cron schedules are UTC. The new routes are connection-health, sync-stripe-events, sync-accounting, sync-bank, sync-ad-insights, dispatch-agent-jobs, schedule-meeting-bots, finance-alerts, mrr-snapshot, ai-budget-rollup, sms-registration-status and retention-purge.
- Push secrets with `wrangler_tool secrets-push`, with the names added to the manifest: `CONNECTIONS_OAUTH_STATE_SECRET`, `BRAVO_FIELD_ENCRYPTION_KEYS`, `OASIS_MANAGED_ANTHROPIC_API_KEY`, `META_APP_ID/SECRET`, `META_SYSTEM_USER_TOKEN`, `GHL_CLIENT_ID/SECRET`, `INTUIT_CLIENT_ID/SECRET/WEBHOOK_VERIFIER`, `XERO_CLIENT_ID/SECRET/WEBHOOK_KEY`, `PLAID_CLIENT_ID/SECRET/ENV`, `RECALL_API_KEY/WEBHOOK_SECRET`, `TWILIO_ISV_ACCOUNT_SID/AUTH_TOKEN`, `SLACK_CLIENT_ID/SECRET/SIGNING_SECRET`, `CALENDLY_CLIENT_ID/SECRET/WEBHOOK_KEY`.
- Codex reviews every money-path or tenant-isolation diff (Rule 8).

## Needs from CC
1. **oasisai.work.** Confirm renewal and billing so the Meta and Google verifications can start on day 1.
2. **Default model.** Approve the Phase-1 eval that picks it (Opus 5 at low/medium effort vs Sonnet 5), plus the Anthropic DPA and a dedicated workspace.
3. **Finance book modes.** Approve mirroring QBO/Xero first and OASIS management books for clients without accounting software.
4. **Competitor research.** No automated scraping of the Ad Library UI (my recommendation): yes or no.
5. **VPS for the runner.** Name the box; srv1723601 is not recommended.
6. **Slack scope.** v1 is notifications and approvals only; two-way comes in v1.1 with events-only history.
7. **Recording default.** Transcripts only, media not retained, 12-month retention.