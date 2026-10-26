/**
 * lib/ai-audit/extraction.ts — drafting the discovery profile from the call's
 * transcripts, when CC asks for it.
 *
 * WHEN. Only on CC's press ("Draft the profile from the transcript"), only
 * before Gate 1, and only from transcripts whose client agreed to AI analysis
 * (and a profile that does not say they declined). The press is itself the
 * authorization for this one processing step; research and writing wait for
 * Gate 1.
 *
 * WHERE. On CC's Mac by default (system runner tool ai_audit_model, which
 * runs `claude -p` with every tool denied, scripts/ai_audit/runner.py), or on
 * the workspace's cloud AI account (runToolModelCall, metered) when CC picks
 * it. Either way the Command Center builds every prompt and checks every
 * answer; the model only reads.
 *
 * HOW. One step row ("extract") per run; one window of numbered lines per
 * model call (lib/ai-audit/transcript.ts transcriptWindows). The Mac's job rows
 * hold ids only: the prompt is built at claim time from the database, and the
 * job keeps only the CHECKED window result (facts with short quotes), never
 * the model's raw text. When every window is in, the facts are merged
 * (lib/ai-audit/extract.ts mergeFacts) and written to the draft profile as
 * Client-reported, from the transcript, with their lines and quote. CC's own
 * entries are never overwritten; a disagreement is listed for him. Then the
 * job rows are cleared of their facts.
 */
import "server-only";
import type { Client, InStatement } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { checkFacts, extractionPrompt, mergeFacts, mergeSummaries, MODEL_MAX_TOKENS, parseExtraction, type Contradiction, type DroppedFact, type ExtractionSummary, type KeptFact } from "@/lib/ai-audit/extract";
import { renderLine, transcriptWindows, type TranscriptLine } from "@/lib/ai-audit/transcript";
import { getTranscript, listTranscripts } from "@/lib/ai-audit/transcripts";
import { ensureDraftProfile, listProfileFields } from "@/lib/ai-audit/versions";
import { aiConsent, withdrawAuthorization } from "@/lib/ai-audit/authorize";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, int, requireTenant, text, type Actor } from "@/lib/ai-audit/store";
import { inputHashOf } from "@/lib/tools/store";
import { runToolModelCall, type ToolModelCall, type ToolModelResult } from "@/lib/tools/worker/ai";

export const EXTRACT_STEP = "extract";
export const MODEL_TOOL_KEY = "ai_audit_model";
/** The CLI model the Mac uses for extraction. */
export const MAC_MODEL = "sonnet";

export type ExtractionEngine = "mac_claude" | "cloud_workspace";
export type WindowRef = { transcript_id: string; from: number; to: number };
export type WindowResult = WindowRef & { kept: KeptFact[]; dropped: DroppedFact[]; summary: ExtractionSummary };

