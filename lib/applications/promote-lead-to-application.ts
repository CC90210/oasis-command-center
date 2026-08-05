/**
 * promote-lead-to-application.ts — turn a lead into a shoppable application,
 * carrying the FULL UW-sheet field set, and regenerate the branded PDF.
 *
 * This is the shared helper behind the automatic live-sub path: when Ezra
 * approves a Breeze deal in Telegram, the VPS bridge injects the lead (at the
 * uw_sheet / "Live Subs" stage) and then calls the internal promote endpoint
 * (app/api/internal/live-subs/promote), which calls this. The same helper backs
 * the one-time backfill of already-approved leads.
 *
 * Why not just createApplicationFromLead: that helper copies a thin 12-key
 * whitelist and mis-keys the rest, so a live sub's EIN / addresses / owner PII /
 * entity type / positions were dropped. Here we map the lead_data across with
 * mapLeadDataToApplicationFields (canonical keys) + extractAppFields (normalize),
 * then gap-fill onto the application so operator edits are never clobbered.
 *
 * The lead STAYS on the Live Subs board (it is never stamped `transferred_at`).
 * An accepted Bridge deal is pre-qualified work-in-hand, not a fresh intake, so
 * it belongs in Live Subs rather than the "Application In" stage — see step 4.
 *
 * Live subs arrive without a phone (ISO sheets carry no contact PII). That does
 * NOT block creation — the application is shoppable without it — so we stamp
 * phone_status:"needs_lookup" as a visible flag the operator (and, later, the
 * ClearFunders lookup integration) can act on. Idempotent: reuses the lead's
 * existing application; only fills gaps.
 */

import "server-only";
import { getRecord, updateRecord } from "@/lib/manifest/data";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { extractAppFields } from "@/lib/forms/application-upsert";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
import {
  liveSubLifecyclePatches,
  mapLeadDataToApplicationFields,
  matchesLegacyLiveSubIncident,
  reconcileLiveSubFields,
} from "@/lib/applications/live-sub-mapping";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { decryptField } from "@/lib/field-encryption";

/**
 * Hydrate the full SSN from the scrubber's encrypted-at-rest blobs.
 *
 * The lender application requires the full SSN, but the VPS scrubber must not
 * park one in plaintext in `tenant_records.data`, so build_lead_data writes
 * `owner_ssn_enc` / `second_owner_ssn_enc` — AES-256-GCM under
 * BRAVO_FIELD_ENCRYPTION_KEY, byte-compatible with lib/field-encryption.ts.
 * Decrypt here, at the server-side promote boundary, so the plaintext exists
 * only on the application record the PDF is generated from.
 *
 * A decrypt failure (rotated/absent key, corrupt blob) is swallowed: the
 * application is still worth creating with `ssn_last4`, and a thrown error here
 * would fail the whole promote. It surfaces instead as an empty `owner_ssn` in
 * the reconciliation log, which is pinned in LIVE_SUB_EXPECTED_FIELDS.
 */
function hydrateEncryptedSsn(leadData: Record<string, unknown>): Record<string, unknown> {
  const out = { ...leadData };
  const pairs: Array<[string, string]> = [
    ["owner_ssn_enc", "owner_ssn"],
    ["second_owner_ssn_enc", "partner_ssn"],
  ];
  for (const [encKey, plainKey] of pairs) {
    const packed = out[encKey];
    if (typeof packed !== "string" || !packed) continue;
    // Never overwrite a value already present (an operator edit, or a form-filled app).
    const existing = out[plainKey];
    if (typeof existing === "string" && existing.trim()) continue;
    try {
      out[plainKey] = decryptField(packed);
    } catch {
      // leave unset — see docblock
    }
    // Drop the ciphertext so it can't ride along into the application record.
    delete out[encKey];
  }
  return out;
}

export type PromoteResult =
  | {
      ok: true;
      applicationId: string;
      created: boolean;
      phoneStatus: "on_file" | "needs_lookup";
      appliedKeys: string[];
      /** Expected application fields that came back empty (silent-loss guard). */
      emptyFields: string[];
      /** Critical fields still blank after promote (operator-actionable). */
      missingCritical: string[];
      /** True once the branded PDF regenerated; false if that step failed. */
      pdfOk: boolean;
      /** True when this approval is intentionally visible in Leads → Live Subs. */
      retainedInLiveSubs: boolean;
    }
  | { ok: false; error: string; stage: PromoteStage };

/** Where in the promote a failure happened — carried to the operator alert so a
 * failed promote is diagnosable, not an opaque 500. */
export type PromoteStage =
  | "load_lead"
  | "create_application"
  | "map_fields"
  | "persist"
  | "unexpected";

