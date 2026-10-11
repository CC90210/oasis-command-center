/**
 * POST /api/os/runs/<id>/events - a producer writes one run's events.
 *
 * The producer is a paired computer's bridge, answering a department turn
 * itself (lib/os/runs/producer.ts has the wire format) -- either the legacy
 * push path's mid-reply handoff, or O4's pull dispatch (claimComputerRun sets
 * source='producer' in the SAME statement that claims the run, so both write
 * through this identical door). It authenticates with the RUN CREDENTIAL
 * (lib/os/runs/producer-auth.ts), not a session: an HMAC-signed grant for
 * this one run, short-lived. Middleware lets the exact path through without a
 * session (middleware.ts RUN_PRODUCER_ROUTE); everything else about who may
 * write is decided here, in this order, failing closed:
 *
 *   1. a signing key is configured (else 503: nothing could verify);
 *   2. no browser Origin (a page cannot be a producer);
 *   3. the credential's signature, audience and expiry hold;
 *   4. it names THIS run;
 *   5. the run exists, belongs to the workspace the credential names, and is a
 *      producer run (the Worker, or O4's claim, handed it over) that is still
 *      running;
 *   6. O4 ONLY (executor = 'computer'): its claimed_pairing_id is not
 *      revoked (disconnecting that computer must stop its run at once, not
 *      at the run's own deadline), and the run's person still holds a live
 *      seat (a removal mid-reply stops the reply);
 *   7. the body is within size and shape.
 * The workspace and the person are the RUN ROW's. The body is never asked.
 *
 * Idempotent: a seq already written is ignored, so a producer resends a batch
 * after any failure. The answer says whether the run is over (`finished`) and
 * whether the person pressed Stop (`cancel`).
 *
 * VAULT READ, ONLY WHEN THERE IS TEXT. An empty batch (events: []) is purely
 * a heartbeat (the producer contract: one at least every 25 s) and carries
 * nothing that could need redaction, so it skips the tenant-vault fetch
 * entirely. Before this, every batch -- even an empty one -- decrypted the
 * whole vault first.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { fetchTenantVaultSecretsForRedaction } from "@/lib/chat-persistence";
import { redactAll, redactTenantVaultSecrets, type VaultSecret } from "@/lib/secret-redaction";
import { departmentPrompt } from "@/lib/os/channel/identity";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { runSigningKey, verifyRunCredential } from "@/lib/os/runs/producer-auth";
import { MAX_BATCH_BYTES, ingestBatch, parseBatch } from "@/lib/os/runs/producer";
import { RunsUnavailableError, getRunForProducer } from "@/lib/os/runs/store";
import { liveSeat } from "@/lib/os/seat";
import { pairingBlocked } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await runSigningKey();
  if (!key) return json(503, { ok: false, error: "producer_not_configured" });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  if (req.headers.get("origin")) return json(403, { ok: false, error: "forbidden" });

  const auth = req.headers.get("authorization") ?? "";
  const presented = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!presented) return json(401, { ok: false, error: "unauthorized" });
  const checked = await verifyRunCredential(key, presented);
  if (!checked.ok) {
    console.error("[os.runs.events] credential refused", { runId: id, reason: checked.reason });
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (checked.claims.rid !== id) return json(401, { ok: false, error: "unauthorized" });

  // The body, read with a ceiling: a producer is trusted to run an app, not to be unbounded.
  const raw = await req.text();
  if (raw.length > MAX_BATCH_BYTES) return json(413, { ok: false, error: "batch_too_large" });
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }
  }
  const parsed = parseBatch(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });

  try {
    const db = getTursoClient();
    const run = await getRunForProducer(db, id);
    if (!run) return json(404, { ok: false, error: "run_not_found" });
    if (run.tenantId !== checked.claims.tid) {
      console.error("[os.runs.events] credential names another workspace", { runId: id });
      return json(403, { ok: false, error: "forbidden" });
    }
    if (run.source !== "producer") return json(409, { ok: false, error: "run_not_producer" });

    // O4: a computer-executor run's door closes the instant its claimed
    // computer is disconnected, or the person who sent it loses their seat --
    // neither is checked for the legacy push path's executor='worker' runs,
    // which carry no claimed_pairing_id to check.
    if (run.executor === "computer") {
      if (!run.claimedPairingId || (await pairingBlocked(run.claimedPairingId))) {
        return json(403, { ok: false, error: "forbidden" });
      }
      const seat = await liveSeat(run.tenantId, run.userId);
      if (!seat.live) return json(403, { ok: false, error: "forbidden" });
    }

    const label = OS_DEPARTMENTS.find((d) => d.key === run.department)?.label ?? "this";
    const hasEvents = parsed.events.length > 0;
    // COMPLETE or nothing (the rule the department turn follows, lib/os/desk/turn.ts): an entry that
    // cannot be read or decrypted fails the read, and the batch is refused rather than written
    // scrubbed of only some secrets. The producer resends it (idempotent by seq). Skipped entirely
    // for an empty (heartbeat-only) batch: there is no text to scrub.
    let vault: VaultSecret[] = [];
    if (hasEvents) {
      try {
        vault = await fetchTenantVaultSecretsForRedaction(run.tenantId, { requireComplete: true });
      } catch (err) {
        console.error("[os.runs.events] vault read failed; the batch was refused", { runId: id, error: err instanceof Error ? err.message : String(err) });
        return json(503, { ok: false, error: "scrub_unavailable" });
      }
    }
    const scrub = (t: string) => {
      if (!hasEvents) throw new Error("os.runs.events: scrub called on a heartbeat-only batch with no vault read");
      return redactTenantVaultSecrets(redactAll(t), vault);
    };
    const result = await ingestBatch(db, run, parsed.events, {
      showThinking: run.showThinking,
      scrub,
      scrubReasoning: (t) => departmentPrompt(scrub(t), label),
      now: new Date(),
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error("[os.runs.events]", { runId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: "events_failed" });
  }
}
