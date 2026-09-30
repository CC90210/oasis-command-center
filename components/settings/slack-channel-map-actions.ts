/**
 * components/settings/slack-channel-map-actions.ts - the two writes the Slack
 * channel map makes (map a channel, unmap one), as functions that NEVER throw.
 *
 * A request that cannot reach OASIS (offline, a dropped connection, a fetch
 * that rejects) comes back as a row note the owner reads, "Not saved: could
 * not reach OASIS", never as an unhandled rejection that only clears the busy
 * state and leaves the row saying nothing. Used by SlackChannelMap.
 */

export type SavedRoute = { department: string | null; customer_id: string | null };
export type MapWrite<T> = { ok: true; value: T } | { ok: false; text: string };

export const NOT_REACHED = "could not reach OASIS. Try again.";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const browserFetch: FetchLike = (input, init) => fetch(input, init);

async function send(label: string, url: string, init: RequestInit, fetchImpl: FetchLike): Promise<{ res: Response; body: Record<string, unknown> | null } | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    console.error(`[slack-channel-map.${label}]`, err instanceof Error ? err.message : String(err));
    return null;
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    // Not JSON (a proxy error page): the HTTP status is what the owner is told.
    console.error(`[slack-channel-map.${label}] the answer was not JSON`, { status: res.status, error: err instanceof Error ? err.message : String(err) });
  }
  return { res, body };
}

export async function saveChannelMapping(
  input: { channelId: string; department: string | null; customerId: string | null },
  fetchImpl: FetchLike = browserFetch,
): Promise<MapWrite<SavedRoute>> {
  const sent = await send(
    "save",
    "/api/slack/channels",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel_id: input.channelId, department: input.department, customer_id: input.customerId }),
    },
    fetchImpl,
  );
  if (!sent) return { ok: false, text: `Not saved: ${NOT_REACHED}` };
  const { res, body } = sent;
  if (!res.ok || body?.ok !== true) return { ok: false, text: String(body?.message ?? `Not saved (HTTP ${res.status}).`) };
  const route = (body.route && typeof body.route === "object" ? body.route : {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      department: typeof route.department === "string" ? route.department : null,
      customer_id: typeof route.customer_id === "string" ? route.customer_id : null,
    },
  };
}

export async function removeChannelMapping(channelId: string, fetchImpl: FetchLike = browserFetch): Promise<MapWrite<null>> {
  const sent = await send("remove", `/api/slack/channels?channel_id=${encodeURIComponent(channelId)}`, { method: "DELETE" }, fetchImpl);
  if (!sent) return { ok: false, text: `Not removed: ${NOT_REACHED}` };
  const { res, body } = sent;
  if (!res.ok || body?.ok !== true) return { ok: false, text: String(body?.message ?? `Not removed (HTTP ${res.status}).`) };
  return { ok: true, value: null };
}