export type ExtractionStatus = {
  step_id: string;
  status: string;
  runs_on: string;
  windows: number;
  done: number;
  failed: number;
  created_at: string;
  finished_at: string | null;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export type StartResult = { ok: true; stepId: string; windows: number; created: boolean } | { ok: false; error: string };

export async function startExtraction(
  db: Client,
  input: { tenantId: string; engagementId: string; engine: ExtractionEngine; actor: Actor; now: Date },
): Promise<StartResult> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (!PROFILE_EDIT_STAGES.includes(engagement.stage)) return { ok: false, error: "stage_closed" };
  const all = await listTranscripts(db, t, engagement.id, { withLines: true });
  const usable = all.filter((x) => x.consent_ai && (x.lines?.length ?? 0) > 0);
  if (!usable.length) return { ok: false, error: all.length ? "no_ai_consent" : "no_transcript" };
  const fields = engagement.current_profile_version_id ? await listProfileFields(db, t, engagement.current_profile_version_id) : [];
  // The profile's own consent answer must not say no, whatever the transcripts say.
  if (!aiConsent(usable, fields)) return { ok: false, error: "no_ai_consent" };

  const windows: WindowRef[] = usable.flatMap((x) => transcriptWindows(x.lines ?? []).map((w) => ({ transcript_id: x.id, from: w.from, to: w.to })));
  const inputHash = contentHash({ transcripts: usable.map((x) => [x.id, x.text_sha256]).sort(), engine: input.engine });
  const idem = `extract:${engagement.id}:${inputHash.slice(0, 24)}`;
  const existing = (await db.execute({ sql: "SELECT id, status FROM ai_audit_steps WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1", args: [t, idem] })).rows[0];
  if (existing && ["queued", "running", "waiting_runner"].includes(String(existing.status))) return { ok: true, stepId: String(existing.id), windows: windows.length, created: false };
  const inFlight = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') LIMIT 1", args: [t, engagement.id, EXTRACT_STEP] })).rows[0];
  if (inFlight) return { ok: false, error: "extraction_running" };

  const stepId = newId();
  const at = input.now.toISOString();
  const mac = input.engine === "mac_claude";
  // A re-run of the same inputs (after a finished or failed run) gets a fresh key.
  const runNo = int((await db.execute({ sql: "SELECT COUNT(1) AS n FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ?", args: [t, engagement.id, EXTRACT_STEP] })).rows[0]?.n) + 1;
  const stmts: InStatement[] = [
    {
      sql: `INSERT INTO ai_audit_steps (id, tenant_id, engagement_id, step_key, run_no, runs_on, status, input_hash, idempotency_key, max_attempts, result_ref, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)`,
      args: [stepId, t, engagement.id, EXTRACT_STEP, runNo, mac ? "mac" : "cloud", mac ? "waiting_runner" : "queued", inputHash, existing ? `${idem}:run-${runNo}` : idem, JSON.stringify({ windows, results: [] }), at, at],
    },
    eventStatement({ tenantId: t, engagementId: engagement.id, event: "extraction_started", actor: input.actor, at, refType: "step", refId: stepId, meta: { engine: input.engine, windows: windows.length, transcripts: usable.length } }),
  ];
  if (mac) {
    for (const w of windows) {
      const jobInput = { step_id: stepId, engagement_id: engagement.id, transcript_id: w.transcript_id, from: w.from, to: w.to };
      stmts.push({
        sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, dedupe_key, created_at, updated_at)
              VALUES (?, ?, ?, 'runner', 'queued', ?, ?, ?, ?, ?)`,
        args: [newId(), t, MODEL_TOOL_KEY, JSON.stringify(jobInput), inputHashOf(MODEL_TOOL_KEY, jobInput), `${MODEL_TOOL_KEY}:${stepId}:${w.transcript_id}:${w.from}`, at, at],
      });
    }
  }
  await db.batch(stmts, "write");
  return { ok: true, stepId, windows: windows.length, created: true };
}

// ---------------------------------------------------------------------------
// One window: its prompt, and its checked result
// ---------------------------------------------------------------------------

type Permitted = { ok: true; lines: TranscriptLine[]; window: { from: number; to: number; text: string }; businessName: string } | { ok: false; code: "not_permitted" | "gone" };

/** Is this window still to be read, by consent and by stage? Its lines if so. */
async function permittedWindow(db: Client, tenantId: string, ref: WindowRef & { step_id: string; engagement_id: string }): Promise<Permitted> {
  const step = (await db.execute({ sql: "SELECT status FROM ai_audit_steps WHERE tenant_id = ? AND id = ? AND engagement_id = ? LIMIT 1", args: [tenantId, ref.step_id, ref.engagement_id] })).rows[0];
  if (!step || !["queued", "running", "waiting_runner"].includes(String(step.status))) return { ok: false, code: "gone" };
  const engagement = await getEngagement(db, tenantId, ref.engagement_id);
  if (!engagement || !PROFILE_EDIT_STAGES.includes(engagement.stage)) return { ok: false, code: "not_permitted" };
  const transcript = await getTranscript(db, tenantId, ref.transcript_id, true);
  if (!transcript || transcript.engagement_id !== engagement.id || transcript.status !== "active" || !transcript.consent_ai) return { ok: false, code: "not_permitted" };
  // The profile's own consent answer is read again too: a "declined" recorded after the run began stops it.
  const fields = engagement.current_profile_version_id ? await listProfileFields(db, tenantId, engagement.current_profile_version_id) : [];
  if (!aiConsent([transcript], fields)) return { ok: false, code: "not_permitted" };
  const lines = transcript.lines ?? [];
  const inWindow = lines.filter((l) => l.n >= ref.from && l.n <= ref.to);
  if (!inWindow.length) return { ok: false, code: "gone" };
  return { ok: true, lines, window: { from: ref.from, to: ref.to, text: inWindow.map(renderLine).join("\n") }, businessName: engagement.business_name || "the business" };
}

function windowRefOf(input: Record<string, unknown>): (WindowRef & { step_id: string; engagement_id: string }) | null {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const n = (k: string) => (typeof input[k] === "number" && Number.isInteger(input[k]) ? (input[k] as number) : NaN);
  const ref = { step_id: s("step_id"), engagement_id: s("engagement_id"), transcript_id: s("transcript_id"), from: n("from"), to: n("to") };
  return ref.step_id && ref.engagement_id && ref.transcript_id && Number.isInteger(ref.from) && Number.isInteger(ref.to) ? ref : null;
}

/** What the Mac is handed at claim time: the prompt, built now, never stored on the job. */
export async function modelJobInput(db: Client, job: { tenantId: string; input: Record<string, unknown> }): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; code: "not_permitted" | "gone" | "bad_input" }> {
  const ref = windowRefOf(job.input);
  if (!ref) return { ok: false, code: "bad_input" };
  const p = await permittedWindow(db, job.tenantId, ref);
  if (!p.ok) return p;
  const prompt = extractionPrompt({ businessName: p.businessName, window: p.window });
  return { ok: true, input: { purpose: "extract", system: prompt.system, prompt: prompt.prompt, max_tokens: MODEL_MAX_TOKENS, model: MAC_MODEL } };
}

/** The model's text for one window, checked. Throws nothing: an unreadable answer is a window with nothing kept. */
export async function checkWindowAnswer(db: Client, tenantId: string, input: Record<string, unknown>, answer: string): Promise<{ ok: true; result: WindowResult; stepId: string; engagementId: string } | { ok: false; code: "not_permitted" | "gone" | "bad_input" }> {
  const ref = windowRefOf(input);
  if (!ref) return { ok: false, code: "bad_input" };
  const p = await permittedWindow(db, tenantId, ref);
  if (!p.ok) return p;
  const parsed = parseExtraction(answer);
  const base = { transcript_id: ref.transcript_id, from: ref.from, to: ref.to };
  if (!parsed.ok) {
    return { ok: true, stepId: ref.step_id, engagementId: ref.engagement_id, result: { ...base, kept: [], dropped: [{ key: "(answer)", reason: "the model's answer could not be read" }], summary: { goals: [], problems: [], commitments: [], open_questions: [] } } };
  }
  const checked = checkFacts(parsed.value, p.lines, { from: ref.from, to: ref.to });
  return { ok: true, stepId: ref.step_id, engagementId: ref.engagement_id, result: { ...base, kept: checked.kept, dropped: checked.dropped, summary: parsed.value.summary } };
}

// ---------------------------------------------------------------------------
// Finishing: merge, write, report
// ---------------------------------------------------------------------------

export type FinishDeps = { alert: (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string; telegramOncePerOpen?: boolean }) => Promise<unknown> };

/**
 * Write a finished run's facts to the draft profile. Idempotent on the step:
 * a step already done writes nothing again. Called by the Mac's last complete,
 * by the cloud tick, and by the tick's repair sweep.
 */
export async function finishExtraction(
  db: Client,
  input: { tenantId: string; stepId: string; results: WindowResult[]; failedWindows: number; now: Date; deps: FinishDeps },
): Promise<{ ok: true; written: number; contradictions: number; dropped: number } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const step = (await db.execute({ sql: "SELECT id, engagement_id, status FROM ai_audit_steps WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, input.stepId] })).rows[0];
  if (!step) return { ok: false, error: "not_found" };
  if (!["queued", "running", "waiting_runner"].includes(String(step.status))) return { ok: false, error: "already_finished" };
  const engagementId = String(step.engagement_id);
  const engagement = await getEngagement(db, t, engagementId);
  const at = input.now.toISOString();
  // CC authorized in the meantime: nothing more is written into the profile he froze.
  const closeStep = async () => {
    await db.execute({ sql: "UPDATE ai_audit_steps SET status = 'cancelled', error_code = 'stage_closed', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')", args: [at, at, t, input.stepId] });
    return { ok: false as const, error: "stage_closed" };
  };
  if (!engagement || !PROFILE_EDIT_STAGES.includes(engagement.stage)) return closeStep();
  const actor: Actor = { type: "system", id: null };
  // Gate 1 can land between that check and these writes. ensureDraftProfile
  // refuses a new draft after it, and the database refuses a field on a frozen
  // profile (bravo__237): either way the run ends as stage_closed, nothing written.
  let version: Awaited<ReturnType<typeof ensureDraftProfile>>["version"];
  try {
    ({ version } = await ensureDraftProfile(db, t, engagementId, actor, input.now));
  } catch (err) {
    if (err instanceof Error && /frozen/.test(err.message)) return closeStep();
    throw err;
  }
  const fields = await listProfileFields(db, t, version.id);
  const existing = new Map(fields.map((f) => [f.field_key, { value: f.value, source_type: f.source_type }]));
  const merged = mergeFacts(input.results.map((r) => r.kept), existing);
  const transcriptOf = new Map<KeptFact, string>();
  for (const r of input.results) for (const k of r.kept) transcriptOf.set(k, r.transcript_id);
  const dropped = input.results.flatMap((r) => r.dropped);
  const summary = mergeSummaries(input.results.map((r) => r.summary));
  const report = {
    at,
    step_id: input.stepId,
    written: merged.write.map((f) => f.key),
    already_known: merged.alreadyKnown,
    contradictions: merged.contradictions as Contradiction[],
    dropped: dropped.slice(0, 100),
    failed_windows: input.failedWindows,
    summary,
  };
  const stmts: InStatement[] = merged.write.map((f) => ({
    // Insert, or replace a value an earlier extraction wrote; never one CC or the call notes set.
    sql: `INSERT INTO ai_audit_profile_fields (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref, evidence_quote, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, 'client_reported', 'transcript', ?, ?, NULL, ?)
          ON CONFLICT (tenant_id, profile_version_id, field_key) DO UPDATE SET
            value_json = excluded.value_json, source_ref = excluded.source_ref, evidence_quote = excluded.evidence_quote, updated_at = excluded.updated_at
          WHERE ai_audit_profile_fields.source_type = 'transcript' AND ai_audit_profile_fields.owner_corrected = 0`,
    args: [newId(), t, version.id, f.key, JSON.stringify(f.value), JSON.stringify({ transcript_id: transcriptOf.get(f) ?? null, from: f.from, to: f.to }), f.quote.slice(0, 300), at],
  }));
  stmts.push(
    {
      sql: "UPDATE ai_audit_profile_versions SET summary = json_set(COALESCE(summary, '{}'), '$.extraction', json(?)), updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'",
      args: [JSON.stringify(report), at, t, version.id],
    },
    {
      sql: "UPDATE ai_audit_steps SET status = 'done', result_ref = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
      args: [JSON.stringify({ written: merged.write.length, contradictions: merged.contradictions.length, dropped: dropped.length, failed_windows: input.failedWindows }), at, at, t, input.stepId],
    },
    // The facts lived on the job rows only until now.
    { sql: "UPDATE tool_jobs SET result_json = '{\"stored\":true}' WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?", args: [t, MODEL_TOOL_KEY, input.stepId] },
    eventStatement({ tenantId: t, engagementId, event: "extraction_done", actor, at, refType: "step", refId: input.stepId, meta: { written: merged.write.length, contradictions: merged.contradictions.length, dropped: dropped.length, failed_windows: input.failedWindows } }),
  );
  try {
    await db.batch(stmts, "write");
  } catch (err) {
    if (err instanceof Error && /frozen/.test(err.message)) return closeStep();
    throw err;
  }
  // New facts change the profile: a pending Gate 1 card no longer shows it.
  const after = await getEngagement(db, t, engagementId);
  if (after && merged.write.length) await withdrawAuthorization(db, t, after, actor, input.now);
  await input.deps.alert({
    tenantId: t,
    alertType: "ai_audit_profile_drafted",
    severity: "info",
    title: `Profile drafted: ${engagement.business_name || "an AI audit"}`,
    body: `${merged.write.length} fact${merged.write.length === 1 ? "" : "s"} from the transcript${merged.contradictions.length ? `, ${merged.contradictions.length} that disagree for you to settle` : ""}${dropped.length ? `, ${dropped.length} not kept` : ""}${input.failedWindows ? `, ${input.failedWindows} part${input.failedWindows === 1 ? "" : "s"} of the call not read` : ""}. Check the profile, then ask for authorization.`,
    subjectType: "ai_audit_engagement",
    subjectId: engagementId,
  });
  return { ok: true, written: merged.write.length, contradictions: merged.contradictions.length, dropped: dropped.length };
}

/** For the Mac's path: when every window's job has finished, finish the run from the jobs' checked results. */
export async function finishMacExtractionIfComplete(db: Client, tenantId: string, stepId: string, now: Date, deps: FinishDeps): Promise<boolean> {
  const t = requireTenant(tenantId);
  const rs = await db.execute({
    sql: "SELECT status, result_json FROM tool_jobs WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?",
    args: [t, MODEL_TOOL_KEY, stepId],
  });
  if (!rs.rows.length) return false;
  if (rs.rows.some((r) => !["done", "failed", "cancelled"].includes(String(r.status)))) return false;
  const results: WindowResult[] = [];
  let failed = 0;
  for (const r of rs.rows) {
    if (String(r.status) !== "done") {
      failed += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(String(r.result_json ?? "{}")) as { window?: WindowResult };
      if (parsed.window) results.push(parsed.window);
    } catch {
      failed += 1;
    }
  }
  const out = await finishExtraction(db, { tenantId: t, stepId, results, failedWindows: failed, now, deps });
  return out.ok;
}

// ---------------------------------------------------------------------------
// The cloud path: the tick reads one window per call, in order
// ---------------------------------------------------------------------------

export type CloudDeps = FinishDeps & { model: (call: ToolModelCall) => Promise<ToolModelResult> };

export function defaultCloudModel(): CloudDeps["model"] {
  return (call) => runToolModelCall(call);
}

/**
 * Advance one cloud extraction run by up to `maxWindows` windows. Each window
 * is one metered model call on the workspace AI account (surface
 * ai_audit.extract). A failed call is retried on the next tick; after the
 * step's attempts it fails and CC is told. The checked results live on the
 * step row until the run finishes.
 */
export async function advanceCloudExtraction(db: Client, input: { tenantId: string; stepId: string; now: Date; deps: CloudDeps; maxWindows?: number }): Promise<"advanced" | "finished" | "failed" | "idle"> {
  const t = requireTenant(input.tenantId);
  const row = (await db.execute({ sql: "SELECT id, engagement_id, status, attempts, max_attempts, result_ref FROM ai_audit_steps WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, input.stepId] })).rows[0];
  if (!row || !["queued", "running"].includes(String(row.status))) return "idle";
  let ref: { windows: WindowRef[]; results: WindowResult[]; failed?: number };
  try {
    ref = JSON.parse(String(row.result_ref ?? "{}"));
  } catch {
    ref = { windows: [], results: [] };
  }
  const engagementId = String(row.engagement_id);
  for (let i = 0; i < (input.maxWindows ?? 1); i++) {
    const next = ref.windows[ref.results.length];
    if (!next) break;
    const jobInput = { step_id: input.stepId, engagement_id: engagementId, ...next };
    const built = await modelJobInput(db, { tenantId: t, input: jobInput });
    if (!built.ok) {
      await db.execute({ sql: "UPDATE ai_audit_steps SET status = 'cancelled', error_code = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", args: [built.code, input.now.toISOString(), input.now.toISOString(), t, input.stepId] });
      return "failed";
    }
    const answer = await input.deps.model({
      tenantId: t,
      userId: null,
      jobId: input.stepId,
      surface: "ai_audit.extract",
      system: String(built.input.system),
      prompt: String(built.input.prompt),
      maxTokens: MODEL_MAX_TOKENS,
    });
    if (!answer.ok) {
      const attempts = int(row.attempts) + 1;
      const giveUp = attempts >= int(row.max_attempts, 3) || answer.code === "ai_account_missing";
      const at = input.now.toISOString();
      await db.execute({
        sql: `UPDATE ai_audit_steps SET status = ?, attempts = ?, error_code = ?, next_attempt_at = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        args: [giveUp ? "failed" : "queued", attempts, answer.code.slice(0, 64), giveUp ? null : new Date(input.now.getTime() + [60_000, 300_000, 1_800_000][Math.min(attempts - 1, 2)]).toISOString(), giveUp ? at : null, at, t, input.stepId],
      });
      if (giveUp) {
        const e = await getEngagement(db, t, engagementId);
        await input.deps.alert({
          tenantId: t,
          alertType: "ai_audit_extraction_failed",
          severity: "warn",
          title: `Profile not drafted: ${e?.business_name || "an AI audit"}`,
          body: answer.code === "ai_account_missing" ? "The workspace has no cloud AI account. Draft it on the Mac instead, or fill the profile by hand." : `The cloud model failed (${answer.code}). Try again, draft it on the Mac, or fill the profile by hand.`,
          subjectType: "ai_audit_engagement",
          subjectId: engagementId,
        });
        return "failed";
      }
      return "advanced";
    }
    const checked = await checkWindowAnswer(db, t, jobInput, answer.text);
    if (!checked.ok) return "failed";
    ref.results.push(checked.result);
    await db.execute({ sql: "UPDATE ai_audit_steps SET status = 'running', result_ref = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", args: [JSON.stringify(ref), input.now.toISOString(), t, input.stepId] });
  }
  if (ref.results.length >= ref.windows.length) {
    const out = await finishExtraction(db, { tenantId: t, stepId: input.stepId, results: ref.results, failedWindows: 0, now: input.now, deps: input.deps });
    return out.ok ? "finished" : "failed";
  }
  return "advanced";
}

