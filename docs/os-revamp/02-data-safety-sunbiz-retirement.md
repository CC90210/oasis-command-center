# OASIS OS: data model, tenant safety, and SunBiz retirement (design)

**Baseline.** Code references are to local `origin/main` 20732c31 (2026-09-27). `git ls-remote` shows remote main is now 5db8551a (#462 merged 2026-09-28 17:05Z), so re-check line numbers in a fresh worktree. Live figures come from read-only aggregate queries run through `BEA/scripts/integrations/turso_tool.py sql` on 2026-09-28 at about 17:46Z; I selected no personal data. No files were changed.

---

## 0. New findings that change the plan (all verified)

| # | Finding | Evidence |
|---|---|---|
| F1 | **SunBiz is still sending today.**<br>• 319 SunBiz outbound messages in the last 7 days, 42 since 09-27, the latest at **2026-09-28T12:06:15Z**. The biggest source is "sequence: Viewed application nudge" (160 this week).<br>• Some rows carry Python-style timestamps (`…18:17:18.655925+00:00`, "Signed application — bank statement"; `shop_out_sender` on 09-24). That means the VPS `send_gateway` is alive even though SSH is refused.<br>• 10 SunBiz drip sequences are enabled, 730 drip runs are scheduled or sending, and 6 tenant crons are enabled.<br>• **No other tenant has any drip_sequences**, so a global drip kill switch only affects SunBiz. | live Turso aggregates |
| F2 | **`/api/quests` is public** and returns 55 rows of CC's ACTIVE_TASKS (`oasis_quests`) to anyone on the internet. | `middleware.ts:80`, `app/api/quests/route.ts:23-50`, live count 55 |
| F3 | **`/api/state-health` leaks operator data** to any signed-in member of any tenant:<br>• the latest `session_logs.summary` (route.ts:134-141, returned at :176-180)<br>• `agent_state_snapshot.working_memory.last_focus` for any agent name the tenant's manifest enables (:107-115, :145). Agent names such as "bravo" are shared by every tenant.<br>`/system-health` renders this with no gate. | `app/api/state-health/route.ts`, `app/system-health/page.tsx` |
| F4 | **Operator identity is an unverified email.**<br>• `isOperatorEmail` (`lib/operator-credentials.ts:29-41`) trusts the session email checked against DEFAULT_OPERATOR_EMAIL, OPERATOR_EMAIL and ADMIN_EMAILS.<br>• `turso-signup` gives a session to any email with no confirmation step (route.ts header lines 1-16, :81-95, :107, :133).<br>• Any configured admin or operator alias that has no live auth user can therefore be registered by a stranger, who then gets operator access to every tenant.<br>• I could not see the env values (secret_guard), so each alias has to be checked when the fix is executed. | code |
| F5 | **`/api/pg/rest/v1/*`** is a PostgREST-style bridge over the whole bravo database.<br>• Public (`middleware.ts:41`) and gated only by a bearer token (`TT_PG_BRIDGE_TOKEN`, `APEX_PG_BRIDGE_TOKEN`).<br>• It protects tables with a *denylist* (route.ts:66-90).<br>• It exists for SunBiz's TextTorrent runtime (`jarvis`, running in Docker on the VPS). | code + Worker manifest key names |
| F6 | **753 SunBiz application records contain full SSNs in plaintext** in `tenant_records.data.owner_ssn`, by design (`lib/applications/promote-lead-to-application.ts:43-80`). There are also 5,461 lead documents (≈4,088 bank statements) in R2 under `lead-documents/aa04fa1f-…/`. | live count, `lib/r2-storage.ts:58-59` |
| F7 | **`BRAVO_FIELD_ENCRYPTION_KEY` is also on the SunBiz VPS.** The scrubber writes `owner_ssn_enc` "byte-compatible with lib/field-encryption.ts" (promote-lead-to-application.ts:45-49), and we cannot log into that box. Rotating the master key is therefore part of retiring SunBiz, not just hygiene. | code |
| F8 | **The migration-number allocator cannot see OCC.**<br>• `BEA/scripts/check_migration_collision.py:48` scans only BEA's `database/` and `database/turso_migrations/`. OCC migrations live in OCC `database/turso/` (latest is 185).<br>• APEX's PR #463 (opened today) adds `database/112_feature_health.sql` *outside* `database/turso/`. Per the header of migration 183 (lines 3-9), files there are never applied. | code |
| F9 | Two branches with unlanded work:<br>• `fix/tenant-boundary-guards` is pushed (6b7ebe14) but has **no PR**.<br>• `audit/oasis-ribbon-final` exists **only locally**, with 56 modified and 5 untracked files, 241 commits behind main. It is the only copy of the per-user agent authorization and a signed website-sales Stripe webhook. | `git ls-remote`, `git status` |
| F10 | Two issues that are latent rather than live:<br>• 0 user_profiles lack a live auth user, so the email-based profile relink in `lib/auth-provisioning.ts:67-78` cannot be exploited today.<br>• 0 `tenant_manifests` rows have a NULL tenant_id, so the null-tenant claim branch at `guards.ts:73` can be closed at no cost. | live |

---

## 1. Order of operations and effort

| When | Workstream | Human team | CC+Bravo |
|---|---|---|---|
| **Day 0 (hours)** | C-1: freeze SunBiz outbound (DB flags plus kill switches; reversible) | 0.5-1 day | 2-3 h + CC one-tap go |
| Day 0-2 | D: in-flight triage (land #457, #434 send-mode, guard cherry-picks, salvage the ribbon worktree); notify APEX and Adon | 3-5 days | 1-1.5 days + APEX turnaround |
| Week 1 | A: Phase-0 tenant safety (includes rotating the encryption key) | 2-3 wks | 4-6 days |
| Weeks 1-3 (calendar set by CC and the client) | C-3 export → CC decision; C-2 VPS once the key is restored; C-4 credentials and users; C-5 domains | 2-3 wks | 3-4 days |
| Weeks 2-4 | C-6: harvest the generic engines and delete funding-only code; C-3 deletion after CC's go; drop funding tables | 3-4 wks | 5-7 days |
| Weeks 3-5 | Split the database (after the SunBiz purge, before any outside tenant writes data) | 3-4 wks | 5-7 days |
| Weeks 3-6 | B: core data-model migrations, data-access layer and isolation test harness (no UI) | 4-6 wks | 1.5-2 wks |

Rule 8 applies: a Codex independent review is required on every tenant-isolation, money-path and deletion diff.

---

## 2. (a) Phase-0 tenant-safety work list

Leases are required on `app/api/**` and `database/**` (shared). `middleware.ts`, `lib/manifest/**` and `tests/**` are Bravo-owned.

| ID | Where | Problem | Fix | Test |
|---|---|---|---|---|
| **P0-1** Env credential fallback | `lib/tenant-integration-store.ts`:<br>• `ENV_FALLBACKS` :84-157, aliases :162-167<br>• `tenantMayUseEnvFallback` :192-203 (**:193 returns `true` for every service except Stripe**)<br>• `getTenantIntegrationValue` :226-233 (**a decrypt failure falls through to env**)<br>• bundle :262-266<br>• status :303, :430, :454 | Any tenant with no keys of its own sends through OASIS or SunBiz env accounts (Kixie, TextTorrent, Gmail, SMTP, n8n, Late, Telegram, Constant Contact, send_gateway HMAC). | • Replace the Stripe-only set with an **allowlist of tenant ids** (`ef8d389e…` oasis-ai-cc and `42423fde…` oasis-webdev; resolve by **id**, not slug) applied to **every** service.<br>• The SunBiz lane is removed, because SunBiz is retired.<br>• A decrypt failure returns `null` and logs a loud error, never env.<br>• Non-allowlisted tenants report `source:null` ("not connected").<br>• Also convert the direct env readers that bypass the store: `lib/routing/provider-availability.ts:150-158` (provider availability from global env presence becomes per-tenant); `app/api/webhooks/twilio/sms-inbound/route.ts:299` (env auth token used for signature verification becomes per-connection only); `lib/sms/twilio-inbound.ts:192-201` (the `TWILIO_TENANT_ID` fallback is number-matched and low risk, but moves to the connection registry in B). | Extend `tests/stripe-env-fallback-oasis-only.test.ts` (from #459) into a table-driven `tests/env-fallback-oasis-only.test.ts`: for each service in ENV_FALLBACKS, a non-OASIS tenant with env set gets `null`, an OASIS tenant gets the env value, a corrupt ciphertext gets `null` and an error, and an unknown id gets `null`. |
| **P0-2** Unsigned provisioning webhook | `app/api/webhooks/stripe-provision/route.ts:4-40`: takes `tenant_id` from the body (:17) and writes "Payment confirmed" (:21-25); public via `/api/webhooks/` (`middleware.ts:108`) | Anyone can forge provisioning progress for any tenant, and the wizard displays it (`app/onboarding/wizard/page.tsx:48`). | **Delete the route now.** It is a simulation, and `provisioning_runs` has 0 rows. In Phase 2, rebuild it as `/api/webhooks/stripe-billing`:<br>• Verify the signature with the verifier extracted from `lib/founders-finances/stripe-signature.ts` into shared `lib/stripe/signature.ts` (the founders portal is a portal, so the boundary test forbids importing it).<br>• Make it idempotent on `event.id` (a `billing_events` table with UNIQUE(event_id)).<br>• It creates a **provisioning grant**, never a tenant. | `tests/stripe-provision-removed.test.ts`: the route file is absent and no code references `startProvisioningRun`. Later, `tests/stripe-billing-webhook.test.ts`: a bad signature returns 400, a replayed event is a no-op, and a verified event produces a grant and no tenant. |
| **P0-3** Manifest slug claim | `lib/manifest/guards.ts`:<br>• :19-24 `PROTECTED_SLUGS` = default/oasis/sun/suga only<br>• :72 no row → OK (first writer claims it)<br>• :73 NULL tenant → OK | Any tenant admin can claim `oasis-ai-cc` or `oasis-webdev` (a seed with no DB row), after which CC's tenant renders the claimer's manifest. | • Cherry-pick **b478c58b** (`unclaimedSlugGuard`, fails closed on lookup error) onto fresh main.<br>• Additionally make the NULL-tenant branch (:73) fail closed; 0 such rows exist live.<br>• Add `oasis-ai-cc`, `oasis-webdev`, `submissions` and `sunbiz` to PROTECTED_SLUGS. | `tests/manifest-slug-claim-guard.test.ts` from that branch (126 lines), plus a new case where a NULL-tenant row is refused. |
| **P0-4** Unknown slug falls back to CC's nav | `lib/manifest/seeds.ts:892-903` (`default`/`oasis` → OASIS_SEED; `getSeedManifest` returns `SEED_MANIFESTS[key] \|\| OASIS_SEED`); `lib/manifest/loader.ts:64` | 48 self-signup tenants see CC_NAV today, including the founders and web-leads rows. | • Add an explicit `UNPROVISIONED_SEED`: Profile, Team and one "Your workspace is being set up" page.<br>• Unknown slugs get that seed. `default` and `oasis` map to OASIS_SEED **only if the resolved tenant id is on the OASIS allowlist**.<br>• The OASIS OS client seed ships as its own seed or template (a separate plan). | `tests/manifest-unknown-slug-fail-closed.test.ts`: `getSeedManifest("anything-new")` contains no `/founders`, `/web-leads`, `/commissions` or `/operations` path. Also snapshot the nav for each of the 3 real seeds. |
| **P0-5** Admin surfaces without a gate | • `app/runs/page.tsx:18-30` (no gate; reads `agent_events` by correlation_id, `lib/queries.ts:811-824`)<br>• `app/reasoning/page.tsx:15`<br>• `app/system-health/page.tsx` (no gate) and `app/api/state-health/route.ts` (F3)<br>• `app/inbox/page.tsx:14` (checks operator status only for rendering)<br>• the WORKER persona has `canSeeSystemSurfaces: true` (`lib/role-surfaces.ts:~317-333`) | Hiding a nav row does not enforce anything, and operator data reaches client members. | • New `requireOperator()` in `lib/role-surfaces-session.ts` returns 404 unless the caller is an operator by **auth user id** (see P0-7), and it runs before any query.<br>• Apply it to `/runs`, `/reasoning`, `/system-health`, `/inbox`, `/operations`, `/agents` and `/api/state-health`. `/api/state-health` returns 404 for non-operators, and the `session_logs` and `working_memory` fields are removed from any non-operator branch entirely.<br>• These pages move to `/admin/*` in the shell work. The client-facing "Operations" becomes the department tab. | `tests/admin-surfaces-operator-only.test.ts`: with a non-operator session each page module or route returns notFound or 404. A static check asserts every `app/(admin)/**/page.tsx` calls `requireOperator()` as its first statement, modelled on `tests/portal-boundaries.test.ts`. |
| **P0-6** Public operator data | `/api/quests` (`middleware.ts:80`, `route.ts:23-50`) | 55 of CC's task rows are public. | Remove it from `PUBLIC_PATH_PREFIXES` and require a bearer token (OASIS Town) or operator. If OASIS Town is dead, delete the route. | Extend `tests/middleware-prefix.test.ts` with `/api/quests` not public, and an unauthenticated GET returns 401. |
| **P0-7** Operator identity by unverified email | `lib/operator-credentials.ts:29-41`; `app/api/auth/turso-signup/route.ts:81-133` | Anyone who registers an unclaimed admin or operator alias becomes an operator (F4). | **Now:** a one-off wrapper `scripts/audit-operator-emails.ts` that prints, for each configured alias, only whether it is set and whether a live auth user exists. It never prints values. Any alias without an auth user is removed from env today.<br>**Fix:** `isOperatorUser(authUserId)` reading a `platform_operators(auth_user_id, granted_by, granted_at, revoked_at)` table, resolved by auth id the way `lib/founders-finances/access.ts` already does. `isOperatorEmail` stays only for display. | `tests/operator-identity-auth-id.test.ts`: a session whose email matches but whose auth id is unknown is not an operator; a revoked operator is refused. |
| **P0-8** Open signup | `/signup` + `turso-signup` (no invite required, no email proof) → `/api/auth/provision` → `provisionAuthenticatedUser`:<br>• relinks by email (`lib/auth-provisioning.ts:67-78`) regardless of the existing `auth_user_id`<br>• calls `signup_tenant` (:96)<br>• picks a shell from brand text (`lib/client-profiles.ts:193-217`, `lib/client-provisioning.ts:41-70`) | Strangers can create tenants; latent account takeover; a "Sunrise Funding" signup gets the SunBiz shell. | • `turso-signup` requires `invite_token` **or** `grant_token`. Both are delivered by email, which proves ownership of the address.<br>• `/api/auth/provision` creates a tenant **only** by consuming a `tenant_provisioning_grants` row (created by an operator in Admin, or later by the verified billing webhook). The grant carries `industry_pack`, `plan_tier` and `email`.<br>• The email relink is allowed only when `auth_user_id IS NULL` **and** the session came from an invite or grant for that email.<br>• Delete the brand-text shell matching.<br>• The 48 existing self-signup tenants get UNPROVISIONED_SEED (P0-4); CC decides later whether to keep them dormant or delete them. | `tests/signup-invite-only.test.ts`: signup with no token returns 403; a grant token for another email returns 403; provision without a grant creates no tenant; relink over a non-null auth_user_id is refused. |
| **P0-9** Revenue goal visible to everyone | `app/api/goals/route.ts:20-33` (any member, including commission-only reps) | Company money is exposed. | Gate the GET on `capabilities.canSeeCompanyFinancials` (`resolveViewerSurface`); others get 404. | `tests/goals-route-persona.test.ts`: rep and worker get 404; founder and manager get 200. |
| **P0-10** `lead_interactions` with NULL tenant | 752 NULL rows live. Sources:<br>• the reservation fallback in `BEA/scripts/integrations/send_gateway.py:2165-2196`, which inserts with no tenant<br>• :2340-2346, which stamps the tenant only when resolved | Orphan personal data with no owner can be neither shown nor purged. | • `send_gateway`: resolve the tenant **before** reserving and refuse to write without one, failing loudly.<br>• Backfill script (dry run by default): join `lead_id` to `tenant_records`/`leads`; move unresolvable rows to `lead_interactions_orphans` (operator-only).<br>• Then add a `BEFORE INSERT` trigger that raises ABORT when `NEW.tenant_id IS NULL`. SQLite cannot add NOT NULL to an existing column without a rebuild, and the trigger enforces the same thing. | BEA `scripts/tests/test_send_gateway.py`: a reservation without a resolvable tenant returns an error and writes nothing. OCC `tests/lead-interactions-tenant-required.test.ts` (in-memory libSQL): an insert without a tenant fails. |
| **P0-11** `agent_events` has no tenant_id | Scoped by `correlation_id` (`tests/agent-events-tenant-scope.test.ts`); 28 call sites | Scoping relies on convention, and one producer that sets correlation_id to something else breaks it. | • `ALTER TABLE agent_events ADD COLUMN tenant_id TEXT`, plus an index on `(tenant_id, published_at)`.<br>• Backfill where `correlation_id` is in `tenants.id`.<br>• Producers write `tenant_id` (`lib/action-log.ts:24`, `lib/manifest/events.ts:88,113`, the kixie/texttorrent writers are deleted with SunBiz), and readers switch to it.<br>• **The OS does not use agent_events.** It uses `outcome_events` and `channel_messages` (B). | Extend `tests/agent-events-tenant-scope.test.ts` so filtering is on `tenant_id`, and a row with a foreign correlation_id is invisible. |
| **P0-12** One master encryption key, no rotation | `lib/field-encryption.ts:8-35` (scrypt of one env passphrase, fixed salt :20); `encryptField` :37-45 has no AAD, so ciphertext is not bound to its row; the same key is on the VPS (F7) | Cannot be rotated, key compromise is plausible, and ciphertext can be copied between tenants. | **Format v2** `v2.<kid>.<iv>.<tag>.<ct>`:<br>• AAD = `table:tenant_id:service:field_key`.<br>• Keyring env `FIELD_KEYS` (kid → key) and `FIELD_KEY_ACTIVE`, pushed through `wrangler_tool secrets-push`.<br>• Legacy 3-part blobs still decrypt as v1.<br>**Rotation script** `scripts/rotate-field-encryption.ts`: dry run by default, batched, compare-and-swap on the old ciphertext. It covers `tenant_integration_credentials.encrypted_value`, `user_integration_credentials.encrypted_value`, `agent_model_config.encrypted_api_key`, the cold-sending mailbox `app_password_enc` (`lib/integrations/cold-sending.ts:223`) and pairing secrets (`app/api/auth/pair/route.ts:310`).<br>**Python parity:** `BEA/scripts/integrations/field_encryption.py`.<br>**Later (B):** per-tenant data keys in `tenant_keys` so a tenant can be crypto-shredded on offboarding.<br>**Order:** rotate *after* SunBiz's credential rows are deleted, so the VPS copy becomes useless. | `tests/field-encryption-v2.test.ts`: v1 decrypts; v2 round-trips; an AAD mismatch fails; an unknown kid throws loudly; rotation is idempotent. Python↔TS golden-vector parity test. |
| **P0-13** `client_health.py` reads across tenants | `BEA/scripts/client_health.py:294` (`leads` where `status='client'`, no tenant filter) | Mixes tenants in CC's daily brief. | Add `.eq("tenant_id", OASIS_TENANT_ID)` (import the constant BEA already uses in `lead_engine`). The per-tenant client-health rebuild comes in B. | `scripts/tests/test_client_health_tenant_scope.py`: rows from another tenant are excluded. |
| **P0-14** Bridge reachable by SunBiz | `lib/bridge-proxy.ts:253` (`slug !== "submissions" && !isOperator`) | Exposes shell and file-write tools. | After C-4 deactivates SunBiz users, make it operator-only by auth id (P0-7). | `tests/bridge-proxy-operator-only.test.ts` |
| **P0-15** PG bridge | `app/api/pg/**` + `middleware.ts:41` | A leaked token exposes nearly the whole database. | Delete it in C-6 once APEX confirms `APEX_PG_BRIDGE_TOKEN` has no non-SunBiz caller. Until then, cherry-pick 61e061c3 (pins the TextTorrent token to SunBiz rows). | `tests/middleware-prefix.test.ts`: `/api/pg` is not public. |
| **P0-16** No database write guard | `lib/turso-postgrest.ts` has no tenant guard (the Python `db_turso` has one) | Every hand-written `.eq('tenant_id')` is a single point of failure (861 of about 1,447 `.from(` calls). | Add a write guard in the TypeScript adapter: inserts and updates on tables registered as tenant-scoped must include `tenant_id`, and updates and deletes must filter on it, or the call throws. Mirror BEA `lib/db_turso` (170 tenant-scoped tables). | `tests/turso-adapter-tenant-guard.test.ts` |

### Should client data live in a separate Turso database? Yes.

Today OCC's single `bravo` database (262 tables) holds:
- **Operator data:** `memories*`, `session_logs`, `agent_state*`, `coord_claims`, `drift_*`, the empire `cron_jobs`, `skills_registry`, `oasis_movies_*`, `oasis_quests`.
- **Money and auth:** the founders' `fin_*` books and the auth tables.
- **Every tenant's product data.**

The Worker holds a token for that whole database, so one missing filter or leaked bridge token exposes Bravo's memory and the founders' books along with client data. The name `oasis` is already taken by the legacy oasis-platform database (`BEA/database/turso_migrations/oasis__000_master_schema.sql`).

| Option | What it is | Completeness |
|---|---|---|
| A | Stay on one database and rely on hand-written filters plus P0-16 | 5/10 |
| **B+ (recommended)** | New **`oasis-os` product database** holding everything a tenant owns or signs in with (tenants, auth, profiles, manifests, `tenant_records`, forms, lead_*, conversations, drips, e-sign, chat, credentials, tenant crons, re-tenanted `fin_*`, and every new OS table).<br>`bravo` becomes Bravo's own operational data only.<br>A data-access layer `dbFor(tenantId)` returns the product client today and can later route one tenant to a **dedicated database ("cell")** for Managed-tier or regulated clients with no code change. | **9/10** |
| C | A database per tenant, starting now | 7/10: strongest isolation, and offboarding becomes one `turso db destroy`, but it means retrofitting about 1,447 call sites and running every migration across N databases. Revisit at about 25 tenants or the first regulated client. |

**Why do it now:**
- Once SunBiz's data is exported and purged, product data shrinks to OASIS's own records (about 2.7K `tenant_records`) plus 48 empty self-signup tenants. The copy is small today and grows with every pilot.
- The SunBiz purge itself (about 60 tables, section 4) shows how costly row-level offboarding is on shared tables.

**How:**
1. Create `oasis-os` and apply the schema of the moved tables plus the new OS migrations.
2. Run a 15-minute write freeze. The writers are the Worker, BEA Python (the OASIS sales engine: `inbound_classifier`, `lead_engine`, `send_gateway`) and APEX tools.
3. Copy, then verify per table: row counts plus a hash of sorted primary keys.
4. Flip configuration:
   - OCC `TURSO_DATABASE_URL` points to `oasis-os`.
   - A new `OPERATOR_TURSO_*` with a **read-only, database-scoped** token serves `/admin` only.
   - BEA `lib/db_turso` gets a table-to-database map.
5. Keep the moved tables in `bravo` read-only for 14 days, then drop them with a reviewed migration.
6. The P0-16 guard refuses product-table access on the operator client and operator-table access on the product client.

**Other placement decisions:**
- **Region:** Turso has no Canadian region, so list the chosen US region in the Law 25 s.17 privacy impact assessment annex.
- **Files:** use a dedicated **R2 bucket `oasis-os-files`** with a scoped token and a per-tenant prefix `t/<tenant_id>/…`. Today one bucket is shared by four apps and relies on a public-prefix allowlist (`lib/r2-storage.ts:71-81`).

**Effort:** 3-4 wks for a human team, 5-7 days for CC+Bravo, including APEX coordination and the BEA remap.

---

## 3. (b) Core data model for OASIS OS

### 3.1 Conventions (all binding)

- **Placement:** every table lives in `oasis-os`. `tenant_id TEXT NOT NULL`, every index **starts with tenant_id**, and ids are `lower(hex(randomblob(16)))`. Timestamps are ISO-8601 UTC strings written by the app, following `database/turso/183`.
- **No CHECK constraints on enum columns.** Allowed values live once in `lib/os/rules.ts` and are pinned by tests (the 183 rationale: SQLite cannot alter a CHECK without rebuilding the table).
- **Visibility fails closed:** `visibility TEXT NOT NULL DEFAULT 'internal'`, and clients or portal users are served from an allowlist (`= 'client'`).
- **Idempotency:** everything that ingests external data has `UNIQUE(tenant_id, source, source_ref) WHERE source_ref IS NOT NULL`.
- **External-id routing:** anything routed to a tenant by an external id (Slack team or channel, Stripe account, Twilio number or subaccount, QBO realm) also has a **global** unique index on `(provider, external_id)`, so an inbound webhook can resolve to exactly one tenant.
- **Access rule:** all access goes through `lib/os/db.ts`. `tenantScoped(ctx)` takes `tenantId` from the resolved session, never from the request body, and injects it into every WHERE and INSERT. A static test forbids raw `.from(` or `db.execute(` in `lib/os/**` and `app/(os)/**`.
- **Isolation harness:** `tests/os-tenant-isolation.test.ts` runs every repository function against **real in-memory libSQL** (`file::memory:`) seeded with tenants A and B, and asserts B never reads or mutates A's rows. The pattern follows `tests/agent-events-tenant-scope.test.ts`, which uses real filtering, not spies.
- **Migrations:** OCC's `database/turso/` keeps the bravo-database migrations (next free number ≥186). A new directory `database/oasis-os/` uses prefix `oasisos__NNN_`, starting at 001.
  - Reserve every number with `python scripts/check_migration_collision.py reserve <n> --prefix <p> --task "<t>"`.
  - That script needs its `DIRS` (:48) extended to OCC's `database/turso` and `database/oasis-os` (F8). It is a shared tool, so per Rule 10 I propose the change for CC's yes rather than making it.
  - Until then, confirm each number by hand with a listing in OCC.

### 3.2 Control plane

These tables sit in `oasis-os` after the split and in `bravo` until then.

| Table / change | Columns (beyond id, tenant_id, created_at, updated_at) | Keys and indexes | Notes |
|---|---|---|---|
| `tenants` (ALTER) | `lifecycle TEXT NOT NULL DEFAULT 'active'` (active\|frozen\|offboarding\|retired), `industry_pack`, `pack_version`, `data_cell TEXT DEFAULT 'shared'`, `product TEXT DEFAULT 'oasis_os'` | — | ALTER ADD with a constant default is legal. `lifecycle` is the **durable, database-level freeze**. Session resolution, `isDryRun`, `send_gateway.can_act` and every cron check it. |
| `tenant_provisioning_grants` | `email, plan_tier, industry_pack, source(operator\|billing), stripe_checkout_session_id, token_sha256, expires_at, consumed_at, consumed_tenant_id, created_by` | UNIQUE(token_sha256) | P0-8. `tenant_id` is NULL until the grant is consumed; this is the one allowed exception. |
| `platform_operators` | `auth_user_id, granted_by, granted_at, revoked_at` | PK(auth_user_id) | P0-7 |
| `support_access_grants` | `operator_user_id, scope, reason, granted_by, expires_at, revoked_at` | (tenant_id, expires_at) | Replaces silent operator preview. Every preview has a grant and a `tenant_audit_log` row (Law 25 accountability). |
| `tenant_keys` | `kid, wrapped_dek, created_at, destroyed_at` | (tenant_id, kid) | Per-tenant data key, wrapped by the master key (P0-12). Destroying it crypto-shreds the tenant's encrypted fields, including copies in backups. |
| `industry_packs` (platform catalog, no tenant_id) | `key, version, manifest_patch_json` (stages, forms, KPIs, routine templates, skill keys) | PK(key, version) | Industry differences are data, not code forks. |

### 3.3 Workspace and collaboration

Departments are **configuration in the manifest** (key, label, persona, prompt overlay, enabled), not a table. Tables reference them as `department_key`.

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- department|customer|project|dm|custom
  department_key TEXT, customer_id TEXT, project_id TEXT,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'team',   -- team|customer_shared
  last_message_at TEXT, archived_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX uq_ch_slug ON channels(tenant_id, slug);
CREATE INDEX ix_ch_kind ON channels(tenant_id, kind, last_message_at);
CREATE INDEX ix_ch_customer ON channels(tenant_id, customer_id);

CREATE TABLE channel_members (tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  member_type TEXT NOT NULL,       -- user|customer_contact|agent
  member_id TEXT NOT NULL, role TEXT, last_read_message_id TEXT, last_read_at TEXT, muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, member_type, member_id));
CREATE INDEX ix_cm_member ON channel_members(tenant_id, member_type, member_id);

CREATE TABLE channel_messages (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_root_id TEXT,
  author_type TEXT NOT NULL,       -- user|agent|system|customer|bridge
  author_id TEXT, agent_key TEXT, body TEXT NOT NULL, body_format TEXT NOT NULL DEFAULT 'md',
  visibility TEXT NOT NULL DEFAULT 'internal',   -- internal|client  (Cook "Team only" = internal)
  source TEXT NOT NULL DEFAULT 'native',         -- native|slack|discord|email|sms
  source_ref TEXT,
  card_type TEXT, card_ref_id TEXT,              -- approval|deliverable|goal|call_recorded|routine_run|alert
  run_meta TEXT,                                 -- {worked_for_ms, skills_used[], tool_steps[]}
  edited_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX ix_msg_channel ON channel_messages(tenant_id, channel_id, created_at);
CREATE INDEX ix_msg_thread ON channel_messages(tenant_id, thread_root_id, created_at);
CREATE UNIQUE INDEX uq_msg_source ON channel_messages(tenant_id, source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE channel_bridges (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  provider TEXT NOT NULL, connection_id TEXT NOT NULL, external_workspace_id TEXT NOT NULL, external_channel_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',  -- out|both ; approvals may be answered from Slack/Discord
  status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX uq_bridge_ext ON channel_bridges(provider, external_channel_id);   -- global: one Slack channel -> one tenant
```

**Rules for channels:**
- Private 1:1 chats with an agent ("Ask") stay in the existing `chat_sessions` and `chat_messages` tables (tenant_id is already NOT NULL).
- `channel_messages` is the shared system of record (decision 3).
- Messages bridged in from Slack or Discord are stored with `source` and `source_ref`, and are never exported in bulk to those platforms (Slack's terms).

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, department_key TEXT,
  requested_by_type TEXT NOT NULL, requested_by_id TEXT, routine_run_id TEXT,
  action_kind TEXT NOT NULL,      -- send_email|send_sms|publish_post|create_ad_paused|book_meeting|send_invoice|share_deliverable|...
  target_ref TEXT,                -- {customer_id|lead_id|...}
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,   -- approval binds to EXACT payload; an edit = new approval
  preview_text TEXT, risk_level TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|sent_back|expired|executing|executed|failed|cancelled
  decided_by TEXT, decided_at TEXT, decided_via TEXT, decision_note TEXT,
  execute_after TEXT, executed_at TEXT, execution_result TEXT,
  idempotency_key TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX uq_appr_idem ON approvals(tenant_id, idempotency_key);
CREATE INDEX ix_appr_queue ON approvals(tenant_id, status, created_at);
CREATE INDEX ix_appr_dept ON approvals(tenant_id, department_key, status);
CREATE TABLE approval_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, approval_id TEXT NOT NULL,
  event TEXT NOT NULL, actor_type TEXT, actor_id TEXT, meta TEXT, created_at TEXT NOT NULL);
CREATE INDEX ix_apev ON approval_events(tenant_id, approval_id, created_at);
```

**How an approval executes:**
- The executor claims `approved → executing` with a compare-and-swap.
- It re-checks `payload_hash`, `tenants.lifecycle = 'active'`, the consent ledger and brand identity.
- It then calls the one outbound chokepoint (`send_gateway` or the TypeScript send-mode path).

This generalizes the SunBiz-only draft approvals (`app/api/conversations/drafts/[id]/route.ts:29`, `components/conversations/SunbizDraftCard.tsx`, owned by APEX).

**Feed and projects:**

| Table | Key columns | Indexes |
|---|---|---|
| `deliverables` | `department_key, project_id, customer_id, title, kind, current_revision, status (draft\|in_review\|approved\|sent_back\|shared\|archived), visibility DEFAULT 'internal', created_by_type/id, routine_run_id` | (tenant_id, status, updated_at), (tenant_id, department_key, updated_at) |
| `deliverable_revisions` | `deliverable_id, revision, file_id, body_md, summary, qa_result_json` | UNIQUE(deliverable_id, revision) |
| `feed_items` (a projection built from approvals, deliverables and goals) | `item_type, item_id, department_key, status, audience (team\|client), occurred_at` | (tenant_id, audience, occurred_at); (tenant_id, status) for "Needs you" |
| `comments` (generic) | `subject_type, subject_id, author_type/id, body, visibility DEFAULT 'internal'` | (tenant_id, subject_type, subject_id, created_at) |
| `projects` (**replaces** `delivery_projects`, 0 rows live) | `customer_id, name, brief_md, instructions_md, stage, priority, owner_user_id, due_at, visibility, archived_at` | (tenant_id, stage, updated_at), (tenant_id, customer_id) |
| `project_tasks`, `project_updates` | ports of `delivery_tasks` and `delivery_updates` (183:97-127); updates are visible to clients only through the allowlist | (tenant_id, project_id, …) |
| `files` | `owner_type (project\|customer\|ticket\|deliverable\|meeting\|message), owner_id, r2_key, filename, mime, size, sha256, text_twin_md` (Cook's `.pdf.md`), `extraction_status, sensitivity (normal\|financial\|identity), uploaded_by, deleted_at` | (tenant_id, owner_type, owner_id) |
| `file_extraction_jobs` | ports the `document_extraction_jobs` queue with tenant_id NOT NULL | (status, created_at), (tenant_id, file_id) |
| `memory_notes` + `memory_notes_fts` (FTS5) | `scope_type (workspace\|project\|customer\|department), scope_id, body, source, source_ref, pinned, superseded_by` | (tenant_id, scope_type, scope_id). The FTS table carries tenant_id UNINDEXED, and **every query filters it**. A libSQL vector index returns a global top-k, so over-fetch and post-filter by tenant, or use a dedicated cell. |

The delivery logic is reused, not rewritten: `lib/delivery/rules.ts` (vocabularies), `access.ts` (row scope, allowlist) and `sla-cron.ts` move into `lib/os/projects` and `lib/os/tickets`. The OASIS pin `DELIVERY_TENANT_ID = WEBDEV_TENANT_ID` (`lib/delivery/rules.ts:17-18`) is dropped, so the tenant becomes the owning business.

### 3.4 Skills and routines

| Table | Key columns | Keys |
|---|---|---|
| `skill_templates` (platform, no tenant) | `key, version, name, department_key, body_md, pack_key` | PK(key, version) |
| `skills` | `key, name, description, department_key, body_md` (SKILL.md), `source (pack\|founder\|agent\|video), source_ref, version, status (draft\|active\|archived), created_by_type/id, approved_by, approved_at` | UNIQUE(tenant_id, key); (tenant_id, department_key, status) |
| `skill_versions` | `skill_id, version, body_md, created_by` | UNIQUE(skill_id, version) |
| `routines` | `department_key, name, description, trigger_type (schedule\|event\|webhook\|manual), schedule_cron, timezone, event_type, graph_json, quality_gate_json, status (draft\|testing\|off\|on\|error), last_test_run_id, test_passed_at, enabled_by, enabled_at` | (tenant_id, status); (status, trigger_type) for the scheduler |
| `routine_runs` | `routine_id, trigger_ref, mode (sandbox\|live), status (queued\|running\|succeeded\|failed\|blocked_on_approval\|cancelled), steps_json, output_deliverable_id, approvals_created, cost_micros, model_usage_json, error, started_at, finished_at` | (tenant_id, routine_id, created_at), (status, created_at) |
| `routine_webhooks` | `routine_id, secret_hash, last_used_at` | UNIQUE(secret_hash) |

**Rules for skills and routines:**
- Skills written by an agent start as `draft` and need an approval card before activation. This defends against prompt-injected skills arriving from inbound content.
- The Playbook tab reads `skills`, which replaces the filesystem markdown in `lib/playbooks.ts:13,25` (that directory is empty on the Worker).
- Routines start `off` and cannot move to `on` without a passing `sandbox` run. In sandbox mode every adapter returns `would_send`, following the `SendResult` shape in `lib/integrations/send-mode.ts`.
- `lib/workflow-steps/*` (dead code today) gets revived as the step library.
- The existing `tenant_cron_jobs` rows migrate into `routines` (after the SunBiz purge, only OASIS rows remain).

### 3.5 Customers, tickets and meetings (the "Clients" tab is the business's own customers)

**Decision: `customers` is a first-class table, not `tenant_records` JSON.** It needs uniqueness (email, Stripe, GHL, QBO or Xero ids) and joins to tickets, projects, meetings, agreements, invoices and portal access. Leads stay in `tenant_records` (entity `lead`, pipeline from the manifest), and converting a lead sets `customers.source_lead_id`.

| Table | Key columns | Keys and indexes |
|---|---|---|
| `customers` | `display_name, company_name, primary_email` (lowercased), `primary_phone` (E.164), `lifecycle (prospect\|onboarding\|active\|paused\|churned), owner_user_id, source_lead_id, stripe_customer_id, ghl_contact_id, qbo_customer_id, xero_contact_id, health_score, health_computed_at, tags, custom_fields` (industry pack), `archived_at` | UNIQUE(tenant_id, primary_email) WHERE NOT NULL; UNIQUE(tenant_id, stripe_customer_id) WHERE NOT NULL; (tenant_id, lifecycle, updated_at) |
| `customer_contacts` | `customer_id, name, email, phone, role` | (tenant_id, customer_id) |
| `portal_access` | `customer_id, auth_user_id, role, invited_at, accepted_at, revoked_at` | UNIQUE(tenant_id, customer_id, auth_user_id). **Portal users are never tenant members.** Portal queries scope by `(tenant_id, customer_id)` and read only `visibility='client'` rows. |
| `consent_ledger` (CASL/TCPA) | `subject_type, subject_id, channel (email\|sms\|call), basis (express\|implied_ebr\|implied_inquiry), captured_at, expires_at` (implied consent: 2 years or 6 months), `source, evidence_ref, revoked_at, revoked_via` | (tenant_id, subject_type, subject_id, channel). Reuses `lib/sms/consent.ts`, `lib/sms/lawful-basis.ts`, `lib/tcpa-window.ts`, `email_suppressions`. |
| `tickets` + `ticket_comments` | ports `support_tickets` and `ticket_comments` from 183:146-223 **as they are** (SLA columns, `is_internal DEFAULT 1`, form-submission idempotency). `client_tenant_id`, `client_name` and `client_email` are replaced by `customer_id` plus `reporter_email`, and `client_match` is kept (a public-form email is unverified). | keeps 183's tenant-leading indexes; adds (tenant_id, customer_id, status) |
| `meetings` | `customer_id, lead_id, project_id, title, provider (google_meet\|zoom\|recall\|fathom\|fireflies\|phone\|manual), external_id, calendar_event_id, starts_at, ends_at, organizer_user_id, attendees_json, recording_status, consent_notice_sent_at, consent_basis, recording_file_id, transcript_status, summary_md, action_items_json, outcome_tags, retention_until` | UNIQUE(tenant_id, provider, external_id); (tenant_id, starts_at); (tenant_id, customer_id, starts_at) |
| `meeting_transcripts` | `meeting_id, language, source, text` (optionally `segments_json`), `retention_until` | UNIQUE(tenant_id, meeting_id) |
| `call_scores` | `meeting_id, rubric_key, score, breakdown_json, coach_notes_md` | (tenant_id, meeting_id) |

**Ticket intake:** each tenant gets its own support form in the Forms engine, with an "on submit, create ticket" hook generalized from `lib/delivery/support-intake.ts`. The OASIS pin in `lib/delivery/support-form.ts:38-47` is removed. `/api/cron/sla-check` already exists and is changed to iterate over tenants.

### 3.6 Connections (per-tenant OAuth), goals, outcome events, usage

```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,          -- google|meta|slack|discord|ghl|zoom|stripe|qbo|xero|plaid|twilio|recall|fathom|constant_contact|...
  scope_level TEXT NOT NULL DEFAULT 'tenant', user_id TEXT,
  external_account_id TEXT NOT NULL, display_name TEXT, scopes TEXT,
  status TEXT NOT NULL,            -- connected|needs_reauth|revoked|error
  access_token_enc TEXT, refresh_token_enc TEXT, token_expires_at TEXT, key_version TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 1,   -- finance connectors must stay 1 (decision 2)
  last_sync_at TEXT, last_error TEXT, connected_by TEXT, connected_at TEXT, revoked_at TEXT, metadata TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX uq_conn ON connections(tenant_id, provider, external_account_id);
CREATE UNIQUE INDEX uq_conn_route ON connections(provider, external_account_id) WHERE revoked_at IS NULL; -- webhook routing
CREATE TABLE connection_sync_runs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, counts TEXT, error TEXT, started_at TEXT, finished_at TEXT);
CREATE INDEX ix_csr ON connection_sync_runs(tenant_id, connection_id, started_at);
```

**Connections:**
- Tokens use v2 envelope encryption (P0-12), with AAD `connections:<tenant>:<provider>:<field>`.
- The OAuth flow copies the Constant Contact pattern: PKCE plus an HMAC-signed state and a public callback (`lib/integrations/constant-contact/{store,route-helpers}.ts`, `middleware.ts` callback entry).
- API-key services stay in `tenant_integration_credentials`, and there is **no env fallback** for any non-OASIS tenant (P0-1).
- Stripe accepts only `rk_` restricted keys and refuses `sk_`. Money movement is never coded (decision 2).

| Table | Key columns | Keys and notes |
|---|---|---|
| `goals` | `department_key, kind (revenue\|pipeline\|custom), label, metric_key, target_value, unit, period_start, period_end, status, created_by` | (tenant_id, status, period_end). `revenue_goals` (182) stays the money goal, and Atlas owns it. Reads are gated as in P0-9. |
| `outcome_events` (the data moat) | `occurred_at, subject_type (lead\|customer\|meeting\|ad\|deliverable\|ticket\|invoice), subject_id, event_key` (e.g. `lead.created`, `meeting.held`, `deal.won`, `payment.received`, `customer.churned`, `ticket.resolved`, `ad.metrics_daily`), `value_cents, currency, attribution_json` (ad_id, angle, form_id, routine_id, skill_ids), `source, source_ref, idempotency_key` | UNIQUE(tenant_id, idempotency_key); (tenant_id, event_key, occurred_at); (tenant_id, subject_type, subject_id, occurred_at). **Retrieval stays within one tenant; there is no cross-tenant training** (In re Otter.AI; the Google, Slack, Xero and Zoom clauses). Any future benchmark would be an opt-in, k-anonymized rollup table with no tenant ids, plus a Law 25 s.8.1 disclosure. |
| `ai_usage` | `department_key, run_ref, provider, model, input_tokens, output_tokens, cost_micros, billed_to (bundled\|byo)` | (tenant_id, created_at). Feeds Atlas's validation of tier unit economics and the AI spend cap. |

### 3.7 Re-tenanting `fin_*`

**Facts:**
- `fin_entities.owner_key CHECK (owner_key IS NULL OR owner_key IN ('cc','adon'))` and the business/personal CHECK are at `database/turso/180_founders_finances.turso.sql:25-30`. `fin_accounts.owner_key` has the same CHECK (:65).
- Every child `fin_*` table is scoped by `entity_id`.
- The business entity is hard-wired: `BUSINESS_ENTITY_ID = "fin_ent_oasis"` (`lib/founders-finances/chart.ts:23`), with the seed list at :25-29.
- Access is by owner email and auth id (`lib/founders-finances/access.ts`).

**Plan: no in-place SQLite table rebuild, ever.**
1. **Phase 1 (OASIS only).** The OASIS tenant's Finance department keeps reading the existing `fin_*` in `bravo`, owner-gated as today.
2. **At the database split, create `fin_*` v2 in `oasis-os`:**
   - Every table gets `tenant_id NOT NULL`.
   - `fin_entities.owner_user_id` (an auth user id; personal books are an owner-only feature, enforced in the app) replaces the `owner_key` CHECK.
   - Indexes lead with `(tenant_id, entity_id, …)`.
3. **Copy OASIS's books** into v2 with `tenant_id = ef8d389e…`. Atlas verifies the copy: row counts per table, journal-line sums per account, and trial-balance equality. The old tables stay read-only for 14 days as a rollback.
4. **Client tenants** each get one `kind='business'` entity at provisioning. No personal books in v1.
5. **Finance v1 read models (decision 2):**
   - `fin_connected_accounts` (tenant_id, connection_id, provider qbo\|xero\|plaid\|stripe\|csv, external_account_id, name, type, currency, mask, status)
   - `fin_balances_daily` (UNIQUE(tenant_id, account_id, as_of_date))
   - `fin_bank_transactions` v2, which reuses the existing shape plus tenant_id, with UNIQUE(tenant_id, account_id, external_id)
   - `fin_cfo_snapshots` (tenant_id, as_of, metrics_json, computed_by='atlas', version)

   CSV/OFX import, rules and categories reuse `lib/founders-finances/*` import code once it is extracted to `lib/finance/`. The founders portal stays owner-only for OASIS.
6. **Machine callers** (`/api/internal/finance/*`, `FINANCE_AGENT_TOKEN`) get a **per-tenant scoped** token with audit, and can reach business books only.

**Effort for B overall:** 4-6 wks for a human team, 1.5-2 wks for CC+Bravo. The finance v2 copy is a money-path change and needs Codex review plus Atlas sign-off.

---

## 4. (c) SunBiz retirement runbook

**Identifiers:**
- Tenant id `aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110`, slug `submissions`, profile slug `sun`, stale manifest row `sunbiz`. The portal registry lists all three (`lib/portals/registry.ts:231`).
- Brands `sunbiz` and `bluerise` both belong to the SunBiz company (`lib/email/brand-for-tenant.ts:39-78`).

**Flags used below:** **[R]** reversible · **[OUT]** outward-facing · **[DESTR]** destructive · **[CC-GO]** needs CC's explicit go at the moment of execution.

### Step 0: one batched decision from CC (and Adon) before C-3 onward
1. The effective end date, and whether any service is owed during a notice period.
2. Contract terms. OASIS acted as the **service provider / mandatary** and SunBiz as the controller. At the end of the mandate the data is returned or destroyed as the contract says; it is never given to anyone else.
3. The former client's websites (sunbizfunding.com, bluerisebusinesscapital.com): hand them over or take them down.
4. Adon's concurrence. Adon is an equal co-owner, and SunBiz ran on Adon's MCA brief, largely built by APEX.
5. Whether CC wants the SunBiz name scrubbed from the code (the prior-retainer precedent). The default is **no**, because rewriting history is destructive.

### Runbook

| # | Step | Actions | Verification |
|---|---|---|---|
| **C-1** | **Freeze outbound (hour 0)** **[R][CC-GO]**. The CC-GO is one tap because it changes production DB rows and secrets; it deletes nothing. | **1a. Database** (takes effect instantly, no deploy). Use a reviewed script, `scripts/sunbiz-freeze.ts`, dry run by default with `--apply`, modelled on `scripts/cancel-offboard-drip-runs.ts`:<br>• `drip_sequences.enabled=0` for SunBiz (10 rows)<br>• `drip_runs` status `scheduled` → `cancelled` with a compare-and-swap (730 pending; leave `sending` rows to the dispatcher's recheck)<br>• `tenant_cron_jobs.enabled=0` (6)<br>• cancel SunBiz's future `scheduled_sends`, `scheduled_calls`, `call_appointments` and `campaign_runs` (**read each schema first**: `scheduled_sends` has no `status` column)<br>• `tenants.lifecycle='frozen'` once P0 adds the column.<br>**1b. Python kill switch** (covers the VPS even without SSH):<br>• `python scripts/pause_controller.py pause global --tenant aa04fa1f… --reason "SunBiz retired 2026-09-28"`, then `set-mode silent`.<br>• `send_gateway.can_act` refuses, and fails closed if the ledger is unreadable (`send_gateway.py:1586-1618`).<br>• SunBiz-Agent's `sequence_runner.py` sends through `send_gateway` (:10, :751).<br>**1c. Worker secrets** (`wrangler_tool.py whoami`, then `secrets-push --app oasis-command-center`):<br>• `DRIPS_CIRCUIT_OPEN=1` (`lib/drips/governor.ts:99-103`). It is global, but no other tenant has any sequences.<br>• `LIVE_SEND_TEXTTORRENT=0`, `LIVE_SEND_KIXIE=0`, `LIVE_SEND_CONSTANT_CONTACT=0` (SunBiz-only channels; `send-mode.ts:43-55`), `ACCELERATED_ENROLL_LIVE=0`.<br>• Once #434 lands, add `BRAVO_FORCE_DRY_RUN__SUBMISSIONS=1` and `DRIPS_LIVE__SUBMISSIONS=0`.<br>**1d. Silence SunBiz health lanes** (SunBiz tenant-cron and extraction-stall checks, the `SUNBIZ_OPS_TELEGRAM_*` lane) so the freeze does not page.<br>**1e. Intake [OUT]:** the 4 SunBiz forms still accept merchant applications and send auto-emails (last on 09-25). Set `forms.enabled=0` so `/f/sun/*` returns not_found (`lib/forms/public-resolver.ts:90`). **This happens only after CC or the former client agree**, because it breaks the client's site forwarding. | • About 1 h, then again at 24 h: `COUNT(*) FROM lead_interactions WHERE tenant_id=SB AND direction='outbound' AND created_at > <freeze_ts>` = **0**.<br>• Pending drip_runs = 0; enabled sequences and crons = 0.<br>• The `kill_switch` row is present in `tenant_records`.<br>• A dry-run `can_act` for SunBiz returns `kill_switch:`.<br>• The cron Worker's inspection `GET /` lists the due routes (removed in C-6a). |
| **C-2** | **VPS srv1723601 teardown** **[DESTR][CC-GO]**. Blocked until CC re-adds `ssh-ed25519 …RM user@CCPC` in hPanel → srv1723601 → SSH keys (`docs/VPS_SERVICE_PROCESSES_SYSTEM_MESSAGE.md`). **The box is shared with other clients' processes**: touch only `/srv/sunbiz/**`, its PM2 apps and the `jarvis` TextTorrent Docker containers. Never `pm2 kill`, `delete all`, or cancel the VPS. | 1. Capture `pm2 jlist`, `docker ps` and `ss -ltnp` to a scratch evidence file. Expected apps:<br>• from `/srv/sunbiz/ceo-agent`: claude-bridge (:9100), claude-bridge-ping, event-router, dashboard-email-consumer, dashboard-email-queue-monitor, extraction-consumer (`BEA/ecosystem.config.js:350-613`)<br>• from `/srv/sunbiz/sunbiz-agent`: sequence-runner, lender-response-classifier, cold-outreach-runner, mca-lead-scrubber, ezra-telegram-bridge, uw-lead-enricher, sentinel (`SunBiz-Agent/ecosystem.config.js:89-337`)<br>2. `pm2 stop <each>`, then `docker stop` for the jarvis containers.<br>3. Watch 24 h, then `pm2 delete <each>` and `pm2 save`.<br>4. Revoke the SunBiz `bridge_pairings` row (1 unrevoked).<br>5. Archive `/srv/sunbiz` (tar, encrypt, download) into the C-3 export, then remove it with a reviewed command (exec_guard blocks `rm -rf` outside tmp; move it to `/root/offboard-<date>` first and delete after CC's go).<br>6. Shred the box's env file only **after** C-4 rotation.<br>7. The production branch `bravo/cron-scheduler-fixes` (4 unique commits) is already pushed (per memory), so nothing is lost. | • `ls -l /proc/*/cwd` shows none that are `(deleted)` or under `/srv/sunbiz`.<br>• `ss -ltnp` shows no listener from those PIDs.<br>• `pm2 list` shows only non-SunBiz apps.<br>• Revoked pairing = 1.<br>• **If SSH is never restored:** C-1, the pairing revocation and C-4 rotation already neutralize the box. |
| **C-3a** | **Export package** **[R]**, a read-only copy | Script `scripts/tenant-export.ts --tenant <id>`, driven by a **table registry** (every tenant-scoped table with its tenant column). This becomes the platform's reusable Law 25 offboarding tool. It produces per-table JSONL + CSV plus `manifest.json` (row counts, sha256 per file), and pulls all R2 objects under every `*/aa04fa1f…/` prefix (lead-documents incl. statements, e-sign PDFs, generated application PDFs; chat and support attachments). Scope, from live and research counts:<br>• `tenant_records` (1,564 leads, 1,370 applications of which **753 contain SSNs**, 91 offers, 47 lenders)<br>• `lead_interactions` 9,698, **plus SunBiz's share of the 752 NULL-tenant rows, resolved by joining on lead_id**<br>• `lead_documents` 5,461; `form_submissions` 5,167; `drip_runs` 5,518; `sequence_state` 2,127; email open/click events<br>• `application_lender_threads` 1,769; `conversation_threads` 1,516 (+ events); `application_underwriting` 628; `merchant_background_checks` 462 (CLEAR reports: dispose of these as consumer-report data; Lex to confirm)<br>• `lender_reply_outcomes` 374; `agent_alerts` 357; `sms_sender_numbers` 71; `email_suppressions` 86; e-sign rows; `funded_deals` 2; chat 24 sessions; `document_extraction_jobs` 45; the `sunbiz_*` tables; `underwriting_ungrounded_backup_20260806`.<br>**Off-Turso copies go in the destruction scope too:**<br>• the legacy Supabase project (still exists, SunBiz rows at parity)<br>• BEA `state/backups/` and `scripts/ops/_supabase_backup.py` output<br>• `SunBiz-Agent/data`, `state` and `memory` directories<br>• Drive MCA phone sheets (`consolidate_mca_phone_sheet.py`)<br>• the SunBiz ops Telegram chat<br>• Turso point-in-time-restore retention (depends on plan; document it).<br>The archive is **encrypted** (AES-256, passphrase held by CC) and is never placed in git or an unencrypted Drive. | The manifest's row counts equal live `COUNT(*)` per table; R2 object count and bytes match a listing; the archive decrypts on a second machine. |
| **C-3b** | **Handover** **[OUT][CC-GO]** | Only to the former client's authorized contact, by secure transfer, as CC and the contract direct. `email_suppressions` go with it (the list is theirs). | Signed receipt; a hash that matches. |
| **C-3c** | **Deletion / anonymization** **[DESTR][CC-GO]**. Every step is dry run first with printed counts; DELETEs carry a WHERE (exec_guard allows that); table drops go through a **reviewed migration** only. | Order:<br>1. Credential rows (`tenant_integration_credentials` 15, `user_integration_credentials` 17), after C-4.<br>2. R2 prefixes, batched delete, then list again to prove empty.<br>3. Rows in shared generic tables `WHERE tenant_id=SB` (section 4.2), including the `sunbiz` manifest row.<br>4. Drop the funding-only tables (section 4.2), once each has **0 non-SunBiz rows** (`GROUP BY tenant_id`) and 0 code references after C-6.<br>5. User profiles are **deactivated and kept to a minimum**, never deleted (CC's convention).<br>6. `tenants` row → `lifecycle='retired'` with `custom_fields` stripped, kept as a tombstone.<br>7. **Last:** the `kill_switch` and `operating_mode` entities in `tenant_records`. Deleting them earlier would undo the freeze.<br>8. Legacy Supabase and local backups.<br>**Timing constraint:** the `/unsubscribe` route and the `sunbiz`/`bluerise` brand entries keep working **until at least 2026-11-27**, 60 days after the last send (CASL s.11(3); CAN-SPAM needs 30). Only then are they removed, together with BEA `scripts/lib/tenant_brand.py`, keeping `tests/brand-identity-coherence.test.ts` green. | Per table, `COUNT(*) WHERE tenant_id=SB` = 0; `sqlite_master` has no funding tables; R2 listing is empty; an **offboarding certificate** (what, hashes, when, by whom) is written to `tenant_audit_log` under the OASIS tenant. |
| **C-4** | **Credentials and users** **[OUT][CC-GO]** | **Remove from the Worker.** Key names come from `BEA/config/cloudflare/manifests/oasis-command-center.json`; run `secrets-plan`, then delete:<br>• `KIXIE_API_KEY`, `KIXIE_BUSINESS_ID`, `KIXIE_WEBHOOK_SECRET`<br>• all `TEXTTORRENT_*` and `TEXTTORRENT_FOLLOWUP_*`<br>• `TT_PG_BRIDGE_TOKEN`, and `APEX_PG_BRIDGE_TOKEN` after APEX confirms<br>• `FUNMATE_EMAIL`, `FUNMATE_APP_PASSWORD`<br>• `api_key_Constant_Contact` and `APP_SECRET`, once no OASIS use is confirmed<br>• `SUNBIZ_OPS_TELEGRAM_*`, `SUNBIZ_PUBLIC_FORM_ORIGIN`<br>• `DRIPS_*_SUNBIZ/_BLUERISE`, `NEXT_PUBLIC_OPTINVAULT_*_SUNBIZ/_BLUERISE`<br>• `TPS_AUTO_ENROLL_SINCE`, `ACCELERATED_ENROLL_LIVE`<br>• `BRIDGE_VPS_URL` and `BRIDGE_BEARER_TOKEN` if they point only at the SunBiz VPS<br>• `ESIGN_FROM_*` if it is a SunBiz mailbox.<br>**Rotate OASIS-owned secrets that sat on the SunBiz box:**<br>• `OASIS_OUTBOUND_HMAC_SECRET` (shared by the VPS extraction daemon and `send_gateway`)<br>• `CRON_SECRET` and `CRON_ATTEST_SECRET` if present there<br>• **`BRAVO_FIELD_ENCRYPTION_KEY`, through the P0-12 rotation.**<br>**Client-owned accounts** (Kixie, TextTorrent, Constant Contact, Google Workspace for submissions@sunbizfunding.com, CLEAR, OptinVault):<br>• delete OASIS's stored copies<br>• ask the former client to rotate them and revoke OASIS's OAuth app in Constant Contact<br>• deregister the Kixie and TextTorrent webhooks that point at `/api/webhooks/{kixie,texttorrent}`<br>• SunBiz never used Twilio.<br>**Users:** deactivate the 4 active SunBiz users with `deactivateMember` (`lib/team-activation.ts:345-445`), which sets `deactivated_at`, bans logins and bumps `session_version`. Revoke the pairing. | `secrets-plan` shows no SunBiz keys; old HMAC and cron secrets get 401 against the Worker; SunBiz user sessions get 401; a login attempt is refused as banned. |
| **C-5** | **Domains** **[OUT][CC-GO]** | sunbizfunding.com forwards `/f/*` to OASIS's form URLs with a 307 (`lib/forms/public-origin.ts:3-14`, repo CC90210/sunbiz-funding). bluerisebusinesscapital.com is also OASIS-hosted (`BEA/config/cloudflare/apps.json:20-45`; APP_REGISTRY:44,46). Per CC's decision, either **transfer** the repos, Vercel/Cloudflare projects and (if OASIS pays for it) the registrar to the former client, or take them down. The `/f/<tenant>/<form>` URL contract **stays frozen for all tenants**; only the `sun` path dies. Remove the `SUNBIZ_FALLBACK_FORM_ORIGIN` code in C-6. | `curl -I https://www.sunbizfunding.com/f/x` no longer resolves to oasisai.work; no DNS points at an OASIS project. |
| **C-6** | **Code** (section 4.1) **[R until deploy]** | PRs, each taking a lease on the relevant shared or APEX paths:<br>• **6a (small, ships with C-1):** remove the SunBiz cron routes from `workers/oasis-cc-cron/src/index.ts` `CRON_TABLE` and `config/cron-registry.json` in lockstep (`tests/cron-driver-coverage.test.ts`). The routes: collect-outreach-intel, scan-lender-replies, sync-tt-inbox ×2, scan-bounces (both brands), scan-funmate-replies, sweep-stale-sent-app, kixie-compliance-scan ×2, enroll-accelerated, tps-enroll, tps-backlog-watch, renewal-thresholds, sync-sms-numbers, reconcile-sms, dispatch-bulk-email (SunBiz mailbox). **Keep** materialize-plans, collect-cc-metrics, dispatch-scheduled-sends, dispatch-scheduled-calls, sms-reply-agent, enroll-drips, dispatch-drips, reconcile-drip-telemetry, reconcile-website-sales-payments, dispatch-founder-meeting-reminders, operator-email-agent, health-check, sla-check.<br>• **6b:** delete funding-only code.<br>• **6c:** harvest and re-home the generic engines, with fixtures moved to a neutral tenant.<br>• **6d:** BEA archive into `scripts/_archive/sunbiz/` with a README (the Skool precedent).<br>Codex review on each. | Worker `GET /` shows only kept routes; `npm test` (the `tests/_suite.mjs` suite, renamed from `test:sunbiz` to `test:platform`) is green; `tests/portal-boundaries.test.ts` is green with `SUNBIZ_PORTAL` removed; `git grep -i 'aa04fa1f\|sunbiz'` in OCC returns only the brand-map entries until 2026-11-27. |
| **C-7** | **Repos** **[OUT]** | • **SunBiz-Agent:** export any committed data (check `data/`, `state/`, `memory/` for merchant personal data; if any was committed, CC decides between a private archive and a history rewrite), then archive it on GitHub.<br>• **CEO-Agent's SunBiz deployment** is just the `/srv/sunbiz/ceo-agent` checkout of the BEA repo, removed in C-2.<br>• **sunbiz-funding and blue-rise-website:** per C-5.<br>• Remove the SunBiz worktrees (section 5). | GitHub shows the repos archived; `git worktree list` has no SunBiz worktrees. |
| **C-8** | **Brain, docs and memory** **[R]** | • `brain/APP_REGISTRY.md:44,46` → RETIRED.<br>• `CONTEXT.md`: 4 references; the tenant examples at :40-42 use SunBiz.<br>• `brain/STATE.md` (5), `memory/ACTIVE_TASKS.md` (15: close them), `brain/ORCHESTRATION_DECISION_TABLE.md` (1).<br>• `brain/OWNERSHIP_MAP.yaml` domains: APEX's "TextTorrent / TPS / phone-lookup" and "SunBiz conversations + campaigns" marked retired. This is a **shared file, so it needs a lease and APEX's ack**.<br>• SunBiz docs in `docs/` → archive.<br>• 18 SunBiz memory files → marked retired, pointing to a new `project_sunbiz_retired_2026_09_28.md`.<br>• MEMORY.md index: remove the SunBiz lines. Reword "Never couple OASIS and SunBiz" to "never couple tenants" (the principle still holds).<br>• Health monitors: BEA `fleet_health_check.py` and `cron_health_check.py`, OCC `lib/health/*` SunBiz lanes.<br>• Rebuild `brain/CAPABILITY_GRAPH.json` with `build_capability_graph.py`.<br>• Any SunBiz text in the lockstep blocks is changed through `PERSONAL.md` and `genome_sync.py`. | `genome_sync.py --check`, `harness_eval.py` and `test_entrypoint_parity.py` all pass. |
| **C-9** | **APEX and Adon coordination** | Post to the agent-coordination table (`agent_activity.py post … --mirror`) and ask for an ack:<br>1. Stop SunBiz work and close the SunBiz PRs (section 5).<br>2. Strip the renewals, shop-out and shopping-out edits from #463.<br>3. Confirm `APEX_PG_BRIDGE_TOKEN` callers.<br>4. Stop the `jarvis` containers (the TextTorrent domain is APEX's).<br>5. **Ack the harvest of `components/conversations/**` and `components/campaigns/**` (APEX-owned)** into generic Inbox and Campaigns, and the ownership re-map.<br>Use `cross_agent_review.py scan` on APEX PRs that touch retired surfaces. | An APEX ack row in the coordination table; no open APEX PR touches deleted paths. |

### 4.1 HARVEST vs DELETE

**HARVEST.** Move these from `SUNBIZ_PORTAL.owns` (`registry.ts:232-257`) to shared "platform" ownership. Directory paths are kept, which keeps the change surgical; only SunBiz-*named* files move.

| Engine | Paths | De-SunBiz work |
|---|---|---|
| Drips / sequences | `lib/drips/**` (44 files, excluding `sunbiz-application-chase.ts`), `components/sequences/**`, `components/drips/`, `app/sequences/**`, `app/drip-tracker/`, crons enroll/dispatch/reconcile | Replace the `SUNBIZ_BRAND` default import (`executor.ts:69`, `lib/drips/html-email.ts`) and the governor's brand default `"sunbiz"` (`governor.ts:90`) with the tenant brand |
| Forms | `lib/forms/**` generic parts, `components/forms/**` | Delete `fundmate-*`, `sunbiz-*`, `application-*` |
| E-sign | `lib/esign/**`, `components/esign/`, `app/sign/[token]`, `/api/sign/*` | Storage moves to the OS files bucket |
| Documents + extraction queue | `lib/lead-documents.ts`, `lib/r2-storage.ts`, the extraction jobs, `/api/internal/apply-extraction`, `extraction-doc-url` | Consumer re-homed off the SunBiz VPS; HMAC rotated in C-4 |
| Import | `lib/import/**` (excluding `fuzzy-merchant-match.ts`), `components/import/`, `app/import` | — |
| Conversations inbox (APEX) | `components/conversations/**`, manifest kind `conversations`, `conversation_*` | `SunbizDraftCard` becomes an approvals card |
| Campaigns (APEX) | `components/campaigns/**` | TextTorrent and Constant Contact become provider adapters |
| SMS compliance layer | `lib/sms/**`: consent, lawful-basis, compliance, send-breaker, delivery receipts, carrier/line/destination health, canary, `twilio-inbound`, meeting-intent, auto-responses, reply-agent | The Helios agent becomes a neutral "SMS rep" behind approvals |
| Metrics | `app/metrics`, `components/metrics/MetricsDashboard.tsx` | Becomes Marketing analytics |
| Brand / unsubscribe / CASL | `lib/tenant/public-identity.ts`, `lib/email/brand-for-tenant.ts`, `brands.ts`, `app/unsubscribe`, `email_suppressions`, `lib/tcpa-window.ts`, `lib/sms-opt-out.ts` | Later a DB-backed brand registry that stays fail-closed |
| Health checks | `lib/health/**` (15 files) | Remove the SunBiz lanes |
| Manifest engine | `/t/[slug]`, `lib/manifest/**`, `components/manifest/**` | — |
| Demo shell pattern | `app/demo/sun` + `lib/sunbiz-demo-data.ts` | Rebuilt as `/demo/os` with clearly labelled synthetic data |
| OAuth pattern | `lib/integrations/constant-contact/{store,route-helpers,popup}.ts` | Becomes the connector framework |
| Python kill switch | BEA `scripts/pause_controller.py` | Make `--tenant` required; the SunBiz default (:508-511) goes |
| Items to review, then harvest or delete | `lib/sunbiz-sla.ts` (compare to ticket SLA), `sunbiz-draft-policy.ts` (becomes approvals policy), `sunbiz-stage-routing.ts`, `sunbiz-stage-meta.ts`, `sunbiz-inbound-context.ts`, `lib/automations/sunbiz-workers.ts`, BEA `extraction_consumer.py`, `dashboard_email_consumer.py` | Also classify `lib/cold-outreach/**`: `SUNBIZ_PORTAL.owns` claims it, but OWNERSHIP_MAP says Bravo (167:0). It is OASIS's own, so keep it and delete `templates/sunbiz_funding.html`. |

**DELETE (funding-only):**
- **lib:** `lib/{lenders(18), underwriting, renewals, applications(5), clair(3), background-check}/`, `lib/renewals-core.ts`, `lib/queries/merchant-summary.ts`, `lib/import/fuzzy-merchant-match.ts`, `lib/forms/{application-disclosure,application-document,application-pdf,application-upsert,fundmate-document,fundmate-logo,fundmate-pdf,sunbiz-logo,sunbiz-templates}.ts`, `lib/integrations/{funmate-mail,funmate-mail-send,sunbiz-lender-mail-send,kixie*,texttorrent*}.ts`, `lib/turso-rpc-texttorrent.ts`, `lib/notify/sunbiz-events*.ts`, `lib/sunbiz-{default-sequences,templates-library,demo-data}.ts`
- **components:** `components/{sunbiz,lenders,underwriting,shop-out,shopping-out,offers,renewals,applications}/`, `components/forms/SunBizFormsClient.tsx`, `components/leads/ClairReportPanel.tsx`, `components/settings/KixieWebhookSyncCard.tsx`
- **app pages:** `app/{lenders,offers,funded-deals,renewals,templates,applications,contacts,embed,demo/sun}` (repoint `lib/setup-readiness.ts:221` first)
- **app/api:** `applications/**`, `lenders/**`, `renewals/**`, `merchants/**`, `leads/[id]/{background-check,clair-report,generate-fundmate-pdf,texttorrent}`, `manifest/[slug]/underwriting/**`, `forms/templates/sunbiz/**`, `integrations/{kixie,texttorrent,personal/kixie,personal/texttorrent}/**`, `webhooks/{kixie,texttorrent}/**`, `pg/**`, `internal/live-subs/**`, `demo/sun`, and the SunBiz crons from C-6a
- **manifest:** `SUN_SEED` (`seeds.ts:345-413` and pages 640-714), `SUGA_SEED` (772+; Suga has no tenant), the dead `SUN_NAV` and `SUGA_NAV` (`lib/nav-config.ts:187-264`), page kinds `shopping_out`, `offers_v2`, `lenders_v2`, `renewals_v2` (`lib/manifest/schema.ts:184-199` and their renderers), the `business_funding` template (`lib/manifest/templates.ts`)
- **SunBiz branches in shared code:** the `sun`/`suga` brand matching (`lib/client-profiles.ts:193-217`) and profiles, `lib/client-provisioning.ts:41-70`, the `/` redirect (`app/page.tsx:77-88`), the `/playbook` SunBiz branch (:83-125) and `content/playbooks/sun-*`, the `/forms` SunBiz switch, the Solara and Helios personas (`lib/agent-personas.ts`; delete or convert to neutral templates), `lib/bridge-proxy.ts:253`, `lib/forms/public-origin.ts` SunBiz origin
- **middleware entries:** `/demo/sun`, `/api/demo/sun`, `/api/pg`, `/api/internal/live-subs/promote`, `/api/quests`
- **tests (38):** accelerated-live-subs, application-*, clair-*, deactivated-rep-sunbiz-outbound, funmate-*, kixie-*, lender-*, live-sub*, merchant-email-wiring, renewal*, shop-out*/shopout*, shopping-out-*, sunbiz-*, texttorrent-*, turso-rpc-texttorrent, underwriting-manual-only
- **BEA → archive:** the `send_gateway` SunBiz lane (60 references), `email_template.py` (25), `run_reseed_sunbiz_forms.py`, `seed_sunbiz_application_form_fields.py`, `sunbiz_cutover_watch.py`, `consolidate_mca_phone_sheet.py`, `migrate_lender_industry_restrictions_key.py`, `scripts/outbound/shop_out*.py`; `tenant_brand.py` after 2026-11-27

### 4.2 Database table disposition

| Disposition | Tables |
|---|---|
| **Export, then delete SunBiz rows** (generic tables stay) | `tenant_records` (entities lead, application, offer, lender, funded_deal, acceptance_run; `kill_switch` and `operating_mode` **last**), `lead_interactions` (including resolved NULLs), `lead_documents`, `document_extraction_jobs`, `forms`, `form_submissions`, `form_views`, `personalized_form_links`, `form_submit_failures`, `conversation_threads`, `conversation_events`, `channel_accounts`, `scheduled_sends`, `scheduled_calls`, `call_appointments`, `email_open_events`, `email_click_events`, `email_log`, `email_templates`, `gmail_templates`, `email_suppressions` (after 2026-11-27 and handover), `esign_*`, `contracts`, `client_signatures`, `tenant_integration_credentials`, `user_integration_credentials`, `integrations_health`, `tenant_cron_jobs`, `chat_sessions`, `chat_messages`, `chat_attachments`, `agent_decisions`, `agent_alerts`, `agent_memory_notes`, `health_*` SunBiz lanes, `daily_plans`, `inference_jobs`, `bridge_pairings`, `drip_sequences`, `drip_runs`, `sequence_state`, `drip_email_events`, `drip_template_pool`, `drip_channel_limits`, `drip_sequence_versions`, `followup_drip_*`, `sms_delivery_receipts`, `sms_sender_numbers`, `sms_breaker_probes`, `sms_destination_health`, `campaign_runs`, `campaign_recipients`, `campaign_metric_snapshots`, `campaign_number_health`, `list_intelligence`, `sms_agent_*`, `tenant_manifests` (`sunbiz` row), `tenant_invites` |
| **Export, then DROP** via a reviewed migration (funding-only) | `funded_deals`, `renewal_outreach_events`, `application_lender_threads`, `application_underwriting`, `application_signing_*`, `signing_otp_codes`, `lender_reply_outcomes`, `lender_feedback`, `deal_paper_snapshot`, `merchant_background_checks`, `clair_reports`, `shop_out_runs`, `shop_out_warnings`, `shopping_threads`, `offer_sources`, `known_funding_companies`, `scrub_candidates`, `phone_lookup_jobs`, `sunbiz_*` (6), `texttorrent_inbound_work`, `texttorrent_dead_letters`, `underwriting_ungrounded_backup_20260806`, view `merchant_summary`, `lead_contacts` (no code references; confirm it has 0 non-SunBiz rows) |
| Keep, deactivated | `user_profiles` (the 4 SunBiz users plus any inactive ones), `tenants` row (`lifecycle='retired'`) |
| 0 rows; retire after the OS equivalents ship | `delivery_*`, `support_tickets`, `ticket_comments`, `provisioning_runs`, `client_roi_snapshots` |

---

## 5. (d) In-flight triage (before touching the shell)

**Start point:** a **fresh worktree from remote main 5db8551a**. The main checkout is on the already-merged `fix/stripe-env-fallback-oasis-only` (#459 merged 09-25).

| Item | Verdict |
|---|---|
| **#457** CC, revenue readiness (70 files: `/t` catch-all, ChatWidget, pipeline, import, bridge recovery) | **Land first.** Rebase on 5db8551a; C-6 removes any SunBiz hunks afterwards. |
| **#434** per-company flags (4 commits, 96 behind) | **Land** 1ce0764b (per-tenant `isDryRun` / `DRIPS_LIVE__<SLUG>`, which also becomes the per-tenant kill switch for OS tenants), 2818ffdd (unsubscribe per tenant) and 40cd7219 (generic health lanes). **Drop** d4baa61e (SunBiz cron health). |
| **tenant-boundary-guards** (pushed, no PR, 96 behind) | **Cherry-pick** b478c58b (P0-3) and 7c3a484d (the bridge refuses to pair one tenant's executor into another; generic), plus their tests from 6b7ebe14. 61e061c3 (TextTorrent token pin) goes in only if the PG-bridge deletion slips more than a week. **Drop** 2dc7f331 (Kixie scan; SunBiz). |
| **Ribbon worktree** `audit/oasis-ribbon-final` (local only; 56 modified + 5 untracked; 241 behind) | **First:** `git diff` plus the untracked files into an encrypted patch in scratch, so nothing is lost. **Then** salvage onto fresh branches only what main lacks:<br>(1) per-user agent authorization (`resolveUserEnabledAgentSlugs`, `tests/per-user-agent-authorization.test.ts`; absent from main): **land as Phase-0 work**<br>(2) the signed website-sales Stripe webhook (`app/api/webhooks/stripe/`, `lib/website-sales-stripe-webhook.ts`, timingSafeEqual and a 300 s tolerance; absent): money path, needs Codex review<br>(3) atomic web-lead claim (main already has a single-statement claim at `lib/web-leads/claim-ops.ts:31`; diff it before salvaging).<br>Discard the rest; the signup and layout edits are superseded by P0-8. |
| **#463** APEX (today): globals.css, layout, Card, tailwind, nav-config, send-mode, renewals, shop-out, `database/112_feature_health.sql`, fleet health | **Hold and coordinate:**<br>• strip the renewals, shop-out and shopping-out edits (retired)<br>• move 112 into `database/turso/` with a reserved number ≥186 (as filed it never applies)<br>• reconcile send-mode with #434<br>• land it *before* the dark-theme shell work so the theme builds on it. |
| #287, #284, #283 APEX rep calendar and dispositions | #287 edits `nav-config`, `role-surfaces` and `Sidebar`. **Reconcile it into the Schedule rebuild** before shell work; the other two are OASIS web-leads work, which APEX rebases or closes. |
| #391, #311, #301, #315, #279 (APEX, OASIS web-leads, sales and marketing) | OASIS-tenant work, not blocking. APEX rebases or closes. |
| #107 APEX, active-profile resolution matches on the API and render paths | Tenant-safety relevant. **Rebase and land in Phase 0**, unless main already makes it redundant. |
| #172 APEX, team invite email | Invite-only signup depends on invite emails. Verify main already sends them; land it or close as superseded. |
| #236 CC, "close two lead-data leaks" (50 files, 5 weeks old; its migrations 147/148 are already on main) | Check that each leak fix is on main, extract anything missing, then close. |
| #249, #151 (small, generic) | Land. |
| #219 build OOM (Vercel era) | Close if the Cloudflare build is unaffected. |
| #174 fleet health | Superseded by #463's health files; close after the #463 decision. |
| #338-344, #453 coordination docs | Update for the SunBiz retirement and merge (docs only), or close as superseded. |
| **SunBiz-only PRs:** #313, #115, #106, #101, #98, #97, #76, #54, #2, #1 | **Close** with the comment "SunBiz retired 2026-09-28" (APEX ack via C-9). |

**Worktrees** (22 linked). `git worktree remove` refuses to remove a dirty tree, which is the safety net.

| Worktree | State | Action |
|---|---|---|
| automation-reliability-hardening, occ-delivery, occ-finances, occ-new-lead-form, occ-oasis-refinement, occ-phone-dedup, oasis-cc-add-lead-stages (detached, #429), oasis-cc-spam-deploy (detached) | 0 ahead, clean | Remove |
| fix-automation-inventory-gen10, builder-sales-access (oasis-cc-pipeline-fix), oasis-cc-sales-turnkey-final, occ-tenant-leaks (`test/exercise-alerting-check`) | Commits already on main (`git cherry` shows `-`: #450, #306) | Remove |
| oasis-cc-auth-hotfix | Fix landed as #296 (801ba2d7); 2 test commits pushed | Check the tests exist on main, then remove |
| occ-sunbiz-restore, occ-sunbiz-form-links, occ-bluerise-drips, oasis-command-center-dolphin-fix | SunBiz, 0 ahead | Remove (abandon) |
| **oasis-command-center-sales-engine** | Holds branch `main` at 3782a042, 209 behind, clean. This is the stale checkout. | Remove; it frees `main` for normal use |
| ocs-leadfix `feat/comp-v4-new-splits` | WIP commit pushed; only `package-lock.json` is dirty | Keep the branch as input to the opt-in Commissions module; remove the worktree |
| occ-per-company-health, occ-tenant-boundary-guards | Active | Remove after landing, as above |
| oasis-cc-ribbon-final | Only local copy | Salvage, as above |

**BEA:** the working tree has uncommitted `bravo_cli/*`, `email_*` and `inbound_classifier` changes, plus untracked `apps/oasis-movies`. These belong to a sibling session. Don't touch them, and keep `oasis_movies_*` in `bravo` (operator data) after the split.

---

## 6. Decisions for CC (batched, each with a recommendation)

1. **Run the C-1 freeze today.** Recommended, 10/10. It is reversible, and SunBiz merchants are still being mailed as of 12:06Z today.
2. **Adopt option B+: separate `oasis-os` database, cell-ready.** Recommended, 9/10. Do it after the SunBiz purge and before the first outside pilot writes data.
3. **SunBiz data:** hand the export to the former client under the contract's end-of-mandate terms, then destroy OASIS's copies (Law 25). Recommended, 9/10. The alternative, retaining a copy, has no lawful purpose once the mandate ends.
4. **Websites and domains:** transfer them to the former client. Recommended, 8/10. Taking them down strands their brand.
5. **The 48 self-signup tenants:** give them the fail-closed "not provisioned" page now, then decide between keeping them dormant and deleting them with notice. Recommended, 8/10.
6. **Extend `check_migration_collision.py` to OCC's migration directories.** A shared tool, so this needs CC's yes (Rule 10). Recommended, 9/10.

---

## 7. Evidence log (read-only)

- **Git:** `git worktree list`; `git rev-list --left-right --count` and `git cherry` per branch; `git ls-remote` (remote main 5db8551a; guards branch pushed; ribbon branch not pushed); `gh pr list` and `gh pr view 462/463/459/107/236/172/249`.
- **Code read at origin/main:** `lib/tenant-integration-store.ts`, `lib/manifest/{seeds,guards}.ts`, commit b478c58b, `app/api/webhooks/stripe-provision`, `app/api/goals`, `lib/field-encryption.ts`, `app/api/state-health`, `app/{runs,system-health,inbox,reasoning}`, `lib/operator-credentials.ts`, `app/api/auth/{turso-signup,provision}`, `lib/auth-provisioning.ts`, `middleware.ts`, `app/api/quests`, `app/api/pg`, `lib/bridge-proxy.ts`, `lib/drips/{governor,executor,enroller}.ts`, `lib/integrations/send-mode.ts` (+ the #434 diff), `lib/portals/registry.ts`, `lib/manifest/schema.ts`, `lib/r2-storage.ts`, `lib/esign/storage.ts`, `lib/lead-documents.ts`, `lib/applications/promote-lead-to-application.ts`, `lib/email/brand-for-tenant.ts`, `database/turso/{180,183}`, `workers/oasis-cc-cron/src/index.ts`, `config/cron-registry.json`, `lib/delivery/{rules,access}.ts`, `lib/team-activation.ts`, `lib/role-surfaces*.ts`.
- **BEA:** `client_health.py:286-304`, `send_gateway.py` (2165-2196, 2335-2362, 1586-1618), `pause_controller.py`, `cron_engine.py:327`, `check_migration_collision.py`, `config/cloudflare/{apps.json, manifests/oasis-command-center.json}` (key names only), `ecosystem.config.js`, `docs/VPS_SERVICE_PROCESSES_SYSTEM_MESSAGE.md`, `brain/OWNERSHIP_MAP.yaml`.
- **SunBiz-Agent:** `ecosystem.config.js`, `scripts/core/cron_registry.py`, `scripts/sequence_runner.py`.
- **Live Turso** (`turso_tool.py sql`, read-only aggregates, logged as unscoped-with-reason):

| Query | Result |
|---|---|
| `lead_interactions` NULL tenant | 752 |
| profiles without a live auth user | 0 |
| tenants | 51 |
| manifests with NULL tenant | 0 |
| `oasis_quests` rows | 55 |
| SunBiz: enabled sequences / other tenants' sequences | 10 / 0 |
| SunBiz: pending drip runs / enabled crons | 730 / 6 |
| SunBiz: active users / open pairings | 4 / 1 |
| SunBiz: applications with an SSN / documents | 753 / 5,461 |
| SunBiz outbound: 7 days / since 09-27 / last | 319 / 42 / 2026-09-28T12:06:15Z |