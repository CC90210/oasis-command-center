/**
 * /api/leads/powerlist — push selected leads into a Kixie PowerList
 * (power-dialer queue) + list the configured PowerLists for the picker.
 *
 * POST { lead_ids: string[] (uuid, ≤200), powerlist_key: string }
 *   Session-authed; read-only roles 403 (same idiom as /api/leads/[id]/call).
 *   PowerList config lives in tenants.custom_fields.kixie_powerlists:
 *     { [key: string]: { id: string, label: string } }
 *   (the `id` is the PowerList id from the Kixie dashboard — Manage →
 *   PowerLists). Unknown key -> 400 listing the available keys+labels only
 *   (never the Kixie ids).
 *
 *   Per lead: tenant-scoped fetch from tenant_records, data.phone →
 *   normalizePhoneE164; no valid phone -> reported in skipped_no_phone.
 *   Dry-run (isDryRun("kixie")) does everything except the Kixie call and
 *   returns would_send. Live mode calls addToPowerlist sequentially with a
 *   150ms gap. One agent_events summary row (BRAVO_KIXIE_POWERLIST_PUSH)
 *   records the push for /feed.
 *
 * GET — lightweight: configured PowerLists' keys+labels only, for the
 *   SendToDialerControl menu. Session-authed (read-only may view).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getKixieCredentials, addToPowerlist, type KixieCredentials } from "@/lib/integrations/kixie";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import { isReadOnlyRole } from "@/lib/role-gates";
import { canMutateGenericLeadForTenant } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;
const PER_PUSH_DELAY_MS = 150;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

type PowerlistConfig = { id: string; label: string };

/**
 * Parse tenants.custom_fields.kixie_powerlists into a validated map. Entries
 * that don't match { id: string, label: string } are dropped (a malformed
 * entry must not crash the whole picker).
 */
function parsePowerlists(customFields: Record<string, unknown> | null): Map<string, PowerlistConfig> {
  const out = new Map<string, PowerlistConfig>();
  const raw = customFields?.kixie_powerlists;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const id = str((val as { id?: unknown }).id);
    const label = str((val as { label?: unknown }).label);
    if (key.trim() && id && label) out.set(key.trim(), { id, label });
  }
  return out;
}

/** Resolve session -> { userId, email, tenantId } with the call-route gates. */
async function resolveActor(requireWrite: boolean): Promise<
  | {
      ok: true;
      userId: string;
      email: string;
      tenantId: string;
      teamRole: string;
      isTrueAdmin: boolean;
      adminAccess: boolean;
    }
  | { ok: false; resp: NextResponse }
> {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return { ok: false, resp: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  if (requireWrite) {
    // Role gate — pushing leads into a live dialer queue is a member+
    // capability, for parity with the single-call route.
    if (isReadOnlyRole(sess.teamRole)) {
      return {
        ok: false,
        resp: NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't push to the dialer." },
          { status: 403 },
        ),
      };
    }
  }
  return {
    ok: true,
    userId: sess.userId,
    email: sess.email || "",
    tenantId: sess.tenantId,
    teamRole: sess.teamRole,
    isTrueAdmin: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
  };
}

async function loadPowerlists(tenantId: string): Promise<Map<string, PowerlistConfig>> {
  const db = getServiceSupabase();
  const row = await db.from("tenants").select("custom_fields").eq("id", tenantId).maybeSingle();
  if (row.error) throw new Error(`tenant fetch failed: ${row.error.message}`);
  return parsePowerlists((row.data as { custom_fields?: Record<string, unknown> | null } | null)?.custom_fields || null);
}

