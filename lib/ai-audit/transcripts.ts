/**
 * lib/ai-audit/transcripts.ts — storing a discovery call's transcript.
 *
 * A transcript arrives parsed and already scrubbed of credentials
 * (lib/ai-audit/transcript.ts). Storing it records the client's consent with
 * it: a transcript exists only for a call the client agreed to record, and its
 * `consent_ai` says whether the client also agreed to AI analysis. Extraction
 * refuses a transcript without that second yes.
 *
 * A transcript can be added only before CC authorizes the audit (Gate 1):
 * adding one afterwards would change what he authorized. Adding the first
 * transcript to an engagement still before its call moves it to Discovery Call
 * Completed, since the call has evidently happened.
 *
 * Deleting wipes the lines, the file name and the speakers' names, and keeps
 * the row and its hash (the database refuses anything else, bravo__239), so a
 * profile that cited it still names the text it came from. Deleting one after
 * Gate 1 voids the authorization: what CC authorized no longer exists.
 */
import "server-only";
import type { Client, Row } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { casWrite, deliveryInFlight, eventStatement, getEngagement, int, noDeliveryInFlight, patchEngagement, requireTenant, text, type Actor } from "@/lib/ai-audit/store";
import { TRANSCRIPT_FORMATS, isOneOfFormat, type ParsedTranscript, type TranscriptFormat, type TranscriptLine } from "@/lib/ai-audit/transcript";
import { AUTHORIZATION_VOIDED_REASONS, PROFILE_EDIT_STAGES, TERMINAL_STAGES, type AiAuditStage } from "@/lib/ai-audit/rules";
import { cancelPendingApproval } from "@/lib/os/approvals/store";

export const TRANSCRIPT_SOURCES = ["paste", "upload", "meet"] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];
/** Who said the client agreed: the workspace owner, another founder (named on Gate 1's card), or every Meet guest on joining (phase 2c). */
export const CONSENT_BASES = ["owner_attested", "founder_attested", "meet_guests"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

/** At most this many live transcripts per engagement (Gate 1's card binds up to 50; a call rarely needs more than one). */
export const MAX_TRANSCRIPTS = 20;

/** Stages where a transcript may still be added: up to and including Transcript Awaiting Approval (the profile's edit stages). */
export const TRANSCRIPT_OPEN_STAGES: readonly AiAuditStage[] = PROFILE_EDIT_STAGES;
const BEFORE_CALL: readonly AiAuditStage[] = ["new_lead", "pre_call_research", "call_scheduled"];

export type Transcript = {
  id: string;
  engagement_id: string;
  source: TranscriptSource;
  format: TranscriptFormat;
  filename: string | null;
  meet_room_id: string | null;
  line_count: number;
  char_count: number;
  speakers: string[];
  text_sha256: string;
  redactions: number;
  consent_recording: boolean;
  consent_ai: boolean;
  consent_basis: ConsentBasis;
  consent_by: string | null;
  consent_at: string;
  status: "active" | "deleted";
  created_by: string | null;
  created_at: string;
  deleted_at: string | null;
  /** Present only when read with lines. */
  lines?: TranscriptLine[];
};

const COLUMNS =
  "id, engagement_id, source, format, filename, meet_room_id, line_count, char_count, speakers_json, text_sha256, redactions, " +
  "consent_recording, consent_ai, consent_basis, consent_by, consent_at, status, created_by, created_at, deleted_at";

function parseLines(v: unknown): TranscriptLine[] {
  if (typeof v !== "string") return [];
  try {
    const rows = JSON.parse(v) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is TranscriptLine => !!r && typeof r === "object" && typeof (r as TranscriptLine).n === "number" && typeof (r as TranscriptLine).text === "string");
  } catch {
    return [];
  }
}

