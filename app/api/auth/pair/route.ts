/**
 * POST /api/auth/pair — setup-wizard ↔ dashboard handoff.
 *
 * Called by the local setup wizard after credentials are saved. Two jobs:
 *   1. Seed/update the operator's user_profiles row from wizard answers
 *      (brand, voice, primary agent, MRR target, schedule, agents_enabled,
 *      manifesto). After this, the dashboard's first paint shows their
 *      personalized data instead of the OASIS defaults.
 *   2. Mint a bridge_pairings row + bearer token. The wizard saves the token
 *      to ~/.oasis/bridge_token; the local bridge daemon then uses it as a
 *      Bearer credential when pinging integrations_health.
 *
 * Auth, and who gets paired. The request body never chooses the person:
 *   - HMAC headers (x-oasis-profile-id + x-oasis-secret), the bridge's
 *     self-pair on boot: the profile the headers prove is the person.
 *     body.email and body.auth_user_id are ignored.
 *   - Bearer CLI_SIGNUP_SECRET, the wizard's legacy path: every wizard machine
 *     holds this secret, so it proves nobody's identity. The body names the
 *     account, and the route pairs it only while it is still being set up:
 *     not onboarded, and the profile and its workspace created within the last
 *     hour (install/bootstrap.py provisions the account, then the wizard pairs
 *     it). Anything else is 403 use_a_pair_code: that person pairs with a code
 *     minted in a signed-in session (Settings > Devices, /api/auth/pair-code).
 * Before this (2026-10-10), body.email won over the proven profile and
 * body.auth_user_id was looked up first, so one person's HMAC secret, or the
 * shared secret, could pair as anyone and overwrite another workspace's AI keys.
 *
 * Body:
 *   {
 *     email:           string  (CLI_SIGNUP_SECRET only, required; ignored with HMAC)
 *     auth_user_id?:   uuid    (CLI_SIGNUP_SECRET only; ignored with HMAC)
 *     profile:         {
 *       full_name?:        string,
 *       display_name?:     string,
 *       brand?:            string,
 *       primary_agent?:    string,
 *       agents_enabled?:   string[],
 *       mrr_target_usd?:   number,
 *       mrr_current_usd?:  number,
 *       mrr_target_date?:  ISO date,
 *       manifesto?:        string,
 *       prospect_focus?:   string[]
 *     },
 *     machine: {
 *       label?:        string  (e.g. "CC's MacBook")
 *       fingerprint?:  string  (os + hostname + cpu hash from the wizard)
 *     }
 *   }
 *
 * Returns:
 *   {
 *     ok: true,
 *     tenant_id, profile_id, auth_user_id,
 *     bridge: { pairing_id, token, dashboard_url }
 *   }
 *
 * The bridge token is sha256-hashed before storage. The plaintext is returned
 * exactly once (in this response) — wizard writes it to ~/.oasis/bridge_token.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, checkBearerSecret, sha256, isUniqueViolationError, publicAppBaseUrl } from "@/lib/api-helpers";
import { encryptField } from "@/lib/field-encryption";
import { chatAgentKeys } from "@/lib/agent-personas";
import { applyClientProvisioningProfile } from "@/lib/client-provisioning";
import { defaultModelFor } from "@/lib/ai/model-registry";
import {
  clientIp as _clientIp,
  isRateLimited as _isRateLimited,
  recordPairAttempt as _recordPairAttempt,
  type PairOutcome,
} from "@/lib/pair-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter"]);
// Each provider's default model is the registry's (lib/ai/model-registry.ts):
// the Google default here was Gemini 2.5 Pro, which Google now serves only to
// projects that used it before.
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  openrouter: defaultModelFor("openrouter"),
  anthropic: defaultModelFor("anthropic"),
  openai: defaultModelFor("openai"),
  google: defaultModelFor("google"),
};

// Pick the best provider when the wizard sent multiple keys — operators
// usually want OpenRouter as default since one key covers all models.
const PROVIDER_PREFERENCE = ["openrouter", "anthropic", "openai", "google"];

type Body = {
  email?: string;
  auth_user_id?: string;
  profile?: {
    full_name?: string;
    display_name?: string;
    brand?: string;
    primary_agent?: string;
    agents_enabled?: string[];
    mrr_target_usd?: number;
    mrr_current_usd?: number;
    mrr_target_date?: string;
    manifesto?: string;
    prospect_focus?: string[];
  };
  machine?: {
    label?: string;
    fingerprint?: string;
  };
  /**
   * Optional: API keys the wizard / bridge collected from the operator's
   * local .env.agents. Each provided key gets encrypted server-side and
   * upserted into agent_model_config for EVERY chat-eligible agent, so the
   * operator's chat works immediately without paste-and-encrypt.
   *
   * The first key found (in PROVIDER_PREFERENCE order) becomes the default
   * provider for all agents. Operator can override per-agent later in
   * /settings → Agents.
   */
  api_keys?: Record<string, string>;
};

