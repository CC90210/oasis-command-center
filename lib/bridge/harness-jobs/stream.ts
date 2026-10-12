import "server-only";
import type { HarnessJob } from "./types";
import { cancelHarnessJob, readHarnessEvents, readHarnessJob } from "./store";

const enc = new TextEncoder();
const POLL_MS = 300;
const PING_MS = 10_000;

function frame(event: string, data: Record<string, unknown>): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Follow one exact-pairing harness job while preserving the ChatWidget's
 * existing SSE vocabulary. The database is the handoff between Vercel and a
 * laptop that only makes outbound requests; no inbound laptop URL exists. */
export function harnessJobStream(job: HarnessJob): ReadableStream<Uint8Array> {
  let stopped = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let after = 0;
        let lastPing = Date.now();
        let terminalFrameSeen = false;
        controller.enqueue(frame("agent_status", { phase: "queued", agent: job.agentKey }));
        try {
          while (!stopped) {
            const events = await readHarnessEvents({ tenantId: job.tenantId, jobId: job.id, after });
            for (const event of events) {
              after = Math.max(after, event.seq);
              if (event.type === "done") terminalFrameSeen = true;
              controller.enqueue(frame(event.type, event.data));
            }
            const current = await readHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id });
            if (!current) {
              controller.enqueue(frame("error", { code: "harness_job_missing", message: "The coding task could not be found." }));
              controller.enqueue(frame("done", {}));
              controller.close();
              return;
            }
            if (["completed", "failed", "cancelled"].includes(current.status)) {
              if (!terminalFrameSeen) {
                if (current.status !== "completed") {
                  controller.enqueue(frame("error", {
                    code: current.errorCode || "harness_failed",
                    message: current.request.fallback_policy === "workspace_api"
                      ? "The selected computer could not answer. Workspace API fallback is enabled, but coding-harness fallback is not supported yet; no API credits were spent."
                      : current.errorCode === "computer_not_answering"
                        ? "The selected computer did not pick up this coding task. Open AI brain to repair that computer."
                        : "The selected computer could not finish this coding task.",
                  }));
                }
                controller.enqueue(frame("done", {}));
              }
              controller.close();
              return;
            }
            if (Date.now() - lastPing >= PING_MS) {
              controller.enqueue(enc.encode(": ping\n\n"));
              lastPing = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          }
        } catch (error) {
          console.error("[bridge.harness.stream]", error instanceof Error ? (error.stack ?? error.message) : String(error));
          if (!stopped) {
            controller.enqueue(frame("error", { code: "harness_stream_failed", message: "The coding task stream was interrupted." }));
            controller.enqueue(frame("done", {}));
            controller.close();
          }
        }
      })();
    },
    async cancel() {
      stopped = true;
      try {
        await cancelHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id });
      } catch (error) {
        console.error("[bridge.harness.cancel]", error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    },
  });
}

/** Keep the response streaming while an exact computer gets the first chance
 * to claim. Only a terminal, never-claimed `computer_not_answering` job may
 * switch to the explicitly saved workspace-API fallback. Once a connector has
 * a lease, its result (including failure) is authoritative: API fallback could
 * otherwise repeat file/tool side effects after a partial device run. */
export function harnessJobStreamWithUnclaimedFallback(
  job: HarnessJob,
  input: {
    deviceStream: () => ReadableStream<Uint8Array>;
    fallbackResponse: () => Promise<Response>;
  },
): ReadableStream<Uint8Array> {
  let stopped = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  async function relay(body: ReadableStream<Uint8Array>, controller: ReadableStreamDefaultController<Uint8Array>) {
    activeReader = body.getReader();
    while (!stopped) {
      const next = await activeReader.read();
      if (next.done) break;
      controller.enqueue(next.value);
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let lastPing = Date.now();
        controller.enqueue(frame("agent_status", { phase: "queued", agent: job.agentKey }));
        try {
          while (!stopped) {
            const current = await readHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id });
            if (!current) {
              controller.enqueue(frame("error", { code: "harness_job_missing", message: "The coding task could not be found." }));
              controller.enqueue(frame("done", {}));
              controller.close();
              return;
            }
            const wasClaimed = Boolean(current.claimId && current.leaseId && current.claimedAt);
            if (current.status !== "queued") {
              if (
                !wasClaimed &&
                current.status === "failed" &&
                current.errorCode === "computer_not_answering" &&
                current.request.fallback_policy === "workspace_api"
              ) {
                const response = await input.fallbackResponse();
                if (!response.ok || !response.body) {
                  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
                  controller.enqueue(frame("error", {
                    code: typeof payload?.code === "string" ? payload.code : "workspace_api_fallback_unavailable",
                    message: typeof payload?.error === "string"
                      ? payload.error
                      : "The selected computer did not answer and the workspace API fallback could not start.",
                  }));
                  controller.enqueue(frame("done", {}));
                } else {
                  await relay(response.body, controller);
                }
                controller.close();
                return;
              }
              await relay(input.deviceStream(), controller);
              controller.close();
              return;
            }
            if (Date.now() - lastPing >= PING_MS) {
              controller.enqueue(enc.encode(": ping\n\n"));
              lastPing = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          }
        } catch (error) {
          console.error("[bridge.harness.fallback-stream]", error instanceof Error ? (error.stack ?? error.message) : String(error));
          if (!stopped) {
            controller.enqueue(frame("error", { code: "harness_stream_failed", message: "The selected runtime stream was interrupted." }));
            controller.enqueue(frame("done", {}));
            controller.close();
          }
        }
      })();
    },
    async cancel() {
      stopped = true;
      await activeReader?.cancel().catch(() => undefined);
      try {
        await cancelHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id });
      } catch (error) {
        console.error("[bridge.harness.fallback-cancel]", error instanceof Error ? error.message : String(error));
      }
    },
  });
}
