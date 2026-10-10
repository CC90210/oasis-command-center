/**
 * lib/os/runs/keepalive.ts - ask the platform to keep a run's driver alive
 * after the browser's connection is gone.
 *
 * ON CLOUDFLARE WORKERS (how this app runs, via OpenNext) a request keeps its
 * Worker alive as long as the client stays connected. When the client
 * disconnects, the request is cancelled except for what was handed to
 * ctx.waitUntil, which gets a grace period of about 30 seconds. So:
 *
 *   - the driver is started inside the request that carries the message, and
 *     that response stays open while the driver works: a person who moves to
 *     another page of the app keeps that connection (the browser's run store
 *     holds it, components/agents/run-store.ts), and the run is not limited;
 *   - a person who closes the tab or reloads loses the connection, and the run
 *     gets the grace period from here. A short turn finishes; a longer one is
 *     marked interrupted by the next reader (./store.ts reapStale), with its
 *     partial answer kept.
 *
 * Lifting the grace limit takes a Cloudflare Queue consumer (15 minutes) or a
 * Durable Object alarm, which need a binding the account does not have yet. The
 * Slack mention job already has this shape (lib/slack/jobs.ts: queue when the
 * binding exists, waitUntil/after otherwise); a run would use it the same way.
 * Not wired, on purpose: see the PR.
 */
import "server-only";
import { after } from "next/server";

export type KeepAlive = "waitUntil" | "after" | "detached";

let noContextLogged = false;

/**
 * Register `work` with the platform and return how. Never throws; `work`'s own
 * failure is logged here so a rejected driver is never an unhandled rejection.
 */
export async function keepAlive(work: Promise<unknown>, label: string): Promise<KeepAlive> {
  const guarded = work.then(
    () => undefined,
    (err: unknown) => {
      console.error("[os.runs.keepalive]", { label, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    },
  );
  try {
    const mod = await import("@opennextjs/cloudflare");
    mod.getCloudflareContext().ctx.waitUntil(guarded);
    return "waitUntil";
  } catch (err) {
    if (!noContextLogged) {
      noContextLogged = true;
      console.warn("[os.runs.keepalive] no Cloudflare context; using after()", err instanceof Error ? err.message : String(err));
    }
  }
  try {
    after(() => guarded);
    return "after";
  } catch {
    // Not inside a request (a test, a script): the promise simply runs on.
    return "detached";
  }
}
