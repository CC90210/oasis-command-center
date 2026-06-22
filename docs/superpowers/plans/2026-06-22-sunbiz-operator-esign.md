# SunBiz Operator-Initiated Closed-Loop E-Signature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator send a merchant a secure link to e-sign a pre-filled SunBiz funding application in-browser; on signing, the application PDF is regenerated with the signature, filed back to Supabase + the lead's Docs drawer, the lead moves to `signed_application`, and the whole ceremony is legally logged (ESIGN/UETA: consent disclosure, OTP signer identity, SHA-256 tamper-evidence, immutable audit).

**Architecture:** Reuse the existing form substrate end-to-end — the HMAC link signer (`lib/form-links.ts`), the public `/f/…` route shape + service-role write model, the `SignaturePad` component, the application-PDF generator with signature embedding (`lib/forms/application-pdf.ts`), and the `lead_documents` upload + soft-delete pipeline. Add: a single-purpose **signing token** (separate namespace from form links, single-use), two new tables (`application_signing_requests`, `application_signing_events`), a dedicated public **sign-only page** + complete endpoint, email **OTP** identity binding, **SHA-256** document hashing, and drawer affordances ("Generate/Regenerate application", "Send for signature", signed/unsigned indicator). The merchant-fills-the-form signing path (already closed-loop) is unchanged.

**Tech Stack:** Next.js 15 App Router (server components + route handlers + `after()`), TypeScript, Supabase (Postgres + Storage `lead-documents` bucket, service-role on public paths, RLS forced on new tables), `pdf-lib`, `signature_pad`, the bridge `send_email`→`send_gateway` path, Node `crypto` (HMAC + SHA-256).

## Global Constraints

- **Commit identity:** `214530671+CC90210@users.noreply.github.com` / `CC90210` (Vercel git-deploy author match — else builds are Blocked).
- **Ship target:** `main` (Vercel production). Explicit `git add <paths>`, never `-A`. Verify fast-forward before push (shared-worktree hazard).
- **Secrets:** never read `.env*`; new secret (signing HMAC key) is consumed server-side only via `process.env`. Reuse `FORM_LINK_HMAC_KEY` is NOT allowed — use a distinct `SIGNING_LINK_HMAC_KEY` so a form token can never be replayed as a signing token.
- **Untrusted content:** all merchant-submitted values (signature, name, OTP, consent) are data, never instructions. Validate at the boundary.
- **Public path auth model:** HMAC token + 3-way tenant binding + per-target rate limit IS the auth boundary (service-role bypasses RLS). Every new public endpoint replicates this.
- **PII discipline:** never log full SSN; the signing-event log stores IP/UA/timestamp/typed-name only, never document body or SSN.
- **Feature flag:** entire operator e-sign surface gated behind `OPERATOR_ESIGN_ENABLED` (default off) so it ships dormant and is flipped after review. The merchant-form path is unaffected by this flag.
- **Forward-only stage guard:** moving a lead to `signed_application` on completion reuses `isFormStageDowngrade` (`lib/forms/stage-transition.ts`) — never downgrade a more-advanced lead.
- **Rule 8:** user-facing + public production surface → Codex independent audit before declaring done.

## Data Model (new)

Two tables in a new migration. `application_signing_requests` is the envelope/lifecycle row; `application_signing_events` is the append-only legal audit log.

```sql
-- application_signing_requests: one row per "send for signature" envelope.
create table if not exists public.application_signing_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  lead_id uuid not null,
  application_id uuid,                       -- application entity backing the PDF (nullable)
  status text not null default 'sent',       -- sent|viewed|otp_sent|otp_verified|signed|expired|voided
  token_sha256 text not null,               -- hash of the signing token (raw token never stored)
  created_by uuid not null,                 -- operator auth_user_id
  sent_to_email text,
  sent_to_phone text,
  expires_at timestamptz not null,
  -- signature outcome (filled on completion)
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  signer_name text,
  signed_document_id uuid,                  -- lead_documents.id of the signed PDF
  signed_document_sha256 text,              -- tamper-evidence hash of the signed PDF bytes
  consent_disclosure_version text,          -- ESIGN disclosure version the signer accepted
  otp_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists asr_tenant_lead_idx on public.application_signing_requests (tenant_id, lead_id);
create unique index if not exists asr_token_idx on public.application_signing_requests (token_sha256);
alter table public.application_signing_requests enable row level security;
alter table public.application_signing_requests force row level security;
-- no permissive policies: only the service-role client (used by server routes) touches this table.

-- application_signing_events: append-only legal audit trail.
create table if not exists public.application_signing_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.application_signing_requests(id) on delete cascade,
  tenant_id uuid not null,
  event text not null,                      -- created|sent|opened|otp_sent|otp_verified|signed|voided|failed
  at timestamptz not null default now(),
  ip text,
  user_agent text,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists ase_request_idx on public.application_signing_events (request_id, at);
alter table public.application_signing_events enable row level security;
alter table public.application_signing_events force row level security;

-- OTP codes for signer-identity binding (short-lived, single-use).
create table if not exists public.signing_otp_codes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.application_signing_requests(id) on delete cascade,
  code_sha256 text not null,                -- hash of the 6-digit code
  channel text not null,                    -- email|sms
  destination text not null,                -- masked at rest is not required; full needed to resend
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists otp_request_idx on public.signing_otp_codes (request_id, created_at);
alter table public.signing_otp_codes enable row level security;
alter table public.signing_otp_codes force row level security;
```

