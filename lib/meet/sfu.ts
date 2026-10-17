/**
 * lib/meet/sfu.ts - Oasis Meet's server-side client for Cloudflare Realtime (the SFU).
 *
 * The SFU forwards media; it knows nothing about who may see whom. Every call goes
 * through our room API, which checks the caller first (lib/meet/access.ts), so the
 * app secret never reaches a browser. Shapes follow Cloudflare's Connection API
 * (https://developers.cloudflare.com/realtime/sfu/api/, OpenAPI realtime-api-2024-05-21):
 *
 *   POST /apps/{appId}/sessions/new                         -> { sessionId }
 *   POST /apps/{appId}/sessions/{id}/tracks/new             publish: offer + local tracks -> answer
 *                                                            pull: remote tracks -> offer to answer
 *   PUT  /apps/{appId}/sessions/{id}/renegotiate            the browser's answer to the SFU's offer
 *   PUT  /apps/{appId}/sessions/{id}/tracks/close           { tracks: [{ mid }], force, sessionDescription? }
 *
 * A top-level errorCode (or a non-2xx answer) throws SfuError. Per-track errors come
 * back in the result for the caller to read: one bad track never hides the others.
 *
 * Config: CF_REALTIME_APP_ID and CF_REALTIME_APP_SECRET (Worker secrets). Missing ->
 * MeetNotConfiguredError, which the routes answer as 503.
 */
import "server-only";
import { MeetNotConfiguredError } from "./access";

export const SFU_BASE = "https://rtc.live.cloudflare.com/v1";
export const REALTIME_APP_ID_ENV = "CF_REALTIME_APP_ID";
export const REALTIME_APP_SECRET_ENV = "CF_REALTIME_APP_SECRET";
/** A call the SFU has not answered by now is reported, not waited on. */
const SFU_TIMEOUT_MS = 10_000;

export type SessionDescription = { type: "offer" | "answer"; sdp: string };

export type SfuTrackResult = {
  location?: "local" | "remote";
  mid?: string;
  trackName?: string;
  sessionId?: string;
  kind?: string;
  errorCode?: string;
  errorDescription?: string;
};

export type SfuTracksResult = {
  requiresImmediateRenegotiation: boolean;
  sessionDescription: SessionDescription | null;
  tracks: SfuTrackResult[];
};

export class SfuError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SfuError";
  }
}

export type SfuClient = {
  newSession(): Promise<string>;
  /** Publish the browser's local tracks: its offer and each transceiver's mid and track name; returns the SFU's answer. */
  publish(sessionId: string, offer: SessionDescription, tracks: Array<{ mid: string; trackName: string }>): Promise<SfuTracksResult>;
  /** Pull other participants' tracks into this session; the SFU answers with an offer for the browser to answer. */
  pull(sessionId: string, tracks: Array<{ sessionId: string; trackName: string }>): Promise<SfuTracksResult>;
  renegotiate(sessionId: string, answer: SessionDescription): Promise<void>;
  /** Close tracks on this session by mid. With an offer the close is negotiated; without, forced (no SDP). */
  close(sessionId: string, mids: string[], offer?: SessionDescription): Promise<{ sessionDescription: SessionDescription | null; tracks: SfuTrackResult[] }>;
  /** Every track on a session as the SFU holds it now: what it publishes and what it pulls. */
  sessionTracks(sessionId: string): Promise<Array<{ location?: string; mid?: string; trackName?: string; status?: string }>>;
};

/**
 * Cut a session off: every active track on it, sent and received, closed by force. Used when a participant is
 * removed or leaves and when a room ends, so a browser that ignores the room's answers still stops getting media.
 * Best effort: a failure is logged and the next step goes on (the participant's token is already dead).
 */