function mapTranscript(r: Row, withLines: boolean): Transcript {
  let speakers: string[] = [];
  try {
    const s = JSON.parse(String(r.speakers_json ?? "[]")) as unknown;
    if (Array.isArray(s)) speakers = s.filter((x): x is string => typeof x === "string");
  } catch {
    speakers = [];
  }
  const source = String(r.source);
  const format = String(r.format);
  const basis = String(r.consent_basis);
  return {
    id: String(r.id),
    engagement_id: String(r.engagement_id),
    source: (TRANSCRIPT_SOURCES as readonly string[]).includes(source) ? (source as TranscriptSource) : "paste",
    format: isOneOfFormat(format) ? format : "txt",
    filename: text(r.filename),
    meet_room_id: text(r.meet_room_id),
    line_count: int(r.line_count),
    char_count: int(r.char_count),
    speakers,
    text_sha256: String(r.text_sha256),
    redactions: int(r.redactions),
    consent_recording: int(r.consent_recording) === 1,
    consent_ai: int(r.consent_ai) === 1,
    consent_basis: (CONSENT_BASES as readonly string[]).includes(basis) ? (basis as ConsentBasis) : "owner_attested",
    consent_by: text(r.consent_by),
    consent_at: String(r.consent_at),
    status: String(r.status) === "deleted" ? "deleted" : "active",
    created_by: text(r.created_by),
    created_at: String(r.created_at),
    deleted_at: text(r.deleted_at),
    ...(withLines ? { lines: parseLines(r.lines_json) } : {}),
  };
}

/** The hash a transcript is known by: its stored lines, in order. */
export function linesHash(lines: readonly TranscriptLine[]): string {
  return contentHash(lines.map((l) => [l.n, l.t, l.speaker, l.text]));
}

/**
 * One hash over every active transcript of an engagement, for Gate 1 to bind:
 * each one's id, text and consent (who attested it, and to what). Deleting and
 * re-adding the same text with other consent is a different set.
 */
