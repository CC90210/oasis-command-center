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
import { checkFacts, DEFAULT_HOSTS, extractionPrompt, mergeFacts, mergeSummaries, MODEL_MAX_TOKENS, parseExtraction, type Contradiction, type DroppedFact, type ExtractionSummary, type KeptFact, type PriorField } from "@/lib/ai-audit/extract";
import { renderLine, transcriptWindows, type TranscriptLine } from "@/lib/ai-audit/transcript";
import { getTranscript, listTranscripts } from "@/lib/ai-audit/transcripts";
import { ensureDraftProfile, listProfileFields } from "@/lib/ai-audit/versions";
import { aiConsent, withdrawAuthorization } from "@/lib/ai-audit/authorize";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, int, requireTenant, text, type Actor } from "@/lib/ai-audit/store";
import { inputHashOf } from "@/lib/tools/store";
import { runToolModelCall, type ToolModelCall, type ToolModelResult } from "@/lib/tools/worker/ai";

export const EXTRACT_STEP = "extract";
const IN_FLIGHT = ["queued", "running", "waiting_runner"] as const;
const inFlight = (status: unknown) => (IN_FLIGHT as readonly string[]).includes(String(status));
/** A Mac run nobody has picked up for this long is called off: the Mac is off, and nothing else may start meanwhile (review of phase 2b, M2). */
export const MAC_RUN_UNCLAIMED_MS = 24 * 3_600_000;
export const MODEL_TOOL_KEY = "ai_audit_model";
/** The CLI model the Mac uses for extraction. */
export const MAC_MODEL = "sonnet";

export type ExtractionEngine = "mac_claude" | "cloud_workspace";
export type WindowRef = { transcript_id: string; from: number; to: number };
export type WindowResult = WindowRef & { kept: KeptFact[]; dropped: DroppedFact[]; summary: ExtractionSummary; unreadable?: boolean };

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
  if (!all.length) return { ok: false, error: "no_transcript" };
  const fields = engagement.current_profile_version_id ? await listProfileFields(db, t, engagement.current_profile_version_id) : [];
  // Every active transcript must agree, as Gate 1 requires, and the profile's own answer must not say no
  // (review of phase 2b, M6: reading only the consenting ones let a mixed set through).
  if (!aiConsent(all, fields)) return { ok: false, error: "no_ai_consent" };
  const usable = all.filter((x) => (x.lines?.length ?? 0) > 0);
  if (!usable.length) return { ok: false, error: "no_transcript" };

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
  try {
    await db.batch(stmts, "write");
  } catch (err) {
    // Two presses at once: the one that lost the race hands back the run that won (review of phase 2b, E1).
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      const won = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') LIMIT 1", args: [t, engagement.id, EXTRACT_STEP] })).rows[0];
      if (won) return { ok: true, stepId: String(won.id), windows: windows.length, created: false };
    }
    throw err;
  }
  return { ok: true, stepId, windows: windows.length, created: true };
}

/**
 * The interviewer's names, for telling the client's words from the host's: the
 * workspace's owners (full and first name), and the usual labels ("CC", "host").
 */
export async function interviewerNames(db: Client, tenantId: string): Promise<ReadonlySet<string>> {
  const out = new Set(DEFAULT_HOSTS);
  try {
    const rs = await db.execute({ sql: "SELECT full_name FROM user_profiles WHERE tenant_id = ? AND is_owner = 1 AND deactivated_at IS NULL", args: [requireTenant(tenantId)] });
    for (const r of rs.rows) {
      const name = String(r.full_name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!name) continue;
      out.add(name);
      out.add(name.split(" ")[0]);
    }
  } catch (err) {
    console.error("[ai-audit.extraction] could not read the owners' names; using the usual labels", err instanceof Error ? err.message : String(err));
  }
  return out;
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
  // The profile's own consent answer is read again too, and every active transcript's: a "declined"
  // recorded, or a transcript without AI consent added, after the run began stops it (Codex review of phase 2b).
  const fields = engagement.current_profile_version_id ? await listProfileFields(db, tenantId, engagement.current_profile_version_id) : [];
  const all = await listTranscripts(db, tenantId, engagement.id);
  if (!aiConsent([transcript, ...all.filter((x) => x.id !== transcript.id)], fields)) return { ok: false, code: "not_permitted" };
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
  const base = { transcript_id: ref.transcript_id, from: ref.from, to: ref.to };
  const unreadable = (): WindowResult => ({ ...base, kept: [], dropped: [{ key: "(answer)", reason: "the model's answer could not be read" }], summary: { goals: [], problems: [], commitments: [], open_questions: [] }, unreadable: true });
  try {
    const parsed = parseExtraction(answer);
    if (!parsed.ok) return { ok: true, stepId: ref.step_id, engagementId: ref.engagement_id, result: unreadable() };
    const checked = checkFacts(parsed.value, p.lines, { from: ref.from, to: ref.to }, { hosts: await interviewerNames(db, tenantId) });
    const kept = checked.kept.map((k) => ({ ...k, transcript_id: ref.transcript_id }));
    return { ok: true, stepId: ref.step_id, engagementId: ref.engagement_id, result: { ...base, kept, dropped: checked.dropped, summary: parsed.value.summary } };
  } catch (err) {
    // Whatever the answer held, the run goes on (review of phase 2b, M3: a RangeError escaped the runner's complete).
    console.error("[ai-audit.extraction] checking an answer failed; the window counts as unreadable", err instanceof Error ? err.message : String(err));
    return { ok: true, stepId: ref.step_id, engagementId: ref.engagement_id, result: unreadable() };
  }
}

