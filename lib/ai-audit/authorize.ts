/**
 * lib/ai-audit/authorize.ts — Gate 1: CC authorizes the client's information
 * for processing.
 *
 * CC's brief: "The audit-generation workflow must not begin until I explicitly
 * authorize the transcript and associated client information for processing."
 *
 * requestAuthorization files an "authorize_ai_audit" approval for the
 * engagement's current draft profile, its transcripts and CC's call notes,
 * bound by their hashes, with the business's name and type, the client's
 * consent and the AI engine that will process the information. Any later
 * change withdraws the card, so CC always approves exactly what he sees.
 *
 * The executor checks, in order: the approver is the workspace owner; the
 * stored payload is valid. Then, in ONE write transaction, it re-reads the
 * engagement, the profile, the transcripts and the notes, checks every one
 * against the card and that the consent still allows the engine, freezes the
 * profile and moves the engagement to Research and writing. Every write
 * that could change those (a field, a transcript, a note, a new draft) carries
 * its own "still before Gate 1" check, so it lands before the transaction (the
 * card no longer matches, nothing is frozen) or is refused after it. Nothing
 * slips into an authorized profile unseen (review of phase 2, F3).
 *
 * No AI runs here. The research and writing that this unlocks arrive in later
 * phases, and every one of their steps re-checks that an executed
 * authorization with the frozen profile's hash exists (authorizedProfile).
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  AI_ENGINE_LABELS,
  AUTHORIZE_AI_AUDIT_KIND,
  validateAuthorizeAiAuditPayload,
  type AiEngine,
  type AuthorizeAiAuditPayload,
} from "@/lib/ai-audit/authorize-payload";
import { essentialGaps } from "@/lib/ai-audit/framework";
import { advanceEngagement, syncLeadStage } from "@/lib/ai-audit/lifecycle";
import { listTranscripts, transcriptsHash, type Transcript } from "@/lib/ai-audit/transcripts";
import { listCallNotes, notesHash } from "@/lib/ai-audit/call-notes";
import { contentHash } from "@/lib/ai-audit/hash";
import { ensureDraftProfile, getProfileVersion, listProfileFields, profileHashOf, type ProfileField } from "@/lib/ai-audit/versions";
import {
  engagementUpdateStatement,
  eventStatement,
  getEngagement,
  getSettings,
  int,
  requireTenant,
  type Actor,
  type AiAuditSettings,
  type Engagement,
} from "@/lib/ai-audit/store";
import { cancelPendingApproval, createApproval, getApprovalInTenant, parsePayload } from "@/lib/os/approvals/store";
import { effectiveStatus } from "@/lib/os/approvals/rules";
import { AUTHORIZATION_VOIDED_REASONS, PROFILE_EDIT_STAGES, TERMINAL_STAGES, shortName } from "@/lib/ai-audit/rules";
import { dbBool } from "@/lib/db-bool";
import { stopEngagementRunsStatements } from "@/lib/ai-audit/extraction-stop";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import type { Executor, ExecutorContext, ExecutorOutcome } from "@/lib/os/approvals/executors";
import { aiAuditModelSearchEnabled } from "@/lib/ai-audit/env";

/** Stages from which CC may ask for Gate 1. The request moves Profile from the call on to Transcript to approve. */
export const AUTHORIZE_FROM: readonly Engagement["stage"][] = ["call_completed", "transcript_review"];
const AUTHORIZATION_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// Consent and engine
// ---------------------------------------------------------------------------

function fieldBool(fields: readonly ProfileField[], key: string): boolean | null {
  const f = fields.find((x) => x.field_key === key);
  return f && typeof f.value === "boolean" ? f.value : null;
}

/**
 * Did the client agree to AI analysis? Every transcript must say yes, and the
 * profile's own consent answer must not say no. With no transcript (a call held
 * without recording), the profile's answer alone decides, and it must be an
 * explicit yes.
 */
export function aiConsent(transcripts: readonly Pick<Transcript, "consent_ai" | "status">[], fields: readonly ProfileField[]): boolean {
  const active = transcripts.filter((t) => t.status === "active");
  const stated = fieldBool(fields, "consent.ai_processing");
  if (stated === false) return false;
  if (active.length) return active.every((t) => t.consent_ai);
  return stated === true;
}

