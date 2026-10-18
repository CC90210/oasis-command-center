/**
 * components/meet/meet-api.ts - the Schedule panel's calls: GET and POST /api/calendar/meet (list a workspace's
 * meetings, make one) and POST /api/meet/<code>/host { action: "delete" } (lib/meet/handlers.ts). Each answers
 * with the meeting(s) or with plain words for the screen; a network failure, a wrong status or a body that is not
 * shaped like a meeting all become words, never a thrown error or half-drawn data. The fetch comes in as an
 * argument so tests/meet-ui.test.ts can run every call without a server. No React. ASCII only.
 */
import {
  DELETE_FAILED,
  LIST_FAILED,
  NO_CONNECTION,
  deleteErrorWords,
  panelErrorWords,
  parseRoomItem,
  parseRoomList,
  parseScheduleNote,
  type MeetRoomItem,
  type MeetRoomList,
  type ScheduleNote,
} from "./meet-format";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; words: string };

const ENDPOINT = "/api/calendar/meet";

const browserFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * What POST /api/calendar/meet takes (lib/meet/bodies.ts parseCreateRoom): all optional. A time (`startsAt`)
 * sent with the browser's `timeZone` also puts the meeting on the host's Schedule; `minutes` (15 to 480) is its
 * length, and without it the host's default length is used.
 */
export type NewMeeting = { title?: string; startsAt?: string; recordAudio?: boolean; timeZone?: string; minutes?: number };

/**
 * Does this workspace record? What the list said ("available" is its `recordingAvailable: true`), or "unknown"
 * before the list has answered (it is loading, or failed and nothing has loaded yet).
 */
export type RecordingAvailability = "available" | "unavailable" | "unknown";

/**
 * What "Start a meeting now" sends. Where recording runs it sends nothing and the server's default (recorded)
 * stands. Where the list said it does not, it says recordAudio false (the server forces that too). Before the
 * list has answered it also sends nothing: the person has not been shown a choice, so the server decides, and
 * a meeting is never left unrecorded just because they clicked before the list loaded.
 */
export function startBody(availability: RecordingAvailability): NewMeeting {
  return availability === "unavailable" ? { recordAudio: false } : {};
}

/**
 * What "Create a link for later" sends. A time goes with the browser's time zone (that is what puts the meeting
 * on the Schedule) and a length if one was picked; without a time neither is sent. The recording choice follows
 * the list: the box's value where recording runs, false where it does not (the box is not drawn there), and
 * nothing at all before the list has answered. Never `recordAudio: true` unless the list said recording runs.
 */
export function laterBody(input: {
  title: string;
  startsAt?: string;
  timeZone?: string;
  minutes: string;
  record: boolean;
  availability: RecordingAvailability;
}): NewMeeting {
  const title = input.title.trim();
  return {
    ...(title ? { title } : {}),
    ...(input.startsAt ? { startsAt: input.startsAt } : {}),
    ...(input.startsAt && input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.startsAt && input.minutes ? { minutes: Number(input.minutes) } : {}),
    ...(input.availability === "unknown" ? {} : { recordAudio: input.availability === "available" && input.record }),
  };
}

/** A meeting just made, and what the Schedule said about it (null when no time was given, so it had nothing to say). */
export type MadeRoom = { room: MeetRoomItem; schedule: ScheduleNote | null };

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchImpl(url, { credentials: "same-origin", cache: "no-store", ...init });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // not JSON: the status below says what happened
    }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

function errorCode(json: unknown): string | null {
  return typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string"
    ? (json as { error: string }).error
    : null;
}

export async function listMeetings(fetchImpl: typeof fetch = browserFetch): Promise<ApiResult<MeetRoomList>> {
  const res = await send(fetchImpl, ENDPOINT, { method: "GET" });
  if (!res) return { ok: false, words: NO_CONNECTION };
  const list = res.status === 200 ? parseRoomList(res.json) : null;
  if (list) return { ok: true, value: list };
  return { ok: false, words: res.status === 401 ? panelErrorWords(401, null) : LIST_FAILED };
}

export async function createMeeting(body: NewMeeting, fetchImpl: typeof fetch = browserFetch): Promise<ApiResult<MadeRoom>> {
  const res = await send(fetchImpl, ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res) return { ok: false, words: NO_CONNECTION };
  const answer = res.status === 201 || res.status === 200 ? (res.json as { room?: unknown; schedule?: unknown } | null) : null;
  const room = parseRoomItem(answer?.room);
  if (room) return { ok: true, value: { room, schedule: parseScheduleNote(answer?.schedule) } };
  return { ok: false, words: panelErrorWords(res.status, errorCode(res.json)) };
}

/**
 * Deleted, with how many relay copies of its audio the server still has to remove; or why not. `gone` is true
 * when the server says there is no such meeting (404 room_not_found): it is not there any more, so the panel
 * takes its row out too, whoever deleted it.
 */
export type DeleteResult = { ok: true; relayRemaining: number } | { ok: false; words: string; gone: boolean };

/** Delete a meeting, its recording and its transcript (the host's, by its dashed code). */
export async function deleteMeeting(code: string, fetchImpl: typeof fetch = browserFetch): Promise<DeleteResult> {
  const res = await send(fetchImpl, `/api/meet/${encodeURIComponent(code)}/host`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete" }),
  });
  if (!res) return { ok: false, words: NO_CONNECTION, gone: false };
  const answer = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; deleted?: unknown; relayRemaining?: unknown }) : null;
  if (res.status === 200 && answer?.ok === true && answer.deleted === true) {
    const left = Number(answer.relayRemaining);
    return { ok: true, relayRemaining: Number.isFinite(left) && left > 0 ? Math.floor(left) : 0 };
  }
  const found = errorCode(res.json);
  // A 404 that is not the room API's own answer (a page from the platform, say) does not mean the meeting is gone.
  const gone = res.status === 404 && found === "room_not_found";
  return { ok: false, words: res.status === 200 ? DELETE_FAILED : deleteErrorWords(res.status, found), gone };
}