export async function GET() {
  const actor = await resolveActor(false);
  if (!actor.ok) return actor.resp;
  let lists: Map<string, PowerlistConfig>;
  try {
    lists = await loadPowerlists(actor.tenantId);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "tenant_fetch_failed" },
      { status: 500 },
    );
  }
  // Keys + labels ONLY — the Kixie PowerList ids stay server-side.
  return NextResponse.json({
    ok: true,
    powerlists: Array.from(lists.entries()).map(([key, cfg]) => ({ key, label: cfg.label })),
  });
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(true);
  if (!actor.ok) return actor.resp;
  const { tenantId, userId, email } = actor;

  let body: { lead_ids?: unknown; powerlist_key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const leadIds = Array.isArray(body.lead_ids)
    ? Array.from(new Set(body.lead_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))))
    : [];
  if (leadIds.length === 0) {
    return NextResponse.json({ ok: false, error: "no_valid_lead_ids" }, { status: 400 });
  }
  if (leadIds.length > MAX_IDS) {
    return NextResponse.json({ ok: false, error: "too_many_lead_ids", max: MAX_IDS }, { status: 400 });
  }
  const powerlistKey = str(body.powerlist_key);
  if (!powerlistKey) {
    return NextResponse.json({ ok: false, error: "missing_powerlist_key" }, { status: 400 });
  }

  let lists: Map<string, PowerlistConfig>;
  try {
    lists = await loadPowerlists(tenantId);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "tenant_fetch_failed" },
      { status: 500 },
    );
  }
  if (lists.size === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_powerlists_configured",
        message:
          "No PowerLists configured — add them in Settings (tenants.kixie_powerlists) with IDs from the Kixie dashboard (Manage → PowerLists).",
      },
      { status: 400 },
    );
  }
  const target = lists.get(powerlistKey);
  if (!target) {
    return NextResponse.json(
      {
        ok: false,
        error: "unknown_powerlist_key",
        available: Array.from(lists.entries()).map(([key, cfg]) => ({ key, label: cfg.label })),
      },
      { status: 400 },
    );
  }

  // Credentials before any work — same idiom as the call route (dry-run still
  // validates the full path so going live later can't surprise-fail).
  let creds: KixieCredentials;
  try {
    creds = await getKixieCredentials(tenantId);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_credentials",
        message: err instanceof Error ? err.message : "Kixie credentials not configured for this workspace.",
      },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();
  // Tenant-scoped batch fetch. Like /api/leads/[id]/call, no entity_type
  // filter — both lead + application records carry data.phone.
  const fetched = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", tenantId)
    .in("id", leadIds);
  if (fetched.error) {
    return NextResponse.json({ ok: false, error: `lead_fetch_failed: ${fetched.error.message}` }, { status: 500 });
  }
  const byId = new Map(
    ((fetched.data || []) as Array<{ id: string; data: Record<string, unknown> | null }>)
      .filter((row) =>
        canMutateGenericLeadForTenant(
          {
            teamRole: actor.teamRole,
            userId: actor.userId,
            isOwner: actor.isTrueAdmin,
            adminAccess: actor.adminAccess,
          },
          { id: row.id, data: row.data || {} },
        ),
      )
      .map((r) => [r.id, r.data || {}]),
  );

  const dryRun = isDryRun("kixie");
  const skippedNoPhone: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const wouldSend: Array<Record<string, unknown>> = [];
  let pushed = 0;
  let first = true;

  for (const id of leadIds) {
    const data = byId.get(id);
    if (!data) {
      failed.push({ id, error: "not_found" });
      continue;
    }
    const phone = normalizePhoneE164(str(data.phone));
    if (!phone) {
      skippedNoPhone.push(id);
      continue;
    }
    // First/last name from contact_name, falling back to business_name.
    const nameSrc = str(data.contact_name) || str(data.business_name);
    const parts = nameSrc.split(/\s+/).filter(Boolean);
    const firstName = parts[0] || undefined;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;

    if (dryRun) {
      wouldSend.push({ lead_id: id, target: phone, first_name: firstName || null, last_name: lastName || null });
      pushed += 1;
      continue;
    }

    // Gentle sequential pacing — 150ms between Kixie calls.
    if (!first) await new Promise((r) => setTimeout(r, PER_PUSH_DELAY_MS));
    first = false;
    try {
      await addToPowerlist(creds, {
        powerlistId: target.id,
        target: phone,
        firstName,
        lastName,
        leadId: id,
      });
      pushed += 1;
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : "kixie_push_failed" });
    }
  }

  // One summary agent_events row so /feed shows the push. Reported (not
  // silent) on failure, but the push result stands either way.
  let eventLogged = true;
  const ev = await db.from("agent_events").insert({
    event_type: "BRAVO_KIXIE_POWERLIST_PUSH",
    publisher_agent: "dashboard",
    severity: "info",
    payload: {
      tenant_id: tenantId,
      powerlist_key: powerlistKey,
      powerlist_label: target.label,
      count: pushed,
      skipped_no_phone: skippedNoPhone.length,
      failed: failed.length,
      dry_run: dryRun,
      actor: email || userId,
      actor_user_id: userId,
    },
    correlation_id: tenantId,
  });
  if (ev.error) {
    console.error("[leads.powerlist] agent_events insert failed", ev.error);
    eventLogged = false;
  }

  return NextResponse.json({
    ok: true,
    pushed,
    skipped_no_phone: skippedNoPhone,
    failed,
    dry_run: dryRun,
    powerlist: { key: powerlistKey, label: target.label },
    event_logged: eventLogged,
    ...(dryRun ? { would_send: wouldSend } : {}),
  });
}