/** The engine Gate 1 will name: none without consent, otherwise CC's choice or the workspace default. */
export function engineFor(consent: boolean, settings: Pick<AiAuditSettings, "engine">, requested?: unknown): AiEngine {
  if (!consent) return "none";
  if (requested === "mac_claude" || requested === "cloud_workspace" || requested === "none") return requested;
  return settings.engine;
}

/** What happens after approval, in the words the card shows. */
export function planFor(input: { engine: AiEngine; versionNo: number; transcriptCount: number; gapCount: number; modelSearchEnabled?: boolean }): string[] {
  const plan = [
    `Freeze discovery profile version ${input.versionNo}${input.transcriptCount ? ` and the ${input.transcriptCount === 1 ? "call transcript" : `${input.transcriptCount} call transcripts`}` : ""} exactly as they are now.`,
    "Move the engagement to Research and writing.",
  ];
  // What the tick then does by itself (lib/ai-audit/research.ts, drafting.ts, writing.ts); each line under the
  // payload's 300-character limit.
  const modelSearchEnabled = input.modelSearchEnabled ?? aiAuditModelSearchEnabled();
  if (input.engine === "none") {
    plan.push("No AI service receives the client's information. Research checks the client's public website and page speed (no web search).");
    plan.push("A first draft of the audit and proposal is built from what research finds, without AI. You write and check the rest yourself.");
  } else if (!modelSearchEnabled) {
    plan.push("Model and web search are deferred while the audit's independent model/search switch is off. Website and PageSpeed research still run.");
    plan.push("The evidence rules still build the audit and proposal, and PDF printing still runs. You write and check the final wording yourself.");
  } else {
    plan.push(
      input.engine === "mac_claude"
        ? "Research then starts by itself: the client's public website, page speed, and a web search for listings and reviews."
        : "Research then starts by itself: the client's public website and page speed (web search runs only on Claude on CC's Mac).",
    );
    // Code builds the drafts (lib/ai-audit/draft.ts); the model only rewrites the audit's opening (writing.ts).
    plan.push(`A draft of the audit and proposal is built from what research finds. ${AI_ENGINE_LABELS[input.engine]} then rewrites the audit's opening, from this frozen information and public sources only. You check and edit it all before it goes anywhere.`);
  }
  if (input.gapCount) {
    plan.push(`${input.gapCount === 1 ? "One essential answer is" : `${input.gapCount} essential answers are`} still missing. The audit will list ${input.gapCount === 1 ? "it" : "them"} as information gaps; it will not guess.`);
  }
  plan.push("Nothing is sent to the client. Delivery needs your separate final approval.");
  return plan;
}

// ---------------------------------------------------------------------------
// Filing the approval
// ---------------------------------------------------------------------------

export type AuthorizationInputs = {
  engagement: Engagement;
  fields: ProfileField[];
  transcripts: Transcript[];
  payload: AuthorizeAiAuditPayload;
};