export function transcriptsHash(rows: ReadonlyArray<Pick<Transcript, "id" | "text_sha256" | "status" | "consent_recording" | "consent_ai" | "consent_basis" | "consent_by">>): string | null {
  const active = rows
    .filter((r) => r.status === "active")
    .map((r) => [r.id, r.text_sha256, r.consent_recording, r.consent_ai, r.consent_basis, r.consent_by ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return active.length ? contentHash(active) : null;
}

export async function listTranscripts(db: Client, tenantId: string, engagementId: string, opts: { withLines?: boolean; includeDeleted?: boolean } = {}): Promise<Transcript[]> {
  const t = requireTenant(tenantId);
  const cols = opts.withLines ? `${COLUMNS}, lines_json` : COLUMNS;
  const rs = await db.execute({
    sql: `SELECT ${cols} FROM ai_audit_transcripts WHERE tenant_id = ? AND engagement_id = ?${opts.includeDeleted ? "" : " AND status = 'active'"} ORDER BY created_at, id`,
    args: [t, engagementId],
  });
  return rs.rows.map((r) => mapTranscript(r, !!opts.withLines));
}

export async function getTranscript(db: Client, tenantId: string, id: string, withLines = true): Promise<Transcript | null> {
  const cols = withLines ? `${COLUMNS}, lines_json` : COLUMNS;
  const rs = await db.execute({ sql: `SELECT ${cols} FROM ai_audit_transcripts WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [requireTenant(tenantId), id] });
  return rs.rows[0] ? mapTranscript(rs.rows[0], withLines) : null;
}

export type AddTranscriptResult =
  | { ok: true; transcript: Transcript; duplicate: boolean }
  | { ok: false; error: "not_found" | "stage_closed" | "no_recording_consent" | "conflict" | "too_many_transcripts" };

/**
 * Store a parsed transcript with its consent. The same text twice on one
 * engagement is the same transcript (returned, duplicate: true).
 */
export async function addTranscript(
  db: Client,
  input: {
    tenantId: string;
    engagementId: string;
    parsed: ParsedTranscript;
    source: TranscriptSource;
    filename?: string | null;
    meetRoomId?: string | null;
    consent: { recording: boolean; ai: boolean; basis: ConsentBasis; by: string | null; at?: string };
    actor: Actor;
    now: Date;
  },
): Promise<AddTranscriptResult> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (!TRANSCRIPT_OPEN_STAGES.includes(engagement.stage)) return { ok: false, error: "stage_closed" };
  if (!input.consent.recording) return { ok: false, error: "no_recording_consent" };
  if (!TRANSCRIPT_FORMATS.includes(input.parsed.format)) throw new Error("ai-audit.transcripts: unknown format");

  const hash = linesHash(input.parsed.lines);
  const id = newId();
  const at = input.now.toISOString();
  const consentAt = input.consent.at ?? at;
  const byHash = `SELECT ${COLUMNS} FROM ai_audit_transcripts WHERE tenant_id = ? AND engagement_id = ? AND text_sha256 = ? AND status = 'active' LIMIT 1`;
  // The stage check, the cap and the insert in ONE write transaction. Gate 1's
  // freeze is one write too, so a transcript lands before it (the card's hash
  // no longer matches, nothing is frozen) or is refused after it: never in
  // between (review of phase 2, F3).
  const tx = await db.transaction("write");
  try {
    const stage = String((await tx.execute({ sql: "SELECT stage FROM ai_audit_engagements WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, engagement.id] })).rows[0]?.stage ?? "");
    if (!(TRANSCRIPT_OPEN_STAGES as readonly string[]).includes(stage)) {
      await tx.rollback();
      return { ok: false, error: "stage_closed" };
    }
    const existing = (await tx.execute({ sql: byHash, args: [t, engagement.id, hash] })).rows[0];
    if (existing) {
      await tx.rollback();
      return { ok: true, transcript: mapTranscript(existing, false), duplicate: true };
    }
    const live = int((await tx.execute({ sql: "SELECT COUNT(1) AS n FROM ai_audit_transcripts WHERE tenant_id = ? AND engagement_id = ? AND status = 'active'", args: [t, engagement.id] })).rows[0]?.n);
    if (live >= MAX_TRANSCRIPTS) {
      await tx.rollback();
      return { ok: false, error: "too_many_transcripts" };
    }
    await tx.batch([
      {
        sql: `INSERT INTO ai_audit_transcripts (id, tenant_id, engagement_id, source, format, filename, meet_room_id, lines_json, line_count, char_count,
                speakers_json, text_sha256, redactions, consent_recording, consent_ai, consent_basis, consent_by, consent_at, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [
          id, t, engagement.id, input.source, input.parsed.format, input.filename?.slice(0, 200) ?? null, input.meetRoomId ?? null,
          JSON.stringify(input.parsed.lines), input.parsed.lines.length, input.parsed.chars, JSON.stringify(input.parsed.speakers.slice(0, 20)),
          hash, input.parsed.redactions, input.consent.ai ? 1 : 0, input.consent.basis, input.consent.by, consentAt, input.actor.id, at,
        ],
      },
      eventStatement({
        tenantId: t,
        engagementId: engagement.id,
        event: "transcript_added",
        actor: input.actor,
        at,
        refType: "transcript",
        refId: id,
        meta: { source: input.source, format: input.parsed.format, lines: input.parsed.lines.length, redactions: input.parsed.redactions, consent_ai: input.consent.ai, consent_basis: input.consent.basis },
      }),
    ]);
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Already gone; the error below decides.
    }
    // Lost a race with the same text (unique index): answer with the winner.
    const again = (await db.execute({ sql: byHash, args: [t, engagement.id, hash] })).rows[0];
    if (again) return { ok: true, transcript: mapTranscript(again, false), duplicate: true };
    throw err;
  } finally {
    tx.close();
  }
  if (BEFORE_CALL.includes(engagement.stage)) {
    // The call has happened. A lost race here only means someone moved it first.
    await advanceEngagement(db, { tenantId: t, engagementId: engagement.id, to: "call_completed", actor: input.actor, now: input.now, event: "call_completed_by_transcript" });
  }
  const stored = await getTranscript(db, t, id, false);
  if (!stored) throw new Error("ai-audit.transcripts: stored a transcript but cannot read it back");
  return { ok: true, transcript: stored, duplicate: false };
}