/** Cloud runs due now, and Mac runs whose every window is in but which were never finished (the tick's repair). */
export async function dueExtractions(db: Client, tenantId: string, now: Date): Promise<{ cloud: string[]; macToFinish: string[] }> {
  const t = requireTenant(tenantId);
  const at = now.toISOString();
  const cloud = await db.execute({
    sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND step_key = ? AND runs_on = 'cloud' AND status IN ('queued', 'running') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 3",
    args: [t, EXTRACT_STEP, at],
  });
  const mac = await db.execute({
    sql: `SELECT s.id FROM ai_audit_steps s WHERE s.tenant_id = ? AND s.step_key = ? AND s.runs_on = 'mac' AND s.status = 'waiting_runner'
            AND NOT EXISTS (SELECT 1 FROM tool_jobs j WHERE j.tenant_id = s.tenant_id AND j.tool_key = ? AND json_extract(j.input_json, '$.step_id') = s.id AND j.status NOT IN ('done', 'failed', 'cancelled'))
          LIMIT 5`,
    args: [t, EXTRACT_STEP, MODEL_TOOL_KEY],
  });
  return { cloud: cloud.rows.map((r) => String(r.id)), macToFinish: mac.rows.map((r) => String(r.id)) };
}

// ---------------------------------------------------------------------------
// Status, for the engagement page
// ---------------------------------------------------------------------------

