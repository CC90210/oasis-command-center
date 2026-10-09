/**
 * One-time (CC, 2026-10-02): a blank start for Clients.
 *
 * CC: "It says that SunBiz and Breeze are clients, and they're not. We need to
 * remove that from here—obviously we're starting from blank." Two seed deals
 * from June and July said BreezeAdvance and SunBiz paid OASIS a retainer. Each
 * has since become a client record: BreezeAdvance converted on 2026-09-30
 * (Active), SunBiz filed under Past by "Mark engagement ended" on 2026-10-07.
 * This retires all four rows, ARCHIVE ONLY: nothing is deleted, and every
 * original value stays readable.
 *
 *   node --conditions=react-server --import tsx scripts/clients-blank-start.ts           dry run: prints what it would change
 *   node --conditions=react-server --import tsx scripts/clients-blank-start.ts --apply   writes
 *
 * Run from a checkout whose env reaches the production Turso database (the same
 * env the app uses; @next/env loads it). For each deal, BreezeAdvance then
 * SunBiz, each change goes through the app's own code path:
 *   1. the client record made from the deal (found by its source deal, so one
 *      made after this was written is found too; read 2026-10-08: 4fe4b614
 *      BreezeAdvance and 4d936fb1 SunBiz): updateCustomer(..., { archived: true }),
 *      the store call PATCH /api/customers/<id> makes for the record's Archive
 *      button. Its contacts are kept. The record stays reachable under
 *      "Include archived".
 *   2. the deal, 349ad3d2 (BreezeAdvance) or db0d4123 (SunBiz, Ezra):
 *      recordOasisLeadStageEvent({ type: "manual_archive" }), so launched ->
 *      lost with reason operator_archived_lead and its BRAVO_LEAD_AUTO_BUMPED event.
 *   3. the same deal's data, guarded on stage = lost: a dated
 *      notes_correction, the "active-client" tag dropped, `notes` untouched; the
 *      SunBiz deal also gets data.client_tenant_id = the retired SunBiz tenant,
 *      so Clients can never list or convert it again (lib/os/customers/retired.ts).
 *
 * Safe to re-run: each step reads its own state first and skips what is already
 * done. A step that cannot be done (a row missing, the engine refusing) stops
 * the run with the reason; nothing after it runs.
 */
import { loadEnvConfig } from "@next/env";
import type { Client } from "@libsql/client";

export const OASIS_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
/** The records these deals became, as read on 2026-10-08 (the run finds them by deal, not by these ids). */
export const BREEZE_CUSTOMER_ID = "4fe4b614-0200-45ff-904a-b77d49293eae";
export const BREEZE_CONTACT_ID = "19ca3463-1b8c-42e2-8291-dff06deeadae";
export const SUNBIZ_CUSTOMER_ID = "4d936fb1-4062-4339-a991-c4fab08ae56f";
export const SUNBIZ_CONTACT_ID = "9757ebeb-6693-4f55-928a-b3698bd84fe9";
export const BREEZE_LEAD_ID = "349ad3d2-72bf-4874-9134-b815fc2e5181";
export const SUNBIZ_LEAD_ID = "db0d4123-9e92-4647-965f-9f8776249504";
const FOUNDER_EMAIL = "conaugh@oasisai.work";
const DROPPED_TAG = "active-client";

/** What each lead's data should carry once it is retired. */
export function leadCorrections(sunbizTenantId: string): Record<string, { notes_correction: string; client_tenant_id?: string }> {
  return {
    [BREEZE_LEAD_ID]: {
      notes_correction:
        "2026-10-02: Not an OASIS client (CC). This deal was seeded in 2026-06 as an active client and became a client " +
        "record on 2026-09-30. The deal is now lost (operator_archived_lead) and the client record is archived. The " +
        "notes below are out of date and kept for history.",
    },
    [SUNBIZ_LEAD_ID]: {
      notes_correction:
        "2026-10-02: Not an OASIS client (CC). SunBiz is a business OASIS retired on 2026-09-28; this deal was seeded " +
        "in 2026-07 as an active client and was filed as a past client record on 2026-10-07. The deal is now lost " +
        "(operator_archived_lead), that client record is archived, and the deal names the retired SunBiz workspace, " +
        "so Clients never lists it again. The notes below are out of date and kept for history.",
      client_tenant_id: sunbizTenantId,
    },
  };
}

export type BlankStartStep = {
  step: string;
  state: "would_change" | "changed" | "already_done";
  detail: string;
};

const show = (v: unknown) => (v === undefined ? "(none)" : JSON.stringify(v));

/**
 * The run itself. `apply: false` reads only. Returns one line per step, in
 * order; throws (stopping the run) on anything it cannot do.
 */