export async function cutSession(sfu: SfuClient, sessionId: string | null, where: string): Promise<number> {
  if (!sessionId) return 0;
  try {
    const mids = (await sfu.sessionTracks(sessionId)).filter((t) => t.status !== "inactive" && t.mid).map((t) => t.mid as string);
    if (mids.length) await sfu.close(sessionId, mids);
    return mids.length;
  } catch (err) {
    console.error(`[meet.${where}] could not close a session's tracks`, err instanceof SfuError ? `${err.code}: ${err.message}` : err);
    return 0;
  }
}

type Env = Record<string, string | undefined>;

function description(value: unknown): SessionDescription | null {
  const d = value as { type?: unknown; sdp?: unknown } | null | undefined;
  return d && (d.type === "offer" || d.type === "answer") && typeof d.sdp === "string" ? { type: d.type, sdp: d.sdp } : null;
}

function trackResults(value: unknown): SfuTrackResult[] {
  return Array.isArray(value) ? (value.filter((t) => t && typeof t === "object") as SfuTrackResult[]) : [];
}

/** The SFU client for this Worker's Realtime app. Throws MeetNotConfiguredError when the app is not set. */
export function sfuClient(env: Env = process.env, fetchImpl: typeof fetch = fetch): SfuClient {
  const appId = env[REALTIME_APP_ID_ENV];
  const secret = env[REALTIME_APP_SECRET_ENV];
  if (!appId || !secret) throw new MeetNotConfiguredError(`${REALTIME_APP_ID_ENV} and ${REALTIME_APP_SECRET_ENV} must both be set`);

  async function call(method: "POST" | "PUT" | "GET", path: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${SFU_BASE}/apps/${encodeURIComponent(appId!)}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(SFU_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SfuError("sfu_unreachable", err instanceof Error ? err.message : String(err));
    }
    let json: Record<string, unknown> = {};
    try {
      json = ((await res.json()) ?? {}) as Record<string, unknown>;
    } catch {
      // A body that is not JSON is reported by the status below.
    }
    if (typeof json.errorCode === "string" && json.errorCode) {
      throw new SfuError(json.errorCode, String(json.errorDescription ?? json.errorCode), res.status);
    }
    if (!res.ok) throw new SfuError(`sfu_http_${res.status}`, `the SFU answered ${res.status}`, res.status);
    return json;
  }

  const tracksResult = (json: Record<string, unknown>): SfuTracksResult => ({
    requiresImmediateRenegotiation: json.requiresImmediateRenegotiation === true,
    sessionDescription: description(json.sessionDescription),
    tracks: trackResults(json.tracks),
  });

  const session = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

  return {
    async newSession() {
      const json = await call("POST", "/sessions/new");
      if (typeof json.sessionId !== "string" || !json.sessionId) throw new SfuError("sfu_no_session", "the SFU returned no sessionId");
      return json.sessionId;
    },
    async publish(sessionId, offer, tracks) {
      const json = await call("POST", `${session(sessionId)}/tracks/new`, {
        sessionDescription: offer,
        tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })),
      });
      return tracksResult(json);
    },
    async pull(sessionId, tracks) {
      const json = await call("POST", `${session(sessionId)}/tracks/new`, {
        tracks: tracks.map((t) => ({ location: "remote", sessionId: t.sessionId, trackName: t.trackName })),
      });
      return tracksResult(json);
    },
    async renegotiate(sessionId, answer) {
      await call("PUT", `${session(sessionId)}/renegotiate`, { sessionDescription: answer });
    },
    async close(sessionId, mids, offer) {
      const json = await call("PUT", `${session(sessionId)}/tracks/close`, {
        tracks: mids.map((mid) => ({ mid })),
        force: !offer,
        ...(offer ? { sessionDescription: offer } : {}),
      });
      return { sessionDescription: description(json.sessionDescription), tracks: trackResults(json.tracks) };
    },
    async sessionTracks(sessionId) {
      const json = await call("GET", session(sessionId));
      return trackResults(json.tracks) as Array<{ location?: string; mid?: string; trackName?: string; status?: string }>;
    },
  };
}