> Schema note: this repo intentionally ships few migrations (`docs/SECURITY_POSTURE.md`). The migration file lives in `database/` for record, but is **applied to Supabase project `phctllmtsogkovoilwos` via `mcp__supabase__apply_migration` / `supabase_tool.py`** — confirm columns live before relying on them. RLS is **forced with no policies**: only the service-role server client reads/writes, matching the existing public-form trust model.

---

## File Structure

**Create:**
- `database/103_application_signing.sql` — the migration above.
- `lib/signing/signing-token.ts` — `signSigningToken` / `verifySigningToken` (separate HMAC namespace, single-purpose claim `{purpose:'sign', tenant, request_id, lead_id, iat}`).
- `lib/signing/signing-requests.ts` — lifecycle helpers: `createSigningRequest`, `getSigningRequestByToken`, `markStatus`, `recordSigningEvent`, `completeSigning`.
- `lib/signing/otp.ts` — `issueOtp`, `verifyOtp` (6-digit, hashed, 10-min TTL, max 5 attempts, throttle).
- `lib/signing/signed-pdf.ts` — `regenerateSignedApplicationPdf({tenantId, leadId, applicationId, signatureDataUri, signerName, signedAt})` → embeds signature, computes SHA-256, soft-deletes prior `final_application_form`, files new one, returns `{documentId, sha256}`. Pulls the shared section-mapping out of `application-document.ts` (small refactor to export a `buildSignedApplicationPdf` that both the lead and record paths call) — DRY, no behavior change to existing callers.
- `lib/signing/esign-disclosure.ts` — versioned ESIGN consent disclosure text (`ESIGN_DISCLOSURE_VERSION`, `ESIGN_DISCLOSURE_TEXT`).
- `app/f/[tenant_slug]/sign/[token]/page.tsx` — public sign-only page (server component).
- `components/signing/SignCeremonyClient.tsx` — client: app summary (read-only) + consent + OTP + SignaturePad + attestation + submit.
- `app/api/forms/sign/route.ts` — POST complete-signing endpoint (public, token-auth).
- `app/api/forms/sign/otp/route.ts` — POST issue/verify OTP (public, token-auth).
- `app/api/leads/[id]/generate-application/route.ts` — operator: generate/regenerate the application PDF.
- `app/api/leads/[id]/send-for-signature/route.ts` — operator: create signing request + mint token + deliver link.
- `tests/signing-token.test.ts`, `tests/signing-requests.test.ts`, `tests/signed-pdf.test.ts`, `tests/otp.test.ts` — unit tests (run via `npx tsx`).

**Modify:**
- `lib/forms/application-document.ts` — export the shared `buildSignedApplicationPdf` core consumed by `lib/signing/signed-pdf.ts` (no change to existing public behavior).
- `components/leads/LeadDetailDrawer.tsx` (DocumentsTab, ~1368-1422) — add "Generate / Regenerate application" + "Send for signature" buttons + signed/unsigned badge on the Application slot.
- `lib/lead-doc-display.ts` — ensure a `signed/unsigned` derivation helper for the Application slot (uses `metadata.signed_document_sha256` presence + `metadata.signed_at`).
- `database/` index/docs as needed.

---

## Phase 0 — Foundation (safe; no public surface; ships behind nothing)

### Task 1: Signing audit migration

**Files:**
- Create: `database/103_application_signing.sql` (SQL above, verbatim)
- Apply: Supabase project `phctllmtsogkovoilwos`

