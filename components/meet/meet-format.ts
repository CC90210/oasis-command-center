/**
 * components/meet/meet-format.ts - the small pure helpers behind Oasis Meet's screens: names, tile layout, and
 * the Schedule panel's rows and error words. No React, nothing that reads the clock or the browser, so the
 * server's markup and the browser's first paint agree and tests/meet-ui.test.ts can run every rule directly.
 * ASCII only.
 */
import { meetErrorWords, type MeetTile } from "@/lib/meet/room-client";

/**
 * The longest name and title the server keeps. lib/meet/access.ts (MEET_NAME_MAX) and lib/meet/rooms.ts
 * (MEET_TITLE_MAX) are server-only, so the browser cannot import them; tests/meet-ui.test.ts holds these equal.
 */
export const NAME_MAX_CHARS = 60;
export const TITLE_MAX_CHARS = 120;

/** A name cut to NAME_MAX_CHARS whole characters, as the server counts them: an emoji at the edge is never halved. */
export function clampName(name: string): string {
  return Array.from(name).slice(0, NAME_MAX_CHARS).join("");
}

/** "Jane Doe" is "JD", "Cher" is "C", nothing is "?". Counts whole characters, so an emoji is never cut in two. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** Columns for n faces. Whole class names, so Tailwind finds them in this file. */
export function gridClasses(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 4) return "grid-cols-2";
  if (count <= 6) return "grid-cols-2 lg:grid-cols-3";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}

/**
 * What keeps every face on a wide window at once: the grid is no wider than 16:9 faces can be and still fit the
 * height under the title bar and above the controls. --cols and --rows say how many there are at each width, and
 * must agree with gridClasses (tests/meet-ui.test.ts holds them to it). Whole class names, so Tailwind finds them here.
 */
const FIT = "lg:max-w-[calc((100dvh-9.5rem)*1.7778*var(--cols)/var(--rows))]";
export function gridFit(count: number): string {
  if (count <= 1) return `[--cols:1] [--rows:1] ${FIT}`;
  if (count === 2) return `[--cols:1] [--rows:2] sm:[--cols:2] sm:[--rows:1] ${FIT}`;
  if (count <= 4) return `[--cols:2] [--rows:2] ${FIT}`;
  if (count <= 6) return `[--cols:2] [--rows:3] lg:[--cols:3] lg:[--rows:2] ${FIT}`;
  return `[--cols:2] [--rows:4] sm:[--cols:3] sm:[--rows:3] lg:[--cols:4] lg:[--rows:2] ${FIT}`;
}

/** Whose screen takes the stage: someone else's first, then the person's own. Null when nobody is sharing. */
export function sharerOf(tiles: MeetTile[]): MeetTile | null {
  return tiles.find((t) => t.sharing && !t.me && t.screen) ?? tiles.find((t) => t.sharing && t.screen) ?? null;
}

// The Schedule panel

export type MeetRoomStatus = "scheduled" | "live" | "ended";

