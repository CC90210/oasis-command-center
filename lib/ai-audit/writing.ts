/**
 * lib/ai-audit/writing.ts — the model's pass over an audit's opening prose
 * (lib/ai-audit/prose.ts), phase 4b: after the code draft exists, on the
 * engine CC authorized at Gate 1 (Claude on his Mac, or the workspace's
 * cloud model; never when the client said no to AI analysis).
 *
 * One step row ("write") per pass, one model call. The Mac's job holds ids
 * only: its prompt is built at claim time from the draft as it stands, and
 * its answer is checked sentence by sentence before anything is kept. The
 * checked prose replaces the draft's opening only while the draft is still
 * the one the pass read: an edit by CC in between wins, and the pass ends
 * without writing. Every withheld sentence is kept on the step, with its
 * reason, for CC to read.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { applyProse, checkProse, prosePrompt, PROSE_MAX_TOKENS, type CheckedProse } from "@/lib/ai-audit/prose";
import { auditDocIssues, validateAuditDoc, type AuditDoc } from "@/lib/ai-audit/doc";
import { authorizedProfile } from "@/lib/ai-audit/authorize";
import { getAuditVersion, saveAuditDraft } from "@/lib/ai-audit/versions";
import { eventStatement, getEngagement, int, requireTenant, type Actor, type Engagement } from "@/lib/ai-audit/store";
import { shortName } from "@/lib/ai-audit/rules";
import { RESEARCH_STAGES } from "@/lib/ai-audit/research";
import { MODEL_TOOL_KEY } from "@/lib/ai-audit/extraction";
import { inputHashOf } from "@/lib/tools/store";
import { runToolModelCall, type ToolModelCall, type ToolModelResult } from "@/lib/tools/worker/ai";
import { aiAuditModelSearchEnabled } from "@/lib/ai-audit/env";

export const WRITE_STEP = "write";
const shortNameOf = (e: Engagement) => shortName(e.business_name, "an AI audit");
const IN_FLIGHT = ["queued", "running", "waiting_runner"];
/** A Mac pass nobody ran in this long is called off, and CC is told. */
export const MAC_WRITE_WAIT_MS = 24 * 3_600_000;
/** The cloud call may wait this long inside the tick. */
export const WRITE_CALL_DEADLINE_MS = 55_000;
/** A cloud pass a tick claimed and never finished is claimed again after this long (the tick that took it died). */
const CLOUD_CLAIM_MS = 5 * 60_000;
/** What a pass keeps of what it held back, for CC to read: never the rest of the model's answer. */
const WITHHELD_KEPT = 20;

export type WriteDeps = {
  model: (call: ToolModelCall) => Promise<ToolModelResult>;
  alert: (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string }) => Promise<unknown>;
};
export function defaultWriteModel(): WriteDeps["model"] {
  return (call) => runToolModelCall(call);
}

/** What a pass read: the draft version and its hash. What it held back goes here too when it ends. */
type StepRef = { audit_version_id: string; content_sha256: string; withheld?: CheckedProse["withheld"]; written?: boolean; parts?: string[] };

export type StartWriteResult =
  | { ok: true; stepId: string; created: boolean; runsOn: "mac" | "cloud" }
  | { ok: false; error: "not_found" | "stage_closed" | "not_authorized" | "no_audit_draft" | "no_ai_engine" | "model_search_deferred" };