- [ ] **Step 1:** Write `database/103_application_signing.sql` with the three `create table` + RLS-force blocks above.
- [ ] **Step 2:** Apply via `mcp__supabase__apply_migration` (name `application_signing`) OR `python scripts/supabase_tool.py` equivalent.
- [ ] **Step 3:** Verify with `mcp__supabase__list_tables` that the three tables exist with `force row level security` and the unique `asr_token_idx`.
- [ ] **Step 4:** Commit `git add database/103_application_signing.sql && git commit`.

### Task 2: Shared signed-PDF regeneration core

**Files:**
- Modify: `lib/forms/application-document.ts` (export shared builder)
- Create: `lib/signing/signed-pdf.ts`
- Test: `tests/signed-pdf.test.ts`

**Interfaces:**
- Produces: `regenerateSignedApplicationPdf(input: { tenantId: string; leadId: string; applicationId?: string; signatureDataUri: string; signerName: string; signedAt: string }): Promise<{ ok: boolean; documentId?: string; sha256?: string; error?: string }>` — embeds the signature into the application PDF, computes `crypto.createHash('sha256').update(buf).digest('hex')`, soft-deletes the prior non-deleted `final_application_form` for the lead, uploads the new one via `uploadLeadDocument` with `extraMetadata: { signed: true, signed_at, signer_name, signed_document_sha256: sha256, generated_from: 'esign' }`, returns `{ documentId, sha256 }`.
- Consumes: the section mapping currently inside `generateApplicationDocumentFromRecord` — factor out `buildApplicationSections({tenantId, source, merged, leadData})` and reuse.

- [ ] **Step 1: Write the failing test** (`tests/signed-pdf.test.ts`): assert `regenerateSignedApplicationPdf` returns a hex sha256 of length 64 and `ok:true` for a stub lead/signature (mock `getServiceSupabase` + `uploadLeadDocument` via dependency seam or a thin integration against a known demo lead). At minimum, unit-test the **hash** is computed over the exact bytes and the signature URI guard mirrors `application-pdf.ts` (`startsWith('data:image')`).
- [ ] **Step 2:** Run `npx tsx tests/signed-pdf.test.ts` → FAIL (function not defined).
- [ ] **Step 3:** Implement `lib/signing/signed-pdf.ts`, reusing `generateApplicationPdf` + `uploadLeadDocument` + the soft-delete loop pattern from `application-document.ts:445-454`. Compute SHA-256 over the generated `Buffer`.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit.

### Task 3: Operator "Generate / Regenerate application" route + drawer button

**Files:**
- Create: `app/api/leads/[id]/generate-application/route.ts`
- Modify: `components/leads/LeadDetailDrawer.tsx` (DocumentsTab Application slot)
- Test: manual + existing typecheck/lint

**Interfaces:**
- `POST /api/leads/[id]/generate-application` body `{ replace?: boolean }` → session+tenant auth (mirror `app/api/leads/[id]/create-application/route.ts`), resolve the lead's application entity (or create one if absent via the same path create-application uses), call `generateApplicationDocumentFromRecord({ tenantId, applicationId, replace })`, return `{ ok, documentId }`. Owner-or-admin gated; `canViewLead` when `LEAD_SCOPING_ENABLED`.

- [ ] **Step 1:** Write the route mirroring `create-application/route.ts` auth + `after()` discipline; call the generator synchronously (operator expects the doc immediately) and return its result.
- [ ] **Step 2:** Add a "Generate application" button (slot empty) and "Regenerate" (slot filled) in `DocumentsTab` near `LeadDetailDrawer.tsx:1402-1421`, POSTing to the new route, then `refresh()`.
- [ ] **Step 3:** `npx tsc --noEmit` + `npx eslint` on both files → clean.
- [ ] **Step 4:** Manual: on a demo lead with an application, click Regenerate → new PDF appears in the slot.
- [ ] **Step 5:** Commit.

---

## Phase 1 — Signing token + request lifecycle (operator side)

### Task 4: Single-purpose signing token

**Files:**
- Create: `lib/signing/signing-token.ts`
- Test: `tests/signing-token.test.ts`

**Interfaces:**
- `signSigningToken({ tenant, request_id, lead_id }): string | null` and `verifySigningToken(token): { ok:true; payload } | { ok:false; reason }`. Payload `{ purpose:'sign', tenant, request_id, lead_id, iat }`. Env `SIGNING_LINK_HMAC_KEY` (≥32 chars), TTL `SIGNING_LINK_TTL_DAYS` default 14, fail-closed in prod when unset. Copy the structure of `lib/form-links.ts:110-219` but with the `purpose` claim required in verification (reject form tokens).

