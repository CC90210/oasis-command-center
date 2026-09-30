/**
 * components/settings/slack-disconnect-action.ts - the Disconnect button's
 * request (SlackDisconnect.tsx), as a function that NEVER throws.
 *
 * A request that cannot reach OASIS (offline, a dropped connection, a fetch
 * that rejects) comes back as the sentence the owner reads, "Not disconnected:
 * could not reach OASIS", never as an unhandled rejection that only re-enables
 * the button and leaves the owner believing Slack was disconnected.
 */

export type DisconnectResult = { ok: true } | { ok: false; text: string };

export const DISCONNECT_NOT_REACHED = "Not disconnected: could not reach OASIS. Try again.";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const browserFetch: FetchLike = (input, init) => fetch(input, init);

export async function disconnectSlack(fetchImpl: FetchLike = browserFetch): Promise<DisconnectResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/connections/slack/disconnect", { method: "POST" });
  } catch (err) {
    console.error("[slack-disconnect]", err instanceof Error ? err.message : String(err));
    return { ok: false, text: DISCONNECT_NOT_REACHED };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    // Not JSON (a proxy error page): the HTTP status is what the owner is told.
    console.error("[slack-disconnect] the answer was not JSON", { status: res.status, error: err instanceof Error ? err.message : String(err) });
  }
  if (!res.ok || body?.ok !== true) return { ok: false, text: String(body?.message ?? `Not disconnected (HTTP ${res.status}).`) };
  return { ok: true };
}
