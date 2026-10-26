/**
 * /api/credentials/custom — per-tenant ARBITRARY KEY/VALUE credential vault.
 *
 * Distinct from /api/integrations/keys (which is schema-locked to the
 * KNOWN_INTEGRATIONS registry: Stripe, Twilio, etc.). This endpoint lets
 * tenant admins paste any KEY=VALUE pair their workflows need — a custom
 * CRM API key, an internal service token, a per-client webhook secret —
 * without the empire operator having to pre-register the schema.
 *
 *   GET     — list every (key, last_updated, agents) — NEVER returns the value.
 *   POST    — upsert one entry. Body: { key, value, agents? }.
 *   POST (bulk) — upsert many entries. Body: { entries: [{key, value}, ...] }
 *                 OR { dotenv: "KEY1=value1\nKEY2=value2" } for raw paste,
 *                 with an optional `agents` for every entry in the request.
 *   DELETE  — remove one entry (and its agent choice). Body: { key }.
 *
 * Agents (CC, 2026-10-26): `agents` is "all" or a list of departments
 * (lib/os/agent-access.ts). A key with no choice saved is for every agent. A
 * request without `agents` leaves an existing key's choice as it was. The
 * choice is saved BEFORE the value, so a key is never readable by more agents
 * than the owner picked, even for the moment between the two writes.
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
import {
  setTenantIntegrationValue,
  deleteTenantIntegrationValue,
  VAULT_CUSTOM_SERVICE,
  VAULT_KEY_PATTERN,
} from "@/lib/tenant-integration-store";
import { normalizeAgentAccess, type AgentAccess } from "@/lib/os/agent-access";
import { clearAgentAccess, effectiveAccess, readAgentAccessOverrides, saveAgentAccess } from "@/lib/os/agent-access-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEY_LEN = 64;
const MAX_VALUE_LEN = 8192; // 8 KB per value — enough for private keys
const MAX_BULK_ENTRIES = 100;


function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toUpperCase();
  if (!VAULT_KEY_PATTERN.test(k)) return null;
  return k;
}

type CustomCredentialRow = {
  key: string;
  has_value: boolean;
  updated_at: string | null;
  /** The agents that may use it; null when the choices could not be read. */
  agents: AgentAccess | null;
  /** True when the owner picked the agents; false for the default (every agent). */
  agents_saved: boolean;
};

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value, updated_at")
    .eq("tenant_id", sess.tenantId)
    .eq("service", VAULT_CUSTOM_SERVICE)
    .order("field_key", { ascending: true });
  const overrides = await readAgentAccessOverrides(sess.tenantId);
  if (!overrides.ok) {
    console.error("[credentials.custom] agent choices unreadable", { tenantId: sess.tenantId, error: overrides.error });
  }
  const rows: CustomCredentialRow[] = (
    (r.data || []) as { field_key: string; encrypted_value: string; updated_at: string | null }[]
  ).map((row) => {
    const key = row.field_key.toUpperCase();
    const choice = overrides.ok ? effectiveAccess(overrides.byField, { kind: "custom", key }) : null;
    return {
      key,
      has_value: !!row.encrypted_value,
      updated_at: row.updated_at,
      agents: choice ? choice.access : null,
      agents_saved: choice ? choice.saved : false,
    };
  });
  return NextResponse.json({
    ok: true,
    entries: rows,
    ...(overrides.ok ? {} : { agents_error: "Could not read which agents may use these keys." }),
  });
}

type SingleUpsertBody = { key: string; value: string };
type BulkUpsertBody = { entries: SingleUpsertBody[] };
type DotenvUpsertBody = { dotenv: string };
type AgentsBody = { agents: unknown };

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
  if (!sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: Partial<SingleUpsertBody & BulkUpsertBody & DotenvUpsertBody & AgentsBody>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  // Optional: who may use every key in this request. Absent leaves each key's choice as it is.
  let agents: AgentAccess | undefined;
  if (body.agents !== undefined) {
    const parsed = normalizeAgentAccess(body.agents);
    if (parsed === null) {
      return NextResponse.json({ ok: false, error: "invalid_agents" }, { status: 400 });
    }
    agents = parsed;
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
    if (agents !== undefined) {
      const a = await saveAgentAccess({
        tenantId: sess.tenantId,
        target: { kind: "custom", key: normalizedKey },
        access: agents,
        createdBy: sess.profileId,
      });
      if (!a.ok) {
        // The value is not saved without its agents: saved alone, every agent could read it.
        results.push({ key: normalizedKey, ok: false, error: `agents_not_saved: ${a.error}` });
        continue;
      }
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
  if (!sess.isAdmin) {
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
  // Its agent choice goes with it, so a new key of the same name starts from the default.
  const cleared = await clearAgentAccess({ tenantId: sess.tenantId, target: { kind: "custom", key: normalizedKey } });
  if (!cleared.ok) {
    console.error("[credentials.custom] agent choice not removed with its key", { tenantId: sess.tenantId, key: normalizedKey, error: cleared.error });
    return NextResponse.json({ ok: true, warning: "The key is removed, but its agent choice is still saved." });
  }
  return NextResponse.json({ ok: true });
}
