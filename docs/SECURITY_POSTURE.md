# SECURITY POSTURE — OASIS Command Center
Audit Fleet V2 (2026-06-09). Verified by inspection; re-verify before trusting.

## Data + tenancy
- **Shared empire Supabase** (`BRAVO_SUPABASE_URL`). Multi-tenant; isolation by `tenant_id`.
- **RLS policies live in the CEO-Agent `database/` migrations**, not in this repo (this repo has no
  schema migrations of its own — `grep -ri "create policy" *.sql` here returns 0, by design).
- **API routes use the service role** (`getServiceSupabase()`), which **bypasses RLS**. The contract:
  **every tenant-scoped query MUST manually filter by the server-resolved `tenant_id`.** Tenant id is
  derived server-side (auth cookie or bridge token), **never** from the request body.
  - **Reviewer rule:** grep new routes for `.from(...)` / `.table(...)` without a nearby
    `.eq('tenant_id', ...)`. A missing filter is a cross-tenant data-leak bug.

## Secrets
- Secrets live in **Vercel env only** (`BRAVO_SUPABASE_*`, `BRAVO_FIELD_ENCRYPTION_KEY`, provider keys).
  No `.env*` is committed. The only `sk_live_` string in the tree is a FAKE fixture in
  `tests/streaming-redactor.test.ts`.
- **Encryption at rest:** client provider keys are AES-256-GCM encrypted (`lib/field-encryption.ts`),
  decrypted at agent-spawn time. Master secret `BRAVO_FIELD_ENCRYPTION_KEY` (Vercel only).
- **Redaction:** `lib/secret-redaction.ts` wraps model-visible strings; the streaming-redactor test
  guards it. Any new model-facing data path must route through redaction.

## Findings + follow-ups (this pass)
- ✅ No tracked env; no real secrets (fake fixture only); redaction tests present; 28 tests + CI.
- 🟠 **Visibility — CC decision pending.** Repo is PUBLIC. Recommendation: **private** (the product
  exposes API routes + tenant-resolution logic to competitors/attackers while public). If kept public
  for marketing, this RLS audit becomes a blocking gate, not documentation.
- ▶ **Per-route tenant-filter audit** (confirm every service-role query filters by tenant_id) is a
  focused next task — high value, not completed in this pass.