/** Everything Gate 1 would bind right now, or the reason it cannot be filed yet. */
export async function authorizationInputs(
  db: Client,
  tenantId: string,
  engagementId: string,
  requestedEngine?: unknown,
): Promise<{ ok: true; value: AuthorizationInputs } | { ok: false; error: string }> {
  const t = requireTenant(tenantId);
  const engagement = await getEngagement(db, t, engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (!engagement.current_profile_version_id) return { ok: false, error: "no_profile" };
  const version = await getProfileVersion(db, t, engagement.current_profile_version_id);
  if (!version || version.status !== "draft") return { ok: false, error: "profile_not_draft" };
  const fields = await listProfileFields(db, t, version.id);
  if (!fields.length) return { ok: false, error: "profile_empty" };
  const transcripts = await listTranscripts(db, t, engagement.id);
  const notes = (await listCallNotes(db, t, engagement.id)).filter((n) => n.notes.trim());
  const { settings } = await getSettings(db, t);
  const consent = aiConsent(transcripts, fields);
  const engine = engineFor(consent, settings, requestedEngine);
  if (engine !== "none" && !consent) return { ok: false, error: "no_ai_consent" };
  const gaps = essentialGaps(new Set(fields.map((f) => f.field_key)));
  const raw: AuthorizeAiAuditPayload = {
    engagement_id: engagement.id,
    lead_id: engagement.lead_id,
    business_name: boundName(engagement),
    business_type: engagement.business_type,
    profile_version_id: version.id,
    profile_version_no: version.version_no,
    profile_sha256: profileHashOf(fields),
    field_count: fields.length,
    gap_count: gaps.length,
    transcripts_sha256: transcriptsHash(transcripts),
    transcript_count: transcripts.length,
    notes_sha256: notesHash(notes),
    note_count: notes.length,
    redaction_count: transcripts.reduce((n, x) => n + x.redactions, 0),
    founder_attested: transcripts.some((x) => x.consent_basis === "founder_attested"),
    consent_ai: consent,
    engine,
    plan: planFor({ engine, versionNo: version.version_no, transcriptCount: transcripts.length, gapCount: gaps.length }),
  };
  const valid = validateAuthorizeAiAuditPayload(raw);
  if (!valid.ok) return { ok: false, error: valid.error };
  return { ok: true, value: { engagement, fields, transcripts, payload: valid.value } };
}

/** The business name a card binds: what the engagement says, within the payload's 200 characters. */
export function boundName(engagement: Pick<Engagement, "business_name">): string {
  return (engagement.business_name || "Unnamed business").trim().slice(0, 200);
}

/** Everything a card binds, as one key: the same information gives the same key. */
export function bindingKey(p: AuthorizeAiAuditPayload): string {
  return contentHash([
    p.engagement_id,
    p.profile_version_id,
    p.profile_sha256,
    p.transcripts_sha256,
    p.notes_sha256,
    p.business_name,
    p.business_type,
    p.consent_ai,
    p.engine,
  ]).slice(0, 32);
}

/**
 * File (or re-file) Gate 1 for the engagement's current profile. The same
 * information and engine give the same card back while it is pending (or
 * already approved); a card that ended (cancelled, failed, expired, sent back)
 * is never handed back as new; anything else withdraws the pending card and
 * files a revision. After a move back from Research and writing the
 * frozen profile is copied into a new draft first, so CC can authorize again
 * (review of phase 2, F1).
 */
export async function requestAuthorization(
  db: Client,
  input: { tenantId: string; engagementId: string; actor: Actor; now: Date; engine?: unknown },
): Promise<{ ok: true; approvalId: string; created: boolean } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const first = await getEngagement(db, t, input.engagementId);
  if (!first) return { ok: false, error: "not_found" };
  if (!AUTHORIZE_FROM.includes(first.stage)) return { ok: false, error: "not_ready_for_authorization" };
  if (first.current_profile_version_id) {
    const current = await getProfileVersion(db, t, first.current_profile_version_id);
    if (current && current.status !== "draft") await ensureDraftProfile(db, t, first.id, input.actor, input.now);
  }
  const inputs = await authorizationInputs(db, t, input.engagementId, input.engine);
  if (!inputs.ok) return inputs;
  const { payload } = inputs.value;
  const baseKey = `ai-audit-authorize:${payload.engagement_id}:${bindingKey(payload)}`;

  let supersedesId: string | undefined;
  if (first.authorization_approval_id) {
    const prior = await getApprovalInTenant(db, t, first.authorization_approval_id);
    const sameInformation = !!prior && (prior.idempotency_key === baseKey || prior.idempotency_key.startsWith(`${baseKey}:retry-`));
    // The same information, still waiting or already decided yes: that card. A
    // card past its expiry still says "pending" until someone acts on it, and
    // Needs you no longer shows it, so it counts as ended (Codex review of phase 2).
    const priorStatus = prior ? effectiveStatus(prior, input.now.toISOString()) : null;
    if (prior && sameInformation && priorStatus && ["pending", "approved", "executing", "executed"].includes(priorStatus)) {
      return { ok: true, approvalId: prior.id, created: false };
    }
    if (prior && ["pending", "sent_back", "cancelled"].includes(prior.status)) supersedesId = prior.id;
  }
  // A card for this same information that was filed but never linked (the pointer write after it was
  // interrupted) is linked now, not filed again: a second filing found the first card already revised
  // and failed on every try after (Codex review of phase 2, third pass).
  const orphan = (
    await db.execute({
      sql: `SELECT id FROM approvals WHERE tenant_id = ? AND action_kind = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
              AND (idempotency_key = ? OR idempotency_key LIKE ?) ORDER BY created_at DESC LIMIT 1`,
      args: [t, AUTHORIZE_AI_AUDIT_KIND, input.now.toISOString(), baseKey, `${baseKey}:retry-%`],
    })
  ).rows[0];
  if (orphan && String(orphan.id) !== first.authorization_approval_id) {
    const linked = await linkAuthorizationCard(db, t, input.engagementId, String(orphan.id), input.actor, input.now, payload.engine);
    return linked.ok ? { ok: true, approvalId: String(orphan.id), created: false } : linked;
  }
  // A card for this same information that ended (failed, expired, sent back,
  // cancelled) is never handed back as if new: the fresh one gets its own key
  // (the pattern requestDeliveryApproval uses; review of phase 2, F1).
  const tries = int(
    (await db.execute({ sql: "SELECT COUNT(1) AS n FROM approvals WHERE tenant_id = ? AND (idempotency_key = ? OR idempotency_key LIKE ?)", args: [t, baseKey, `${baseKey}:retry-%`] })).rows[0]?.n,
  );
  const idempotencyKey = tries ? `${baseKey}:retry-${tries}` : baseKey;
  const file = (supersedes: string | undefined) =>
    createApproval(
      db,
      {
        tenantId: t,
        departmentKey: null,
        requestedBy: { type: "human", id: input.actor.id },
        actionKind: AUTHORIZE_AI_AUDIT_KIND,
        title: `Authorize ${shortName(payload.business_name, "the business")}'s information for their Free AI Audit`,
        targetRef: `lead:${payload.lead_id}`,
        payload: payload as unknown as Record<string, unknown>,
        riskLevel: "data",
        idempotencyKey,
        expiresAt: new Date(input.now.getTime() + AUTHORIZATION_TTL_DAYS * 86_400_000).toISOString(),
        ...(supersedes ? { supersedesId: supersedes } : {}),
      },
      input.now,
    );
  let created = await file(supersedesId);
  if (!created.ok && created.error === "already_revised" && "successorId" in created && created.successorId) {
    // The linked card was already replaced by one that never got linked (for other information, or
    // since expired, cancelled or ended): revise the last card of that chain if it can be revised,
    // else file a fresh card. Refusing here left every later request already_revised (Codex review, fifth pass).
    const last = await lastRevision(db, t, String(created.successorId));
    created = await file(last && ["pending", "sent_back", "cancelled"].includes(last.status) ? last.id : undefined);
  }
  if (!created.ok) return { ok: false, error: created.error };
  const linked = await linkAuthorizationCard(db, t, input.engagementId, created.approval.id, input.actor, input.now, payload.engine);
  if (!linked.ok) return linked;
  return { ok: true, approvalId: created.approval.id, created: created.created };
}