/** Start a pass over the current draft's opening prose, or hand back the one running. */
export async function startWriting(db: Client, input: { tenantId: string; engagementId: string; actor: Actor; now: Date }): Promise<StartWriteResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!RESEARCH_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  const auth = await authorizedProfile(db, t, e);
  if (!auth) return { ok: false, error: "not_authorized" };
  // The engine CC authorized at Gate 1 is the only one that may read this client's information.
  if (auth.engine !== "mac_claude" && auth.engine !== "cloud_workspace") return { ok: false, error: "no_ai_engine" };
  if (!aiAuditModelSearchEnabled()) return { ok: false, error: "model_search_deferred" };
  const audit = e.current_audit_version_id ? await getAuditVersion(db, t, e.current_audit_version_id) : null;
  if (!audit || audit.status !== "draft" || !audit.doc) return { ok: false, error: "no_audit_draft" };
  const running = async () =>
    (await db.execute({ sql: "SELECT id, runs_on, result_ref FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') LIMIT 1", args: [t, e.id, WRITE_STEP] })).rows[0];
  const now = await running();
  if (now) {
    // A pass over the draft as it stands is handed back; one that read an older draft (CC edited since) is
    // called off, so this press starts a fresh one instead of waiting a day for it (review of phase 4, F4).
    let ref: Partial<StepRef> = {};
    try {
      ref = JSON.parse(String(now.result_ref ?? "{}")) as StepRef;
    } catch {
      ref = {};
    }
    // A Mac pass whose job failed (the model call, or every attempt) is dead too, whatever its step says (review of
    // phase 4, third round, N3): this press starts a fresh one instead of waiting a day.
    const dead = String(now.runs_on) === "mac" && !(await macJobLive(db, t, String(now.id)));
    if (!dead && ref.audit_version_id === audit.id && ref.content_sha256 === audit.content_sha256) {
      return { ok: true, stepId: String(now.id), created: false, runsOn: String(now.runs_on) === "mac" ? "mac" : "cloud" };
    }
    await cancelWriting(db, t, String(now.id), dead ? "write_failed" : "draft_changed", input.now);
  }
  const mac = auth.engine === "mac_claude";
  const runNo = int((await db.execute({ sql: "SELECT COUNT(1) AS n FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ?", args: [t, e.id, WRITE_STEP] })).rows[0]?.n) + 1;
  const stepId = newId();
  const at = input.now.toISOString();
  const ref: StepRef = { audit_version_id: audit.id, content_sha256: audit.content_sha256 };
  const jobInput = { step_id: stepId, engagement_id: e.id, purpose: "write" };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO ai_audit_steps (id, tenant_id, engagement_id, step_key, run_no, runs_on, status, input_hash, idempotency_key, max_attempts, result_ref, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)`,
          args: [stepId, t, e.id, WRITE_STEP, runNo, mac ? "mac" : "cloud", mac ? "waiting_runner" : "queued", contentHash(ref), `write:${e.id}:${runNo}`, JSON.stringify(ref), at, at],
        },
        ...(mac
          ? [
              {
                sql: "INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'runner', 'queued', ?, ?, ?, ?, ?)",
                args: [newId(), t, MODEL_TOOL_KEY, JSON.stringify(jobInput), inputHashOf(MODEL_TOOL_KEY, jobInput), `${MODEL_TOOL_KEY}:write:${stepId}`, at, at],
              },
            ]
          : []),
        eventStatement({ tenantId: t, engagementId: e.id, event: "writing_started", actor: input.actor, at, refType: "step", refId: stepId, meta: { engine: auth.engine } }),
      ],
      "write",
    );
  } catch (err) {
    // Two starts at once: the one that lost hands back the pass that won.
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      const won = await running();
      if (won) return { ok: true, stepId: String(won.id), created: false, runsOn: String(won.runs_on) === "mac" ? "mac" : "cloud" };
    }
    throw err;
  }
  return { ok: true, stepId, created: true, runsOn: mac ? "mac" : "cloud" };
}

type WriteContext = { ok: true; stepId: string; engagement: Engagement; doc: AuditDoc; ref: StepRef } | { ok: false; code: "gone" | "not_permitted" | "bad_input" };

/** The pass's step, engagement and draft, if it may still run: in flight, after Gate 1, and the draft unchanged since it started. */
async function writeContext(db: Client, tenantId: string, input: Record<string, unknown>): Promise<WriteContext> {
  // Recheck at the result boundary too: a pass may have started while the
  // independent switch was on and answered only after CC turned it off.
  if (!aiAuditModelSearchEnabled()) return { ok: false, code: "not_permitted" };
  const t = requireTenant(tenantId);
  const stepId = typeof input.step_id === "string" ? input.step_id : "";
  const engagementId = typeof input.engagement_id === "string" ? input.engagement_id : "";
  if (!stepId || !engagementId || input.purpose !== "write") return { ok: false, code: "bad_input" };
  const step = (await db.execute({ sql: "SELECT status, result_ref FROM ai_audit_steps WHERE tenant_id = ? AND id = ? AND engagement_id = ? AND step_key = ? LIMIT 1", args: [t, stepId, engagementId, WRITE_STEP] })).rows[0];
  if (!step || !IN_FLIGHT.includes(String(step.status))) return { ok: false, code: "gone" };
  const e = await getEngagement(db, t, engagementId);
  if (!e || !RESEARCH_STAGES.includes(e.stage)) return { ok: false, code: "not_permitted" };
  const auth = await authorizedProfile(db, t, e);
  if (!auth || (auth.engine !== "mac_claude" && auth.engine !== "cloud_workspace")) return { ok: false, code: "not_permitted" };
  let ref: StepRef;
  try {
    ref = JSON.parse(String(step.result_ref ?? "{}")) as StepRef;
  } catch {
    return { ok: false, code: "gone" };
  }
  if (e.current_audit_version_id !== ref.audit_version_id) return { ok: false, code: "gone" };
  const audit = await getAuditVersion(db, t, ref.audit_version_id);
  if (!audit || audit.status !== "draft" || audit.content_sha256 !== ref.content_sha256 || !audit.doc) return { ok: false, code: "gone" };
  return { ok: true, stepId, engagement: e, doc: audit.doc, ref };
}

/** The Mac's job input for a pass, built now from the draft as it stands (the job row holds ids only). */
export async function writeJobInput(db: Client, job: { tenantId: string; input: Record<string, unknown> }): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; code: "gone" | "not_permitted" | "bad_input" }> {
  if (!aiAuditModelSearchEnabled()) return { ok: false, code: "not_permitted" };
  const ctx = await writeContext(db, job.tenantId, job.input);
  if (!ctx.ok) return ctx;
  const p = prosePrompt(ctx.doc);
  return { ok: true, input: { purpose: "write", system: p.system, prompt: p.prompt, model: "sonnet", max_tokens: PROSE_MAX_TOKENS } };
}

async function endStep(db: Client, t: string, stepId: string, status: "done" | "cancelled" | "failed", code: string | null, ref: StepRef | null, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db.execute({
    sql: "UPDATE ai_audit_steps SET status = ?, error_code = ?, result_ref = COALESCE(?, result_ref), finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
    args: [status, code, ref ? JSON.stringify(ref) : null, at, at, t, stepId],
  });
  return r.rowsAffected === 1;
}

/** Whether a Mac pass still has a job the Mac can take or is running. */
async function macJobLive(db: Client, t: string, stepId: string): Promise<boolean> {
  const job = (
    await db.execute({ sql: "SELECT status FROM tool_jobs WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ? ORDER BY created_at DESC LIMIT 1", args: [t, MODEL_TOOL_KEY, stepId] })
  ).rows[0];
  return !!job && ["queued", "claimed", "running"].includes(String(job.status));
}

/** A pass ended before it could write (the draft changed, the authorization ended): its Mac job goes with it. */
export async function cancelWriting(db: Client, tenantId: string, stepId: string, code: "draft_changed" | "not_authorized" | "write_failed", now: Date): Promise<boolean> {
  const t = requireTenant(tenantId);
  const ended = await endStep(db, t, stepId, code === "write_failed" ? "failed" : "cancelled", code, null, now);
  const at = now.toISOString();
  await db.execute({
    sql: "UPDATE tool_jobs SET status = 'failed', error_code = 'ai_audit_gone', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ? AND status IN ('queued', 'claimed', 'running')",
    args: [at, at, t, MODEL_TOOL_KEY, stepId],
  });
  return ended;
}

export type FinishWrite = { ok: true; written: boolean; withheld: number } | { ok: false; code: "gone" | "not_permitted" | "bad_input" };

/**
 * The model's answer for a pass: checked, and put in the draft if the draft
 * is still the one the pass read. The answer's own text is never stored;
 * what was withheld is, with its reasons.
 */
export async function finishWriting(db: Client, input: { tenantId: string; jobInput: Record<string, unknown>; text: string; now: Date; alert: WriteDeps["alert"] }): Promise<FinishWrite> {
  const t = requireTenant(input.tenantId);
  const ctx = await writeContext(db, t, input.jobInput);
  const stepId = typeof input.jobInput.step_id === "string" ? input.jobInput.step_id : "";
  if (!ctx.ok) {
    if (stepId && ctx.code !== "bad_input") await endStep(db, t, stepId, "cancelled", ctx.code === "gone" ? "draft_changed" : "not_authorized", null, input.now);
    return ctx;
  }
  const e = ctx.engagement;
  const checked = checkProse(input.text, ctx.doc);
  if (!checked.ok) {
    await endStep(db, t, ctx.stepId, "failed", "unreadable", { ...ctx.ref, written: false, withheld: [] }, input.now);
    await input.alert({ tenantId: t, alertType: "ai_audit_writing_failed", severity: "warn", title: `Prose not written: ${shortNameOf(e)}`, body: "The model's answer could not be read, so the draft stays as it was. Write it again, or edit the draft yourself.", subjectType: "ai_audit_engagement", subjectId: e.id });
    return { ok: true, written: false, withheld: 0 };
  }
  const next = applyProse(ctx.doc, checked.value);
  const valid = validateAuditDoc(next);
  const blocking = valid.ok ? auditDocIssues(valid.doc).filter((i) => i.severity === "block") : [];
  const parts = Object.keys(checked.value.parts);
  const ref: StepRef = { ...ctx.ref, withheld: checked.value.withheld.slice(0, WITHHELD_KEPT), parts, written: false };
  if (!valid.ok || blocking.length || !parts.length) {
    // Whatever the prose broke, the code draft stays: it already passes every rule.
    await endStep(db, t, ctx.stepId, "done", !parts.length ? "nothing_kept" : "rules_broken", ref, input.now);
    return { ok: true, written: false, withheld: checked.value.withheld.length };
  }
  const saved = await saveAuditDraft(db, { tenantId: t, engagementId: e.id, doc: valid.doc, actor: { type: "system", id: null }, now: input.now, expectedRowVersion: e.row_version });
  if (!saved.ok) {
    // CC changed the engagement or the draft meanwhile: his edit wins.
    await endStep(db, t, ctx.stepId, "cancelled", "draft_changed", ref, input.now);
    return { ok: true, written: false, withheld: checked.value.withheld.length };
  }
  const withheld = checked.value.withheld.length;
  await endStep(db, t, ctx.stepId, "done", null, { ...ref, written: true }, input.now);
  await db.execute(
    eventStatement({ tenantId: t, engagementId: e.id, event: "audit_written", actor: { type: "system", id: null }, at: input.now.toISOString(), refType: "audit_version", refId: saved.version.id, meta: { parts, withheld } }),
  );
  await input.alert({
    tenantId: t,
    alertType: "ai_audit_prose_ready",
    severity: "info",
    title: `Audit prose drafted: ${shortNameOf(e)}`,
    body: withheld ? `The opening was written; ${withheld} sentence${withheld === 1 ? " was" : "s were"} held back for a claim the facts do not support. Read the draft before you submit it.` : "The opening was written from the research. Read the draft before you submit it.",
    subjectType: "ai_audit_engagement",
    subjectId: e.id,
  });
  return { ok: true, written: true, withheld };
}

/** One cloud pass: the metered model call on the workspace AI account, then the same checks. Retries back off; a pass given up tells CC. */
export async function advanceCloudWriting(db: Client, input: { tenantId: string; stepId: string; now: Date; deps: WriteDeps }): Promise<"finished" | "failed" | "retry" | "idle"> {
  const t = requireTenant(input.tenantId);
  const row = (await db.execute({ sql: "SELECT id, engagement_id, status, attempts, max_attempts, runs_on FROM ai_audit_steps WHERE tenant_id = ? AND id = ? AND step_key = ? LIMIT 1", args: [t, input.stepId, WRITE_STEP] })).rows[0];
  if (!row || String(row.runs_on) !== "cloud" || !["queued", "running"].includes(String(row.status))) return "idle";
  // Claimed first, by compare-and-set: an overlapping tick finds it taken and makes no second metered call.
  const claimed = await db.execute({
    sql: `UPDATE ai_audit_steps SET status = 'running', updated_at = ? WHERE tenant_id = ? AND id = ? AND step_key = ? AND runs_on = 'cloud'
            AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'running' AND updated_at < ?))`,
    args: [input.now.toISOString(), t, input.stepId, WRITE_STEP, input.now.toISOString(), new Date(input.now.getTime() - CLOUD_CLAIM_MS).toISOString()],
  });
  if (claimed.rowsAffected !== 1) return "idle";
  const jobInput = { step_id: input.stepId, engagement_id: String(row.engagement_id), purpose: "write" };
  const built = await writeJobInput(db, { tenantId: t, input: jobInput });
  if (!built.ok) {
    await endStep(db, t, input.stepId, "cancelled", built.code === "gone" ? "draft_changed" : "not_authorized", null, input.now);
    return "failed";
  }
  const answer = await input.deps.model({
    tenantId: t,
    userId: null,
    jobId: input.stepId,
    surface: "ai_audit.write",
    system: String(built.input.system),
    prompt: String(built.input.prompt),
    maxTokens: PROSE_MAX_TOKENS,
    deadlineMs: WRITE_CALL_DEADLINE_MS,
  });
  if (!answer.ok) {
    const attempts = int(row.attempts) + 1;
    const giveUp = attempts >= int(row.max_attempts, 3) || answer.code === "ai_account_missing";
    const at = input.now.toISOString();
    await db.execute({
      sql: "UPDATE ai_audit_steps SET status = ?, attempts = ?, error_code = ?, next_attempt_at = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')",
      args: [giveUp ? "failed" : "queued", attempts, answer.code.slice(0, 64), giveUp ? null : new Date(input.now.getTime() + [60_000, 300_000, 1_800_000][Math.min(attempts - 1, 2)]).toISOString(), giveUp ? at : null, at, t, input.stepId],
    });
    if (giveUp) {
      const e = await getEngagement(db, t, String(row.engagement_id));
      await input.deps.alert({ tenantId: t, alertType: "ai_audit_writing_failed", severity: "warn", title: `Prose not written: ${e ? shortNameOf(e) : "an AI audit"}`, body: `The cloud model failed (${answer.code}). The draft stays as it was; write it again or edit it yourself.`, subjectType: "ai_audit_engagement", subjectId: String(row.engagement_id) });
      return "failed";
    }
    return "retry";
  }
  try {
    const done = await finishWriting(db, { tenantId: t, jobInput, text: answer.text, now: input.now, alert: input.deps.alert });
    return done.ok ? "finished" : "failed";
  } catch (err) {
    // Counted and backed off like a failed call, so a pass that cannot finish is not paid for on every tick (review of phase 4, N4).
    console.error("[ai-audit.writing] the cloud pass could not be finished", err instanceof Error ? (err.stack ?? err.message) : String(err));
    const attempts = int(row.attempts) + 1;
    const giveUp = attempts >= int(row.max_attempts, 3);
    const at = input.now.toISOString();
    await db.execute({
      sql: "UPDATE ai_audit_steps SET status = ?, attempts = ?, error_code = 'write_failed', next_attempt_at = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')",
      args: [giveUp ? "failed" : "queued", attempts, giveUp ? null : new Date(input.now.getTime() + [60_000, 300_000, 1_800_000][Math.min(attempts - 1, 2)]).toISOString(), giveUp ? at : null, at, t, input.stepId],
    });
    return giveUp ? "failed" : "retry";
  }
}

/** Cloud passes due now, and Mac passes no computer has run for a day (to call off). */
export async function dueWriting(db: Client, tenantId: string, now: Date): Promise<{ cloud: string[]; stale: string[] }> {
  const t = requireTenant(tenantId);
  const cloud = await db.execute({
    sql: `SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND step_key = ? AND runs_on = 'cloud'
            AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'running' AND updated_at < ?))
          ORDER BY updated_at LIMIT 2`,
    args: [t, WRITE_STEP, now.toISOString(), new Date(now.getTime() - CLOUD_CLAIM_MS).toISOString()],
  });
  // A Mac pass nobody ran for a day, or whose job has failed (the model call, or every attempt).
  const stale = await db.execute({
    sql: `SELECT s.id FROM ai_audit_steps s
           WHERE s.tenant_id = ? AND s.step_key = ? AND s.runs_on = 'mac' AND s.status = 'waiting_runner'
             AND (s.updated_at < ? OR NOT EXISTS (
               SELECT 1 FROM tool_jobs j WHERE j.tenant_id = s.tenant_id AND j.tool_key = ? AND json_extract(j.input_json, '$.step_id') = s.id
                  AND j.status IN ('queued', 'claimed', 'running')))
           LIMIT 5`,
    args: [t, WRITE_STEP, new Date(now.getTime() - MAC_WRITE_WAIT_MS).toISOString(), MODEL_TOOL_KEY],
  });
  return { cloud: cloud.rows.map((r) => String(r.id)), stale: stale.rows.map((r) => String(r.id)) };
}

/** A Mac pass nobody ran for a day, or whose job failed: called off (its job too), and CC told which. */
export async function callOffStaleWriting(db: Client, tenantId: string, stepId: string, now: Date, alert: WriteDeps["alert"]): Promise<void> {
  const t = requireTenant(tenantId);
  const row = (await db.execute({ sql: "SELECT engagement_id FROM ai_audit_steps WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, stepId] })).rows[0];
  const failed = !(await macJobLive(db, t, stepId)) && (await db.execute({ sql: "SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ? AND status = 'failed' LIMIT 1", args: [t, MODEL_TOOL_KEY, stepId] })).rows.length > 0;
  if (failed) {
    if (!(await endStep(db, t, stepId, "failed", "write_failed", null, now))) return;
    const e = row ? await getEngagement(db, t, String(row.engagement_id)) : null;
    if (e) await alert({ tenantId: t, alertType: "ai_audit_writing_failed", severity: "warn", title: `Prose not written: ${shortNameOf(e)}`, body: "The Mac's model call failed, so the draft stays as it was. Write it again, or edit it yourself.", subjectType: "ai_audit_engagement", subjectId: e.id });
    return;
  }
  if (!(await endStep(db, t, stepId, "cancelled", "runner_offline", null, now))) return;
  const at = now.toISOString();
  await db.execute({
    sql: "UPDATE tool_jobs SET status = 'failed', error_code = 'runner_offline', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ? AND status IN ('queued', 'claimed', 'running')",
    args: [at, at, t, MODEL_TOOL_KEY, stepId],
  });
  const e = row ? await getEngagement(db, t, String(row.engagement_id)) : null;
  if (e) await alert({ tenantId: t, alertType: "ai_audit_writing_failed", severity: "warn", title: `Prose not written: ${shortNameOf(e)}`, body: "No Mac wrote the audit's opening within a day, so it was called off. The draft stays as it was; turn the Mac on and write it again, or edit it yourself.", subjectType: "ai_audit_engagement", subjectId: e.id });
}

/** The latest pass, for the engagement page: its status, and what it held back. */
export async function latestWriteStep(db: Client, tenantId: string, engagementId: string): Promise<{ status: string; error: string | null; created_at: string; written: boolean; withheld: CheckedProse["withheld"] } | null> {
  const r = (await db.execute({ sql: "SELECT status, error_code, result_ref, created_at FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? ORDER BY run_no DESC, created_at DESC LIMIT 1", args: [requireTenant(tenantId), engagementId, WRITE_STEP] })).rows[0];
  if (!r) return null;
  let ref: StepRef | null = null;
  try {
    ref = JSON.parse(String(r.result_ref ?? "{}")) as StepRef;
  } catch {
    ref = null;
  }
  return { status: String(r.status), error: r.error_code === null || r.error_code === undefined ? null : String(r.error_code), created_at: String(r.created_at), written: !!ref?.written, withheld: ref?.withheld ?? [] };
}
