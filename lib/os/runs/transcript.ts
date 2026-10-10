/**
 * lib/os/runs/transcript.ts - a saved conversation, as the channel renders it.
 *
 * One call returns the messages in order (the newest TRANSCRIPT_MAX_RUNS of a
 * longer conversation: it used to return the OLDEST 200, so a long chat lost
 * its latest messages) with, for each finished one, its activity trail (the
 * lookups it made, the error if it failed) and its answer.
 * A run still working has no trail here: the browser attaches to it with
 * GET /api/os/runs/<id>/stream and replays it from seq 0. Reasoning is never in
 * a transcript (it is dropped when a run ends).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { getConversation, listRuns, readTrails, type Conversation, type RunScope } from "./store";
import { isTerminalStatus, type RunEvent, type RunStatus } from "./types";

export type TranscriptRun = {
  id: string;
  seq: number;
  status: RunStatus;
  user_text: string;
  final_text: string | null;
  error_code: string | null;
  agent: Record<string, unknown> | null;
  events: RunEvent[];
  created_at: string;
  finished_at: string | null;
};

export type Transcript = { conversation: Conversation; runs: TranscriptRun[] };

/** The most messages a transcript shows: a longer conversation shows its newest ones. */
export const TRANSCRIPT_MAX_RUNS = 200;

export async function buildTranscript(db: Client, scope: RunScope, conversationId: string): Promise<Transcript | null> {
  const conversation = await getConversation(db, scope, conversationId);
  if (!conversation) return null;
  const runs = await listRuns(db, scope, conversationId, TRANSCRIPT_MAX_RUNS);
  // Only the trails of the runs shown: listRuns returns the newest, in order.
  const trails = runs.length > 0 ? await readTrails(db, scope, conversationId, { fromSeq: runs[0].seq }) : new Map<string, RunEvent[]>();
  return {
    conversation,
    runs: runs.map((r) => ({
      id: r.id,
      seq: r.seq,
      status: r.status,
      user_text: r.userText,
      final_text: r.finalText,
      error_code: r.errorCode,
      agent: r.agent,
      events: isTerminalStatus(r.status) ? (trails.get(r.id) ?? []) : [],
      created_at: r.createdAt,
      finished_at: r.finishedAt,
    })),
  };
}
