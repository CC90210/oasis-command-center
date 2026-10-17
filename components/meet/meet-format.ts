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
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const orNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A meeting from the API, or null when it is not shaped like one: the panel then says it could not load rather than draw junk. */
export function parseRoomItem(v: unknown): MeetRoomItem | null {
  if (!isRecord(v)) return null;
  const { id, code, title, status, link, createdAt } = v;
  if (typeof id !== "string" || typeof code !== "string" || typeof title !== "string" || typeof link !== "string" || typeof createdAt !== "string") return null;
  if (status !== "scheduled" && status !== "live" && status !== "ended") return null;
  return {
    id, code, title, status, link, createdAt,
    recordAudio: v.recordAudio === true,
    startsAt: orNull(v.startsAt),
    startedAt: orNull(v.startedAt),
    endedAt: orNull(v.endedAt),
    mine: v.mine === true,
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

/** The quiet line under a link made for later. `wordsFor` is the Schedule's messageFor. */
export function scheduleLine(note: ScheduleNote, wordsFor: (reason: string) => string): string {
  return note.added ? "Added to your Schedule." : `The link works, but it is not on your Schedule. ${wordsFor(note.reason)}`;
}

export function parseRoomList(v: unknown): MeetRoomItem[] | null {
  if (!isRecord(v) || !Array.isArray(v.rooms)) return null;
  const rooms: MeetRoomItem[] = [];
  for (const item of v.rooms) {
    const room = parseRoomItem(item);
    if (!room) return null;
    rooms.push(room);
  }
  return rooms;
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

/** The absolute link people are sent: the page's own origin plus the meeting's path. */
export function meetingUrl(origin: string, link: string): string {
  return `${origin.replace(/\/+$/, "")}${link.startsWith("/") ? link : `/${link}`}`;
}

/** Plain words for what the Schedule panel's calls answered. Server text never reaches the screen. */
export function panelErrorWords(status: number, code: string | null): string {
  if (status === 401 || code === "sign_in_required") return "Sign in again, then try once more.";
  if (code === "invalid_body") return "That title or time was not accepted. Check it and try again.";
  if (code === "cross_origin_refused") return "This page could not reach the meeting service. Reload it and try again.";
  return meetErrorWords(code ?? "unknown");
}

export const LIST_FAILED = "Your meetings could not load.";
export const NO_CONNECTION = "No connection. Check it and try again.";
