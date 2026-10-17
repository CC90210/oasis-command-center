/**
 * lib/meet/bodies.ts - what each Oasis Meet route accepts, checked strictly: an unknown key, a wrong type or an
 * out-of-range list is refused (null), never trimmed into shape. Pure, so the tests read every rule directly.
 */
import type { SessionDescription } from "./sfu";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** The longest SDP accepted: a browser's offer for three tracks is a few kilobytes. */
export const MAX_SDP_LENGTH = 32_000;
/** A track's name on its session: short and plain, so it can never smuggle anything into a URL or a log. */
export const TRACK_NAME = /^[a-z0-9_-]{1,40}$/;
/** A mid, as browsers number transceivers. */
const MID = /^[A-Za-z0-9_-]{1,16}$/;
/** The most tracks one pull or close names: everyone else's microphone, camera and screen. */
export const MAX_TRACKS_PER_CALL = 24;

function sdp(v: unknown, type: "offer" | "answer"): SessionDescription | null {
  if (!isRecord(v) || !onlyKeys(v, ["type", "sdp"]) || v.type !== type) return null;
  return typeof v.sdp === "string" && v.sdp.length > 0 && v.sdp.length <= MAX_SDP_LENGTH ? { type, sdp: v.sdp } : null;
}

function list<T>(v: unknown, min: number, max: number, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

export type CreateRoomBody = { title?: string; startsAt?: string | null; recordAudio?: boolean };

/** POST /api/calendar/meet: all optional. */
export function parseCreateRoom(v: unknown): CreateRoomBody | null {
  if (!isRecord(v) || !onlyKeys(v, ["title", "startsAt", "recordAudio"])) return null;
  if (v.title !== undefined && (typeof v.title !== "string" || v.title.length > 400)) return null;
  if (v.startsAt !== undefined && v.startsAt !== null && (typeof v.startsAt !== "string" || !Number.isFinite(Date.parse(v.startsAt)))) return null;
  if (v.recordAudio !== undefined && typeof v.recordAudio !== "boolean") return null;
  return v as CreateRoomBody;
}

export type JoinBody = { name?: string; consent?: boolean };

/** POST /api/meet/[code]/join: a name (a guest must give one) and the recording-notice tick. */
export function parseJoin(v: unknown): JoinBody | null {
  if (v === undefined) return {};
  if (!isRecord(v) || !onlyKeys(v, ["name", "consent"])) return null;
  if (v.name !== undefined && (typeof v.name !== "string" || v.name.length > 400)) return null;
  if (v.consent !== undefined && typeof v.consent !== "boolean") return null;
  return v as JoinBody;
}

export type SfuBody =
  | { action: "session" }
  | { action: "publish"; offer: SessionDescription; tracks: Array<{ mid: string; trackName: string; kind: "audio" | "video" }> }
  | { action: "pull"; tracks: Array<{ participantId: string; trackName: string }> }
  | { action: "renegotiate"; answer: SessionDescription }
  | { action: "close"; mids: string[]; offer?: SessionDescription };

/** POST /api/meet/[code]/sfu: one negotiation step on the caller's own SFU session. */
export function parseSfu(v: unknown): SfuBody | null {
  if (!isRecord(v)) return null;
  switch (v.action) {
    case "session":
      return onlyKeys(v, ["action"]) ? { action: "session" } : null;
    case "publish": {
      if (!onlyKeys(v, ["action", "offer", "tracks"])) return null;
      const offer = sdp(v.offer, "offer");
      const tracks = list(v.tracks, 1, 3, (t) =>
        isRecord(t) && onlyKeys(t, ["mid", "trackName", "kind"]) && typeof t.mid === "string" && MID.test(t.mid) &&
        typeof t.trackName === "string" && TRACK_NAME.test(t.trackName) && (t.kind === "audio" || t.kind === "video")
          ? { mid: t.mid, trackName: t.trackName, kind: t.kind as "audio" | "video" }
          : null,
      );
      if (!offer || !tracks || new Set(tracks.map((t) => t.trackName)).size !== tracks.length) return null;
      return { action: "publish", offer, tracks };
    }
    case "pull": {
      if (!onlyKeys(v, ["action", "tracks"])) return null;
      const tracks = list(v.tracks, 1, MAX_TRACKS_PER_CALL, (t) =>
        isRecord(t) && onlyKeys(t, ["participantId", "trackName"]) && typeof t.participantId === "string" &&
        t.participantId.length > 0 && t.participantId.length <= 64 && typeof t.trackName === "string" && TRACK_NAME.test(t.trackName)
          ? { participantId: t.participantId, trackName: t.trackName }
          : null,
      );
      return tracks ? { action: "pull", tracks } : null;
    }
    case "renegotiate": {
      if (!onlyKeys(v, ["action", "answer"])) return null;
      const answer = sdp(v.answer, "answer");
      return answer ? { action: "renegotiate", answer } : null;
    }
    case "close": {
      if (!onlyKeys(v, ["action", "mids", "offer"])) return null;
      const mids = list(v.mids, 1, MAX_TRACKS_PER_CALL, (m) => (typeof m === "string" && MID.test(m) ? m : null));
      if (!mids) return null;
      if (v.offer === undefined) return { action: "close", mids };
      const offer = sdp(v.offer, "offer");
      return offer ? { action: "close", mids, offer } : null;
    }
    default:
      return null;
  }
}

export type HostBody = { action: "remove"; participantId: string } | { action: "end" };

/** POST /api/meet/[code]/host: a host removes someone or ends the meeting. */
export function parseHost(v: unknown): HostBody | null {
  if (!isRecord(v)) return null;
  if (v.action === "end") return onlyKeys(v, ["action"]) ? { action: "end" } : null;
  if (v.action === "remove" && onlyKeys(v, ["action", "participantId"]) && typeof v.participantId === "string" && v.participantId.length > 0 && v.participantId.length <= 64) {
    return { action: "remove", participantId: v.participantId };
  }
  return null;
}