export async function clientsBlankStart(opts: { apply: boolean; db: Client; now: Date }): Promise<BlankStartStep[]> {
  const { apply, db, now } = opts;
  const { getCustomerBySourceLead, updateCustomer, listContacts } = await import("../lib/os/customers/store");
  const { getRecord, updateRecord } = await import("../lib/manifest/data");
  const { recordOasisLeadStageEvent } = await import("../lib/oasis-lead-stage-engine");
  const { SUNBIZ_RETIRED_TENANT_ID } = await import("../lib/tenant/retired");
  const out: BlankStartStep[] = [];
  const corrections = leadCorrections(SUNBIZ_RETIRED_TENANT_ID);

  for (const leadId of [BREEZE_LEAD_ID, SUNBIZ_LEAD_ID]) {
    const lead = await getRecord({ tenant_id: OASIS_TENANT_ID, entity: "lead", id: leadId });
    if (!lead) throw new Error(`lead ${leadId} not found in OASIS's pipeline: stopping`);

    // ── 1. the client record this deal became: archived, its contacts kept ─
    const customer = await getCustomerBySourceLead(db, OASIS_TENANT_ID, leadId);
    if (!customer) {
      out.push({ step: "archive customer", state: "already_done", detail: `lead ${leadId}: no client record was made from this deal` });
    } else {
      const contacts = (await listContacts(db, OASIS_TENANT_ID, customer.id)).map((c) => c.id);
      const label = `customer ${customer.id} (${customer.display_name}, ${customer.lifecycle})`;
      const kept = contacts.length ? `contact ${contacts.join(", ")} kept` : "no contacts";
      if (customer.archived_at) {
        out.push({ step: "archive customer", state: "already_done", detail: `${label}: archived at ${customer.archived_at}` });
      } else if (!apply) {
        out.push({ step: "archive customer", state: "would_change", detail: `${label}: archived_at null -> now; ${kept}` });
      } else {
        const actor = await founderUserId(db);
        const r = await updateCustomer(db, OASIS_TENANT_ID, customer.id, { archived: true }, now, actor);
        if (!r.ok || !r.customer.archived_at) throw new Error(`archiving ${customer.id} failed: ${JSON.stringify(r)}`);
        const after = (await listContacts(db, OASIS_TENANT_ID, customer.id)).map((c) => c.id);
        if (after.join(",") !== contacts.join(",")) throw new Error(`archiving ${customer.id} changed its contacts: stopping`);
        out.push({ step: "archive customer", state: "changed", detail: `${label}: archived at ${r.customer.archived_at}; ${kept}` });
      }
    }

    // ── 2 and 3. the deal: lost, then corrected ─────────────────────────
    const data = (lead.data || {}) as Record<string, unknown>;
    const name = `lead ${leadId} (${String(data.company ?? data.name ?? "unnamed")})`;
    const stage = String(data.stage ?? "");

    if (stage === "lost") {
      out.push({ step: "retire deal", state: "already_done", detail: `${name}: stage lost` });
    } else if (!apply) {
      out.push({ step: "retire deal", state: "would_change", detail: `${name}: stage ${stage} -> lost (manual_archive, operator_archived_lead)` });
    } else {
      const r = await recordOasisLeadStageEvent({ type: "manual_archive", tenantId: OASIS_TENANT_ID, leadId });
      if (!r.fired || r.to !== "lost") throw new Error(`manual_archive did not fire for ${leadId}: ${JSON.stringify(r)}`);
      out.push({ step: "retire deal", state: "changed", detail: `${name}: stage ${r.from} -> ${r.to} (${r.reasonCode})` });
    }

    const want = corrections[leadId];
    const tags = Array.isArray(data.tags) ? (data.tags as unknown[]) : null;
    const patch: Record<string, unknown> = {};
    if (data.notes_correction !== want.notes_correction) patch.notes_correction = want.notes_correction;
    if (tags && tags.includes(DROPPED_TAG)) patch.tags = tags.filter((t) => t !== DROPPED_TAG);
    if (want.client_tenant_id && data.client_tenant_id !== want.client_tenant_id) patch.client_tenant_id = want.client_tenant_id;
    const changes = Object.keys(patch)
      .map((k) => `${k} ${show(data[k])} -> ${show(patch[k])}`)
      .join("; ");
    if (Object.keys(patch).length === 0) {
      out.push({ step: "correct deal", state: "already_done", detail: `${name}: correction, tags and link already in place; notes kept` });
    } else if (!apply) {
      out.push({ step: "correct deal", state: "would_change", detail: `${name}: ${changes}; notes kept` });
    } else {
      // Only onto the deal this run just retired: if anyone moved it since, nothing is written.
      await updateRecord({ tenant_id: OASIS_TENANT_ID, entity: "lead", id: leadId, patch, ifMatch: { field: "stage", value: "lost" } });
      out.push({ step: "correct deal", state: "changed", detail: `${name}: ${changes}; notes kept` });
    }
  }
  return out;
}

/** CC's auth user id, the person this cleanup is done for (the record's Archive button is his). */
async function founderUserId(db: Client): Promise<string> {
  const rs = await db.execute({
    sql: "SELECT auth_user_id FROM user_profiles WHERE tenant_id = ? AND lower(email) = ? AND auth_user_id IS NOT NULL LIMIT 1",
    args: [OASIS_TENANT_ID, FOUNDER_EMAIL],
  });
  const id = rs.rows[0]?.auth_user_id;
  if (typeof id !== "string" || !id) throw new Error(`no profile for ${FOUNDER_EMAIL} in OASIS's workspace: stopping`);
  return id;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { getTursoClient, tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured: refusing to run without the Turso data client");
  console.log(`${apply ? "APPLY" : "DRY RUN (nothing is written; pass --apply to write)"}: Clients blank start\n`);
  const steps = await clientsBlankStart({ apply, db: getTursoClient(), now: new Date() });
  for (const s of steps) console.log(`${s.state.padEnd(12)} ${s.step.padEnd(16)} ${s.detail}`);
}

// Runs only as a script, never when a test imports clientsBlankStart.
if (/scripts[\\/]clients-blank-start\.ts$/.test(process.argv[1] ?? "")) {
  // The hybrid data client falls back to the retired Supabase path unless this
  // is exactly turso_cloud. Pinned BEFORE any data module is imported.
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
  loadEnvConfig(process.cwd());
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