/** One meeting as GET and POST /api/calendar/meet (lib/meet/handlers.ts) describe it. */
export type MeetRoomItem = {
  id: string;
  /** The dashed code, "abc-defg-hjk". */
  code: string;
  title: string;
  status: MeetRoomStatus;
  recordAudio: boolean;
  startsAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The path of the meeting link, "/meet/abc-defg-hjk". */
  link: string;
  /** The whole link from the app's canonical address (lib/api-helpers.ts publicAppBaseUrl). */
  url?: string;
  createdAt: string;
  mine: boolean;
  /** The lead who booked this meeting, when one did: it is theirs to cancel (from their page), not the host's to delete. */
  leadId: string | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const orNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The whole link the server sends: a plain http(s) address, never anything a link could run. */
const WHOLE_LINK = /^https?:\/\/[^\s"'<>]{1,300}$/i;

/** A lead's id as the server sends it (a UUID): letters, digits, hyphen and underscore. Anything else is not drawn into a link. */
const LEAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A meeting from the API, or null when it is not shaped like one: the panel then says it could not load rather than draw junk. */
export function parseRoomItem(v: unknown): MeetRoomItem | null {
  if (!isRecord(v)) return null;
  const { id, code, title, status, link, createdAt } = v;
  if (typeof id !== "string" || typeof code !== "string" || typeof title !== "string" || typeof link !== "string" || typeof createdAt !== "string") return null;
  if (status !== "scheduled" && status !== "live" && status !== "ended") return null;
  return {
    id, code, title, status, link, createdAt,
    ...(typeof v.url === "string" && WHOLE_LINK.test(v.url) ? { url: v.url } : {}),
    recordAudio: v.recordAudio === true,
    startsAt: orNull(v.startsAt),
    startedAt: orNull(v.startedAt),
    endedAt: orNull(v.endedAt),
    mine: v.mine === true,
    leadId: typeof v.leadId === "string" && LEAD_ID.test(v.leadId) ? v.leadId : null,
  };
}

/**
 * What POST /api/calendar/meet says about the host's Schedule, only when a time was given: the meeting was added,
 * or the link works but the Schedule would not take it, with the Schedule's own reason code ("shabbat_protected").
 * The words for a code are the Schedule's (components/calendar/useCalendarData.ts messageFor), so a refusal reads
 * the same there and here. They are passed to scheduleLine rather than imported, which keeps this file free of the
 * calendar (the room page shares it).
 */
export type ScheduleNote = { added: true } | { added: false; reason: string };

/** The longest code kept: it comes from our own server, but the screen does not trust its size. */
const REASON_MAX = 80;

export function parseScheduleNote(v: unknown): ScheduleNote | null {
  if (!isRecord(v)) return null;
  if (v.added === true) return { added: true };
  if (v.added === false && typeof v.reason === "string" && v.reason.trim()) return { added: false, reason: v.reason.trim().slice(0, REASON_MAX) };
  return null;
}

/** The meeting lengths the panel offers (the API takes 15 to 480 minutes). */
export const LENGTH_CHOICES: readonly number[] = [15, 30, 45, 60, 90, 120];

export function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minutes` : ""}`;
}

/**
 * The reason the server gives when the Schedule itself could not be reached (lib/meet/handlers.ts). By then the
 * meeting is made and its link works, so the Schedule's usual "try again" would make a second meeting.
 */
const SCHEDULE_UNREACHED = "schedule_unavailable";

/**
 * The quiet line under a link made for later. `wordsFor` is the Schedule's messageFor, used for every reason but one:
 * when the Schedule could not be reached the person is told to add the meeting there by hand, not to try again.
 */
export function scheduleLine(note: ScheduleNote, wordsFor: (reason: string) => string): string {
  if (note.added) return "Added to your Schedule.";
  const lead = "The link works, but it is not on your Schedule.";
  if (note.reason === SCHEDULE_UNREACHED) {
    return `${lead} The Schedule could not be reached. The meeting is already made, so add it to your Schedule yourself instead of making another.`;
  }
  return `${lead} ${wordsFor(note.reason)}`;
}

/**
 * GET /api/calendar/meet: the workspace's meetings, whether this workspace records at all, and whether video calls
 * can connect yet. Both flags are true only when the server says so; a missing or odd value is false, so the panel
 * never offers recording the server cannot do, and says so when the video service is not connected (`mediaReady`
 * false: the panel offers no new meeting until it is).
 */
export type MeetRoomList = { rooms: MeetRoomItem[]; recordingAvailable: boolean; mediaReady: boolean };

export function parseRoomList(v: unknown): MeetRoomList | null {
  if (!isRecord(v) || !Array.isArray(v.rooms)) return null;
  const rooms: MeetRoomItem[] = [];
  for (const item of v.rooms) {
    const room = parseRoomItem(item);
    if (!room) return null;
    rooms.push(room);
  }
  return { rooms, recordingAvailable: v.recordingAvailable === true, mediaReady: v.mediaReady === true };
}

/**
 * Does a meeting offer its transcript? Only a finished one that recorded, in a workspace where recording runs:
 * a meeting that never recorded has nothing to show, and where recording is not installed the transcript reads
 * would answer 503 for every meeting. This is the one gate: the Transcript button and the transcript itself both
 * ask it.
 */
export function showsTranscript(room: Pick<MeetRoomItem, "status" | "recordAudio">, recordingAvailable: boolean): boolean {
  return room.status === "ended" && room.recordAudio === true && recordingAvailable === true;
}

/**
 * Which transcript is open once the Transcript button on a meeting (by id) is pressed: that meeting's, or none if
 * it was the one already open. Only one is open at a time, so opening another closes the first.
 */
export function toggledTranscript(open: string | null, id: string): string | null {
  return open === id ? null : id;
}

/** The id of the box a meeting's transcript opens in: its Transcript button points at it, and the panel scrolls to it. */
export function transcriptBoxId(id: string): string {
  return `meet-transcript-${id}`;
}

/**
 * The ids of the two boxes that open below a button when a link is made: Start now's and Create link's. The panel
 * scrolls each into view when a new link is made, so the button does not seem to do nothing on a small phone.
 */
export const MADE_BOX_START = "meet-made-start";
export const MADE_BOX_LATER = "meet-made-later";

/**
 * Delete is offered only on a meeting the person made (the list's `mine`) that no lead booked: a booked meeting is the
 * booking's, and cancelling the booking (from the lead's page) is what deletes it. The server refuses it too (409).
 */
export function canDelete(room: Pick<MeetRoomItem, "mine" | "leadId">): boolean {
  return room.mine === true && !room.leadId;
}

/** What a meeting a lead booked says where Delete would be, and where it links: the lead's page in the pipeline. */
export const BOOKED_BY_LEAD = "Booked by a lead. Cancel it from their page.";
export function leadPagePath(leadId: string): string {
  return `/pipeline/${encodeURIComponent(leadId)}`;
}

/**
 * The list once one meeting is gone: its row leaves, and focus has somewhere to go (`focusId`): the row after it,
 * else the one before it, else nowhere (null, so the list's heading). An id that is not in the list changes nothing.
 */
export function withoutMeeting(rooms: MeetRoomItem[], id: string): { rooms: MeetRoomItem[]; focusId: string | null } {
  const at = rooms.findIndex((r) => r.id === id);
  if (at === -1) return { rooms, focusId: null };
  return { rooms: rooms.filter((r) => r.id !== id), focusId: (rooms[at + 1] ?? rooms[at - 1])?.id ?? null };
}

/** A formatter for "Sat, Oct 17, 4:05 PM" in a time zone (the viewer's own, once the page is in the browser). */
export function timeFormatter(zone?: string, locale?: string): (iso: string) => string {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
  } catch {
    // An unknown zone name: the browser's own zone is still right for the person looking.
    format = new Intl.DateTimeFormat(locale, options);
  }
  return (iso) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) ? format.format(at) : "";
  };
}