const PROFILE_FIELDS = new Set([
  "full_name",
  "display_name",
  "brand",
  "primary_agent",
  "agents_enabled",
  "mrr_target_usd",
  "mrr_current_usd",
  "mrr_target_date",
  "manifesto",
  "prospect_focus",
]);

// Rate-limit + audit-log helpers (clientIp, isRateLimited, recordPairAttempt,
// PairOutcome) are imported from @/lib/pair-rate-limit so /api/auth/pair-code/
// redeem shares the same primitives. See migration 031 + 034 + brain/
// SECURITY_MODEL.md §6 for the threat model + table schema.

type ProfileRow = {
  id: string;
  tenant_id: string | null;
  auth_user_id: string | null;
  email: string | null;
};

/**
 * How long after an account and its workspace are created the shared
 * CLI_SIGNUP_SECRET may still pair it: the wizard pairs in the same run that
 * provisioned the account (/api/auth/provision-cli).
 */
const SIGNUP_SECRET_PAIR_WINDOW_MS = 60 * 60 * 1000;
/** A creation time this far ahead of this server's clock still counts as now. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// The wizard prints the first 200 characters of a refusal; both stay under it.
// `bravo seed-keys` sends this secret too, to set an account's AI keys.
const USE_A_PAIR_CODE =
  "use_a_pair_code: this account or its workspace is already set up, so the setup secret cannot pair it " +
  "or set its AI keys. Pair with a code from Settings > Devices.";
const MACHINE_PAIRED_TO_ANOTHER_PERSON =
  "machine_paired_to_another_person: this computer is paired to another person in this workspace. " +
  "Disconnect it in Settings > Devices, then pair again.";

/** True when `createdAt` is a readable time within the signup-secret window. */
function createdWithinSignupWindow(createdAt: unknown, nowMs: number): boolean {
  if (typeof createdAt !== "string" || !createdAt) return false;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = nowMs - createdMs;
  return ageMs >= -CLOCK_SKEW_MS && ageMs <= SIGNUP_SECRET_PAIR_WINDOW_MS;
}

/**
 * Alternate auth path: HMAC headers (x-oasis-profile-id + x-oasis-secret).
 * Used by the chat server's self-pair-on-boot — operators don't have
 * CLI_SIGNUP_SECRET in their local env, but they DO have the per-profile
 * HMAC secret (issued by `n8n_webhook_secret.py issue --save-env` and used
 * for the outbound write-through path). One credential, two purposes.
 *
 * Returns the profile the headers PROVE, or null when the headers are absent
 * or malformed, no live secret for that profile matches, or the profile cannot
 * be read. The route pairs exactly this profile.
 */
async function _hmacProvenProfile(req: NextRequest): Promise<ProfileRow | null> {
  const profileId = req.headers.get("x-oasis-profile-id");
  const rawSecret = req.headers.get("x-oasis-secret");
  if (!profileId || !rawSecret) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) return null;
  const secretHash = sha256(rawSecret);
  const db = getServiceSupabase();
  // Pull ALL non-revoked rows for this profile, then compare each hash
  // in Node via timingSafeEqual. Doing the comparison in SQL via
  // .eq("secret_hash", secretHash) is byte-wise but not constant-time
  // at the SQL/index layer — Node-side compare eliminates the
  // (theoretical) timing side-channel from the DB indexer. See
  // brain/SECURITY_MODEL.md §4 for the threat model rationale.
  //
  // Why fetch ALL rows + iterate (not maybeSingle):
  // operators may have multiple issued secrets per profile during
  // rotation (issue new before revoking old to avoid downtime).
  // Original code worked because SQL .eq filtered uniquely by hash,
  // but for Node-side compare we have to enumerate and match any
  // live secret. Iteration is over secrets-per-profile (small N,
  // typically 1-3), runs in <1ms.
  const r = await db
    .from("n8n_webhook_secrets")
    .select("secret_hash")
    .eq("profile_id", profileId)
    .is("revoked_at", null);
  if (r.error || !r.data || r.data.length === 0) return null;
  const provided = Buffer.from(secretHash, "hex");
  let matched = false;
  for (const row of r.data) {
    if (!row.secret_hash) continue;
    const stored = Buffer.from(row.secret_hash, "hex");
    if (stored.length !== provided.length) continue;
    // timingSafeEqual on a CT-comparable buffer pair. Don't short-circuit
    // out of the loop on first match — keeps total work bounded by the
    // number of issued secrets, not by which one matched, so the
    // attacker can't time which secret-id was the live one.
    if (timingSafeEqual(stored, provided)) matched = true;
  }
  if (!matched) return null;
  const pf = await db
    .from("user_profiles")
    .select("id, tenant_id, auth_user_id, email")
    .eq("id", profileId)
    .maybeSingle();
  if (pf.error || !pf.data) return null;
  return pf.data as ProfileRow;
}

