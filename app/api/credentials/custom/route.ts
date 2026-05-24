/**
 * /api/credentials/custom — per-tenant ARBITRARY KEY/VALUE credential vault.
 *
 * Distinct from /api/integrations/keys (which is schema-locked to the
 * KNOWN_INTEGRATIONS registry: Stripe, Twilio, etc.). This endpoint lets
 * tenant admins paste any KEY=VALUE pair their workflows need — a custom
 * CRM API key, an internal service token, a per-client webhook secret —
 * without the empire operator having to pre-register the schema.
 *
 *   GET     — list every (key, last_updated) — NEVER returns the value.
 *   POST    — upsert one entry. Body: { key, value }.
 *   POST (bulk) — upsert many entries. Body: { entries: [{key, value}, ...] }
 *                 OR { dotenv: "KEY1=value1\nKEY2=value2" } for raw paste.
 *   DELETE  — remove one entry. Body: { key }.
 *
 * Storage: reuses `tenant_integration_credentials` with `service="custom"`
 * and `field_key=<user-provided name, normalized>`. Same AES-256-GCM
 * encryption as the integrations table — see lib/field-encryption.ts.
 *
 * Auth: owner / admin (canManageTenant). Members can't see this surface.
 * Agents READ via the new `get_credential` tool (server-side, service-
 * role-scoped, RLS bypassed because the tool itself enforces tenant
 * isolation via ctx.tenantId — same pattern as every other cloud tool).
 *
 * Key naming: normalized to UPPER_SNAKE_CASE (max 64 chars, letters/
 * digits/underscores, must start with a letter). Matches .env convention
 * and means agents can refer to the key by the same name the operator
 * typed. Invalid keys are rejected with a clear error.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canManageTeam, type TeamRole } from "@/lib/team";
import {
  setTenantIntegrationValue,
  deleteTenantIntegrationValue,
  VAULT_CUSTOM_SERVICE,
} from "@/lib/tenant-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEY_LEN = 64;
const MAX_VALUE_LEN = 8192; // 8 KB per value — enough for private keys
const MAX_BULK_ENTRIES = 100;

/** Same UPPER_SNAKE_CASE rule as Node's `process.env` keys. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toUpperCase();
  if (!KEY_PATTERN.test(k)) return null;
  return k;
}

async function canManageTenant(tenantId: string, userId: string): Promise<boolean> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("team_role, is_owner")
    .eq("auth_user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const row = r.data as { team_role: TeamRole | null; is_owner: boolean | null } | null;
  if (!row) return false;
  if (row.is_owner) return true;
  return canManageTeam(row.team_role || "member");
}

type CustomCredentialRow = {
  key: string;
  has_value: boolean;
  updated_at: string | null;
};

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canManageTenant(sess.tenantId, sess.userId))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value, updated_at")
    .eq("tenant_id", sess.tenantId)
    .eq("service", VAULT_CUSTOM_SERVICE)
    .order("field_key", { ascending: true });
  const rows: CustomCredentialRow[] = (
    (r.data || []) as { field_key: string; encrypted_value: string; updated_at: string | null }[]
  ).map((row) => ({
    key: row.field_key.toUpperCase(),
    has_value: !!row.encrypted_value,
    updated_at: row.updated_at,
  }));
  return NextResponse.json({ ok: true, entries: rows });
}

type SingleUpsertBody = { key: string; value: string };
type BulkUpsertBody = { entries: SingleUpsertBody[] };
type DotenvUpsertBody = { dotenv: string };

function parseDotenv(text: string): SingleUpsertBody[] {
  const out: SingleUpsertBody[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Allow optional `export ` prefix (bash style).
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out.push({ key, value });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canManageTenant(sess.tenantId, sess.userId))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: Partial<SingleUpsertBody & BulkUpsertBody & DotenvUpsertBody>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Normalize all three input shapes (single, bulk, dotenv) into one
  // list of pending writes. Validation runs uniformly across all paths.
  let pending: SingleUpsertBody[] = [];
  if (typeof body.dotenv === "string") {
    pending = parseDotenv(body.dotenv);
  } else if (Array.isArray(body.entries)) {
    pending = body.entries.filter(
      (e): e is SingleUpsertBody =>
        !!e && typeof e === "object" && typeof e.key === "string" && typeof e.value === "string",
    );
  } else if (typeof body.key === "string" && typeof body.value === "string") {
    pending = [{ key: body.key, value: body.value }];
  } else {
    return NextResponse.json(
      { ok: false, error: "expected_key+value_OR_entries_array_OR_dotenv_string" },
      { status: 400 },
    );
  }

  if (pending.length === 0) {
    return NextResponse.json({ ok: false, error: "no_entries" }, { status: 400 });
  }
  if (pending.length > MAX_BULK_ENTRIES) {
    return NextResponse.json(
      { ok: false, error: `too_many_entries_max_${MAX_BULK_ENTRIES}` },
      { status: 422 },
    );
  }

  type ResultRow = { key: string; ok: boolean; error?: string };
  const results: ResultRow[] = [];

  for (const entry of pending) {
    const normalizedKey = normalizeKey(entry.key);
    if (!normalizedKey) {
      results.push({
        key: String(entry.key).slice(0, MAX_KEY_LEN),
        ok: false,
        error: "invalid_key_format__must_match_/^[A-Z][A-Z0-9_]{0,63}$/",
      });
      continue;
    }
    const value = (entry.value || "").trim();
    if (!value) {
      results.push({ key: normalizedKey, ok: false, error: "empty_value" });
      continue;
    }
    if (value.length > MAX_VALUE_LEN) {
      results.push({
        key: normalizedKey,
        ok: false,
        error: `value_too_long_max_${MAX_VALUE_LEN}`,
      });
      continue;
    }
    const r = await setTenantIntegrationValue({
      tenantId: sess.tenantId,
      service: VAULT_CUSTOM_SERVICE,
      fieldKey: normalizedKey.toLowerCase(),
      value,
      createdBy: sess.profileId,
    });
    if (r.ok) {
      results.push({ key: normalizedKey, ok: true });
    } else {
      results.push({ key: normalizedKey, ok: false, error: r.error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({
    ok: failed.length === 0,
    saved: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
  });
}

export async function DELETE(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canManageTenant(sess.tenantId, sess.userId))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  let body: { key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const normalizedKey = normalizeKey(body.key);
  if (!normalizedKey) {
    return NextResponse.json({ ok: false, error: "invalid_key" }, { status: 400 });
  }
  const r = await deleteTenantIntegrationValue({
    tenantId: sess.tenantId,
    service: VAULT_CUSTOM_SERVICE,
    fieldKey: normalizedKey.toLowerCase(),
  });
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