/**
 * Wipe a transcript's lines, its file name and speakers' names, and the short
 * quotes any profile took from it. Allowed at any stage: a client may ask for
 * it at any time (the route lets only the workspace owner do it). The quotes
 * go on frozen profiles too (the one change bravo__237 lets a frozen field
 * take); the values, labels and line numbers stay, so what was authorized is
 * still on record. After Gate 1 the authorization no longer holds
 * (authorizedProfile compares the transcripts), and the trail says so.
 */
export async function deleteTranscript(
  db: Client,
  input: { tenantId: string; engagementId: string; id: string; actor: Actor; now: Date },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "delivery_in_progress" }> {
  const t = requireTenant(input.tenantId);
  const at = input.now.toISOString();
  const engagement = await getEngagement(db, t, input.engagementId);
  // Not while the audit email is going out: the send already checked the authorization this voids.
  const guard = noDeliveryInFlight(t, input.engagementId, input.now);
  const afterGate = !!engagement && !PROFILE_EDIT_STAGES.includes(engagement.stage) && !TERMINAL_STAGES.includes(engagement.stage) && !!engagement.authorization_approval_id;
  const ok = await casWrite(
    db,
    {
      sql: `UPDATE ai_audit_transcripts SET status = 'deleted', lines_json = '[]', filename = NULL, speakers_json = '[]', deleted_at = ?, deleted_by = ?
             WHERE tenant_id = ? AND engagement_id = ? AND id = ? AND status = 'active' AND ${guard.sql}`,
      args: [at, input.actor.id, t, input.engagementId, input.id, ...guard.args],
    },
    [
      {
        sql: `UPDATE ai_audit_profile_fields SET evidence_quote = NULL
               WHERE tenant_id = ? AND evidence_quote IS NOT NULL AND json_extract(source_ref, '$.transcript_id') = ?`,
        args: [t, input.id],
      },
      eventStatement({ tenantId: t, engagementId: input.engagementId, event: "transcript_deleted", actor: input.actor, at, refType: "transcript", refId: input.id }),
      ...(afterGate
        ? [eventStatement({ tenantId: t, engagementId: input.engagementId, event: "authorization_voided", actor: input.actor, at, refType: "transcript", refId: input.id, meta: { reason: "transcript_deleted" } })]
        : []),
    ],
  );
  // The audit was built on what this transcript said: a final approval still
  // waiting must not go out on an authorization that no longer holds (the
  // executor refuses it too; this takes the card out of Needs you).
  if (ok && afterGate && engagement?.delivery_approval_id) {
    await cancelPendingApproval(db, t, engagement.delivery_approval_id, { type: input.actor.type === "user" ? "user" : "system", id: input.actor.id }, { reason: "authorization_voided" }, input.now);
  }
  if (ok && afterGate) {
    // The page says so as well as the trail (review of phase 2, second pass). A lost race only means someone else wrote first.
    const now = await getEngagement(db, t, input.engagementId);
    if (now) {
      await patchEngagement(db, {
        tenantId: t,
        id: now.id,
        expectedRowVersion: now.row_version,
        patch: { health: "attention", health_reason: AUTHORIZATION_VOIDED_REASONS.transcriptDeleted },
        event: "authorization_voided_flagged",
        actor: input.actor,
        now: input.now,
      });
    }
  }
  if (!ok && (await deliveryInFlight(db, t, input.engagementId, input.now))) return { ok: false, error: "delivery_in_progress" };
  return ok ? { ok: true } : { ok: false, error: "not_found" };
}