/** The newest card in a chain of revisions, starting at `id` (a few steps at most). */
async function lastRevision(db: Client, t: string, id: string): Promise<Awaited<ReturnType<typeof getApprovalInTenant>>> {
  let card = await getApprovalInTenant(db, t, id);
  for (let i = 0; card && i < 10; i++) {
    const next = (await db.execute({ sql: "SELECT id FROM approvals WHERE tenant_id = ? AND supersedes_id = ? LIMIT 1", args: [t, card.id] })).rows[0];
    if (!next) break;
    card = await getApprovalInTenant(db, t, String(next.id));
  }
  return card;
}

/**
 * Point the engagement at a Gate 1 card, moving Profile from the call on to
 * Transcript to approve. A concurrent write only means re-reading; a
 * card left unlinked is picked up by the next request (the orphan check above).
 */
async function linkAuthorizationCard(
  db: Client,
  t: string,
  engagementId: string,
  cardId: string,
  actor: Actor,
  now: Date,
  engine: AiEngine,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await getEngagement(db, t, engagementId);
    if (!e) return { ok: false, error: "not_found" };
    if (e.authorization_approval_id === cardId && e.stage === "transcript_review") return { ok: true };
    if (e.stage === "call_completed") {
      const moved = await advanceEngagement(db, {
        tenantId: t,
        engagementId: e.id,
        to: "transcript_review",
        actor,
        now,
        expectedRowVersion: e.row_version,
        patch: { authorization_approval_id: cardId },
        event: "authorization_requested",
        meta: { approval_id: cardId, engine },
      });
      if (moved.ok) return { ok: true };
      continue;
    }
    if (e.stage !== "transcript_review") return { ok: false, error: "stage_moved" };
    const at = now.toISOString();
    const tx = await db.transaction("write");
    try {
      const r = await tx.execute(engagementUpdateStatement(t, e.id, e.row_version, { authorization_approval_id: cardId }, at));
      if (r.rowsAffected === 1) {
        await tx.execute(eventStatement({ tenantId: t, engagementId: e.id, event: "authorization_requested", actor, at, refType: "approval", refId: cardId, meta: { engine } }));
        await tx.commit();
        return { ok: true };
      }
      await tx.rollback();
    } finally {
      tx.close();
    }
  }
  // Three writes in a row lost to others: say so, so the caller tries again (the card stays, and the
  // next request links it). Reporting success here handed back a card that could never be approved.
  return { ok: false, error: "changed_elsewhere_refresh" };
}