export const STATUS_WORDS: Record<MeetRoomStatus, string> = { scheduled: "Scheduled", live: "Live now", ended: "Ended" };

/** The one time worth showing for a meeting, in plain words. */
export function whenText(room: MeetRoomItem, format: (iso: string) => string): string {
  if (room.status === "live") return room.startedAt ? `Started ${format(room.startedAt)}` : "Happening now";
  if (room.status === "ended") {
    const at = room.endedAt ?? room.startedAt;
    return at ? `Ended ${format(at)}` : "Ended";
  }
  if (room.startsAt) return format(room.startsAt);
  return `Link made ${format(room.createdAt)}`;
}

// When a meeting made for a time starts, for the person about to join it

/**
 * How early the room opens for a meeting made for a time. lib/meet/participants.ts (MEET_EARLY_START_MIN) is server-only,
 * so the browser cannot import it; tests/meet-ui.test.ts holds the two equal. From then on the room is the call.
 */
export const EARLY_START_MIN = 10;

/**
 * The language the date and time are written in. The sentence around them is English, so they are too: the viewer's own
 * English if they use one (en-GB writes 14:00, en-US 2:00 PM), else en-US. Their time zone is never touched.
 */
export function englishLocaleOf(languages: readonly string[]): string {
  return languages.find((l) => /^en(-|$)/i.test(l)) ?? "en-US";
}

/**
 * "Your call starts at 2:00 PM." for a meeting made for a time, "Your call starts on Tuesday, October 20 at 2:00 PM." when
 * that is not today (the year too when it is not this one), in the viewer's time zone. Null when there is no time, and
 * once the room is open (the time has passed, or is within EARLY_START_MIN): the page then says only what it always says.
 * `now` comes from the caller, so this never reads the clock. It never throws either (it runs on a page anyone can open):
 * a `zone` the browser does not know falls back to its own, and a `locale` it does not know to its own.
 */
export function startsLine(startsAt: string | null, now: number, options: { zone?: string; locale?: string } = {}): string | null {
  if (!startsAt) return null;
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start) || now >= start - EARLY_START_MIN * 60_000) return null;
  const formatter = (shape: Intl.DateTimeFormatOptions) => {
    for (const [locale, timeZone] of [[options.locale, options.zone], [options.locale, undefined]] as const) {
      try {
        return new Intl.DateTimeFormat(locale, { ...shape, timeZone });
      } catch {
        // the zone, then the language, is one this browser does not know: try without it
      }
    }
    return new Intl.DateTimeFormat(undefined, shape);
  };
  const time = formatter({ hour: "numeric", minute: "2-digit" }).format(start);
  // A time that ends in its own period (en-CA writes "8:30 p.m.") closes the sentence: never "p.m..".
  const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);
  const day = formatter({ year: "numeric", month: "numeric", day: "numeric" });
  if (day.format(start) === day.format(now)) return sentence(`Your call starts at ${time}`);
  const year = formatter({ year: "numeric" });
  const shape: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", ...(year.format(start) === year.format(now) ? {} : { year: "numeric" }) };
  return sentence(`Your call starts on ${formatter(shape).format(start)} at ${time}`);
}

