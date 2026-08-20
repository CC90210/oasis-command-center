/**
 * POST /api/leads/bulk — bulk assign / bulk stage-change for the pipeline board
 * (Adon Batch 2.2 bulk + Batch 6.1 multi). Lets an admin distribute an imported
 * list across agents, or move a batch of leads forward, in one action instead of
 * opening each drawer.
 *
 * Body:
 *   { op: "assign", ids: string[], assigned_to: string | null }
 *   { op: "stage",  ids: string[], stage: string, entity?: "lead" | "application" }
 *
 * Authorization is applied PER id with the SAME owner-or-admin gate as the
 * single-record routes (/assign mirrors /assign's unconditional gate; /stage
 * mirrors /set-stage's flag-aware gate). An admin can act on any record; an agent
 * only on records they own (or any record when LEAD_SCOPING_ENABLED is off, for
 * the stage op). A record the caller can't touch is folded into `skipped` —
 * INDISTINGUISHABLE from a missing record, so the endpoint can't be used to
 * enumerate which UUIDs are real (matches the single routes' 404-for-both).
 * Never errors the whole batch — fail closed.
 *
 * Response: { ok, op, updated, skipped, failed }.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { declineLeadToApplication } from "@/lib/applications/decline-lead";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { canWriteCrm } from "@/lib/role-gates";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";
import { SUNBIZ_EMAIL_TEMPLATES, renderSunbizTemplate } from "@/lib/sunbiz-templates-library";
import { runBlast, resolveLeadsAudience, renderTemplate, getDefaultSender } from "@/lib/integrations/constant-contact/blast";
import { assignLifecycleOwner } from "@/lib/lifecycle-assignment";
import { BULK_EMAIL_SOURCE, runDispatchBulkEmail } from "@/lib/bulk-email/dispatch";
import { classifyBulkRecipients, summarizeClassification } from "@/lib/bulk-email/recipients";
import { validateCustomMessage, renderCustomMessage } from "@/lib/bulk-email/compose";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { stripDashes, matchPositioningPhrases } from "@/lib/integrations/blast-safety-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The op="email" path kicks the queue drain via after(); give that work
 *  room to finish inside the invocation (the drain self-caps at 45s). */
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;
/**
 * The email op only QUEUES rows (the 5-min dispatch-bulk-email cron does the
 * sending, throttled + daily-capped), so a blast's size is not a request-time
 * concern the way the per-id loop ops are. This bound is a request-abuse
 * sanity limit, not a volume policy — volume policy lives in
 * lib/bulk-email/dispatch.ts.
 */
const MAX_EMAIL_IDS = 10_000;
const FETCH_CHUNK = 100;
const INSERT_CHUNK = 50;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

