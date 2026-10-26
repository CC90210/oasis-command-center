/**
 * lib/ai-audit/call-notes.ts — CC's notes during the discovery call, one per
 * framework question (lib/ai-audit/framework.ts), and the call's clock.
 *
 * Notes save as CC types (the live-call screen debounces). Each note carries
 * its own row_version: a save names the version it was typed over, and a
 * stale one answers "conflict" with the current text, so two open tabs never
 * silently overwrite each other. Notes are internal working material: the
 * audit never shows them. Gate 1 binds them (their hash is on the card), so a
 * note can change only before CC authorizes, and the write itself carries that
 * stage check. A credential typed into a note is scrubbed like a transcript's.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { newId } from "@/lib/ai-audit/hash";
import { DISCOVERY_QUESTIONS } from "@/lib/ai-audit/framework";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
import { contentHash } from "@/lib/ai-audit/hash";
import { scrubCredentials } from "@/lib/ai-audit/transcript";
import { casWrite, engagementUpdateStatement, eventStatement, getEngagement, int, requireTenant, text, type Actor, type Engagement } from "@/lib/ai-audit/store";

export const CALL_NOTE_MAX_CHARS = 4_000;

export type CallNote = { question_id: string; notes: string; row_version: number; updated_by: string | null; updated_at: string };

const QUESTION_IDS = new Set(DISCOVERY_QUESTIONS.map((q) => q.id));

export async function listCallNotes(db: Client, tenantId: string, engagementId: string): Promise<CallNote[]> {
  const rs = await db.execute({
    sql: "SELECT question_id, notes, row_version, updated_by, updated_at FROM ai_audit_call_notes WHERE tenant_id = ? AND engagement_id = ? ORDER BY question_id",
    args: [requireTenant(tenantId), engagementId],
  });
  return rs.rows.map((r) => ({ question_id: String(r.question_id), notes: String(r.notes ?? ""), row_version: int(r.row_version, 1), updated_by: text(r.updated_by), updated_at: String(r.updated_at) }));
}

export type SaveNoteResult =
  | { ok: true; note: CallNote }
  | { ok: false; error: "unknown_question" | "too_long" | "not_found" | "stage_closed" }
  | { ok: false; error: "conflict"; current: CallNote };

/**
 * Save one question's notes. `expectedVersion` is the row_version the text was
 * typed over (0 for a note that did not exist yet).
 */