/** The absolute link people are sent: the page's own origin plus the meeting's path. */
export function meetingUrl(origin: string, link: string): string {
  return `${origin.replace(/\/+$/, "")}${link.startsWith("/") ? link : `/${link}`}`;
}

/**
 * The link to show and copy for a meeting: the server's whole one (`url`, from the app's canonical address) when
 * it sent one, else the page's own origin plus the path. Opening a tab never uses this: the host is signed in on
 * the page's own address, so that is where Join and Open go.
 */
export function linkToSend(origin: string, room: Pick<MeetRoomItem, "link" | "url">): string {
  return room.url ?? meetingUrl(origin, room.link);
}

/**
 * What the Schedule panel says when video calls cannot connect yet: the list said so (`mediaReady` false), or making a
 * meeting was refused with meet_not_configured. Said to the person who can fix it, so it names the step; the room
 * page says something shorter to a guest (lib/meet/room-client.ts meetErrorWords).
 */
export const MEDIA_NOT_READY = "Video calls are not switched on yet. They start working once the video service is connected, a one-time step for an owner.";

/** Plain words for what the Schedule panel's calls answered. Server text never reaches the screen. */
export function panelErrorWords(status: number, code: string | null): string {
  if (status === 401 || code === "sign_in_required") return "Sign in again, then try once more.";
  if (code === "invalid_body") return "That title or time was not accepted. Check it and try again.";
  if (code === "cross_origin_refused") return "This page could not reach the meeting service. Reload it and try again.";
  if (code === "meet_not_configured") return MEDIA_NOT_READY;
  return meetErrorWords(code ?? "unknown");
}

export const LIST_FAILED = "Your meetings could not load.";
export const NO_CONNECTION = "No connection. Check it and try again.";

// Deleting a meeting (POST /api/meet/<code>/host { action: "delete" })

const DELETE_RECORDED = "This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone.";
const DELETE_UNRECORDED = "This deletes the meeting, and its link stops working. It cannot be undone.";
const DELETE_LIVE = "The meeting is on now: this ends it for everyone in it. ";

/**
 * What the host reads before a meeting is deleted for good, said for the meeting in question: a recording and a
 * transcript go with it only if it recorded, and a meeting that is on now is ended for everyone in it.
 */
export function deleteConfirm(row: { recordAudio: boolean; status: MeetRoomStatus }): string {
  return (row.status === "live" ? DELETE_LIVE : "") + (row.recordAudio ? DELETE_RECORDED : DELETE_UNRECORDED);
}

export const ALREADY_DELETED = "This meeting was already deleted.";
export const DELETE_FAILED = "Couldn't delete the meeting. Try again.";
/** A stale panel (opened before a lead booked) asked to delete a booked meeting and the server said no. */
export const BOOKED_DELETE_REFUSED = "This meeting was booked by a lead. Cancel it from their page in the pipeline.";

/**
 * The line shown once a meeting is gone. The server deletes the recording's audio a batch at a time and says how
 * many copies are left; the page says so rather than claim it is all gone while some is still being removed.
 */
export function deletedNote(relayRemaining: number): string {
  return relayRemaining > 0
    ? "The meeting was deleted. Some of its audio is still being removed from the server."
    : "The meeting was deleted.";
}

/** Plain words for what a refused delete answered, by status and code. Server text never reaches the screen. */
export function deleteErrorWords(status: number, code: string | null): string {
  if (status === 401 || code === "sign_in_required") return panelErrorWords(401, null);
  if (code === "host_only") return "Only the host can delete this meeting.";
  if (code === "booked_meeting") return BOOKED_DELETE_REFUSED;
  if (code === "room_not_found") return ALREADY_DELETED;
  if (code === "cross_origin_refused") return panelErrorWords(403, code);
  if (status === 429 || code === "rate_limited") return meetErrorWords("rate_limited");
  return DELETE_FAILED;
}
