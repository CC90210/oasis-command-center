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
 *   POST    — upsert one entry. Body: { key, value, agents?, suggested_agents? }.
 *   POST (bulk) — upsert many entries. Body: { entries: [{key, value, agents?, suggested_agents?}, ...] }
 *                 OR { dotenv: "KEY1=value1\nKEY2=value2" } for raw paste,
 *                 with an optional `agents` / `suggested_agents` for every
 *                 entry in the request. An entry's own wins over the request's.
 *                 `suggested_agents` (the app's suggestion, as the vault shows
 *                 it) is saved only for a key with no saved value and no saved
 *                 choice when it is written; whether a key is new is never
 *                 taken from the browser (review of OCC #748).
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
import { agentChoicesForSession } from "@/lib/os/agent-access-names-session";
import { looksLikeSecret, parseDotenvLines, VAULT_MAX_PASTE_ENTRIES, VAULT_MAX_VALUE_LENGTH } from "@/lib/os/custom-keys";
import { accessField, assignmentsApply, clearAgentAccess, effectiveAccess, readAgentAccessOverrides, saveAgentAccess } from "@/lib/os/agent-access-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEY_LEN = 64;
const MAX_VALUE_LEN = VAULT_MAX_VALUE_LENGTH; // 8 KB per value, shared with the vault's own check
const MAX_BULK_ENTRIES = VAULT_MAX_PASTE_ENTRIES; // shared with the vault, which says so before sending more


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
  /** The agents that may use it; null when its choice (or every choice) could not be read. */
  agents: AgentAccess | null;
  /** True when the owner picked the agents; false for the default (every agent). */
  agents_saved: boolean;
  /** True when this key's saved choice cannot be read: no agent may use it until it is saved again. */
  agents_unreadable: boolean;
};

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Three reads that do not depend on each other, at once (review of OCC #748).
  const [r, overrides, choices] = await Promise.all([
    getServiceSupabase()
      .from("tenant_integration_credentials")
      .select("field_key, encrypted_value, updated_at")
      .eq("tenant_id", sess.tenantId)
      .eq("service", VAULT_CUSTOM_SERVICE)
      .order("field_key", { ascending: true }),
    readAgentAccessOverrides(sess.tenantId),
    agentChoicesForSession(),
  ]);
  // A read that failed is an error, never an empty list: the vault would say "No keys yet"
  // and treat every saved key as new (review of OCC #748).
  if (r.error) {
    console.error("[credentials.custom] keys unreadable", { tenantId: sess.tenantId, error: r.error.message });
    return NextResponse.json({ ok: false, error: "keys_unreadable" }, { status: 500 });
  }
  if (!overrides.ok) {
    console.error("[credentials.custom] agent choices unreadable", { tenantId: sess.tenantId, error: overrides.error });
  }
  const rows: CustomCredentialRow[] = (
    (r.data || []) as { field_key: string; encrypted_value: string; updated_at: string | null }[]
  ).map((row) => {
    const key = row.field_key.toUpperCase();
    const choice = overrides.ok ? effectiveAccess(overrides, { kind: "custom", key }) : null;
    return {
      key,
      has_value: !!row.encrypted_value,
      updated_at: row.updated_at,
      agents: choice ? choice.access : null,
      agents_saved: choice ? choice.saved : false,
      agents_unreadable: !!choice && choice.access === null,
    };
  });
  return NextResponse.json({
    ok: true,
    entries: rows,
    // The agents as this workspace's AI Team names them, for the picker and each key's "Assigned to".
    choices,
    // Whether this workspace's agents can read custom keys at all (assignmentsApply).
    assignable: assignmentsApply(sess.tenantId, "custom"),
    ...(overrides.ok ? {} : { agents_error: "Could not read which agents may use these keys." }),
  });
}

type SingleUpsertBody = { key: string; value: string };
/** A pending write, with this key's own agents or suggestion when the request names them. */
type PendingEntry = SingleUpsertBody & { agents?: AgentAccess; suggested?: AgentAccess };
type EntryBody = SingleUpsertBody & { agents?: unknown; suggested_agents?: unknown };
type BulkUpsertBody = { entries: EntryBody[] };
type DotenvUpsertBody = { dotenv: string };
type AgentsBody = { agents: unknown; suggested_agents: unknown };