- [ ] **Step 1:** Test: a token signed by `signFormLink` MUST fail `verifySigningToken` (namespace isolation), a valid signing token round-trips, expired fails, tampered sig fails (timing-safe).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; include `purpose==='sign'` check + separate key var.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 5: Signing-request lifecycle helpers

**Files:**
- Create: `lib/signing/signing-requests.ts`
- Test: `tests/signing-requests.test.ts`

**Interfaces:**
- `createSigningRequest({ tenantId, leadId, applicationId, createdBy, sentToEmail, sentToPhone }): Promise<{ request, token }>` — inserts a row (`status:'sent'`, `expires_at = now + TTL`, `token_sha256`), signs a token, writes a `created` + `sent` event.
- `getSigningRequestByToken(token): Promise<{ request } | null>` — verify token → look up by `token_sha256` → guard `status !== signed|expired|voided` and `expires_at > now` (single-use).
- `recordSigningEvent(requestId, tenantId, event, {ip,user_agent,meta})`.
- `markStatus(requestId, status)`.
- `completeSigning({ requestId, signedDocumentId, sha256, signerName, ip, userAgent, consentVersion })` — sets the outcome columns + `status:'signed'` + `signed` event, atomically guarding against double-sign (`update … where status != 'signed'`).

- [ ] Steps 1-5: TDD each helper. Critical test: `getSigningRequestByToken` returns null for an already-`signed` request (single-use), and `completeSigning` is idempotent under concurrent calls (guarded UPDATE returns 0 rows on the second).

### Task 6: Operator "Send for signature" route + drawer button

**Files:**
- Create: `app/api/leads/[id]/send-for-signature/route.ts`
- Modify: `components/leads/LeadDetailDrawer.tsx`

**Interfaces:**
- `POST /api/leads/[id]/send-for-signature` body `{ channel?: 'email'|'sms' }` → session+tenant+owner-or-admin auth; ensure an application PDF exists (call generate if missing); resolve merchant email/phone from the lead; `createSigningRequest`; build URL `<origin>/f/<tenant_slug>/sign/<token>`; deliver via the bridge `send_email` path (reuse `lib/forms/next-steps-email.ts` send pattern; fail-closed suppression check); return `{ ok, url, request_id }`. Gated behind `OPERATOR_ESIGN_ENABLED`.

- [ ] Steps: route + a "Send for signature" button in the drawer Application slot showing last request status; typecheck/lint; commit. (No automated send in tests — unit-test URL construction + the flag gate.)

---

## Phase 2 — Public sign ceremony (merchant side)

### Task 7: OTP issue + verify

**Files:**
- Create: `lib/signing/otp.ts`, `app/api/forms/sign/otp/route.ts`
- Test: `tests/otp.test.ts`

**Interfaces:**
- `issueOtp({ requestId, channel, destination }): Promise<{ ok }>` — 6-digit numeric, store `code_sha256`, 10-min TTL, deletes prior unconsumed codes, rate-limited (≤3 issues / 10 min / request); sends via bridge email (reuse send path) or Kixie/TextTorrent for SMS.
- `verifyOtp({ requestId, code }): Promise<{ ok: boolean; reason? }>` — hash-compare, `attempts++`, max 5, mark `consumed_at`, set `application_signing_requests.otp_verified=true` + `otp_verified` event.
- `POST /api/forms/sign/otp` body `{ token, action:'issue'|'verify', code? }` → token-auth (`getSigningRequestByToken`) + 3-way tenant bind + rate limit.

- [ ] Steps 1-5: TDD. Tests: wrong code increments attempts and fails; 6th attempt locked; correct code consumes + flips `otp_verified`; expired code fails.

### Task 8: Public sign-only page

**Files:**
- Create: `app/f/[tenant_slug]/sign/[token]/page.tsx`, `components/signing/SignCeremonyClient.tsx`, `lib/signing/esign-disclosure.ts`

**Interfaces:**
- Server page: `verifySigningToken` + `getSigningRequestByToken` + 3-way tenant bind (token.tenant === url tenant_slug === joined tenants.slug) → 404 on mismatch; `force-dynamic`, `revalidate 0`; record `opened` event + `status:'viewed'`; load a **read-only** summary of the application sections (reuse `buildApplicationSections`) to render; pass to `SignCeremonyClient`.
- Client: shows (1) application summary; (2) **ESIGN consent disclosure** (`ESIGN_DISCLOSURE_TEXT` + version) with a required checkbox; (3) OTP step (request code → enter); (4) `SignaturePad` + typed legal name + accuracy attestation; (5) Submit (disabled until consent + OTP verified + signature non-empty + name + attestation).