/** One hash over every non-empty note, for Gate 1 to bind (null when there are none). */
export function notesHash(notes: ReadonlyArray<Pick<CallNote, "question_id" | "notes">>): string | null {
  const rows = notes
    .filter((n) => n.notes.trim())
    .map((n) => [n.question_id, n.notes] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows.length ? contentHash(rows) : null;
}

/** The SQL condition "the engagement is still before Gate 1", with its arguments. */
function stillEditable(t: string, engagementId: string): { sql: string; args: string[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM ai_audit_engagements WHERE tenant_id = ? AND id = ? AND stage IN (${PROFILE_EDIT_STAGES.map(() => "?").join(", ")}))`,
    args: [t, engagementId, ...PROFILE_EDIT_STAGES],
  };
}

/**
 * Save one question's notes over `expectedVersion`. `afterText` is the text of
 * a save this same screen sent just before, still unanswered: the note may be
 * at expectedVersion + 1 holding exactly that text, and this save may go on
 * top of it (the live-call screen's keepalive save as the page closes; review
 * of phase 2, F5). Saving the text the note already holds is never a conflict.
 */
export async function saveCallNote(
  db: Client,
  input: { tenantId: string; engagementId: string; questionId: string; notes: string; expectedVersion: number; afterText?: string | null; actor: Actor; now: Date },
): Promise<SaveNoteResult> {
  const t = requireTenant(input.tenantId);
  if (!QUESTION_IDS.has(input.questionId)) return { ok: false, error: "unknown_question" };
  if (input.notes.length > CALL_NOTE_MAX_CHARS) return { ok: false, error: "too_long" };
  // A password typed into a note goes the way a transcript's does (review of phase 2, F2).
  const notes = scrubCredentials(input.notes.replace(/\r\n/g, "\n")).text;
  const after = typeof input.afterText === "string" ? scrubCredentials(input.afterText.replace(/\r\n/g, "\n")).text : null;
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (!PROFILE_EDIT_STAGES.includes(engagement.stage)) return { ok: false, error: "stage_closed" };
  const at = input.now.toISOString();
  const before = (await listCallNotes(db, t, engagement.id)).find((n) => n.question_id === input.questionId) ?? null;
  // Every write carries "still before Gate 1" itself: Gate 1 freezes in one
  // write, so a note lands before it (the card no longer matches) or not at all (review of phase 2, F3).
  const open = stillEditable(t, engagement.id);
  const update = (expected: number, alsoAfter: string | null) =>
    db.execute({
      sql: `UPDATE ai_audit_call_notes SET notes = ?, row_version = row_version + 1, updated_by = ?, updated_at = ?
            WHERE tenant_id = ? AND engagement_id = ? AND question_id = ?
              AND (row_version = ?${alsoAfter !== null ? " OR (row_version = ? AND notes = ?)" : ""}) AND ${open.sql}`,
      args: [notes, input.actor.id, at, t, engagement.id, input.questionId, expected, ...(alsoAfter !== null ? [expected + 1, alsoAfter] : []), ...open.args],
    });
  let r =
    input.expectedVersion === 0
      ? await db.execute({
          sql: `INSERT INTO ai_audit_call_notes (id, tenant_id, engagement_id, question_id, notes, row_version, updated_by, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${open.sql}
                ON CONFLICT (tenant_id, engagement_id, question_id) DO NOTHING`,
          args: [newId(), t, engagement.id, input.questionId, notes, input.actor.id, at, at, ...open.args],
        })
      : await update(input.expectedVersion, after);
  if (r.rowsAffected !== 1 && input.expectedVersion === 0 && after !== null) r = await update(0, after);
  const current = (await listCallNotes(db, t, engagement.id)).find((n) => n.question_id === input.questionId);
  if (r.rowsAffected !== 1) {
    const now_ = await getEngagement(db, t, engagement.id);
    if (!now_ || !PROFILE_EDIT_STAGES.includes(now_.stage)) return { ok: false, error: now_ ? "stage_closed" : "not_found" };
    // Saving the text the note already holds loses nothing, whatever version was
    // expected: a repeat of the same save (the live-call screen's keepalive flush
    // beside its save loop, components/ai-audit/call/note-saver.ts) is a success.
    if (current && current.notes === notes) return { ok: true, note: current };
    if (current) return { ok: false, error: "conflict", current };
    return { ok: false, error: "not_found" };
  }
  if (!current) throw new Error("ai-audit.call-notes: saved a note but cannot read it back");
  // The audit trail: one line per note per ten minutes of typing, not one per keystroke pause.
  if (current.notes !== (before?.notes ?? "") && (!before || input.now.getTime() - Date.parse(before.updated_at) > NOTE_EVENT_GAP_MS)) {
    await db.execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "call_note_saved", actor: input.actor, at, refType: "call_note", refId: input.questionId, meta: { row_version: current.row_version, chars: current.notes.length } }),
    );
  }
  return { ok: true, note: current };
}

/** Note saves within this gap of the last one leave no new line in the audit trail. */
export const NOTE_EVENT_GAP_MS = 10 * 60_000;

/**
 * Start or end the call's clock (the live-call screen's elapsed time). Neither
 * moves the engagement's stage: the call counts as held once a transcript
 * arrives or CC moves it on.
 */
export async function markCall(
  db: Client,
  input: { tenantId: string; engagementId: string; what: "start" | "end"; actor: Actor; now: Date },
): Promise<{ ok: true; engagement: Engagement } | { ok: false; error: "not_found" | "stage_closed" | "conflict" | "not_started" }> {
  const t = requireTenant(input.tenantId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await getEngagement(db, t, input.engagementId);
    if (!e) return { ok: false, error: "not_found" };
    if (!PROFILE_EDIT_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
    if (input.what === "end" && !e.call_started_at) return { ok: false, error: "not_started" };
    const at = input.now.toISOString();
    const patch = input.what === "start" ? { call_started_at: at, call_ended_at: null } : { call_ended_at: at };
    const ok = await casWrite(db, engagementUpdateStatement(t, e.id, e.row_version, patch, at), [
      eventStatement({ tenantId: t, engagementId: e.id, event: input.what === "start" ? "call_started" : "call_ended", actor: input.actor, at }),
    ]);
    if (ok) {
      const after = await getEngagement(db, t, e.id);
      return after ? { ok: true, engagement: after } : { ok: false, error: "not_found" };
    }
  }
  return { ok: false, error: "conflict" };
}