// ---------------------------------------------------------------------------
// Finishing: merge, write, report
// ---------------------------------------------------------------------------

export type FinishDeps = { alert: (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string; telegramOncePerOpen?: boolean }) => Promise<unknown> };

/** End a run without writing: the step is called off and every stored window result is cleared (review of phase 2b, H1). */
async function closeRun(db: Client, t: string, stepId: string, code: string, at: string): Promise<{ ok: false; error: string }> {
  await db.batch(closeRunStatements(t, stepId, code, at), "write");
  return { ok: false, error: code };
}
function closeRunStatements(t: string, stepId: string, code: string, at: string): InStatement[] {
  return [
    {
      sql: "UPDATE ai_audit_steps SET status = 'cancelled', error_code = ?, result_ref = NULL, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
      args: [code, at, at, t, stepId],
    },
    {
      // A window still out on the Mac stops too: its answer, if it comes, finds the lease gone and is never stored.
      sql: `UPDATE tool_jobs SET
              status = CASE WHEN status IN ('queued', 'claimed', 'running') THEN 'failed' ELSE status END,
              error_code = CASE WHEN status IN ('queued', 'claimed', 'running') THEN 'ai_audit_cancelled' ELSE error_code END,
              finished_at = CASE WHEN status IN ('queued', 'claimed', 'running') THEN ? ELSE finished_at END,
              result_json = CASE WHEN result_json IS NULL THEN NULL ELSE '{"stored":false}' END, updated_at = ?
            WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?`,
      args: [at, at, t, MODEL_TOOL_KEY, stepId],
    },
  ];
}

export type Finished = { ok: true; written: number; contradictions: number; dropped: number } | { ok: false; error: string };

/**
 * Write a finished run's facts to the draft profile, in ONE write transaction
 * that reads again everything the write depends on: the step is still running
 * (two finishers: one writes, one alert), the stage is still before Gate 1,
 * the draft is still a draft, and each window's transcript is still there with
 * the client's consent and the profile's consent not withdrawn (a delete or a
 * decline that lands first is seen; review of phase 2b, H1 and M4). Only a value
 * an earlier extraction wrote, untouched since, is replaced (H2). Called by the
 * Mac's last complete, by the cloud tick, and by the tick's repair sweep.
 */