/** Withdraw a pending Gate 1 outright (the engagement moved back, or the card no longer describes anything). The trail says so. */
export async function withdrawAuthorization(db: Client, tenantId: string, engagement: Engagement, actor: Actor, now: Date, reason = "profile_changed"): Promise<boolean> {
  if (!engagement.authorization_approval_id) return false;
  const t = requireTenant(tenantId);
  const card = await getApprovalInTenant(db, t, engagement.authorization_approval_id);
  if (!card || card.status !== "pending") return false;
  await cancelPendingApproval(db, t, engagement.authorization_approval_id, { type: actor.type === "user" ? "user" : "system", id: actor.id }, { reason }, now);
  const after = await getApprovalInTenant(db, t, engagement.authorization_approval_id);
  if (after?.status !== "cancelled") return false;
  await db.execute(eventStatement({ tenantId: t, engagementId: engagement.id, event: "authorization_withdrawn", actor, at: now.toISOString(), refType: "approval", refId: card.id, meta: { reason } }));
  return true;
}

/**
 * Withdraw a pending Gate 1 only when what it binds has really changed: the
 * profile, the transcripts, the notes, the business's name or type, or the
 * client's consent. A save that changes nothing (pressing Agreed again, saving
 * an unchanged field) leaves the card alone (review of phase 2, F1). Returns
 * whether it withdrew.
 */