/** An agents field of the body: absent, a valid choice, or null when it is not one. */
function agentsField(raw: unknown): AgentAccess | undefined | null {
  return raw === undefined ? undefined : normalizeAgentAccess(raw);
}

/**
 * Which custom keys have a saved value, and which have a saved agent choice
 * (readable or not), read at write time. Not ok when either read fails: a
 * suggestion is then refused, never applied blind.
 */
async function readKeyState(tenantId: string): Promise<{ ok: true; values: Set<string>; choices: Set<string> } | { ok: false }> {
  const [r, overrides] = await Promise.all([
    getServiceSupabase().from("tenant_integration_credentials").select("field_key").eq("tenant_id", tenantId).eq("service", VAULT_CUSTOM_SERVICE),
    readAgentAccessOverrides(tenantId),
  ]);
  if (r.error || !overrides.ok) return { ok: false };
  return {
    ok: true,
    values: new Set(((r.data || []) as { field_key: string }[]).map((row) => row.field_key)),
    choices: new Set<string>([...overrides.byField.keys(), ...overrides.unreadable]),
  };
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
  // Optional, for every key in the request. `agents` is the owner's choice and is saved as it
  // is. `suggested_agents` (the app's suggestion, lib/os/custom-keys.ts) is saved only for a
  // key that is new when it is written. With neither, each key's choice stays as it is.
  const agents = agentsField(body.agents);
  const suggested = agentsField(body.suggested_agents);
  if (agents === null || suggested === null) {
    return NextResponse.json({ ok: false, error: "invalid_agents" }, { status: 400 });
  }

  // Normalize all three input shapes (single, bulk, dotenv) into one
  // list of pending writes. Validation runs uniformly across all paths.
  let pending: PendingEntry[] = [];
  if (typeof body.dotenv === "string") {
    pending = parseDotenvLines(body.dotenv);
  } else if (Array.isArray(body.entries)) {
    const shaped = body.entries.filter(
      (e): e is EntryBody => !!e && typeof e === "object" && typeof e.key === "string" && typeof e.value === "string",
    );
    // Each entry's own agents are checked before anything is written: one typo saves nothing.
    for (const e of shaped) {
      const own = agentsField(e.agents);
      const ownSuggested = agentsField(e.suggested_agents);
      if (own === null || ownSuggested === null) {
        return NextResponse.json({ ok: false, error: "invalid_agents" }, { status: 400 });
      }
      pending.push({
        key: e.key,
        value: e.value,
        ...(own !== undefined ? { agents: own } : {}),
        ...(ownSuggested !== undefined ? { suggested: ownSuggested } : {}),
      });
    }
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

  // Whether a key is new is read here, when it is written, never taken from the browser: its
  // list can be stale (another admin, another tab, an agent's add_credential), and a
  // suggestion must not replace a choice an owner made (review of OCC #748).
  const suggests = pending.some((e) => (e.agents ?? agents) === undefined && (e.suggested ?? suggested) !== undefined);
  const state = suggests ? await readKeyState(sess.tenantId) : null;
  const writtenNow = new Set<string>();

  for (const entry of pending) {
    // A secret pasted without a name must not become one: names are stored and listed in
    // the clear. Nothing of it is echoed back.
    if (looksLikeSecret(entry.key)) {
      results.push({ key: "(a secret without a name)", ok: false, error: "key_looks_like_a_secret" });
      continue;
    }
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
    // Only "=" is the padding of a secret pasted without a name, not a value.
    if (!value || /^=+$/.test(value)) {
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
    let entryAgents = entry.agents ?? agents;
    const suggestion = entry.suggested ?? suggested;
    if (entryAgents === undefined && suggestion !== undefined) {
      if (!state?.ok) {
        results.push({ key: normalizedKey, ok: false, error: "agents_unknown: the saved keys could not be read, so nothing was saved; try again" });
        continue;
      }
      const target = { kind: "custom" as const, key: normalizedKey };
      const isNew = !state.values.has(normalizedKey.toLowerCase()) && !state.choices.has(accessField(target)) && !writtenNow.has(normalizedKey);
      if (isNew) entryAgents = suggestion;
    }
    if (entryAgents !== undefined) {
      const a = await saveAgentAccess({
        tenantId: sess.tenantId,
        target: { kind: "custom", key: normalizedKey },
        access: entryAgents,
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
      writtenNow.add(normalizedKey);
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