- [ ] Steps: build page + client; typecheck/lint; manual render with a minted token; commit.

### Task 9: Complete-signing endpoint (the closed loop)

**Files:**
- Create: `app/api/forms/sign/route.ts`
- Test: `tests/signed-pdf.test.ts` (extend) + manual e2e

**Interfaces:**
- `POST /api/forms/sign` body `{ token, signature_data_uri, signer_name, consent_accepted:true, attestation:'agreed' }` → token-auth + 3-way bind + rate limit (10/min/request); guard `request.otp_verified === true` and `status !== 'signed'`; capture `ip`+`user_agent`; call `regenerateSignedApplicationPdf` (embeds signature, SHA-256, files signed PDF, soft-deletes old); also file the standalone signature image (reuse `ensureApplicantSignatureFile`); move the lead to `signed_application` via the forward-only guard; `completeSigning(...)` (single-use); write `signed` event; fire a Realtime broadcast nudge to the lead's board + a `lead_interactions` `application_generated`/`application_signed` timeline row. Return `{ ok, signed_document_id }`.

- [ ] **Step 1:** Test the guard chain: missing OTP → 403; already-signed token → 409 (single-use); success path returns a `signed_document_id` and the lead stage becomes `signed_application`.
- [ ] **Step 2-4:** Implement + run.
- [ ] **Step 5:** Commit.

### Task 10: Completion screen — retain-a-copy

**Files:**
- Modify: `components/signing/SignCeremonyClient.tsx`

- [ ] On `{ok}`, show a success screen with a **Download your signed copy** button (mints a short-lived signed URL for the merchant — a NEW public, token-scoped read route `app/api/forms/sign/document/route.ts` that returns a signed URL ONLY for `request.signed_document_id` of a `signed` request, satisfying the ESIGN "right to retain a copy"). TDD the route's scope guard (only serves the one signed doc bound to the token). Commit.

---

## Phase 3 — Compliance surfacing + live update

### Task 11: Drawer signed/unsigned indicator + tamper-evidence display

**Files:**
- Modify: `components/leads/LeadDetailDrawer.tsx` (Application slot), `lib/lead-doc-display.ts`

- [ ] Derive signed state from `appDoc.metadata.signed_document_sha256` + `signed_at`; show a green "Signed ✓ (e-signed <date>)" vs amber "Unsigned — awaiting signature" badge; show the SHA-256 (truncated) + signer name + IP on hover/expand. Typecheck/lint. Commit.

### Task 12: Live command-center update on sign

**Files:**
- Modify: `app/api/forms/sign/route.ts` (broadcast), confirm `BoardLiveRefresh` subscribes

- [ ] Reuse the existing P3 Realtime broadcast nudge (`board:<auth_user_id>` of the lead's assignee/admins) so the Leads board + drawer refresh the instant the merchant signs. Verify against `components/.../BoardLiveRefresh`. Commit.

---

## Phase 4 — Verification & ship

### Task 13: End-to-end + Rule 8

- [ ] Full e2e on a demo lead: operator "Send for signature" → open the minted link → consent → OTP → draw signature → submit → confirm: signed PDF replaces the old in the drawer, SHA-256 present, lead in `signed_application`, audit rows in `application_signing_events`, single-use token now 409s on reuse.
- [ ] `npm run typecheck` + `npm run lint` + all `tests/*.test.ts` green.
- [ ] Codex independent audit (`codex-companion.mjs review --wait`) — focus: token namespace isolation, single-use enforcement, OTP brute-force limits, service-role write surface, storage-path confused-deputy guard, ESIGN audit completeness. Present verbatim.
- [ ] Ship behind `OPERATOR_ESIGN_ENABLED=false`; set `SIGNING_LINK_HMAC_KEY` in Vercel; flip flag after CC review.

---

## Out of scope (YAGNI for v1)
- PKI/digital-certificate signatures (image e-signature + hash + audit is ESIGN/UETA-adequate for MCA applications).
- Multi-signer / counter-signature flows.
- SMS OTP is optional (email OTP is the default identity check; wire Kixie/TextTorrent only if CC wants SMS).
- Re-architecting the merchant-fills-the-form path (already closed-loop).

## Verification gate (definition of done)
typecheck + lint + unit tests green, e2e loop proven on a demo lead, Codex audit clean/addressed, shipped to `main` Ready on Vercel, flag dormant. Then CC flips `OPERATOR_ESIGN_ENABLED`.