type Outcome = { updated: number; skipped: number; failed: number };

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;

  let body: {
    op?: unknown;
    ids?: unknown;
    assigned_to?: unknown;
    stage?: unknown;
    entity?: unknown;
    template_id?: unknown;
    custom?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const op =
    body.op === "assign" ||
      body.op === "stage" ||
      body.op === "email" ||
      body.op === "email_preflight" ||
      body.op === "cc_blast" ||
      body.op === "decline"
      ? body.op
      : null;
  if (!op) {
    return NextResponse.json({ ok: false, error: "invalid_op" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? Array.from(new Set(body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))))
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no_valid_ids" }, { status: 400 });
  }
  const idCap = op === "email" || op === "email_preflight" ? MAX_EMAIL_IDS : MAX_IDS;
  if (ids.length > idCap) {
    return NextResponse.json({ ok: false, error: "too_many_ids", max: idCap }, { status: 400 });
  }

  const db = getServiceSupabase();
  const out: Outcome = { updated: 0, skipped: 0, failed: 0 };

  if (op === "assign") {
    // CRM-write authorization (2026-07-07, CC directive). Bulk-assign is core CRM
    // work for any non-read_only member on any tenant lead — matching single
    // /assign. Checked ONCE, before any record work, so read_only gets a clean 403
    // rather than an all-skipped 200 (Codex adversarial review 2026-07-07).
    if (!canWriteCrm(sess.teamRole)) {
      return NextResponse.json(
        { ok: false, error: "forbidden_role", message: "Read-only members can't reassign leads." },
        { status: 403 },
      );
    }
    // Validate the assignee once (null = clear). A non-UUID is a 400; a UUID that
    // isn't a member of this tenant is rejected before we touch any record.
    const raw = body.assigned_to;
    let nextAssignedTo: string | null = null;
    if (typeof raw === "string" && raw.trim().length) {
      const candidate = raw.trim().toLowerCase();
      if (!UUID_RE.test(candidate)) {
        return NextResponse.json({ ok: false, error: "invalid_assigned_to" }, { status: 400 });
      }
      nextAssignedTo = candidate;
    }
    if (nextAssignedTo) {
      const member = await db
        .from("user_profiles")
        .select("auth_user_id")
        .eq("tenant_id", tenantId)
        .eq("auth_user_id", nextAssignedTo)
        .maybeSingle();
      if (!member.data) {
        return NextResponse.json({ ok: false, error: "not_a_tenant_member" }, { status: 400 });
      }
    }

    for (const id of ids) {
      const existing = await db
        .from("tenant_records")
        .select("id, entity_type, data")
        .eq("tenant_id", tenantId)
        .in("entity_type", ["lead", "application", "funded_deal", "renewal"])
        .eq("id", id)
        .maybeSingle();
      if (!existing.data) {
        out.skipped += 1;
        continue;
      }
      const upd = await assignLifecycleOwner({
        tenantId,
        record: existing.data as {
          id: string;
          entity_type: "lead" | "application" | "funded_deal" | "renewal";
          data: Record<string, unknown>;
        },
        assignedTo: nextAssignedTo,
      });
      if (!upd.ok) {
        out.failed += 1;
        continue;
      }
      out.updated += 1;
      try {
        const note = nextAssignedTo
          ? `Reassigned to ${nextAssignedTo} by ${sess.email || "an admin"} (bulk).`
          : `Assignment cleared by ${sess.email || "an admin"} (bulk).`;
        await db.from("lead_interactions").insert({
          tenant_id: tenantId,
          lead_id: id,
          type: "lead_reassigned",
          channel: "system",
          direction: "outbound",
          agent_source: "dashboard_bulk_assign",
          subject: "Lead reassigned",
          content: note,
          content_preview: note,
          metadata: {
            assigned_to: nextAssignedTo,
            assigned_by: sess.userId,
            entity_type: (existing.data as { entity_type?: string }).entity_type,
            bulk: true,
          },
        });
      } catch {
        /* best-effort audit */
      }
    }
    return NextResponse.json({ ok: true, op, ...out });
  }

  if (op === "cc_blast") {
    // Bulk "Send via Constant Contact" — one blast to the selected leads through
    // the shared blast core (suppression + blast-safety + dry-run). Admin-only
    // (org-wide send). Bulk-safe templates only.
    if (!sess.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });
    const templateId = str(body.template_id);
    const tpl = SUNBIZ_EMAIL_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return NextResponse.json({ ok: false, error: "invalid_template" }, { status: 400 });
    if (tpl.bulkSafe === false) return NextResponse.json({ ok: false, error: "template_not_bulk_safe" }, { status: 400 });
    const rendered = renderTemplate("sunbiz", templateId);
    if (!rendered) return NextResponse.json({ ok: false, error: "template_render_failed" }, { status: 400 });
    const fromEmail = await getDefaultSender(tenantId);
    if (!fromEmail) return NextResponse.json({ ok: false, error: "no_confirmed_sender", message: "Connect Constant Contact and confirm a sender email first." }, { status: 400 });
    const aud = await resolveLeadsAudience(tenantId, ids);
    if (!aud.ok) return NextResponse.json({ ok: false, error: aud.error }, { status: 500 });
    if (aud.recipients.length === 0) return NextResponse.json({ ok: false, error: "no_recipients" }, { status: 400 });
    const result = await runBlast({ tenantId, userId: sess.userId, recipients: aud.recipients, subject: rendered.subject, html: rendered.html, fromEmail, listNameHint: "bulk" });
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400 });
  }

  if (op === "email" || op === "email_preflight") {
    // Bulk email, either a library template or an operator-authored message.
    //
    // We QUEUE (status='queued') rather than send inline — the drain
    // (lib/bulk-email/dispatch.ts) owns suppression, throttle and the daily
    // cap. Since 2026-08-20 the queue write also KICKS the drain via after(),
    // so a send starts in seconds instead of waiting up to 5 minutes for the
    // next cron tick. The cron remains the safety net, not the trigger: an
    // operator who clicks send and sees nothing happen for six minutes
    // reasonably concludes the button is broken, which is exactly how this
    // feature was reported as "not sending at all" while every message was in
    // fact being delivered (Adon, 2026-08-20).
    //
    // The v2 agent_source keeps the legacy VPS send_gateway OFF these rows.
    const emailEntity = body.entity === "application" ? "application" : "lead";
    const scoping = leadScopingEnabled();
    const viewer = { isAdmin: sess.isAdmin, userId: sess.userId };
    const canAct = (data: Record<string, unknown>) => canViewLead(viewer, data, scoping, "isolate");

    // Batched fetch. A blast is thousands of rows; one round-trip per lead
    // would blow the request budget long before the queue was full.
    const byId = new Map<string, { id: string; data?: Record<string, unknown> | null }>();
    const unreadable = new Set<string>();
    for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
      const chunk = ids.slice(i, i + FETCH_CHUNK);
      const fetched = await db
        .from("tenant_records")
        .select("id, entity_type, data")
        .eq("tenant_id", tenantId)
        .eq("entity_type", emailEntity)
        .in("id", chunk);
      if (fetched.error) {
        // FAIL CLOSED and stay HONEST: an unreadable chunk is reported as
        // failed, never folded into "not found". Telling an operator a lead
        // vanished when the database hiccuped sends them to clean data that
        // was never dirty.
        for (const id of chunk) unreadable.add(id);
        continue;
      }
      for (const r of (fetched.data ?? []) as Array<{ id: string; data?: Record<string, unknown> }>) {
        byId.set(r.id, r);
      }
    }

    const readableIds = ids.filter((id) => !unreadable.has(id));
    const cls = classifyBulkRecipients(readableIds, byId, canAct);

    // Preflight answers "what would happen", writes nothing, sends nothing.
    // It runs the SAME classifier as the send below, so the count an operator
    // approves is by construction the count that goes out.
    if (op === "email_preflight") {
      return NextResponse.json({
        ok: true,
        op,
        counts: { ...cls.counts, unreadable: unreadable.size },
        summary: summarizeClassification(cls, emailEntity),
        skipped: cls.skipped,
        sample: cls.eligible.slice(0, 3).map((r) => ({
          id: r.id,
          to_email: r.toEmail,
          first_name: r.firstName,
          business_name: r.businessName,
        })),
      });
    }

    // ---- resolve the message: library template OR operator-authored --------
    const custom = body.custom;
    const isCustom = !!custom && typeof custom === "object";
    let renderFor: (r: { firstName: string; businessName: string }) => { subject: string; body: string };
    let templateId: string | null = null;

    if (isCustom) {
      // Writing free-form merchant-facing copy is a CRM-write action. The
      // template path is constrained to pre-approved copy; this one is not,
      // so it carries the role gate the template path doesn't need.
      if (!canWriteCrm(sess.teamRole)) {
        return NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't send email." },
          { status: 403 },
        );
      }
      const valid = validateCustomMessage(custom as { subject?: unknown; body?: unknown });
      if (!valid.ok) {
        return NextResponse.json(
          { ok: false, error: "invalid_message", problem: valid.problem, message: valid.message, tokens: valid.tokens },
          { status: 400 },
        );
      }
      // LOAD-BEARING: SunBiz positions AS the direct funder. Operator-authored
      // copy is the first free-form merchant-facing text on the bulk path, so
      // the positioning + lender-name guard runs BEFORE anything is queued and
      // fails CLOSED (an unverifiable message is refused, never sent blind).
      const guard = await sanitizeBlastMessage(
        tenantId,
        `${valid.value.subject}\n\n${valid.value.body}`,
        { checkPositioning: true },
      );
      if (!guard.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: "blocked_copy",
            reason: guard.reason,
            message: guard.message,
            lender_hits: guard.lenderHits,
            positioning_hits: guard.positioningHits,
          },
          { status: 400 },
        );
      }
      const subject = stripDashes(valid.value.subject);
      const bodyText = stripDashes(valid.value.body);
      renderFor = (r) => renderCustomMessage({ subject, body: bodyText }, { firstName: r.firstName, businessName: r.businessName });
    } else {
      templateId = str(body.template_id);
      const tpl = SUNBIZ_EMAIL_TEMPLATES.find((t) => t.id === templateId);
      if (!tpl) {
        return NextResponse.json({ ok: false, error: "invalid_template" }, { status: 400 });
      }
      // Server-side bulk-safety guard (defense in depth behind the UI filter).
      // Stage/history-asserting templates (offers, funded, renewals, stips) are
      // 1:1-only — blasting them would send false claims to leads they aren't
      // true for. The dropdown already hides them; reject here in case a stale
      // or hand-crafted client POSTs one anyway.
      if (tpl.bulkSafe === false) {
        return NextResponse.json({ ok: false, error: "template_not_bulk_safe" }, { status: 400 });
      }
      renderFor = (r) => {
        const out = renderSunbizTemplate(tpl, { firstName: r.firstName, businessName: r.businessName });
        return { subject: out.subject, body: out.body };
      };
    }

    // One id per batch, so a send has a receipt an operator can open later and
    // a status the UI can poll while it drains.
    const batchId = randomUUID();
    const queueRows: Array<Record<string, unknown>> = [];
    let blockedAfterMerge = 0;

    for (const r of cls.eligible) {
      const { subject, body: rendered } = renderFor(r);
      // Merge values are merchant-supplied data. A business name that happens
      // to complete a broker-positioning phrase would slip past the pre-render
      // guard, so the pure (no-DB, per-row cheap) matcher runs on the final
      // text. A hit drops THAT recipient rather than the batch.
      if (matchPositioningPhrases(`${subject}\n\n${rendered}`).length > 0) {
        blockedAfterMerge += 1;
        continue;
      }
      queueRows.push({
        tenant_id: tenantId,
        lead_id: r.id,
        type: "email_queued",
        channel: "email",
        direction: "outbound",
        agent_source: BULK_EMAIL_SOURCE,
        actor_user_id: sess.userId,
        subject: subject.slice(0, 200),
        content: rendered.slice(0, 32000),
        content_preview: rendered.slice(0, 1024),
        to_email: r.toEmail,
        metadata: {
          requested_by_email: sess.email,
          acted_by_user_id: sess.userId,
          status: "queued",
          template_id: templateId,
          custom_message: isCustom,
          batch_id: batchId,
          entity_type: emailEntity,
          bulk: true,
        },
      });
    }

    let queued = 0;
    let insertFailed = 0;
    for (let i = 0; i < queueRows.length; i += INSERT_CHUNK) {
      const chunk = queueRows.slice(i, i + INSERT_CHUNK);
      try {
        const ins = await db.from("lead_interactions").insert(chunk);
        if (ins.error) insertFailed += chunk.length;
        else queued += chunk.length;
      } catch {
        insertFailed += chunk.length;
      }
    }

    // Start draining NOW, after the response is flushed. Best-effort by
    // design: the row is already durable and the 5-minute cron re-drains
    // anything this misses, so a failure here delays a send, never loses one.
    if (queued > 0) {
      after(async () => {
        try {
          await runDispatchBulkEmail();
        } catch (err) {
          console.error("[leads.bulk] post-queue drain kick failed", {
            batch_id: batchId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    out.updated = queued;
    out.skipped = cls.skipped.length + blockedAfterMerge;
    out.failed = insertFailed + unreadable.size;
    return NextResponse.json({
      ok: true,
      op,
      batch_id: batchId,
      ...out,
      counts: {
        ...cls.counts,
        queued,
        blocked_copy: blockedAfterMerge,
        unreadable: unreadable.size,
        insert_failed: insertFailed,
      },
      summary: summarizeClassification(cls, emailEntity),
    });
  }

  if (op === "decline") {
    // Bulk decline: promote each selected lead to an application + set status="declined"
    // (→ Applications › Declined) via the shared helper. Leads-only; same CRM-write gate
    // as bulk stage-change. Read-only members get a clean 403 before any record work.
    if (!canWriteCrm(sess.teamRole)) {
      return NextResponse.json(
        { ok: false, error: "forbidden_role", message: "Read-only members can't decline leads." },
        { status: 403 },
      );
    }
    for (const id of ids) {
      const existing = await db
        .from("tenant_records")
        .select("id, data")
        .eq("tenant_id", tenantId)
        .eq("entity_type", "lead")
        .eq("id", id)
        .maybeSingle();
      if (!existing.data) {
        out.skipped += 1;
        continue;
      }
      const leadData = (existing.data as { data?: Record<string, unknown> }).data || {};
      const dec = await declineLeadToApplication({ tenantId, leadId: id, leadData });
      if (!dec.ok) {
        out.failed += 1;
        continue;
      }
      out.updated += 1;
      try {
        const note = `Declined (bulk) → Applications › Declined (application ${dec.applicationId.slice(0, 8)})`;
        await db.from("lead_interactions").insert({
          tenant_id: tenantId,
          lead_id: id,
          type: "stage_changed",
          channel: "system",
          direction: "outbound",
          agent_source: "dashboard_bulk_decline",
          subject: "Declined",
          content: note,
          content_preview: note,
          metadata: { application_id: dec.applicationId, declined_by: sess.userId, bulk: true },
        });
      } catch {
        /* best-effort audit */
      }
    }
    return NextResponse.json({ ok: true, op, ...out });
  }

  // op === "stage"
  const entity = body.entity === "application" ? "application" : "lead";
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  const validStages = entity === "application" ? OPPORTUNITY_PIPELINE_STAGES : LEAD_PIPELINE_STAGES;
  if (!stage || !validStages.some((s) => s.key === stage)) {
    return NextResponse.json({ ok: false, error: "invalid_stage" }, { status: 400 });
  }
  const field = entity === "application" ? "status" : "stage";

  // CRM-write authorization (2026-07-07, CC directive + Codex round-2). Bulk stage
  // change is core CRM work for any non-read_only member on any tenant lead —
  // matching single /set-stage. Checked ONCE before the loop, so read_only gets a
  // clean 403. (Was a per-record canViewLead("isolate") gate, which let a read_only
  // OWNER still mutate stages and diverged from /set-stage's role model.)
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't change stages." },
      { status: 403 },
    );
  }

  for (const id of ids) {
    const existing = await db
      .from("tenant_records")
      .select("id, entity_type, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", entity)
      .eq("id", id)
      .maybeSingle();
    if (!existing.data) {
      out.skipped += 1;
      continue;
    }
    const data = (existing.data as { data?: Record<string, unknown> }).data || {};
    // Authorization happened once before the loop (canWriteCrm); tenant scope is
    // enforced by the tenant_id-filtered fetch above.
    if (typeof data[field] === "string" && data[field] === stage) {
      out.skipped += 1; // already on this stage
      continue;
    }
    try {
      await updateRecord({ tenant_id: tenantId, entity, id, patch: { [field]: stage } });
    } catch (err) {
      void (err instanceof RecordsError ? err.code : "unknown");
      out.failed += 1;
      continue;
    }
    out.updated += 1;
    try {
      const note = `Stage set to ${stage} (bulk)`;
      await db.from("lead_interactions").insert({
        tenant_id: tenantId,
        lead_id: id,
        type: "stage_changed",
        channel: "system",
        direction: "outbound",
        agent_source: "dashboard_bulk_set_stage",
        subject: "Stage changed",
        content: note,
        content_preview: note,
        metadata: { to: stage, field, entity, changed_by: sess.userId, bulk: true },
      });
    } catch {
      /* best-effort audit */
    }
  }
  return NextResponse.json({ ok: true, op, ...out });
}