type SignupProfileRow = ProfileRow & {
  onboarding_completed_at: string | null;
  created_at: string | null;
};

/**
 * The account a CLI_SIGNUP_SECRET call names: by auth_user_id first, then by
 * email, as the wizard has always been answered. A failed read is an error,
 * never "not found": falling through to the email lookup after a failed
 * auth_user_id read could resolve a different account than the one named.
 */
async function _findSignupProfile(
  db: ReturnType<typeof getServiceSupabase>,
  authUserId: string | undefined,
  email: string,
): Promise<{ row: SignupProfileRow | null; error: string | null }> {
  const columns = "id, tenant_id, auth_user_id, email, onboarding_completed_at, created_at";
  if (authUserId) {
    const r = await db.from("user_profiles").select(columns).eq("auth_user_id", authUserId).maybeSingle();
    if (r.error) return { row: null, error: r.error.message };
    if (r.data) return { row: r.data as SignupProfileRow, error: null };
  }
  const r = await db.from("user_profiles").select(columns).eq("email", email).maybeSingle();
  if (r.error) return { row: null, error: r.error.message };
  return { row: (r.data as SignupProfileRow | null) ?? null, error: null };
}

export async function POST(req: NextRequest) {
  // Two valid auth modes:
  //   1. CLI_SIGNUP_SECRET bearer (interactive wizard path)
  //   2. HMAC headers (chat-server self-pair path)
  //
  // Rate-limit: if the same profile_id has hit > PAIR_RATE_MAX_FAILURES in
  // the last PAIR_RATE_WINDOW_SECONDS with INVALID auth, return 429 + log
  // the rate_limited outcome. Successful pairs don't accumulate. Window is
  // intentionally short (60s / 10 fails) so a legitimate operator hitting
  // a typo doesn't get locked out for long.
  const ip = _clientIp(req);
  const headerProfileId = req.headers.get("x-oasis-profile-id") || "";

  if (headerProfileId && (await _isRateLimited(headerProfileId))) {
    await _recordPairAttempt(headerProfileId, "rate_limited", ip);
    return bad(429, "rate_limited: too many failed pair attempts; back off and retry");
  }

  const hmacProfile = await _hmacProvenProfile(req);
  if (!hmacProfile && !checkBearerSecret(req, "CLI_SIGNUP_SECRET")) {
    // Log the failure with the right outcome based on which path was tried.
    // headerProfileId may be empty when neither header was sent at all.
    const outcome: PairOutcome = !headerProfileId
      ? "invalid_bearer"
      : hmacProfile === null
        ? "invalid_hmac"
        : "invalid_bearer";
    await _recordPairAttempt(headerProfileId || "no-profile", outcome, ip);
    return bad(401, "missing or invalid Bearer secret (or HMAC headers)");
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const db = getServiceSupabase();

  // ---- 1. Resolve the person ----------------------------------------------
  const profileSrc = body.profile || {};
  const update: Record<string, unknown> = {};
  for (const k of Object.keys(profileSrc)) {
    if (PROFILE_FIELDS.has(k)) update[k] = (profileSrc as Record<string, unknown>)[k];
  }

  // HMAC: the proven profile, whatever the body names. Signup secret: the
  // account the body names, which step 1b must find still being set up.
  let profileRow: ProfileRow | null = hmacProfile;
  let signupRow: SignupProfileRow | null = null;
  if (!hmacProfile) {
    const email = (body.email || "").trim().toLowerCase();
    if (!email) return bad(400, "email required");
    const lookup = await _findSignupProfile(db, body.auth_user_id, email);
    if (lookup.error) return bad(503, `profile lookup failed: ${lookup.error}`);
    signupRow = lookup.row;
    profileRow = signupRow;
  }
  if (!profileRow) {
    return bad(
      404,
      "no user_profiles row for this email — call /api/auth/provision-cli first"
    );
  }

  // Checked before any write, so a refusal changes nothing.
  if (!profileRow.tenant_id) {
    return bad(412, "profile has no tenant_id — provision step incomplete");
  }

  // ---- 1b. The shared signup secret pairs only an account being set up -----
  // Not onboarded, and both the profile and its workspace created within the
  // hour. The workspace check matters: a member invited minutes ago into an
  // established workspace has a fresh profile, and pairing it would seed that
  // established workspace's AI keys in step 1.5.
  if (signupRow) {
    const tenant = await db
      .from("tenants")
      .select("created_at")
      .eq("id", profileRow.tenant_id)
      .maybeSingle();
    if (tenant.error) return bad(503, `workspace lookup failed: ${tenant.error.message}`);
    const nowMs = Date.now();
    const beingSetUp =
      signupRow.onboarding_completed_at == null &&
      createdWithinSignupWindow(signupRow.created_at, nowMs) &&
      createdWithinSignupWindow(tenant.data?.created_at, nowMs);
    if (!beingSetUp) {
      console.warn("[pair] setup-secret pairing refused: account or workspace already set up", {
        profileId: profileRow.id,
      });
      return bad(403, USE_A_PAIR_CODE);
    }
  }

  if (Object.keys(update).length > 0) {
    const r = await db
      .from("user_profiles")
      .update(update)
      .eq("id", profileRow.id)
      .select("id")
      .maybeSingle();
    if (r.error) return bad(500, `profile update failed: ${r.error.message}`);
  }

  // V6.2: brand-based client profile routing. If the wizard sent a brand
  // ("Sun Biz Funding", "Suga Sean O'Malley"), apply the matching client
  // profile slug + data_backend + deployment_mode to tenants.custom_fields.
  // Without this, a tenant that signed up via OAuth (default brand "OASIS AI")
  // and is now setting up SunBiz via the wizard would render CC_NAV instead
  // of SUN_NAV on first dashboard load. Idempotent — non-matching brands
  // return {clientProfileSlug: null} and leave custom_fields untouched.
  const brandForRouting = (profileSrc.brand as string | undefined) || "";
  if (brandForRouting) {
    try {
      await applyClientProvisioningProfile({
        db,
        tenantId: profileRow.tenant_id,
        profileId: profileRow.id,
        brand: brandForRouting,
        email: profileRow.email,
      });
    } catch (err) {
      // Non-fatal: pair still succeeds. Operator can re-trigger from /settings.
      console.warn("[pair.applyClientProvisioningProfile]", err);
    }
  }

  // ---- 1.5. Seed agent_model_config from local API keys -------------------
  // The bridge / wizard ships the operator's .env.agents key values (already
  // on their machine) so admin chat works without paste-and-encrypt.
  let seededAgents = 0;
  let seededProvider: string | null = null;
  if (body.api_keys && Object.keys(body.api_keys).length > 0) {
    // Pick the preferred provider that was supplied
    const supplied = Object.keys(body.api_keys).filter(
      (p) => VALID_PROVIDERS.has(p) && (body.api_keys?.[p] || "").trim().length > 0
    );
    const chosen = PROVIDER_PREFERENCE.find((p) => supplied.includes(p));
    if (chosen) {
      const plaintext = (body.api_keys[chosen] || "").trim();
      let encrypted: string;
      try {
        encrypted = encryptField(plaintext);
      } catch (e) {
        return bad(500, `encrypt_failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
      const model = PROVIDER_DEFAULT_MODEL[chosen];
      // Upsert one row per chat-eligible agent. ON CONFLICT (tenant_id,
      // agent_key) — preserves any per-agent override the operator set
      // earlier by overwriting only when the key is newer.
      const rows = chatAgentKeys().map((agent_key) => ({
        tenant_id: profileRow!.tenant_id,
        user_id: null,
        agent_key,
        provider: chosen,
        model,
        encrypted_api_key: encrypted,
        enabled: true,
      }));
      for (const seedRow of rows) {
        const existing = await db
          .from("agent_model_config")
          .select("id")
          .eq("tenant_id", seedRow.tenant_id)
          .eq("agent_key", seedRow.agent_key)
          .is("user_id", null)
          .maybeSingle();
        if (existing.error) return bad(500, `seed_lookup_failed: ${existing.error.message}`);

        const write = existing.data
          ? await db.from("agent_model_config").update(seedRow).eq("id", existing.data.id)
          : await db.from("agent_model_config").insert(seedRow);
        if (write.error) return bad(500, `seed_failed: ${write.error.message}`);
      }
      seededAgents = rows.length;
      seededProvider = chosen;
    }
  }

  // ---- 2. Mint or rotate a bridge_pairings row ----------------------------
  // Idempotent by (tenant_id, machine_fingerprint). The DB enforces the
  // invariant via the partial unique index from migration 030
  // (idx_bridge_pairings_unique_live_machine, WHERE revoked_at IS NULL).
  // Without this, every restart of `oasis bridge serve` minted a NEW row
  // — CC saw four Mac rows for the same fingerprint after setup attempts.
  //
  // Strategy: try INSERT first. On unique-constraint violation (Postgres
  // code 23505, or SQLITE_CONSTRAINT on the Turso/libSQL path — see
  // isUniqueViolationError), the partial index caught a duplicate live row
  // — switch to UPDATE keyed by (tenant_id, machine_fingerprint,
  // revoked_at IS NULL) to rotate the token on the existing row. This is
  // race-safe (DB-level atomic) AND clean (intent reads as "create a
  // pairing"). PostgREST's .upsert(onConflict:) can't target partial
  // indexes, so we manage the conflict path explicitly.
  const tokenPlain = `oab_${randomBytes(32).toString("hex")}`;
  const tokenHash = sha256(tokenPlain);

  const machine = body.machine || {};
  const fingerprint = (machine.fingerprint as string | undefined) || null;
  const label = (machine.label as string | undefined) || "Local install";
  const nowIso = new Date().toISOString();

  const row = {
    tenant_id: profileRow.tenant_id,
    user_id: profileRow.auth_user_id || null,
    label,
    bridge_token_hash: tokenHash,
    machine_fingerprint: fingerprint,
    last_seen_at: nowIso,
  };

  let pairingId: string | null = null;
  const ins = await db.from("bridge_pairings").insert(row).select("id").single();

  if (!ins.error && ins.data) {
    pairingId = ins.data.id;
  } else if (isUniqueViolationError(ins.error) && fingerprint) {
    // Partial unique index fired — a live pairing already exists for this
    // (tenant, machine). Rotate the token + label on the existing row, but
    // only when that row is this person's own. The fingerprint is
    // self-reported, so without the user_id guard anyone paired in this
    // workspace could send a teammate's fingerprint, rotate the teammate's
    // computer and receive a token for it. One guarded UPDATE: the check and
    // the rotation cannot be split by a concurrent pair.
    if (!row.user_id) return bad(409, MACHINE_PAIRED_TO_ANOTHER_PERSON);
    const upd = await db
      .from("bridge_pairings")
      .update({
        bridge_token_hash: tokenHash,
        last_seen_at: nowIso,
        label,
      })
      .eq("tenant_id", profileRow.tenant_id)
      .eq("machine_fingerprint", fingerprint)
      .eq("user_id", row.user_id)
      .is("revoked_at", null)
      .select("id");
    if (upd.error) {
      return bad(500, `pair rotate failed: ${upd.error.message}`);
    }
    if (!upd.data || upd.data.length !== 1) {
      return bad(409, MACHINE_PAIRED_TO_ANOTHER_PERSON);
    }
    pairingId = upd.data[0].id;
  } else {
    return bad(500, `pair insert failed: ${ins.error?.message || "unknown"}`);
  }

  const baseUrl = process.env.BRAVO_DASHBOARD_URL || publicAppBaseUrl();

  // Log the successful pair attempt. Uses the resolved profile_id (which
  // is canonical — operator may have hit either the bearer or HMAC path,
  // both of which resolve to the same profileRow.id).
  await _recordPairAttempt(profileRow.id, "ok", ip);

  return NextResponse.json({
    ok: true,
    tenant_id: profileRow.tenant_id,
    profile_id: profileRow.id,
    auth_user_id: profileRow.auth_user_id,
    bridge: {
      pairing_id: pairingId,
      token: tokenPlain,
      dashboard_url: baseUrl.replace(/\/$/, "") + "/",
    },
    seeded: {
      agents: seededAgents,
      provider: seededProvider,
    },
  });
}