export async function withdrawAuthorizationIfStale(db: Client, tenantId: string, engagementId: string, actor: Actor, now: Date): Promise<boolean> {
  const t = requireTenant(tenantId);
  const engagement = await getEngagement(db, t, engagementId);
  if (!engagement?.authorization_approval_id) return false;
  const card = await getApprovalInTenant(db, t, engagement.authorization_approval_id);
  if (!card || card.status !== "pending") return false;
  let bound: AuthorizeAiAuditPayload | null = null;
  try {
    const v = validateAuthorizeAiAuditPayload(parsePayload(card));
    bound = v.ok ? v.value : null;
  } catch {
    bound = null;
  }
  const now_ = bound ? await authorizationInputs(db, t, engagement.id, bound.engine) : null;
  const same = !!bound && !!now_ && now_.ok && bindingKey(now_.value.payload) === bindingKey(bound);
  if (same) return false;
  return withdrawAuthorization(db, t, engagement, actor, now, "information_changed");
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export type AuthorizeExecutorDeps = {
  isOwner: (db: Client, tenantId: string, userId: string) => Promise<boolean>;
};

export function defaultAuthorizeExecutorDeps(): AuthorizeExecutorDeps {
  return {
    isOwner: async (db, tenantId, userId) => {
      const row = (await db.execute({ sql: "SELECT is_owner FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1", args: [tenantId, userId] })).rows[0];
      return !!row && dbBool(row.is_owner);
    },
  };
}

function failed(reason: string, message: string): ExecutorOutcome {
  return { ok: false, result: { outcome: "failed", reason, message, provider: null } };
}

async function runAuthorization(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  const deps = ctx.deps.aiAuditAuthorize ?? defaultAuthorizeExecutorDeps();
  const t = ctx.tenant.id;
  const approverId = ctx.approver?.userId ?? "";
  if (!approverId || !(await deps.isOwner(ctx.db, t, approverId))) {
    return failed("owner_only", "Only the workspace owner can authorize a client's information for processing, so nothing was authorized.");
  }
  const v = validateAuthorizeAiAuditPayload(ctx.payload);
  if (!v.ok) return failed("payload_invalid", `The stored authorization is not valid (${v.error}).`);
  const p = v.value;
  if (!(await getEngagement(ctx.db, t, p.engagement_id))) return failed("engagement_missing", "The engagement no longer exists.");

  const at = new Date().toISOString();
  const tx = await ctx.db.transaction("write");
  try {
    // Everything re-read inside the write transaction: nothing can change these rows until it ends.
    const read = tx as unknown as Client;
    const engagement = await getEngagement(read, t, p.engagement_id);
    const refuse = async (reason: string, message: string) => {
      await tx.rollback();
      return failed(reason, message);
    };
    if (!engagement) return await refuse("engagement_missing", "The engagement no longer exists.");
    if (engagement.stage !== "transcript_review") return await refuse("stage_moved", "The engagement is no longer waiting for authorization.");
    if (engagement.authorization_approval_id !== ctx.approval.id) return await refuse("payload_changed", "A newer authorization card exists for this engagement. Approve that one instead.");
    if (engagement.current_profile_version_id !== p.profile_version_id) return await refuse("payload_changed", "The discovery profile changed after this card was made. Approve the newer card.");
    if (boundName(engagement) !== p.business_name || engagement.business_type !== p.business_type) {
      return await refuse("payload_changed", "The business's name or type changed after this card was made. Ask for authorization again.");
    }
    const transcripts = await listTranscripts(read, t, engagement.id);
    if (transcriptsHash(transcripts) !== p.transcripts_sha256 || transcripts.length !== p.transcript_count) {
      return await refuse("payload_changed", "A transcript was added or removed after this card was made. Ask for authorization again.");
    }
    const notes = (await listCallNotes(read, t, engagement.id)).filter((n) => n.notes.trim());
    if (notesHash(notes) !== p.notes_sha256 || notes.length !== p.note_count) {
      return await refuse("payload_changed", "The call notes changed after this card was made. Ask for authorization again.");
    }
    const version = (await tx.execute({ sql: "SELECT status, version_no FROM ai_audit_profile_versions WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, p.profile_version_id] })).rows[0];
    if (!version || String(version.status) !== "draft") {
      await tx.rollback();
      return failed("payload_changed", "The discovery profile is no longer the draft this card was made from.");
    }
    const fields = await listProfileFields(read, t, p.profile_version_id);
    if (profileHashOf(fields) !== p.profile_sha256 || fields.length !== p.field_count) {
      await tx.rollback();
      return failed("payload_changed", "The discovery profile changed after this card was made. Approve the newer card.");
    }
    if (!aiConsent(transcripts, fields) && p.engine !== "none") {
      await tx.rollback();
      return failed("no_ai_consent", "The client's consent no longer allows AI analysis, so nothing was authorized.");
    }
    const moved = await tx.execute(engagementUpdateStatement(t, engagement.id, engagement.row_version, { engine: p.engine }, at, "generating"));
    if (moved.rowsAffected !== 1) {
      await tx.rollback();
      return failed("changed_elsewhere", "The engagement changed while this was being approved. Nothing was authorized; open it and file the card again.");
    }
    await tx.batch([
      {
        // The draft's run report (the model's summary of the call) is a working note, not part of what is
        // authorized: a frozen profile never holds one, so nothing a later delete must reach stays frozen (review of phase 2b, H1).
        sql: `UPDATE ai_audit_profile_versions SET status = 'frozen', profile_sha256 = ?, transcript_sha256 = ?, frozen_at = ?, updated_at = ?,
                summary = json_remove(COALESCE(summary, '{}'), '$.extraction')
               WHERE tenant_id = ? AND id = ? AND status = 'draft'`,
        args: [p.profile_sha256, p.transcripts_sha256, at, at, t, p.profile_version_id],
      },
      // A draft still running reads a profile that is now frozen: it stops, and keeps nothing (review of phase 2b, F5).
      ...stopEngagementRunsStatements(t, engagement.id, "stage_closed", at),
      {
        // A warning that an earlier authorization stopped holding is answered by this one; other warnings stay.
        sql: `UPDATE ai_audit_engagements SET health = 'ok', health_reason = NULL
               WHERE tenant_id = ? AND id = ? AND health = 'attention' AND health_reason IN (?, ?)`,
        args: [t, engagement.id, AUTHORIZATION_VOIDED_REASONS.transcriptDeleted, AUTHORIZATION_VOIDED_REASONS.notAuthorized],
      },
      eventStatement({
        tenantId: t,
        engagementId: engagement.id,
        event: "authorized",
        actor: { type: "user", id: approverId },
        at,
        fromStage: "transcript_review",
        toStage: "generating",
        refType: "approval",
        refId: ctx.approval.id,
        meta: { engine: p.engine, profile_version_no: p.profile_version_no, profile_sha256: p.profile_sha256, transcripts_sha256: p.transcripts_sha256, notes_sha256: p.notes_sha256 },
      }),
    ]);
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Already gone; the error below is the one that matters.
    }
    throw err;
  } finally {
    tx.close();
  }
  const after = await getEngagement(ctx.db, t, p.engagement_id);
  if (after) await syncLeadStage(ctx.db, after, { type: "user", id: approverId }, new Date());
  return { ok: true, result: { outcome: "authorized", provider: "ai_audit", detail: `Profile version ${p.profile_version_no} frozen; processed by ${AI_ENGINE_LABELS[p.engine]}.` } };
}

export const authorizeAiAuditExecutor: Executor = {
  readiness: (tenant) => (isOasisInternalTenant(tenant.id) ? null : "AI audits run only in OASIS's own workspaces."),
  run: runAuthorization,
};

/**
 * For every later step: the engagement's frozen, authorized profile, or null.
 * A step that gets null must not touch the client's information. Null also
 * when the engagement was moved back to correct the profile, declined or
 * cancelled, or when a transcript CC authorized was deleted since (review of
 * phase 2, F4).
 */
export async function authorizedProfile(db: Client, tenantId: string, engagement: Engagement): Promise<{ versionId: string; profileSha256: string; engine: AiEngine } | null> {
  const t = requireTenant(tenantId);
  if (PROFILE_EDIT_STAGES.includes(engagement.stage) || TERMINAL_STAGES.includes(engagement.stage)) return null;
  if (!engagement.authorization_approval_id || !engagement.current_profile_version_id) return null;
  const approval = await getApprovalInTenant(db, t, engagement.authorization_approval_id);
  if (!approval || approval.status !== "executed" || approval.action_kind !== AUTHORIZE_AI_AUDIT_KIND) return null;
  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(approval);
  } catch {
    return null;
  }
  const v = validateAuthorizeAiAuditPayload(payload);
  if (!v.ok || v.value.profile_version_id !== engagement.current_profile_version_id) return null;
  const version = await getProfileVersion(db, t, v.value.profile_version_id);
  if (!version || version.status !== "frozen" || version.profile_sha256 !== v.value.profile_sha256) return null;
  const fields = await listProfileFields(db, t, version.id);
  if (profileHashOf(fields) !== v.value.profile_sha256) return null;
  if (transcriptsHash(await listTranscripts(db, t, engagement.id)) !== v.value.transcripts_sha256) return null;
  // And the rest of what CC authorized: the notes and the business, however they were changed (review of phase 2, second pass).
  if (notesHash((await listCallNotes(db, t, engagement.id)).filter((n) => n.notes.trim())) !== v.value.notes_sha256) return null;
  if (boundName(engagement) !== v.value.business_name || engagement.business_type !== v.value.business_type) return null;
  return { versionId: version.id, profileSha256: v.value.profile_sha256, engine: v.value.engine };
}