export async function finishExtraction(
  db: Client,
  input: { tenantId: string; stepId: string; results: WindowResult[]; failedWindows: number; now: Date; deps: FinishDeps },
): Promise<Finished> {
  const t = requireTenant(input.tenantId);
  const step = (await db.execute({ sql: "SELECT id, engagement_id, status FROM ai_audit_steps WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, input.stepId] })).rows[0];
  if (!step) return { ok: false, error: "not_found" };
  if (!inFlight(step.status)) return { ok: false, error: "already_finished" };
  const engagementId = String(step.engagement_id);
  const engagement = await getEngagement(db, t, engagementId);
  const at = input.now.toISOString();
  if (!engagement || !PROFILE_EDIT_STAGES.includes(engagement.stage)) return closeRun(db, t, input.stepId, "stage_closed", at);
  const actor: Actor = { type: "system", id: null };
  let version: Awaited<ReturnType<typeof ensureDraftProfile>>["version"];
  try {
    ({ version } = await ensureDraftProfile(db, t, engagementId, actor, input.now));
  } catch (err) {
    if (err instanceof Error && /frozen/.test(err.message)) return closeRun(db, t, input.stepId, "stage_closed", at);
    throw err;
  }

  type Outcome = { kind: "closed"; code: string } | { kind: "already" } | { kind: "written"; written: string[]; contradictions: Contradiction[]; dropped: DroppedFact[]; read: number; notRead: number };
  let outcome: Outcome;
  const tx = await db.transaction("write");
  try {
    const s2 = (await tx.execute({ sql: "SELECT status FROM ai_audit_steps WHERE tenant_id = ? AND id = ?", args: [t, input.stepId] })).rows[0];
    const e2 = (await tx.execute({ sql: "SELECT stage FROM ai_audit_engagements WHERE tenant_id = ? AND id = ?", args: [t, engagementId] })).rows[0];
    const v2 = (await tx.execute({ sql: "SELECT status FROM ai_audit_profile_versions WHERE tenant_id = ? AND id = ?", args: [t, version.id] })).rows[0];
    if (!s2 || !inFlight(s2.status)) {
      outcome = { kind: "already" };
    } else if (!e2 || !(PROFILE_EDIT_STAGES as readonly string[]).includes(String(e2.stage)) || !v2 || String(v2.status) !== "draft") {
      for (const st of closeRunStatements(t, input.stepId, "stage_closed", at)) await tx.execute(st);
      outcome = { kind: "closed", code: "stage_closed" };
    } else {
      const fieldRows = (
        await tx.execute({ sql: "SELECT field_key, value_json, label, source_type, verified_note, owner_corrected FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ?", args: [t, version.id] })
      ).rows;
      const parse = (x: unknown) => {
        try {
          return JSON.parse(String(x ?? "null"));
        } catch {
          return null;
        }
      };
      const declined = fieldRows.some((r) => String(r.field_key) === "consent.ai_processing" && parse(r.value_json) === false);
      const tRows = (await tx.execute({ sql: "SELECT id, status, consent_ai FROM ai_audit_transcripts WHERE tenant_id = ? AND engagement_id = ?", args: [t, engagementId] })).rows;
      const active = tRows.filter((r) => String(r.status) === "active");
      const readable = new Set(active.filter((r) => Number(r.consent_ai) === 1).map((r) => String(r.id)));
      // Every active transcript must agree, as at the start and at Gate 1: one added without AI consent stops the
      // write (Codex review of phase 2b). A window whose transcript was deleted since it was read is not written either.
      const everyoneAgrees = active.every((r) => Number(r.consent_ai) === 1);
      const results = declined || !everyoneAgrees ? [] : input.results.filter((r) => readable.has(r.transcript_id));
      const usable = results.filter((r) => !r.unreadable);
      const notRead = input.failedWindows + (input.results.length - usable.length);
      const existing = new Map<string, PriorField>(
        fieldRows.map((r) => [
          String(r.field_key),
          { value: parse(r.value_json), source_type: String(r.source_type), label: String(r.label), verified_note: r.verified_note === null || r.verified_note === undefined ? null : String(r.verified_note), owner_corrected: Number(r.owner_corrected) === 1 },
        ]),
      );
      const merged = mergeFacts(usable.map((r) => r.kept), existing);
      const dropped = results.flatMap((r) => r.dropped);
      const written: string[] = [];
      for (const f of merged.write) {
        // Insert, or replace a value an earlier extraction wrote and nobody touched since; never one CC verified,
        // corrected or typed. RETURNING says which rows really changed, so the report counts only those.
        const rs = await tx.execute({
          sql: `INSERT INTO ai_audit_profile_fields (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref, evidence_quote, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, 'client_reported', 'transcript', ?, ?, NULL, ?)
                ON CONFLICT (tenant_id, profile_version_id, field_key) DO UPDATE SET
                  value_json = excluded.value_json, source_ref = excluded.source_ref, evidence_quote = excluded.evidence_quote, updated_at = excluded.updated_at
                WHERE ai_audit_profile_fields.source_type = 'transcript' AND ai_audit_profile_fields.owner_corrected = 0
                  AND ai_audit_profile_fields.label = 'client_reported' AND COALESCE(ai_audit_profile_fields.verified_note, '') = ''
                RETURNING field_key`,
          args: [
            newId(),
            t,
            version.id,
            f.key,
            JSON.stringify(f.value),
            JSON.stringify({
              transcript_id: f.transcript_id ?? null,
              from: f.from,
              to: f.to,
              speakers: f.speakers ?? [],
              // Every transcript a merged list or table drew on: deleting any of them takes the field out of the draft.
              transcript_ids: [...new Set([f.transcript_id ?? null, ...(f.sources ?? []).map((x) => x.transcript_id)].filter((x): x is string => !!x))],
              ...(f.sources && f.sources.length > 1 ? { sources: f.sources } : {}),
            }),
            f.quote.slice(0, 300),
            at,
          ],
        });
        if (rs.rows.length) written.push(f.key);
      }
      const summary = mergeSummaries(results.map((r) => r.summary));
      const report = {
        at,
        step_id: input.stepId,
        written,
        already_known: merged.alreadyKnown,
        contradictions: merged.contradictions,
        dropped: dropped.slice(0, 100),
        dropped_total: dropped.length,
        failed_windows: notRead,
        read_windows: usable.length,
        summary,
      };
      const nothingRead = usable.length === 0;
      for (const st of [
        { sql: "UPDATE ai_audit_profile_versions SET summary = json_set(COALESCE(summary, '{}'), '$.extraction', json(?)), updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'", args: [JSON.stringify(report), at, t, version.id] },
        {
          // The step keeps counts only; the facts lived on it and on the jobs until now.
          sql: "UPDATE ai_audit_steps SET status = ?, error_code = ?, result_ref = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
          args: [nothingRead ? "failed" : "done", nothingRead ? "nothing_read" : null, JSON.stringify({ written: written.length, contradictions: merged.contradictions.length, dropped: dropped.length, failed_windows: notRead }), at, at, t, input.stepId],
        },
        { sql: "UPDATE tool_jobs SET result_json = '{\"stored\":true}' WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?", args: [t, MODEL_TOOL_KEY, input.stepId] },
        eventStatement({ tenantId: t, engagementId, event: nothingRead ? "extraction_failed" : "extraction_done", actor, at, refType: "step", refId: input.stepId, meta: { written: written.length, contradictions: merged.contradictions.length, dropped: dropped.length, failed_windows: notRead } }),
      ]) {
        await tx.execute(st);
      }
      outcome = { kind: "written", written, contradictions: merged.contradictions, dropped, read: usable.length, notRead };
    }
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // The transaction is already gone; the original error is the one to report.
    }
    if (err instanceof Error && /frozen/.test(err.message)) return closeRun(db, t, input.stepId, "stage_closed", at);
    throw err;
  } finally {
    tx.close();
  }
  if (outcome.kind === "already") return { ok: false, error: "already_finished" };
  if (outcome.kind === "closed") return { ok: false, error: outcome.code };

  const { written, contradictions, dropped, read, notRead } = outcome;
  // New facts change the profile: a pending Gate 1 card no longer shows it.
  const after = await getEngagement(db, t, engagementId);
  if (after && written.length) await withdrawAuthorization(db, t, after, actor, input.now);
  const name = engagement.business_name || "an AI audit";
  if (!read) {
    await input.deps.alert({
      tenantId: t,
      alertType: "ai_audit_extraction_failed",
      severity: "warn",
      title: `Profile not drafted: ${name}`,
      body: `No part of the call could be read${notRead ? ` (${notRead} part${notRead === 1 ? "" : "s"} failed or were withdrawn)` : ""}. Try again, or fill the profile by hand.`,
      subjectType: "ai_audit_engagement",
      subjectId: engagementId,
    });
    return { ok: false, error: "nothing_read" };
  }
  await input.deps.alert({
    tenantId: t,
    alertType: "ai_audit_profile_drafted",
    severity: "info",
    title: `Profile drafted: ${name}`,
    body: `${written.length} fact${written.length === 1 ? "" : "s"} from the transcript${contradictions.length ? `, ${contradictions.length} that disagree for you to settle` : ""}${dropped.length ? `, ${dropped.length} not kept` : ""}${notRead ? `, ${notRead} part${notRead === 1 ? "" : "s"} of the call not read` : ""}. Check the profile, then ask for authorization.`,
    subjectType: "ai_audit_engagement",
    subjectId: engagementId,
  });
  return { ok: true, written: written.length, contradictions: contradictions.length, dropped: dropped.length };
}

/** Call off a run that is still going (CC's Cancel, or a Mac that never came). Nothing it read is written or kept. */
export async function cancelExtraction(db: Client, input: { tenantId: string; engagementId: string; actor: Actor; now: Date; reason?: string }): Promise<{ ok: true; stepId: string } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const step = (await db.execute({ sql: "SELECT id FROM ai_audit_steps WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner') ORDER BY created_at DESC LIMIT 1", args: [t, input.engagementId, EXTRACT_STEP] })).rows[0];
  if (!step) return { ok: false, error: "nothing_running" };
  const at = input.now.toISOString();
  await db.batch(
    [
      ...closeRunStatements(t, String(step.id), input.reason ?? "cancelled_by_owner", at),
      eventStatement({ tenantId: t, engagementId: input.engagementId, event: "extraction_cancelled", actor: input.actor, at, refType: "step", refId: String(step.id), meta: { reason: input.reason ?? "cancelled_by_owner" } }),
    ],
    "write",
  );
  return { ok: true, stepId: String(step.id) };
}

/** Mac runs no computer has picked up for a day: called off, and CC is told, so a new run (on the cloud, say) can start. */
export async function sweepStaleExtractions(db: Client, tenantId: string, now: Date, deps: FinishDeps): Promise<number> {
  const t = requireTenant(tenantId);
  const cutoff = new Date(now.getTime() - MAC_RUN_UNCLAIMED_MS).toISOString();
  const rs = await db.execute({
    sql: `SELECT s.id, s.engagement_id FROM ai_audit_steps s WHERE s.tenant_id = ? AND s.step_key = ? AND s.runs_on = 'mac' AND s.status = 'waiting_runner' AND s.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM tool_jobs j WHERE j.tenant_id = s.tenant_id AND j.tool_key = ? AND json_extract(j.input_json, '$.step_id') = s.id AND j.status <> 'queued')
          LIMIT 5`,
    args: [t, EXTRACT_STEP, cutoff, MODEL_TOOL_KEY],
  });
  let n = 0;
  for (const r of rs.rows) {
    const engagementId = String(r.engagement_id);
    const c = await cancelExtraction(db, { tenantId: t, engagementId, actor: { type: "system", id: null }, now, reason: "runner_offline" });
    if (!c.ok) continue;
    n += 1;
    const e = await getEngagement(db, t, engagementId);
    await deps.alert({
      tenantId: t,
      alertType: "ai_audit_extraction_failed",
      severity: "warn",
      title: `Profile not drafted: ${e?.business_name || "an AI audit"}`,
      body: "No Mac picked up the draft in a day, so it was called off. Turn the Mac on and draft again, or draft it on the cloud model.",
      subjectType: "ai_audit_engagement",
      subjectId: engagementId,
    });
  }
  return n;
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
      else failed += 1;
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
/** One cloud window's model call may wait this long. */
export const CLOUD_CALL_DEADLINE_MS = 55_000;

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
      await closeRun(db, t, input.stepId, built.code, input.now.toISOString());
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
      // The tick has a budget: one window may not take all of it (review of phase 2b, M3).
      deadlineMs: CLOUD_CALL_DEADLINE_MS,
    });
    if (!answer.ok) {
      const attempts = int(row.attempts) + 1;
      const giveUp = attempts >= int(row.max_attempts, 3) || answer.code === "ai_account_missing";
      const at = input.now.toISOString();
      await db.execute({
        sql: `UPDATE ai_audit_steps SET status = ?, attempts = ?, error_code = ?, next_attempt_at = ?, finished_at = ?, result_ref = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')`,
        args: [
          giveUp ? "failed" : "queued",
          attempts,
          answer.code.slice(0, 64),
          giveUp ? null : new Date(input.now.getTime() + [60_000, 300_000, 1_800_000][Math.min(attempts - 1, 2)]).toISOString(),
          giveUp ? at : null,
          // A run given up keeps nothing it read.
          giveUp ? null : JSON.stringify(ref),
          at,
          t,
          input.stepId,
        ],
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
    if (!checked.ok) {
      await closeRun(db, t, input.stepId, checked.code, input.now.toISOString());
      return "failed";
    }
    ref.results.push(checked.result);
    // Attempts count per window: a window that answered resets them (review of phase 2b, M3). A step that
    // finished or was called off meanwhile is not written over.
    const saved = await db.execute({
      sql: "UPDATE ai_audit_steps SET status = 'running', attempts = 0, result_ref = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')",
      args: [JSON.stringify(ref), input.now.toISOString(), t, input.stepId],
    });
    if (saved.rowsAffected !== 1) return "idle";
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