export async function latestExtraction(db: Client, tenantId: string, engagementId: string): Promise<ExtractionStatus | null> {
  const t = requireTenant(tenantId);
  const s = (
    await db.execute({
      sql: "SELECT id, status, runs_on, result_ref, error_code, created_at, finished_at FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? ORDER BY created_at DESC LIMIT 1",
      args: [t, engagementId, EXTRACT_STEP],
    })
  ).rows[0];
  if (!s) return null;
  let windows = 0;
  let done = 0;
  let failed = 0;
  if (String(s.runs_on) === "mac") {
    const jobs = await db.execute({ sql: "SELECT status FROM tool_jobs WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?", args: [t, MODEL_TOOL_KEY, String(s.id)] });
    windows = jobs.rows.length;
    done = jobs.rows.filter((r) => String(r.status) === "done").length;
    failed = jobs.rows.filter((r) => ["failed", "cancelled"].includes(String(r.status))).length;
  } else {
    try {
      const ref = JSON.parse(String(s.result_ref ?? "{}")) as { windows?: unknown[]; results?: unknown[] };
      windows = Array.isArray(ref.windows) ? ref.windows.length : 0;
      done = Array.isArray(ref.results) ? ref.results.length : 0;
    } catch {
      windows = 0;
    }
  }
  return { step_id: String(s.id), status: String(s.status), runs_on: String(s.runs_on), windows, done, failed, created_at: String(s.created_at), finished_at: text(s.finished_at), error: text(s.error_code) };
}