export async function promoteLeadToApplication(input: {
  tenantId: string;
  leadId: string;
  /** Provenance stamped on a NEWLY created application (default live_sub_auto). */
  source?: string;
  /** Signed one-shot repair for the known legacy auto-transfer incident. */
  restoreLiveSubs?: boolean;
}): Promise<PromoteResult> {
  const { tenantId, leadId } = input;
  const source = input.source || "live_sub_auto";
  if (!tenantId || !leadId) return { ok: false, error: "missing_tenant_or_lead", stage: "load_lead" };

  // Surface a failure as an operator-visible, dedup'd agent_alert (System Health
  // card + Telegram) so a promote never fails silently into an opaque 500. The
  // lead stays at uw_sheet (not transferred) and is re-runnable from the queue.
  const fail = async (stage: PromoteStage, error: string): Promise<PromoteResult> => {
    await writeAgentAlert({
      tenantId,
      alertType: "live_sub_promote_failed",
      lane: "sunbiz-ops",
      severity: "urgent",
      subjectType: "lead",
      subjectId: leadId,
      title: `Live Sub promote failed (${stage})`,
      body: `Lead ${leadId} could not be promoted to an application: ${error}. It remains in the Live Subs queue — fix and retry.`,
      payload: { stage, error, source },
    });
    return { ok: false, error, stage };
  };

  try {
    // Load the lead (tenant-scoped — a lead outside this tenant resolves to null).
    const lead = await getRecord({ tenant_id: tenantId, entity: "lead", id: leadId }).catch(() => null);
    if (!lead) return await fail("load_lead", "lead_not_found");
    const leadData = hydrateEncryptedSsn((lead.data || {}) as Record<string, unknown>);

    // 1) Create (or reuse) the linked application. Idempotent.
    const appRes = await createApplicationFromLead({ tenantId, leadId });
    if (!appRes.ok) return await fail("create_application", appRes.error);
    const applicationId = appRes.applicationId;

    // 2) Map the full lead_data → canonical application fields, then normalize.
    const mapped = mapLeadDataToApplicationFields(leadData);
    const fields = extractAppFields({ ...leadData, ...mapped });

    const hasPhone = typeof fields.phone === "string" && (fields.phone as string).trim().length > 0;
    const phoneStatus: "on_file" | "needs_lookup" = hasPhone ? "on_file" : "needs_lookup";

    // 3) Gap-fill onto the application — never clobber a value the operator (or a
    //    prior form submission) already set on a reused application.
    const app = await getRecord({ tenant_id: tenantId, entity: "application", id: applicationId }).catch(() => null);
    const appData = (app?.data || {}) as Record<string, unknown>;
    const legacyIncidentMatch = matchesLegacyLiveSubIncident({
      leadSource: leadData.source,
      applicationCreatedVia: appData.created_via,
      leadCreatedAt:
        (lead as { created_at?: unknown }).created_at ?? leadData.created_at,
      leadTransferredAt: leadData.transferred_at,
    });
    const lifecycle = liveSubLifecyclePatches({
      applicationId,
      applicationCreated: appRes.created,
      leadTransferredAt: leadData.transferred_at,
      applicationPromotedAt: appData.promoted_at,
      restoreLiveSubs: input.restoreLiveSubs,
      legacyIncidentMatch,
    });
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const cur = appData[k];
      // On a FRESHLY created application there's no operator data to protect, so
      // the mapped + normalized values are authoritative — e.g. business_state
      // "AZ" must win over the raw "Arizona" that createApplicationFromLead just
      // copied off the lead (the SOP §4 restricted-states filter needs the
      // 2-letter code). On a REUSED application, only fill gaps so an operator's
      // edits are never clobbered.
      if (appRes.created || cur === undefined || cur === null || cur === "") {
        patch[k] = v;
      }
    }
    patch.lead_id = leadId;
    if (!appData.status) patch.status = "application_in";
    // Provenance: mark a freshly created app as the live-sub auto path; leave a
    // reused app's existing created_via (e.g. form_submission) intact.
    if (appRes.created) patch.created_via = source;
    Object.assign(patch, lifecycle.applicationPatch);
    if (!appData.phone_status) patch.phone_status = phoneStatus;

    // When retaining/restoring Live Subs, expose the lead first. If the second
    // write fails, the deal may briefly appear on both boards but can never
    // disappear from both. The ordinary advanced/retry path keeps its existing
    // application-first order because it does not clear lifecycle markers.
    if (lifecycle.retainInLiveSubs) {
      await updateRecord({
        tenant_id: tenantId,
        entity: "lead",
        id: leadId,
        patch: lifecycle.leadPatch,
      });
    }

    await updateRecord({ tenant_id: tenantId, entity: "application", id: applicationId, patch });

    // 4) Link the lead to its application, but LEAVE IT ON THE LIVE SUBS BOARD.
    //
    //    2026-07-27 (Adon) — this step used to stamp `transferred_at`, which is
    //    the flag the Leads board filters on (lib/manifest/data.ts). Stamping it
    //    made an Ezra-approved Bridge deal vanish from the Live Subs tab the
    //    instant it was accepted and reappear only as an "Application In" card.
    //    That is the wrong destination for this path: a live sub arrives
    //    pre-qualified with the UW sheet and statements already in hand, so it is
    //    ready to be WORKED in Live Subs, not parked in the application-intake
    //    stage the merchant has already completed.
    //
    //    ONE DEAL, ONE BOARD. The two markers are a matched pair: a lead is
    //    hidden from the Leads board by `transferred_at`, and an application is
    //    SHOWN on the Applications board by `promoted_at` (lib/manifest/data.ts).
    //    Dropping one without the other would put the deal on both boards, so
    //    neither is stamped here. The application record is still created and
    //    still carries status="application_in", so underwriting and the branded
    //    PDF are unaffected — it simply stays off the Applications board until an
    //    operator explicitly transfers it, which is also when it becomes
    //    selectable in Shopping Out (that picker reads the same filtered list).
    //    Work the deal in Live Subs, then Transfer to Application to shop it.
    //
    //    This mirrors the dropped-application path exactly
    //    (lib/applications/apply-extracted.ts), which lands its lead at uw_sheet
    //    and creates its backing application with neither marker.
    //
    //    The signed one-shot repair may explicitly clear both markers for rows
    //    matching the known legacy incident fingerprint. Ordinary retries never
    //    pull an operator-advanced application backwards.
    //    STAGE IS FORCED HERE, not just at creation. The dashboard approve path
    //    de-duplicates against an existing merchant lead
    //    (app/api/scrub-candidates/[id] findExistingLead), and that lead can sit
    //    in ANY stage — follow_up, ghost, declined. Only the create branch runs
    //    sanitizeLeadData, which is what pins stage="uw_sheet"; the dedup branch
    //    promotes the existing record untouched. That used to be invisible
    //    because the transfer marker pulled the lead off the board entirely, so
    //    now that it stays visible it has to be visible in the RIGHT place, or
    //    an approved Bridge deal would sit in Live Subs' neighbour stage forever.
    //    Matching the create branch also means the dedup'd deal fires the same
    //    uw_sheet first-touch cadence, which is what a scrubber-fed live sub is
    //    supposed to get (it carries no docs_on_file — see lib/drips/enroller).
    if (!lifecycle.retainInLiveSubs) {
      await updateRecord({
        tenant_id: tenantId,
        entity: "lead",
        id: leadId,
        patch: lifecycle.leadPatch,
      });
    }

    // 5) Reconcile the final application fields against the pinned parser
    //    contract — no silent data loss. Log every expected field that came back
    //    empty; alert (dedup'd) when a critical one is blank so the operator can
    //    fill it before the deal is shopped.
    const finalApp = await getRecord({ tenant_id: tenantId, entity: "application", id: applicationId }).catch(() => null);
    const finalData = (finalApp?.data || { ...appData, ...patch }) as Record<string, unknown>;
    const { emptyExpected, missingCritical, severe } = reconcileLiveSubFields(finalData);
    if (emptyExpected.length) {
      console.warn(
        `[promote] lead=${leadId} app=${applicationId} empty expected fields: ${emptyExpected.join(", ")}`,
      );
    }
    if (missingCritical.length) {
      await writeAgentAlert({
        tenantId,
        alertType: "live_sub_incomplete",
        lane: "sunbiz-ops",
        severity: severe ? "urgent" : "warn",
        subjectType: "lead",
        subjectId: leadId,
        title: `Live Sub promoted with ${missingCritical.length} blank critical field(s)`,
        body: `Application ${applicationId} is missing: ${missingCritical.join(", ")}. All empty: ${emptyExpected.join(", ") || "none"}.`,
        payload: { applicationId, missingCritical, emptyExpected, phoneStatus },
      });
    }

    // 6) (Re)generate the branded application PDF from the now-populated record.
    //    A PDF failure does NOT fail the promote (the record is already correct),
    //    but it must be VISIBLE, not swallowed — the operator needs to know the
    //    lender-ready document is stale.
    let pdfOk = true;
    try {
      await generateApplicationDocumentFromRecord({ tenantId, applicationId, replace: true });
    } catch (pdfErr) {
      pdfOk = false;
      const msg = pdfErr instanceof Error ? pdfErr.message : "pdf_generation_failed";
      console.error(`[promote] lead=${leadId} app=${applicationId} PDF regen failed: ${msg}`);
      await writeAgentAlert({
        tenantId,
        alertType: "live_sub_pdf_failed",
        lane: "sunbiz-ops",
        severity: "warn",
        subjectType: "application",
        subjectId: applicationId,
        title: "Live Sub application PDF failed to generate",
        body: `Application ${applicationId} promoted OK but its branded PDF did not regenerate: ${msg}. Re-run from the application drawer.`,
        payload: { leadId, error: msg },
      });
    }

    return {
      ok: true,
      applicationId,
      created: appRes.created,
      phoneStatus,
      appliedKeys: Object.keys(patch),
      emptyFields: emptyExpected,
      missingCritical,
      pdfOk,
      retainedInLiveSubs: lifecycle.retainInLiveSubs,
    };
  } catch (err) {
    return await fail("unexpected", err instanceof Error ? err.message : "promote_failed");
  }
}
