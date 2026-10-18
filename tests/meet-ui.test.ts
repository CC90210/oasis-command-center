/**
 * tests/meet-ui.test.ts - Oasis Meet's screens as a person sees them: the room page's loader, the pre-join
 * screen, the call, the ending screens, and the Schedule's Meet panel (components/meet/*, app/meet/[code]/*).
 *
 * Pins:
 *   (a) a visitor in a recorded room reads the recording notice and ticks it BEFORE anything asks for their
 *       camera or microphone (Quebec Law 25, notice before collection): the notice and a required, unticked box
 *       come first, and the pre-join markup holds no camera step, preview or device list until it is ticked.
 *       The browser itself is never asked while the gate is shut (openDevices run against a counting stand-in).
 *   (b) a host sees no tick;
 *   (c) the Schedule panel draws its three sections and its loading, error and empty states in plain words,
 *       and says whether a link made for a time is on the Schedule;
 *   (d) every ending screen says the right words for why the person is out;
 *   and the loader (not found, redirect to the dashed address, ended, who is looking), the call's controls,
 *   the Recording indicator, 44 px touch targets, no confirm()/alert()/prompt(), no <Link> out of a page that
 *   has no app shell, and ASCII only.
 *
 * The screens render in a child process (tests/meet-ui.render.ts) because react-dom/server does not load
 * under --conditions=react-server. Run: node --conditions=react-server --import tsx tests/meet-ui.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createClient } from "@libsql/client";
import ts from "typescript";
import { loadMeetPage, meetCreatorFor, meetViewerFor, sessionOrVisitor } from "../app/meet/[code]/load";
import { NOT_WAITING, createDeviceRequests, deviceWords, listInputs, openDevices, problemOf, waitingWords, type DeviceAnswer } from "../components/meet/devices";
import { messageFor } from "../components/calendar/useCalendarData";
import { createMeeting, deleteMeeting, laterBody, listMeetings, startBody } from "../components/meet/meet-api";
import {
  ALREADY_DELETED,
  BOOKED_BY_LEAD,
  BOOKED_DELETE_REFUSED,
  DELETE_FAILED,
  EARLY_START_MIN,
  LENGTH_CHOICES,
  MADE_BOX_LATER,
  MADE_BOX_START,
  MEDIA_NOT_READY,
  NAME_MAX_CHARS,
  NO_CONNECTION,
  STATUS_WORDS,
  TITLE_MAX_CHARS,
  canDelete,
  clampName,
  deleteConfirm,
  deleteErrorWords,
  deletedNote,
  englishLocaleOf,
  gridClasses,
  gridFit,
  initialsOf,
  leadPagePath,
  lengthWords,
  linkToSend,
  meetingUrl,
  panelErrorWords,
  parseRoomItem,
  parseRoomList,
  parseScheduleNote,
  scheduleLine,
  sharerOf,
  showsTranscript,
  startsLine,
  timeFormatter,
  toggledTranscript,
  transcriptBoxId,
  whenText,
  withoutMeeting,
  type MeetRoomItem,
} from "../components/meet/meet-format";
import { CONSENT_LABEL, DEVICES_BUTTON, ENDED_WORDS, JOIN_HERE, RECORDING_NOTICE, TICK_FIRST, WAITING_FOR_HOST } from "../components/meet/meet-words";
import { mayAskForDevices, needsRecordingNotice, preJoinNeeds } from "../components/meet/notice";
import { MEET_NAME_MAX } from "../lib/meet/access";
import { MEET_EARLY_START_MIN, endMeetRoom } from "../lib/meet/participants";
import { MEET_TITLE_MAX, createMeetRoom, displayMeetCode } from "../lib/meet/rooms";
import { meetErrorWords, type MeetTile } from "../lib/meet/room-client";
import { FULL_BLEED_PREFIXES, isFullBleedPath } from "../lib/os/full-bleed";
import { isPublic } from "../middleware";

const root = join(__dirname, "..");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/**
 * The server-rendered screens (tests/meet-ui.render.ts). With `loaded` (room props the page's own loader made), draws
 * only those rooms, under `loaded.<name>`: the loader's answer and the real room, with nothing set by hand between.
 */
function renderMarkup(loaded?: Record<string, object>): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/meet-ui.render.ts"], {
    cwd: root,
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step; react-dom/server refuses to load under it.
    env: { ...process.env, NODE_OPTIONS: "", ...(loaded ? { MEET_RENDER_LOADED_ROOMS: JSON.stringify(loaded) } : {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { markup: Record<string, string> }).markup;
}

const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const buttonNames = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));
const NARROW_SPACES = new RegExp(`[${String.fromCharCode(0x202f)}${String.fromCharCode(0xa0)}]`, "g");

// -- files this change owns, for the source checks -------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
/** What ships to the browser and the Worker. */
const shippedFiles = [...sourceFiles(join(root, "components", "meet")), ...sourceFiles(join(root, "app", "meet"))];
/** Everything this change wrote. */
const ownFiles = [...shippedFiles, join(root, "tests", "meet-ui.test.ts"), join(root, "tests", "meet-ui.render.ts")];
const rel = (file: string) => relative(root, file).split(sep).join("/");

// -- stand-ins for the Schedule panel's calls ---------------------------------------------------------------------------

function fakeFetch(answer: { status?: number; json?: unknown; raw?: string; throws?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (answer.throws) throw new TypeError("network down");
    return new Response(answer.raw ?? JSON.stringify(answer.json ?? null), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/** One meeting as GET and POST /api/calendar/meet answer it. */
const roomJson = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  code: "aaa-bbbb-ccc",
  title: "Discovery call",
  status: "scheduled",
  recordAudio: true,
  startsAt: null,
  startedAt: null,
  endedAt: null,
  link: "/meet/aaa-bbbb-ccc",
  createdAt: "2026-10-17T16:00:00.000Z",
  mine: true,
  ...over,
});

// -- a real database for the loader -------------------------------------------------------------------------------

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CC = "11111111-0000-4000-8000-000000000001";
const ADON = "11111111-0000-4000-8000-000000000002";
const REP = "11111111-0000-4000-8000-000000000003";
const as = (userId: string, tenantId = OASIS, isTrueAdmin = false) => async () => ({ ok: true as const, tenantId, userId, isTrueAdmin });
const signedOut = async () => ({ ok: false as const });

async function main() {
  console.log("meet ui:");
  const markup = renderMarkup();

  // ---- the gate --------------------------------------------------------------------------------------------------

  await check("the recording notice rule: everyone but the room's creator, in a recorded room; the camera step waits for the tick", () => {
    assert.equal(needsRecordingNotice({ creator: true, recordAudio: true }), false, "the creator chose to record: they are told, they do not tick it");
    assert.equal(needsRecordingNotice({ creator: false, recordAudio: true }), true, "anyone else, a second host included");
    for (const creator of [true, false]) {
      assert.equal(needsRecordingNotice({ creator, recordAudio: false }), false, `a room that does not record has no notice (creator ${creator})`);
    }
    assert.equal(mayAskForDevices({ needsNotice: true, ticked: false }), false, "notice shown, not ticked: no camera");
    assert.equal(mayAskForDevices({ needsNotice: true, ticked: true }), true);
    assert.equal(mayAskForDevices({ needsNotice: false, ticked: false }), true, "no notice to tick: the camera step is open");
  });

  await check("the Meet button sits at the far right of the Schedule's toolbar, and a meeting for later refreshes the calendar", () => {
    const toolbar = readFileSync(join(root, "components", "calendar", "Toolbar.tsx"), "utf8");
    const right = toolbar.slice(toolbar.indexOf('<div className="ml-auto flex items-center gap-1">'));
    assert.ok(right.indexOf("{meet ?") > right.indexOf('role="group" aria-label="View"'), "after the view switcher, the last thing on the right");
    const app = readFileSync(join(root, "components", "calendar", "CalendarApp.tsx"), "utf8");
    assert.match(app, /meet=\{<MeetPanel onScheduleAdded=\{\(\) => void data\.reload\(\)\}/, "the panel's 'added to your Schedule' reloads the events");
  });

  await check("a refused join shows the field the server asked for, read from its code, not its words", () => {
    assert.deepEqual(preJoinNeeds({ viewer: "host", creator: true, recordAudio: true, failedCode: null }), { notice: false, name: false }, "the creator");
    assert.deepEqual(preJoinNeeds({ viewer: "host", creator: false, recordAudio: true, failedCode: null }), { notice: true, name: false }, "a second host: the notice, but their account name will do");
    assert.deepEqual(preJoinNeeds({ viewer: "visitor", creator: false, recordAudio: true, failedCode: null }), { notice: true, name: true });
    // The creator whose session ran out is refused as a guest: the tick and the name come back.
    assert.deepEqual(preJoinNeeds({ viewer: "host", creator: true, recordAudio: true, failedCode: "consent_required" }), { notice: true, name: false });
    assert.deepEqual(preJoinNeeds({ viewer: "host", creator: true, recordAudio: false, failedCode: "name_required" }), { notice: false, name: true });
    assert.deepEqual(preJoinNeeds({ viewer: "member", creator: false, recordAudio: false, failedCode: "room_full" }), { notice: false, name: false }, "any other failure asks for nothing more");
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.doesNotMatch(room, /=== meetErrorWords\(/, "no decision is made by comparing words");
    assert.match(room, /preJoinNeeds\(\{ viewer, creator, recordAudio, failedCode:/, "the notice is decided by whether they made the room, handed down from the page");
  });

  await check("(a) a visitor, a member or a second host in a recorded room: the notice and a required unticked box come first; nothing asks for the camera", () => {
    for (const id of ["room.visitorRecorded", "room.memberRecorded", "room.secondHostRecorded"]) {
      const html = markup[id];
      const words = text(html);
      assert.ok(words.includes("This meeting is recorded and transcribed so the host has notes of it."), `${id}: the notice, word for word`);
      assert.ok(words.includes("I agree to this meeting being recorded."), `${id}: the tick's label, word for word`);
      assert.equal(RECORDING_NOTICE, "This meeting is recorded and transcribed so the host has notes of it.");
      assert.equal(CONSENT_LABEL, "I agree to this meeting being recorded.");
      const box = tags(html, "input").find((t) => t.includes('id="meet-consent"')) ?? "";
      assert.match(box, /type="checkbox"/, `${id}: a checkbox`);
      assert.match(box, /\brequired=""/, `${id}: the tick is required`);
      assert.doesNotMatch(box, /\bchecked\b/, `${id}: and starts unticked`);
      assert.ok(words.includes("Oasis Meet") && words.includes("Quarterly review"), `${id}: the product and the meeting's name`);

      // Nothing on the screen asks for, shows or lists a camera or microphone until the tick.
      assert.ok(!words.includes(DEVICES_BUTTON), `${id}: no "Turn on camera and microphone" button`);
      assert.ok(!/<video\b/.test(html), `${id}: no camera preview`);
      assert.ok(!/<select\b/.test(html), `${id}: no device list`);
      assert.ok(!/<audio\b/.test(html), `${id}: no audio`);
      assert.ok(words.includes(TICK_FIRST), `${id}: it says why there is no camera step yet`);

      // The notice comes first in the page, then the name, then the camera section.
      const at = (needle: string) => {
        const i = html.indexOf(needle);
        assert.ok(i >= 0, `${id}: ${needle} is on the screen`);
        return i;
      };
      assert.ok(at("meet-notice") < at('id="meet-name"'), `${id}: the notice is above the name`);
      assert.ok(at('id="meet-consent"') < at('aria-label="Camera and microphone"'), `${id}: the tick is above the camera section`);
    }
  });

  await check("(a) a visitor must give a name; a member or a second host may leave it empty (the server uses their account)", () => {
    const visitorName = tags(markup["room.visitorRecorded"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(visitorName, /\brequired=""/);
    assert.ok(text(markup["room.visitorRecorded"]).includes("Your name"));
    assert.ok(!text(markup["room.visitorRecorded"]).includes("(optional)"));
    const memberName = tags(markup["room.memberRecorded"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.doesNotMatch(memberName, /\brequired=""/);
    assert.ok(text(markup["room.memberRecorded"]).includes("Your name (optional)"));
    assert.ok(text(markup["room.memberRecorded"]).includes("Leave it empty to use your account name."));
    assert.match(memberName, new RegExp(`maxLength="${NAME_MAX_CHARS}"`), "the box stops at the length the server keeps");
    const hostName = tags(markup["room.secondHostRecorded"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.doesNotMatch(hostName, /\brequired=""/, "a second host's account name will do, though they still tick the notice");
    assert.ok(text(markup["room.secondHostRecorded"]).includes("Your name (optional)"));
  });

  await check("(b) the room's creator sees no tick, no gate, and is told the meeting records", () => {
    const html = markup["room.creatorRecorded"];
    const words = text(html);
    assert.ok(!/type="checkbox"/.test(html), "no checkbox");
    assert.ok(!words.includes("I agree"), "nothing to agree to");
    assert.ok(!words.includes(TICK_FIRST));
    assert.ok(words.includes(DEVICES_BUTTON), "the camera step is open");
    assert.ok(words.includes("This meeting is recorded and transcribed. Guests agree to this before they join."));
    assert.ok(words.includes("Your name (optional)"));
    assert.ok(words.includes("Join now"));
  });

  await check("a room that does not record has no notice for anyone, and the camera step is open", () => {
    for (const id of ["room.visitorPlain", "room.memberPlain", "room.creatorPlain", "room.secondHostPlain"]) {
      const html = markup[id];
      assert.ok(!/type="checkbox"/.test(html), `${id}: no tick`);
      assert.ok(!text(html).includes("recorded"), `${id}: nothing says it records`);
      assert.ok(text(html).includes(DEVICES_BUTTON), `${id}: the camera step is open`);
    }
    const visitorName = tags(markup["room.visitorPlain"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(visitorName, /\brequired=""/, "a visitor still gives a name");
  });

  await check("the camera step is a button: the page never asks the browser on its own (no autostart in the markup)", () => {
    for (const html of [markup["room.creatorRecorded"], markup["room.visitorPlain"]]) {
      assert.equal(count(html, /<video\b/g), 0, "no preview until the person turns the camera on");
      assert.ok(buttonNames(html).includes(DEVICES_BUTTON));
    }
  });

  // ---- a room a lead booked ------------------------------------------------------------------------------------------------

  await check("a booked room: the name field starts with the lead's first name, can be changed and is checked as ever; the server draws no time line", () => {
    const field = (id: string) => tags(markup[id], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(field("room.bookedVisitor"), /\bvalue="Jane"/, "the lead's first name is already there");
    assert.match(field("room.bookedVisitor"), /\brequired=""/, "a visitor still gives a name: it is checked as ever");
    assert.ok(!/\b(readonly|disabled)=/i.test(field("room.bookedVisitor")), "and it can be changed");
    assert.match(field("room.bookedVisitor"), /maxlength="60"/i, "to the same length as ever");
    assert.match(field("room.bookedVisitorNoName"), /\bvalue=""/, "no name to give: the field starts empty");
    assert.match(field("room.bookedLongName"), new RegExp(`value="${"J".repeat(60)}"`), "a name longer than the server keeps is cut to it");
    assert.ok(!field("room.bookedLongName").includes("J".repeat(61)));
    assert.match(field("room.bookedMember"), /\bvalue=""/, "a member's name field starts empty");
    assert.match(field("room.visitorRecorded"), /\bvalue=""/, "a room no lead booked: empty, as before");
    // The server cannot know the viewer's zone or clock, so it says nothing of the time: the browser adds it once the page is up.
    for (const id of ["room.bookedVisitor", "room.bookedVisitorNoName", "room.bookedMember"]) {
      assert.ok(!text(markup[id]).includes("Your call starts"), `${id}: no time line in the server's markup (it would disagree with the browser's)`);
    }
    // The clock is read after the page is drawn, never while drawing it.
    const hook = readFileSync(join(root, "components", "meet", "useStartsLine.ts"), "utf8");
    assert.match(hook, /useState<string \| null>\(null\)/, "null until the browser has worked it out");
    assert.doesNotMatch(hook.slice(0, hook.indexOf("useEffect(")), /Date\.now\(\)|new Date\(/, "the clock is read inside the effect only");
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /const \[name, setName\] = useState\(\(\) => clampName\(guestName \?\? ""\)\);/, "the lead's name is where the field starts, and only that");
    const long = `${"a".repeat(NAME_MAX_CHARS - 1)}\u{1F600}b`;
    assert.equal(clampName(long), `${"a".repeat(NAME_MAX_CHARS - 1)}\u{1F600}`, "cut by whole characters, as the server counts: the emoji at the edge is kept whole");
    assert.equal(clampName("Jane"), "Jane");
  });

  await check("a meeting made for a time says when it starts: under its name on the pre-join screen and under the waiting line in the lobby, and nowhere else", () => {
    const pre = text(markup["prejoin.starts"]);
    const line = "Your call starts at 2:00 PM.";
    assert.ok(pre.indexOf("Quarterly review") < pre.indexOf(line) && pre.indexOf(line) < pre.indexOf(RECORDING_NOTICE), "under the title, before the notice");
    assert.ok(!text(markup["prejoin.notWaiting"]).includes("Your call starts"), "no time, no line");
    const lobby = text(markup["lobby.waiting.starts"]);
    assert.ok(lobby.indexOf(WAITING_FOR_HOST) >= 0 && lobby.indexOf(WAITING_FOR_HOST) < lobby.indexOf("Your call starts on Tuesday, October 20 at 2:00 PM."), "under the waiting line");
    for (const mode of ["joining", "connecting", "waiting"]) assert.ok(!text(markup[`lobby.${mode}`]).includes("Your call starts"), `${mode}: nothing unless it is handed a line`);
    // MeetRoom hands the line to the pre-join screen and to the waiting lobby, and to no other screen.
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.equal(count(room, /startsLine=\{startsLine\}/g), 2, "two places hand it on: the pre-join screen and the waiting lobby");
    assert.match(room, /const startsLine = useStartsLine\(startsAt\);/);
  });

  await check("when a meeting starts, in plain words and the viewer's own zone: today is just the time, another day carries its date, and once the room opens there is nothing to say", () => {
    const start = "2026-10-20T18:00:00.000Z"; // 2:00 PM in Montreal, 3:00 AM the next day in Tokyo
    const said = (startsAt: string | null, now: string, zone: string, locale = "en-US") => startsLine(startsAt, Date.parse(now), { zone, locale })?.replace(NARROW_SPACES, " ") ?? null;
    assert.equal(said(start, "2026-10-20T12:00:00.000Z", "America/Toronto"), "Your call starts at 2:00 PM.");
    assert.equal(said(start, "2026-10-18T15:30:00.000Z", "America/Toronto"), "Your call starts on Tuesday, October 20 at 2:00 PM.");
    assert.equal(said(start, "2026-10-20T12:00:00.000Z", "Asia/Tokyo"), "Your call starts on Wednesday, October 21 at 3:00 AM.", "the same moment is another day and hour for someone in Tokyo");
    assert.equal(said(start, "2025-12-30T15:00:00.000Z", "America/Toronto"), "Your call starts on Tuesday, October 20, 2026 at 2:00 PM.", "the year too, when it is not this one");
    assert.equal(said(start, "2026-10-20T12:00:00.000Z", "America/Toronto", "en-GB"), "Your call starts at 14:00.", "a 24-hour reader reads 24 hours");
    // en-CA writes "2:00 p.m.", whose own period closes the sentence: never "p.m.." (found live on the first booked room).
    assert.equal(said(start, "2026-10-20T12:00:00.000Z", "America/Toronto", "en-CA"), "Your call starts at 2:00 p.m.", "one period, today");
    assert.equal(said(start, "2026-10-18T15:30:00.000Z", "America/Toronto", "en-CA"), "Your call starts on Tuesday, October 20 at 2:00 p.m.", "and another day");
    // Midnight turns the date over: five hours before the call it is still today in Montreal, a day earlier it is not.
    assert.equal(said(start, "2026-10-20T04:01:00.000Z", "America/Toronto"), "Your call starts at 2:00 PM.", "just after midnight in Montreal it is already today");
    assert.equal(said(start, "2026-10-20T03:59:00.000Z", "America/Toronto"), "Your call starts on Tuesday, October 20 at 2:00 PM.", "just before it, it is not");
    // The room opens EARLY_START_MIN minutes before the time; from then on, and after, there is nothing to say.
    const opens = Date.parse(start) - EARLY_START_MIN * 60_000;
    const at = (now: number) => startsLine(start, now, { zone: "America/Toronto", locale: "en-US" });
    assert.notEqual(at(opens - 1), null, "a millisecond before the room opens");
    assert.equal(at(opens), null, "when the room opens");
    assert.equal(at(Date.parse(start)), null, "at the time");
    assert.equal(at(Date.parse(start) + 3_600_000), null, "an hour past it");
    assert.equal(startsLine(null, 0), null, "no time");
    assert.equal(startsLine("not a time", 0), null, "a time that is not one");
    assert.match(startsLine(start, Date.parse("2026-10-20T12:00:00.000Z"), { zone: "Not/AZone", locale: "en-US" }) ?? "", /^Your call starts (at|on) /, "a zone the browser does not know falls back to its own");
    assert.match(startsLine(start, Date.parse("2026-10-20T12:00:00.000Z"), { zone: "America/Toronto", locale: "en_US" }) ?? "", /^Your call starts (at|on) /, "a language tag the browser does not know falls back to its own, and the page does not break");
    assert.match(startsLine(start, Date.parse("2026-10-20T12:00:00.000Z"), { zone: "Not/AZone", locale: "not a locale" }) ?? "", /^Your call starts (at|on) /, "and both at once");
    assert.equal(EARLY_START_MIN, MEET_EARLY_START_MIN, "the browser's early window is the server's");
    assert.equal(englishLocaleOf(["fr-CA", "en-GB", "en-US"]), "en-GB", "the viewer's own English");
    assert.equal(englishLocaleOf(["fr-CA"]), "en-US");
    assert.equal(englishLocaleOf([]), "en-US");
    assert.equal(englishLocaleOf(["english"]), "en-US", "not a language tag");
  });

  // ---- the browser is never asked while the gate is shut ---------------------------------------------------------------

  const aTrack = { kind: "audio" } as unknown as MediaStreamTrack;
  const vTrack = { kind: "video" } as unknown as MediaStreamTrack;
  const streamOf = (audio: boolean, video: boolean) => ({ getAudioTracks: () => (audio ? [aTrack] : []), getVideoTracks: () => (video ? [vTrack] : []) });
  function standIn(answer: (c: MediaStreamConstraints) => unknown) {
    const calls: MediaStreamConstraints[] = [];
    const media = {
      getUserMedia: async (c: MediaStreamConstraints) => {
        calls.push(c);
        return answer(c);
      },
    } as unknown as Pick<MediaDevices, "getUserMedia">;
    return { calls, media };
  }
  const named = (name: string) => Object.assign(new Error(name), { name });

  await check("(a) openDevices does not touch getUserMedia while the gate is shut, and asks once it is open", async () => {
    const shut = standIn(() => streamOf(true, true));
    const closed = await openDevices({ allowed: false, media: shut.media, want: { mic: true, cam: true } });
    assert.equal(shut.calls.length, 0, "the browser was asked before the notice was ticked");
    assert.deepEqual(closed, { mic: null, cam: null, problems: { mic: "not_yet", cam: "not_yet" } });
    assert.equal(deviceWords(closed.problems), null, "nothing to say yet");

    const open = standIn(() => streamOf(true, true));
    const got = await openDevices({ allowed: true, media: open.media, want: { mic: true, cam: true } });
    assert.deepEqual(open.calls, [{ audio: true, video: true }], "one request for both");
    assert.equal(got.mic, aTrack);
    assert.equal(got.cam, vTrack);
    assert.deepEqual(got.problems, {});
  });

  await check("a second host in a recorded room is held at the gate like a guest: the notice, no camera step, and getUserMedia is not called until the tick; the creator is asked for none of it", async () => {
    // The real chain: who they are -> the rule -> the gate -> what openDevices does with the browser (counted at getUserMedia).
    const asked = async (creator: boolean, ticked: boolean) => {
      const needsNotice = preJoinNeeds({ viewer: "host", creator, recordAudio: true, failedCode: null }).notice;
      const allowed = mayAskForDevices({ needsNotice, ticked });
      const browser = standIn(() => streamOf(true, true));
      await openDevices({ allowed, media: browser.media, want: { mic: true, cam: true } });
      return { needsNotice, allowed, getUserMediaCalls: browser.calls.length };
    };
    assert.deepEqual(await asked(false, false), { needsNotice: true, allowed: false, getUserMediaCalls: 0 }, "a second host before the tick: the browser is not asked");
    assert.deepEqual(await asked(false, true), { needsNotice: true, allowed: true, getUserMediaCalls: 1 }, "after it, once");
    assert.deepEqual(await asked(true, false), { needsNotice: false, allowed: true, getUserMediaCalls: 1 }, "the creator has nothing to tick");
    // The screens say the same: the second host reads the notice and waits for the tick; the creator is told and may go on.
    const second = text(markup["room.secondHostRecorded"]);
    assert.ok(second.includes(RECORDING_NOTICE) && second.includes(CONSENT_LABEL) && second.includes(TICK_FIRST) && !second.includes(DEVICES_BUTTON), "second host: notice, tick, no camera step");
    const creator = text(markup["room.creatorRecorded"]);
    assert.ok(!creator.includes(RECORDING_NOTICE) && !creator.includes(CONSENT_LABEL) && !creator.includes(TICK_FIRST) && creator.includes(DEVICES_BUTTON), "creator: no notice, no tick, the camera step open");
  });

  // ---- an answer from the browser that comes too late -------------------------------------------------------------------------

  /** A browser whose answers arrive when the test says so, with tracks that count their stops and say which answer they came in. */
  function lateBrowser() {
    type Counted = { kind: string; answer: number; stopped: number; stop: () => void };
    const arrivals: Array<() => void> = [];
    const made: Counted[] = [];
    const counted = (kind: string, answer: number): Counted => {
      const t: Counted = { kind, answer, stopped: 0, stop: () => void (t.stopped += 1) };
      made.push(t);
      return t;
    };
    const media = {
      getUserMedia: (c: MediaStreamConstraints) =>
        new Promise((resolve) => {
          const answer = arrivals.length;
          arrivals.push(() => resolve({ getAudioTracks: () => (c.audio ? [counted("audio", answer)] : []), getVideoTracks: () => (c.video ? [counted("video", answer)] : []) }));
        }),
    } as unknown as Pick<MediaDevices, "getUserMedia">;
    return {
      media,
      /** The browser answers the request it was asked `answer`th (counting from 0). */
      answer: (answer: number) => arrivals[answer](),
      /** How many times each track that came with that answer has been stopped. */
      stops: (answer: number) => made.filter((t) => t.answer === answer).map((t) => t.stopped),
    };
  }
  type Browser = ReturnType<typeof lateBrowser>;
  type Requests = ReturnType<typeof createDeviceRequests>;
  /** One request as the hook makes it: ask the browser through openDevices, and settle what comes back (devices.ts run). */
  const requestDevices = (
    requests: Requests,
    browser: Browser,
    want: { mic: boolean; cam: boolean },
    options: { allowed?: () => boolean; onError?: (err: unknown) => void } = {},
  ): Promise<DeviceAnswer> =>
    requests.run(want, () => openDevices({ allowed: true, media: browser.media, want }), options.allowed ?? (() => true), options.onError ?? (() => undefined));

  await check("a late answer for the same device is stopped, not held: the newer request wins, whichever answers first", async () => {
    for (const order of [[1, 0], [0, 1]]) {
      const requests = createDeviceRequests();
      const browser = lateBrowser();
      const asks = [requestDevices(requests, browser, { mic: false, cam: true }), requestDevices(requests, browser, { mic: false, cam: true })];
      const settled: DeviceAnswer[] = [];
      for (const answer of order) {
        browser.answer(answer);
        settled[answer] = await asks[answer];
      }
      const label = `answers ${order.join(" then ")}`;
      assert.equal(settled[1].cam?.kind, "video", `${label}: the newer camera is kept`);
      assert.deepEqual([settled[0].cam, settled[0].current], [null, false], `${label}: the older one is not handed back`);
      assert.deepEqual(browser.stops(0), [1], `${label}: its track was stopped`);
      assert.deepEqual(browser.stops(1), [0], `${label}: the kept one is still running`);
      assert.deepEqual(order.map((a) => settled[a].pending), [true, false], `${label}: asking ends with the last open request, not the first`);
    }
  });

  await check("a late answer after the devices were released, the screen going away or consent withdrawn is stopped; a request made afterwards is wanted again", async () => {
    // cancel() is what all three do (useJoinDevices.ts); a join is not one of them (the next check).
    const requests = createDeviceRequests();
    const browser = lateBrowser();
    const open = requestDevices(requests, browser, { mic: true, cam: true });
    requests.cancel();
    browser.answer(0);
    const late = await open;
    assert.deepEqual([late.mic, late.cam, late.current, late.pending], [null, null, false, false]);
    assert.deepEqual(browser.stops(0), [1, 1], "both of its tracks were stopped");

    const again = requestDevices(requests, browser, { mic: true, cam: true });
    browser.answer(1);
    const fresh = await again;
    assert.ok(fresh.mic && fresh.cam && fresh.current, "after a cancel the next request counts again");
    assert.deepEqual(browser.stops(1), [0, 0]);

    // The notice un-ticked and ticked again while a request was open: it began under the agreement that was withdrawn.
    const withdrawn = requestDevices(requests, browser, { mic: false, cam: true });
    requests.cancel();
    browser.answer(2);
    assert.equal((await withdrawn).cam, null, "ticked again by the time it arrives, and still not wanted");
    assert.deepEqual(browser.stops(2), [1]);

    // The gate shut by the time it arrived, with nothing cancelled: not wanted either.
    const shut = requestDevices(requests, browser, { mic: true, cam: false }, { allowed: () => false });
    browser.answer(3);
    assert.equal((await shut).mic, null);
    assert.deepEqual(browser.stops(3), [1]);
  });

  await check("a join that fails keeps a camera answered after it; a join that works still stops it, because release() follows it", async () => {
    // What MeetRoom.join does, in order: takeForJoin() (copies for the room, nothing cancelled), then controller.join(),
    // then, only if the join did not fail, release(). The hook itself stays mounted through the call, so it is
    // release(), not the screen going away, that stops a late answer after a join that worked.
    const answeredAfterJoin = async (joinWorks: boolean) => {
      const requests = createDeviceRequests();
      const browser = lateBrowser();
      const open = requestDevices(requests, browser, { mic: false, cam: true });
      if (joinWorks) requests.cancel();
      browser.answer(0);
      return { answer: await open, stops: browser.stops(0) };
    };
    const failed = await answeredAfterJoin(false);
    assert.deepEqual([failed.answer.cam?.kind, failed.answer.current], ["video", true], "the join failed: the lobby keeps the camera that was opening");
    assert.deepEqual(failed.stops, [0], "and it is still running");
    const worked = await answeredAfterJoin(true);
    assert.deepEqual([worked.answer.cam, worked.answer.current], [null, false], "the join worked and release() ran: the late camera is not handed back");
    assert.deepEqual(worked.stops, [1], "it was stopped");
  });

  await check("asking for the microphone while the camera is still opening costs neither: the numbers are per device", async () => {
    const requests = createDeviceRequests();
    const browser = lateBrowser();
    const cam = requestDevices(requests, browser, { mic: false, cam: true });
    const mic = requestDevices(requests, browser, { mic: true, cam: false });
    browser.answer(1);
    const gotMic = await mic;
    browser.answer(0);
    const gotCam = await cam;
    assert.deepEqual([gotMic.mic?.kind, gotCam.cam?.kind], ["audio", "video"]);
    assert.deepEqual([browser.stops(0), browser.stops(1)], [[0], [0]], "nothing was stopped");
    // One request for both, then a newer one for the camera alone: the first loses only its camera.
    const both = requestDevices(requests, browser, { mic: true, cam: true });
    const camAgain = requestDevices(requests, browser, { mic: false, cam: true });
    browser.answer(2);
    browser.answer(3);
    const first = await both;
    const second = await camAgain;
    assert.deepEqual([first.mic?.kind, first.cam, first.current], ["audio", null, true], "its microphone is still wanted, its camera is not");
    assert.deepEqual(browser.stops(2), [0, 1], "audio kept, video stopped");
    assert.equal(second.cam?.kind, "video");
  });

  await check("a request whose ask throws still settles: nothing in hand, what it asked for reads \"unknown\", the error is handed on, and the count of open requests goes down", async () => {
    // openDevices answers with problems instead of throwing, so a throw is a bug or a browser object that misbehaves.
    // Before this, a request whose ask threw left `pending` up, and the screen waiting on it spun with nothing to wait for.
    const boom = new Error("the browser object misbehaved");
    const errors: unknown[] = [];
    const onError = (err: unknown) => void errors.push(err);
    const requests = createDeviceRequests();
    const rejected = await requests.run({ mic: false, cam: true }, async () => { throw boom; }, () => true, onError);
    assert.deepEqual([rejected.mic, rejected.cam, rejected.current, rejected.pending], [null, null, true, false], "still wanted, nothing held, nothing left open");
    assert.deepEqual(rejected.problems, { cam: "unknown" }, "only the device it asked for");
    assert.equal(deviceWords(rejected.problems), "The camera did not start. You can still join without it.", "the person is told, and can try again");
    // A throw before any await, such as the policy object being read to build the request.
    const thrown = await requests.run({ mic: true, cam: true }, () => { throw boom; }, () => true, onError);
    assert.deepEqual([thrown.pending, thrown.current, thrown.problems], [false, true, { mic: "unknown", cam: "unknown" }]);
    assert.deepEqual(errors, [boom, boom], "both were handed on");
    // Beside a request that is still open: pending stays up for that one and comes down with it.
    const browser = lateBrowser();
    const open = requestDevices(requests, browser, { mic: true, cam: false });
    const beside = await requests.run({ mic: false, cam: true }, async () => { throw boom; }, () => true, onError);
    assert.equal(beside.pending, true, "the microphone request is still open");
    browser.answer(0);
    const mic = await open;
    assert.deepEqual([mic.mic?.kind, mic.pending], ["audio", false]);
    // A report that fails must not leave the count up either: the next request still ends with nothing open.
    await assert.rejects(requests.run({ mic: true, cam: false }, async () => { throw boom; }, () => true, () => { throw new Error("report failed"); }), /report failed/);
    const calm = standIn(() => streamOf(true, false));
    const after = await requests.run({ mic: true, cam: false }, () => openDevices({ allowed: true, media: calm.media, want: { mic: true, cam: false } }), () => true, onError);
    assert.deepEqual([after.mic?.kind, after.pending], ["audio", false], "nothing is stuck open");
  });

  await check("cancel() stops counting the requests it abandons: waiting() and pending read empty at once, the late answer is stopped and hands back nothing, and it cannot disturb the count of a newer request", async () => {
    const requests = createDeviceRequests();
    const browser = lateBrowser();
    // Two requests open, the browser answering neither: the camera, then the microphone.
    const cam = requestDevices(requests, browser, { mic: false, cam: true });
    const mic = requestDevices(requests, browser, { mic: true, cam: false });
    assert.deepEqual(requests.waiting(), { mic: true, cam: true }, "both are waited for");
    // The person stops waiting.
    requests.cancel();
    assert.equal(requests.waiting(), NOT_WAITING, "nobody waits on either any more, though the browser has not answered");
    // A newer request begins while the abandoned ones are still open in the browser.
    const again = requestDevices(requests, browser, { mic: false, cam: true });
    assert.deepEqual(requests.waiting(), { mic: false, cam: true }, "only the new request is waited for");
    // The abandoned camera answers late: stopped, nothing handed back, and the newer request is still counted.
    browser.answer(0);
    const lateCam = await cam;
    assert.deepEqual([lateCam.cam, lateCam.mic, lateCam.current], [null, null, false], "the abandoned answer hands back nothing");
    assert.deepEqual(browser.stops(0), [1], "and its camera was stopped");
    assert.deepEqual([lateCam.pending, lateCam.waiting], [true, { mic: false, cam: true }], "the new request is still counted: the abandoned one took nothing from it");
    browser.answer(1);
    const lateMic = await mic;
    assert.deepEqual([lateMic.mic, lateMic.current, lateMic.pending], [null, false, true], "the abandoned microphone too");
    assert.deepEqual(browser.stops(1), [1]);
    assert.deepEqual(requests.waiting(), { mic: false, cam: true }, "still only the new request");
    // The new request answers: kept, and nothing is left open.
    browser.answer(2);
    const kept = await again;
    assert.deepEqual([kept.cam?.kind, kept.current, kept.pending], ["video", true, false]);
    assert.equal(requests.waiting(), NOT_WAITING);
    // The count did not go below zero: two requests open together are two to wait for, so the first to settle leaves one.
    const first = requestDevices(requests, browser, { mic: true, cam: false });
    const second = requestDevices(requests, browser, { mic: false, cam: true });
    browser.answer(3);
    assert.equal((await first).pending, true, "the second is still open: the abandoned answers took no count away");
    browser.answer(4);
    assert.equal((await second).pending, false);
  });

  await check("waiting() names the devices the open requests wait for from the moment run counts them, and shrinks as they settle; a request that throws is not counted after it", async () => {
    const requests = createDeviceRequests();
    assert.equal(requests.waiting(), NOT_WAITING, "nothing open: one shared answer, so the screen is not drawn again for it");
    const browser = lateBrowser();
    const cam = requestDevices(requests, browser, { mic: false, cam: true });
    assert.deepEqual(requests.waiting(), { mic: false, cam: true }, "counted before the browser has answered");
    const both = requestDevices(requests, browser, { mic: true, cam: true });
    assert.deepEqual(requests.waiting(), { mic: true, cam: true });
    browser.answer(0);
    const first = await cam;
    assert.deepEqual([first.pending, first.waiting], [true, { mic: true, cam: true }], "the second request still waits for both");
    browser.answer(1);
    const second = await both;
    assert.deepEqual([second.pending, second.waiting], [false, { mic: false, cam: false }]);
    const open = requestDevices(requests, browser, { mic: true, cam: false });
    await requests.run({ mic: false, cam: true }, async () => { throw new Error("the browser object misbehaved"); }, () => true, () => undefined);
    assert.deepEqual(requests.waiting(), { mic: true, cam: false }, "the one that threw is gone; the one still open is not");
    browser.answer(2);
    await open;
    assert.equal(requests.waiting(), NOT_WAITING);
  });

  await check("the hook opens every request through run and lets go of the open ones at release, consent withdrawn and the way out (abandon) and when the screen goes away, never at a join", () => {
    const hook = readFileSync(join(root, "components", "meet", "useJoinDevices.ts"), "utf8");
    assert.match(hook, /const \[requests\] = useState\(createDeviceRequests\);/, "one set of numbers for the life of the screen");
    assert.match(hook, /const answered = requests\.run\(/, "a request is opened only through run, which settles it when the browser answers or throws");
    assert.doesNotMatch(hook, /requests\.(begin|settle)\(/, "there is no other way to open or close one");
    assert.match(hook, /\(err\) => reportClientError\("rejection", err\),/, "a request that throws is reported, as the call screen reports its own");
    assert.match(hook, /\(\) => live\.current\.allowed,/, "the gate is read when the answer arrives");
    // What is waited for is said as soon as run has counted the request, and again when any request settles.
    assert.match(hook, /\);\s*(?:\/\/[^\n]*\s*)*setWaiting\(requests\.waiting\(\)\);\s*const answer = await answered;\s*setWaiting\(answer\.waiting\);/, "waiting follows the open requests: set on the way in, set from what is still open on the way out");
    assert.match(hook, /const asking = waiting\.mic \|\| waiting\.cam;/, "asking is whether anything is waited for: one source, not two");
    assert.doesNotMatch(hook, /setAsking/, "no second copy of asking to drift from the first");
    assert.match(hook, /if \(answer\.mic\) hold\("mic", answer\.mic\);/, "only what is wanted is held");
    assert.match(hook, /if \(answer\.cam\) hold\("cam", answer\.cam\);/);
    assert.equal(count(hook, /requests\.cancel\(\)/g), 2, "two places cancel: abandon, and the screen going away");
    assert.match(hook, /const abandon = useCallback\(\(\) => \{\s*requests\.cancel\(\);\s*setWaiting\(NOT_WAITING\);\s*\}, \[requests\]\);/, "abandon cancels AND stops waiting on it at once, or Join stays off for a request nobody wants");
    assert.match(hook, /if \(allowed\) return;\s*abandon\(\);\s*hold\("mic", null\);\s*hold\("cam", null\);/, "consent withdrawn");
    assert.match(hook, /return \(\) => \{\s*requests\.cancel\(\);\s*store\.mic\?\.stop\(\);/, "the screen going away");
    assert.match(hook, /const release = useCallback\(\(\) => \{\s*abandon\(\);\s*hold\("mic", null\);\s*hold\("cam", null\);/, "release lets go of what is open and of what is held");
    assert.match(hook, /stopWaiting: abandon,/, "the way out lets go of what is open and keeps what is held");
    assert.match(hook, /takeForJoin: \(\) => \(\{ mic: live\.current\.mic\?\.clone\(\) \?\? null, cam: live\.current\.cam\?\.clone\(\) \?\? null \}\),/, "a join takes copies and cancels nothing");
    assert.doesNotMatch(hook, /if \(!live\.current\.allowed\) \{/, "no second, partial check of the gate: run owns it");
    // A join that works is followed by release(), and only a join that works: that is what stops a late answer then.
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /const held = devices\.takeForJoin\(\);\s*await controller\.join\([^\n]*\);\s*(?:\/\/[^\n]*\s*)*if \(controller\.snapshot\(\)\.phase\.kind !== "failed"\) releaseDevices\(\);/, "release() follows a join that did not fail");
  });

  await check("openDevices asks for only what was wanted, and for the device the person picked", async () => {
    const mic = standIn(() => streamOf(true, false));
    await openDevices({ allowed: true, media: mic.media, want: { mic: true, cam: false } });
    assert.deepEqual(mic.calls, [{ audio: true, video: false }]);
    const cam = standIn(() => streamOf(false, true));
    await openDevices({ allowed: true, media: cam.media, want: { mic: false, cam: true }, camId: "cam-2", micId: "ignored" });
    assert.deepEqual(cam.calls, [{ audio: false, video: { deviceId: { exact: "cam-2" } } }]);
    const none = standIn(() => streamOf(true, true));
    assert.deepEqual(await openDevices({ allowed: true, media: none.media, want: { mic: false, cam: false } }), { mic: null, cam: null, problems: {} });
    assert.equal(none.calls.length, 0, "wanting nothing asks for nothing");
  });

  await check("openDevices: blocked is one answer for both; a missing camera does not cost the microphone", async () => {
    const blocked = standIn(() => {
      throw named("NotAllowedError");
    });
    const denied = await openDevices({ allowed: true, media: blocked.media, want: { mic: true, cam: true } });
    assert.equal(blocked.calls.length, 1, "a block is not asked about twice");
    assert.deepEqual(denied.problems, { mic: "blocked", cam: "blocked" });
    const words = deviceWords(denied.problems) ?? "";
    assert.equal(
      words,
      "Your browser blocked the camera and microphone. To allow them, click the camera or lock icon in the address bar, choose Allow, then try again. You can still join without them.",
    );

    const noCamera = standIn((c) => {
      if (c.video) throw named("NotFoundError");
      return streamOf(true, false);
    });
    const partial = await openDevices({ allowed: true, media: noCamera.media, want: { mic: true, cam: true } });
    assert.equal(partial.mic, aTrack, "the microphone still arrives");
    assert.equal(partial.cam, null);
    assert.deepEqual(partial.problems, { cam: "none" });
    assert.equal(deviceWords(partial.problems), "No camera was found. You can still join without it.");
    assert.deepEqual(noCamera.calls.map((c) => [!!c.audio, !!c.video]), [[true, true], [true, false], [false, true]], "together, then each on its own");

    assert.deepEqual((await openDevices({ allowed: true, media: undefined, want: { mic: true, cam: false } })).problems, { mic: "unsupported" });
    assert.equal(
      deviceWords({ mic: "busy", cam: "none" }),
      "No camera was found. Another app is using your microphone. You can still join without them.",
    );
    assert.equal(deviceWords({ mic: "none", cam: "none" }), "No camera or microphone was found. You can still join without them.");
    assert.equal(deviceWords({ cam: "blocked", mic: "none" }), "Your browser blocked the camera. No microphone was found. To allow it, click the camera or lock icon in the address bar, choose Allow, then try again. You can still join without them.");
    assert.deepEqual(
      ["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError", "TypeError", "Weird"].map((n) => problemOf(named(n))),
      ["blocked", "blocked", "none", "none", "busy", "busy", "unsupported", "unknown"],
    );
    assert.equal(problemOf(null), "unknown");
  });

  await check("a page whose own policy forbids the camera is told apart from a person who said no (no address-bar advice that goes nowhere)", async () => {
    const blocked = standIn(() => {
      throw named("NotAllowedError");
    });
    const forbidsAll = { allowsFeature: () => false };
    const both = await openDevices({ allowed: true, media: blocked.media, want: { mic: true, cam: true }, policy: forbidsAll });
    assert.deepEqual(both.problems, { mic: "policy", cam: "policy" });
    assert.equal(
      deviceWords(both.problems),
      "This page is not allowed to use the camera and microphone. That is a setup problem on our side, not a setting you can change. You can still join without them.",
    );
    assert.ok(!(deviceWords(both.problems) ?? "").includes("address bar"));
    const camOnly = await openDevices({ allowed: true, media: blocked.media, want: { mic: true, cam: true }, policy: { allowsFeature: (f) => f !== "camera" } });
    assert.deepEqual(camOnly.problems, { mic: "blocked", cam: "policy" });
    assert.equal(
      deviceWords(camOnly.problems),
      "This page is not allowed to use the camera. That is a setup problem on our side, not a setting you can change. Your browser blocked the microphone. To allow it, click the camera or lock icon in the address bar, choose Allow, then try again. You can still join without them.",
    );
    // A policy that allows them, or none at all, leaves a refusal as the person's own.
    for (const policy of [{ allowsFeature: () => true }, null, undefined]) {
      const own = await openDevices({ allowed: true, media: blocked.media, want: { mic: true, cam: true }, policy });
      assert.deepEqual(own.problems, { mic: "blocked", cam: "blocked" });
    }
  });

  await check("listInputs: names appear once permission is granted; a failure leaves the lists empty", async () => {
    const found = await listInputs({
      enumerateDevices: async () =>
        [
          { kind: "audioinput", deviceId: "m1", label: "Headset mic" },
          { kind: "audioinput", deviceId: "m2", label: "" },
          { kind: "videoinput", deviceId: "c1", label: "Webcam" },
          { kind: "audiooutput", deviceId: "s1", label: "Speakers" },
          { kind: "videoinput", deviceId: "", label: "Hidden" },
        ] as MediaDeviceInfo[],
    });
    assert.deepEqual(found, {
      mics: [{ id: "m1", label: "Headset mic" }, { id: "m2", label: "Microphone 2" }],
      cams: [{ id: "c1", label: "Webcam" }],
    });
    assert.deepEqual(await listInputs({ enumerateDevices: async () => { throw new Error("no"); } }), { mics: [], cams: [] });
    assert.deepEqual(await listInputs(undefined), { mics: [], cams: [] });
  });

  await check("the gate is wired through every layer: the room hands it to the hook, the hook to openDevices, the screen draws by it", () => {
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /const devicesOpen = mayAskForDevices\(\{ needsNotice, ticked: consent \}\);/);
    assert.match(room, /const devices = useJoinDevices\(devicesOpen\);/);
    assert.match(room, /devicesOpen=\{devicesOpen\}/);
    const hook = readFileSync(join(root, "components", "meet", "useJoinDevices.ts"), "utf8");
    assert.match(hook, /allowed: live\.current\.allowed,/, "the hook passes the CURRENT gate to openDevices");
    assert.match(hook, /if \(allowed\) return;\s*abandon\(\);\s*hold\("mic", null\);\s*hold\("cam", null\);/, "un-ticking the notice lets go of the devices, and of any request still open");
    const pre = readFileSync(join(root, "components", "meet", "PreJoin.tsx"), "utf8");
    assert.match(pre, /!props\.devicesOpen \?\s*\(\s*<p className="text-sm text-fg-muted">\{TICK_FIRST\}<\/p>/, "the camera step is behind the gate");
  });

  // ---- the way out of waiting on the browser -----------------------------------------------------------------------------------

  await check("the way out names exactly what is still waiting (camera, microphone or both), keeps the device a switch would replace, and says the same steps deviceWords says", () => {
    const none = { mic: false, cam: false };
    const cam = { mic: false, cam: true };
    const mic = { mic: true, cam: false };
    const both = { mic: true, cam: true };
    assert.equal(waitingWords(none, none), null, "nothing waiting, no way out");
    assert.equal(waitingWords(none, both), null, "holding devices is not waiting");
    const steps = "click the camera or lock icon in the address bar, choose Allow";
    const allow = (them: boolean) => `Or, to allow ${them ? "them" : "it"}, ${steps}.`;
    // Waiting for a device they do not have: they would join without it.
    assert.deepEqual(waitingWords(both, none), { button: "Join without your camera and microphone", hint: allow(true) });
    assert.deepEqual(waitingWords(cam, none), { button: "Join without your camera", hint: allow(false) });
    assert.deepEqual(waitingWords(mic, none), { button: "Join without your microphone", hint: allow(false) });
    // Holding one while the other is waited for: only what they would join without is named.
    assert.deepEqual(waitingWords(both, mic), { button: "Join without your camera", hint: allow(false) });
    assert.deepEqual(waitingWords(both, cam), { button: "Join without your microphone", hint: allow(false) });
    assert.deepEqual(waitingWords(cam, mic), { button: "Join without your camera", hint: allow(false) });
    assert.deepEqual(waitingWords(mic, cam), { button: "Join without your microphone", hint: allow(false) });
    // Waiting for a device they already hold is a switch to another one: they keep the one they have.
    const switching = "Or wait: your browser is still opening the one you picked.";
    assert.deepEqual(waitingWords(cam, cam), { button: "Join with your current camera", hint: switching });
    assert.deepEqual(waitingWords(mic, mic), { button: "Join with your current microphone", hint: switching });
    assert.deepEqual(waitingWords(both, both), { button: "Join with your current camera and microphone", hint: switching });
    assert.deepEqual(waitingWords(cam, both), { button: "Join with your current camera", hint: switching });
    // The steps are the ones deviceWords gives a blocked camera, word for word.
    assert.ok((deviceWords({ cam: "blocked" }) ?? "").includes(`To allow it, ${steps}, then try again.`));
    assert.ok((waitingWords(cam, none)?.hint ?? "").includes(`to allow it, ${steps}.`));
    // Plain bytes and plain words, in every case.
    for (const w of [cam, mic, both]) {
      for (const h of [none, cam, mic, both]) {
        const words = waitingWords(w, h);
        assert.ok(words && /^[\x20-\x7e]+$/.test(words.button + words.hint), "ASCII only");
        assert.ok(!/asking|pending|request|track|stream/i.test(`${words?.button} ${words?.hint}`), "no internal word");
      }
    }
  });

  await check("the way out of waiting on the browser: drawn only while something is waited for and behind the notice's gate, naming what is waiting, with Join now still off beside it", () => {
    const outs = (html: string) => buttonNames(html).filter((n) => /^Join with(out)? /.test(n));
    const tagOf = (html: string, name: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].find((m) => text(m[1]) === name)?.[0] ?? "";
    const waitingScreens = ["prejoin.waitingBoth", "prejoin.waitingCamera", "prejoin.waitingMicrophone", "prejoin.switching"];
    // Nothing waited for, or the gate shut: no way out and no hint, on any screen.
    for (const [id, html] of Object.entries(markup)) {
      if (waitingScreens.includes(id)) continue;
      assert.deepEqual(outs(html), [], `${id}: no way out`);
      assert.ok(!html.includes("meet-waiting-hint"), `${id}: no hint either`);
    }
    assert.ok(!/\bdisabled=""/.test(tagOf(markup["prejoin.notWaiting"], "Join now")), "nothing waiting: Join now is on");
    assert.ok(text(markup["prejoin.waitingGateShut"]).includes(TICK_FIRST), "the shut gate draws the tick-first line where the camera step would be");
    // Waiting: the words follow what is waited for and what is held.
    const cases: Array<[string, string, string]> = [
      ["prejoin.waitingBoth", "Join without your camera and microphone", "Or, to allow them, click the camera or lock icon in the address bar, choose Allow."],
      ["prejoin.waitingCamera", "Join without your camera", "Or, to allow it, click the camera or lock icon in the address bar, choose Allow."],
      ["prejoin.waitingMicrophone", "Join without your microphone", "Or, to allow it, click the camera or lock icon in the address bar, choose Allow."],
      ["prejoin.switching", "Join with your current camera", "Or wait: your browser is still opening the one you picked."],
    ];
    for (const [id, button, hint] of cases) {
      const html = markup[id];
      assert.deepEqual(outs(html), [button], `${id}: one way out, naming exactly what is waiting`);
      assert.ok(text(html).includes(hint), `${id}: the hint`);
      const tag = tagOf(html, button);
      assert.match(tag, /type="button"/, `${id}: a plain button, not a second submit`);
      assert.ok(!/\bdisabled=""/.test(tag), `${id}: and it is on`);
      assert.match(tag, /aria-describedby="meet-waiting-hint"/, `${id}: described by its hint`);
      assert.match(html, /<p id="meet-waiting-hint"/, `${id}: the hint it points to`);
      const joinNow = tagOf(html, "Join now");
      assert.ok(/type="submit"/.test(joinNow) && /\bdisabled=""/.test(joinNow), `${id}: Join now stays off while the browser has not answered`);
    }
  });

  await check("the way out joins through the same join: Join now still waits, the notice and the name are checked first, and the open request is let go only once they pass", () => {
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /const join = async \(options: \{ stopWaiting\?: boolean; here\?: boolean \} = \{\}\) => \{\s*(?:\/\/[^\n]*\s*)*if \(devices\.asking && !options\.stopWaiting\) return;\s*setTried\(true\);/, "only the way out passes the wait");
    assert.match(
      room,
      /if \(needsNotice && !consent\) \{\s*consentRef\.current\?\.focus\(\);\s*return;\s*\}\s*if \(nameRequired && !trimmed\) \{\s*nameRef\.current\?\.focus\(\);\s*return;\s*\}\s*(?:\/\/[^\n]*\s*)*if \(options\.stopWaiting\) devices\.stopWaiting\(\);\s*const held = devices\.takeForJoin\(\);/,
      "the notice, then the name, then the open request is let go, then the copies are taken",
    );
    assert.equal(count(room, /devices\.stopWaiting\(\)/g), 1, "one place lets go of the wait");
    assert.equal(count(room, /controller\.join\(/g), 1, "one call joins: the way out goes through it, not around it");
    assert.match(room, /onJoin=\{\(\) => void join\(\)\}/);
    assert.match(room, /onJoinWithout=\{\(\) => void join\(\{ stopWaiting: true \}\)\}/);
    const pre = readFileSync(join(root, "components", "meet", "PreJoin.tsx"), "utf8");
    assert.match(pre, /const way = props\.devicesOpen && devices\.asking \? waitingWords\(devices\.waiting, \{ mic: !!devices\.mic, cam: !!devices\.cam \}\) : null;/, "behind the same gate as the camera step, and only while waiting");
    assert.match(pre, /<button type="submit" disabled=\{devices\.asking\}/, "Join now is off while the browser has not answered");
    assert.match(pre, /<button type="button" onClick=\{props\.onJoinWithout\}/, "the way out is its own button");
    assert.equal(count(pre, /props\.onJoinWithout/g), 1, "and nothing else calls it");
  });

  // ---- the quiet screens between Join now and the call ---------------------------------------------------------------------

  await check("every lobby offers Leave, the first join and a dropped line's wait included: MeetRoom hands one to each, and the Lobby draws it in every mode", () => {
    // What each screen draws.
    const words = { joining: "Joining...", connecting: "Joining...", waiting: WAITING_FOR_HOST } as const;
    for (const mode of ["joining", "connecting", "waiting"] as const) {
      const html = markup[`lobby.${mode}`];
      assert.deepEqual(buttonNames(html), ["Leave"], `${mode}: one button, and it is Leave`);
      assert.match(html, /<button type="button"[^>]*>\s*Leave\s*<\/button>/, `${mode}: a plain button`);
      assert.ok(text(html).includes(words[mode]), `${mode}: its words`);
      assert.deepEqual(buttonNames(markup[`lobby.${mode}.bare`]), [], `${mode}: the Lobby draws no button it was given no way to use`);
    }
    // What MeetRoom hands each one: every <Lobby> in it has a mode and the call that leaves. Read with the parser, so
    // the way the lines are broken cannot hide a missing one.
    const file = join(root, "components", "meet", "MeetRoom.tsx");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lobbies: Array<{ mode: string; onLeave: string; startsLine: string }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "Lobby") {
        const attribute = (name: string) => node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name)?.initializer;
        const expression = (initializer: ReturnType<typeof attribute>) => (initializer && ts.isJsxExpression(initializer) && initializer.expression ? initializer.expression.getText(sf).replace(/\s+/g, " ") : "");
        const mode = attribute("mode");
        lobbies.push({ mode: mode && ts.isStringLiteral(mode) ? mode.text : "?", onLeave: expression(attribute("onLeave")), startsLine: expression(attribute("startsLine")) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.deepEqual(
      lobbies.sort((a, b) => a.mode.localeCompare(b.mode)),
      // The waiting lobby is told when the meeting starts; the two that say "Joining..." are not.
      [
        { mode: "connecting", onLeave: "() => void controller.leave()", startsLine: "" },
        { mode: "joining", onLeave: "() => void controller.leave()", startsLine: "" },
        { mode: "waiting", onLeave: "() => void controller.leave()", startsLine: "startsLine" },
      ],
      "one Lobby per mode, each with the call that leaves, and only the waiting one with the time",
    );
  });

  // ---- the ending screens ------------------------------------------------------------------------------------------------

  await check("(d) every ending says the right words; Rejoin only after leaving, being disconnected or moving to another tab; the way back only for a host", () => {
    const words = {
      left: "You left the meeting.",
      dropped: "You were disconnected from the meeting.",
      host_ended: "The host ended the meeting.",
      removed: "The host removed you from this meeting.",
      moved: "You moved this meeting to another tab.",
      room_closed: "This meeting has ended.",
    } as const;
    assert.deepEqual(ENDED_WORDS, words);
    for (const [reason, sentence] of Object.entries(words)) {
      const guest = markup[`ended.${reason}.guest`];
      const host = markup[`ended.${reason}.host`];
      assert.match(guest, new RegExp(`<h1[^>]*>${sentence.replace(/\./g, "\\.")}</h1>`), `${reason}: the words`);
      // A meeting still going, that this person is out of: back in through a fresh join (from a tab that moved it on,
      // that join finds the other tab and offers to take the meeting back).
      const rejoin = reason === "left" || reason === "dropped" || reason === "moved";
      assert.equal(buttonNames(guest).includes("Rejoin"), rejoin, `${reason}: Rejoin only after the person left, was disconnected or moved tabs`);
      assert.equal(buttonNames(host).includes("Rejoin"), rejoin, `${reason}: ... for a host too`);
      assert.ok(!guest.includes("/schedule"), `${reason}: a guest is not sent to the Schedule`);
      assert.match(host, /<a href="\/schedule"[^>]*>Back to Schedule<\/a>/, `${reason}: a host gets the way back, as a plain link`);
    }
    assert.match(text(markup["room.endedProp"]), /This meeting has ended\./, "a room that ended before the link was opened");
    assert.ok(!/type="checkbox"/.test(markup["room.endedProp"]) && !text(markup["room.endedProp"]).includes("Join now"), "and offers no way in");
  });

  // ---- the call -----------------------------------------------------------------------------------------------------------

  await check("the call: the Recording indicator is a dot WITH the word, for everyone, only while the recording is running: the room records and the browser recording it is in the call", () => {
    // The creator's own view and a guest's, with the creator's browser recording; and a second host's browser
    // recording a call the creator is not in (any host's browser records), seen by him and by a guest.
    for (const id of ["call.guest", "call.host", "call.secondHostAlone", "call.guestWithSecondHost"]) {
      assert.match(markup[id], /<span aria-hidden="true" class="h-2 w-2 rounded-full bg-status-hot"><\/span>Recording<\/p>/, `${id}: red dot and the word`);
    }
    assert.ok(!text(markup["call.noHostYet"]).includes("Recording"), "no host in the call yet: no indicator");
    assert.ok(!text(markup["call.notRecorded"]).includes("Recording"), "a room that does not record: no indicator");
    // A recorded room with a host present whose browser does not record (yet). Nothing is recording, so nothing says it is.
    for (const id of ["call.hostNotRecording", "call.guestHostNotRecording"]) {
      assert.ok(markup[id].includes("Adon") && /Host/.test(text(markup[id])), `${id}: a host is in the call`);
      assert.ok(!text(markup[id]).includes("Recording"), `${id}: no browser records, so there is no indicator`);
      assert.ok(!markup[id].includes("being recorded and transcribed"), `${id}: and no claim in its tooltip either`);
    }
    // Where the claim comes from: the room's own answer, and nothing else on the call or lobby screens says "recorded".
    const codeOf = (file: string) => readFileSync(join(root, "components", "meet", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const screen = codeOf("CallScreen.tsx");
    assert.match(screen, /const recording = snapshot\.roomRecording;/, "the badge is the room's answer");
    assert.doesNotMatch(screen, /recordAudio|hostPresent/, "not worked out from the room's setting or from who is present");
    assert.doesNotMatch(codeOf("Lobby.tsx"), /record/i, "the lobby claims nothing about recording");
    assert.doesNotMatch(codeOf("MeetRoom.tsx").match(/<CallScreen[^>]*>/)?.[0] ?? "", /recordAudio/, "and the room does not hand the call screen the room's setting");
  });

  await check("the call: faces, names, Host tag, mic-off, a mirrored own tile, muted videos and one hidden audio per remote microphone", () => {
    const html = markup["call.guest"];
    assert.equal(count(html, /data-tile="/g), 3);
    assert.ok(text(html).includes("Jane Doe (You)"));
    assert.ok(text(html).includes("Samantha Lee-Whitfield"));
    assert.equal(count(html, />Host</g), 1, "one Host tag");
    assert.ok(html.includes("SL"), "initials stand in for a camera that is off");
    assert.equal(count(html, />Mic off</g), 1, "only the one with the microphone off");
    assert.equal(count(html, /<audio\b[^>]*hidden/g), 1, "one hidden audio, for the one remote microphone (never the person's own)");
    for (const v of tags(html, "video")) assert.match(v, /\bmuted=""/, "every video is muted");
    const mine = html.match(/data-tile="me">(.*?)<div class="absolute inset-x-0 bottom-0/)?.[1] ?? "";
    assert.match(mine, /-scale-x-100/, "own camera is mirrored");
    const theirs = html.match(/data-tile="other">(.*?)<div class="absolute inset-x-0 bottom-0/)?.[1] ?? "";
    assert.doesNotMatch(theirs, /-scale-x-100/, "other people's are not");
  });

  await check("the call: controls are labelled, the toggles say aria-pressed, share is hidden where it does not exist, End is the host's alone", () => {
    const guest = markup["call.guest"];
    assert.deepEqual(buttonNames(guest), ["Mic", "Camera", "Share screen", "Copy meeting link", "People (3)", "Leave"]);
    const pressed = (html: string, name: string) => {
      const m = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((b) => text(b[2]) === name);
      assert.ok(m, `${name} is on the screen`);
      return m[1].match(/aria-pressed="(true|false)"/)?.[1] ?? null;
    };
    assert.equal(pressed(guest, "Mic"), "true");
    assert.equal(pressed(guest, "Camera"), "true");
    assert.equal(pressed(guest, "Share screen"), "false");
    assert.equal(pressed(guest, "Copy meeting link"), null, "not a toggle");
    assert.equal(pressed(guest, "Leave"), null);
    assert.match(guest, /aria-controls="meet-people"/);
    assert.ok(!buttonNames(markup["call.guestNoShare"]).includes("Share screen"), "no screen sharing on a phone");
    assert.ok(!text(guest).includes("End meeting"));
    assert.deepEqual(buttonNames(markup["call.host"]).slice(-2), ["Leave", "End meeting"], "End meeting is the host's, after Leave");
    assert.match(markup["call.host"], /role="group" aria-label="Meeting controls"/);
  });

  await check("the call: a quiet notice line; a shared screen takes the stage and the faces become a strip; your own share is not echoed back", () => {
    assert.match(markup["call.notice"], /<p role="status"[^>]*>Reconnecting\.\.\.<\/p>/);
    assert.ok(!/role="status"/.test(markup["call.guest"]), "no notice, no line");

    const shared = markup["call.sharing"];
    assert.match(shared, /<section aria-label="Shared screen"/);
    assert.ok(text(shared).includes("CC is sharing their screen"));
    assert.equal(count(shared, /object-contain/g), 1, "the screen is shown whole");
    assert.equal(count(shared, /data-tile="/g), 2, "both faces are in the strip");
    assert.match(shared, /<ul class="grid shrink-0 grid-cols-3/, "the strip");

    const own = markup["call.ownShare"];
    assert.ok(text(own).includes("You are sharing your screen."));
    assert.ok(buttonNames(own).includes("Stop sharing"));
    assert.equal(count(own, /object-contain/g), 0, "your own screen is not played back to you");
  });

  await check("the people list: a host can Remove anyone but themselves; a guest cannot", () => {
    const host = markup["people.host"];
    assert.equal(count(host, /data-remove="/g), 2, "CC and Samantha, not Jane (you)");
    assert.ok(host.includes('aria-label="Remove CC"') && host.includes('aria-label="Remove Samantha Lee-Whitfield"'));
    assert.ok(!host.includes('aria-label="Remove Jane Doe"'));
    assert.ok(text(host).includes("People (3)"));
    assert.equal(count(markup["people.guest"], /data-remove="/g), 0);
    assert.ok(text(markup["people.guest"]).includes("Jane Doe (You)"));
  });

  await check("the two-step End and Remove are in the source as words: End for everyone? / Cancel, Remove from the meeting? / Remove / Cancel", () => {
    const controls = readFileSync(join(root, "components", "meet", "CallControls.tsx"), "utf8");
    assert.match(controls, /"End for everyone\?"/);
    assert.match(controls, />\s*Cancel\s*</);
    assert.match(controls, /<BarButton[\s\S]*?label="End meeting"/);
    const people = readFileSync(join(root, "components", "meet", "PeoplePanel.tsx"), "utf8");
    assert.match(people, /Remove from the meeting\?/);
    assert.match(people, />\s*Cancel\s*</);
  });

  // ---- the Schedule panel -------------------------------------------------------------------------------------------------

  await check("(c) the panel draws its three sections in order, with Start now, the later form and the recent list", () => {
    const html = markup["panel.loading"];
    const order = ["Start a meeting now", "Create a link for later", "Recent meetings"].map((n) => html.indexOf(`aria-label="${n}"`));
    assert.ok(order.every((i) => i >= 0), "all three sections are named");
    assert.deepEqual([...order].sort((x, y) => x - y), order, "in that order");
    assert.deepEqual(buttonNames(html), ["Start a meeting now", "Create link"]);
    assert.ok(text(html).includes("Title (optional)") && text(html).includes("Date and time (optional)"));
    assert.ok(text(html).includes("Record and transcribe"));
    assert.ok(text(html).includes("Guests agree to this before they join."));
    const record = tags(html, "input").find((t) => t.includes('id="meet-later-record"')) ?? "";
    assert.match(record, /\bchecked=""/, "record and transcribe is on by default");
    assert.doesNotMatch(tags(markup["panel.laterUnticked"], "input").find((t) => t.includes('id="meet-later-record"')) ?? "", /\bchecked\b/);
    assert.match(tags(html, "input").find((t) => t.includes('id="meet-later-when"')) ?? "", /type="datetime-local"/);
    assert.match(tags(html, "input").find((t) => t.includes('id="meet-later-title"')) ?? "", new RegExp(`maxLength="${TITLE_MAX_CHARS}"`));
  });

  await check("(c) the recent list has a loading line, an error with Try again, and an empty line in plain words", () => {
    assert.match(markup["panel.loading"], /<p role="status"[^>]*>Loading meetings\.\.\.<\/p>/);
    assert.ok(text(markup["panel.empty"]).includes("No meetings yet. Start one above."));
    assert.ok(!text(markup["panel.empty"]).includes("Loading"));
    assert.match(markup["panel.error"], /<p role="alert"[^>]*>Your meetings could not load\.<\/p>/);
    assert.ok(buttonNames(markup["panel.error"]).includes("Try again"));
    assert.ok(!text(markup["panel.error"]).includes("No meetings yet"));
  });

  await check("(c) a meeting is a title, a plain status, a time, Copy link, and Join unless it ended; a finished recorded one has a Transcript button, closed", () => {
    const html = markup["panel.rows"];
    assert.equal(count(html, /<li\b/g), 3);
    for (const [title, status] of [["Discovery call", "Scheduled"], ["Team sync", "Live now"], ["Old review", "Ended"]]) {
      assert.ok(text(html).includes(title) && text(html).includes(status), `${title} / ${status}`);
    }
    assert.equal(count(html, />Copy link</g), 3, "every meeting can have its link copied");
    const joins = [...html.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Join<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(joins, ["/meet/aaa-bbbb-ccc", "/meet/ddd-eeee-fff"], "Join for scheduled and live, not for ended");
    assert.equal(count(html, /data-transcript-slot=/g), 0, "no transcript is mounted until one is opened");
    assert.deepEqual([...html.matchAll(/data-transcript-toggle="([^"]+)"/g)].map((m) => m[1]), ["r3"], "the Transcript button is on the ended meeting only");
    assert.ok(!markup["panel.empty"].includes("data-transcript"));
    assert.match(markup["panel.copyFailed"], /Copy this link: <span[^>]*>https:\/\/oasisai\.work\/meet\/aaa-bbbb-ccc<\/span>/, "a refused copy shows the link to copy by hand");
  });

  await check("(c) Start now shows the link to send; a blocked tab is said so; a failure is an alert in plain words", () => {
    const made = markup["panel.startMade"];
    assert.ok(text(made).includes("Your meeting is open in a new tab. Send this link so people can join."));
    assert.ok(text(made).includes("oasisai.work/meet/aaa-bbbb-ccc"));
    assert.ok(text(made).includes("Open again"));
    assert.ok(!text(made).includes("Added to your Schedule") && !text(made).includes("not on your Schedule"), "Start now says nothing about the Schedule");
    const blocked = markup["panel.startBlocked"];
    assert.ok(text(blocked).includes("Your browser blocked the new tab."));
    assert.ok(text(blocked).includes("Open meeting"));
    assert.match(markup["panel.startError"], /<p role="alert"[^>]*>Sign in again, then try once more\.<\/p>/);
  });

  await check("(c) a link made for a time says whether it is on the Schedule; one made without a time says nothing", () => {
    assert.ok(text(markup["panel.laterAdded"]).includes("Added to your Schedule."));
    assert.ok(!text(markup["panel.laterAdded"]).includes("not on your Schedule"));
    // A refusal is worded by the Schedule's own messageFor, so it reads the same there and here.
    const shabbat = "That time is inside Shabbat, which is protected. Pick another time.";
    assert.equal(messageFor("shabbat_protected"), shabbat, "the Schedule's own sentence");
    assert.ok(text(markup["panel.laterNotAdded"]).includes(`The link works, but it is not on your Schedule. ${shabbat}`));
    assert.ok(!text(markup["panel.laterNotAdded"]).includes("Added to your Schedule."));
    assert.ok(text(markup["panel.laterNotAddedOther"]).includes(`The link works, but it is not on your Schedule. ${messageFor("time_zone_invalid")}`), "any other code gets the Schedule's words for it too");
    assert.ok(!text(markup["panel.laterNoLine"]).includes("Schedule."), "no time, no line");
    // One reason is said in the panel's own words: the Schedule could not be reached. The meeting is made, so the
    // Schedule's "try again" would make a second one; the person is told to add it there by hand.
    const unreached = "The link works, but it is not on your Schedule. The Schedule could not be reached. The meeting is already made, so add it to your Schedule yourself instead of making another.";
    assert.ok(text(markup["panel.laterScheduleUnreached"]).includes(unreached), "the screen says it");
    assert.equal(scheduleLine({ added: false, reason: "schedule_unavailable" }, messageFor), unreached);
    assert.equal(messageFor("schedule_unavailable"), "That change could not be saved. Nothing was lost; try again.", "the default for this code is exactly the advice that would make a second meeting");
    assert.ok(!unreached.includes("try again") && !text(markup["panel.laterScheduleUnreached"]).includes("try again"), "so it is not used here");
    for (const reason of ["shabbat_protected", "time_zone_invalid", "calendar_storage_missing", "unauthorized", "some_future_code"]) {
      assert.equal(scheduleLine({ added: false, reason }, messageFor), `The link works, but it is not on your Schedule. ${messageFor(reason)}`, `${reason} keeps the Schedule's words`);
    }
    assert.equal(scheduleLine({ added: false, reason: "schedule_unavailable_again" }, messageFor), `The link works, but it is not on your Schedule. ${messageFor("schedule_unavailable_again")}`, "only that exact code");
    assert.ok(text(markup["panel.laterAdded"]).includes("Link ready. Send it to the people you want in the meeting."));
    assert.ok(text(markup["panel.laterAdded"]).includes("Copy link") && text(markup["panel.laterAdded"]).includes("Open meeting"));
  });

  await check("(c) the length picker appears only with a time, and offers the usual length first", () => {
    assert.ok(!markup["panel.laterNoTime"].includes('id="meet-later-length"'), "no time, no length");
    const html = markup["panel.laterWithTime"];
    const select = html.match(/<select id="meet-later-length"[\s\S]*?<\/select>/)?.[0] ?? "";
    assert.ok(select, "a length picker");
    assert.deepEqual(
      [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]),
      [["", "Your usual length"], ...LENGTH_CHOICES.map((m) => [String(m), lengthWords(m)])],
    );
    assert.match(select, /<option value="45" selected="">45 minutes<\/option>/, "the one picked is selected");
    assert.deepEqual(LENGTH_CHOICES.filter((m) => m < 15 || m > 480), [], "every choice is one the server accepts (15 to 480)");
    assert.deepEqual([15, 30, 45, 60, 90, 120].map(lengthWords), ["15 minutes", "30 minutes", "45 minutes", "1 hour", "1 hour 30 minutes", "2 hours"]);
    assert.ok(text(html).includes("With a time, the meeting is added to your Schedule too."));
  });

  // ---- recording is offered only where it runs ----------------------------------------------------------------------------------

  await check("no recording, no box: where recording does not run the panel draws no Record and transcribe box and no claim that a meeting records", () => {
    for (const id of ["panel.noRecording", "panel.noRecordingMadeStart", "panel.mixedUnavailable"]) {
      const html = markup[id];
      const words = text(html);
      assert.ok(!html.includes('id="meet-later-record"'), `${id}: no box`);
      assert.ok(!words.includes("Record and transcribe"), `${id}: nor its words`);
      assert.ok(!words.includes("Guests agree to this before they join."), `${id}: nor its explanation`);
      assert.ok(!/\bchecked\b/.test(html), `${id}: nothing ticked`);
      assert.ok(words.includes("Opens in a new tab."), `${id}: Start now still says it opens a tab`);
      assert.ok(!words.includes("recorded and transcribed, and guests agree"), `${id}: and no longer says it records`);
    }
    // Where it runs, all of that is back exactly as it was.
    const on = markup["panel.loading"];
    assert.match(tags(on, "input").find((t) => t.includes('id="meet-later-record"')) ?? "", /\bchecked=""/);
    assert.ok(text(on).includes("Record and transcribe") && text(on).includes("Guests agree to this before they join."));
    assert.ok(text(on).includes("Opens in a new tab. It is recorded and transcribed, and guests agree to that before they join."));
  });

  await check("recordAudio true is asked for only where the list said recording runs: false where it does not, nothing before it has answered", () => {
    // Where the list said recording does not run: false, whatever the box held (the box is not even drawn there).
    for (const record of [true, false]) {
      for (const startsAt of [undefined, "2030-01-01T15:00:00.000Z"]) {
        const body = laterBody({ title: "  Kickoff ", startsAt, timeZone: "America/Toronto", minutes: "45", record, availability: "unavailable" });
        assert.equal(body.recordAudio, false, `unavailable, box ${record}, time ${startsAt ?? "none"}`);
      }
    }
    // Where it runs: the box. Before the list answers: nothing, so the server decides and a click that came before the list loaded never leaves a meeting unrecorded.
    assert.equal(laterBody({ title: "", minutes: "", record: true, availability: "available" }).recordAudio, true, "available and ticked");
    assert.equal(laterBody({ title: "", minutes: "", record: false, availability: "available" }).recordAudio, false, "available and not ticked");
    for (const record of [true, false]) assert.ok(!("recordAudio" in laterBody({ title: "", minutes: "", record, availability: "unknown" })), `unknown, box ${record}: nothing sent`);
    assert.deepEqual(startBody("available"), {}, "Start now where recording runs: nothing, the server's default stands");
    assert.deepEqual(startBody("unknown"), {}, "and before the list has answered");
    assert.deepEqual(startBody("unavailable"), { recordAudio: false });
    // The body is exactly what the form holds, nothing more: a time brings its zone and length, no time brings neither.
    assert.deepEqual(laterBody({ title: "  Kickoff ", startsAt: "2030-01-01T15:00:00.000Z", timeZone: "America/Toronto", minutes: "45", record: true, availability: "available" }), {
      title: "Kickoff",
      startsAt: "2030-01-01T15:00:00.000Z",
      timeZone: "America/Toronto",
      minutes: 45,
      recordAudio: true,
    });
    assert.deepEqual(laterBody({ title: " ", timeZone: "America/Toronto", minutes: "45", record: true, availability: "available" }), { recordAudio: true });
    // The panel hands both builders what the list said, and "available" is only ever the list's own word.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /const availability: RecordingAvailability = load\.status !== "ready" \? "unknown" : load\.recordingAvailable \? "available" : "unavailable";/);
    assert.match(panel, /const recordingAvailable = availability === "available";/);
    assert.match(panel, /createMeeting\(startBody\(availability\)\)/);
    assert.match(panel, /laterBody\(\{[^}]*\bavailability\b[^}]*\}\)/);
  });

  // ---- video calls may not be switched on yet ------------------------------------------------------------------------------------

  /** The attributes of the button whose words are `label`, as the server draws it. */
  const buttonAttrs = (html: string, label: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => text(m[2]) === label)?.[1] ?? "";

  await check("video calls not switched on yet: one plain line at the top, Start now and Create link switched off (not hidden) and pointing at it; the meetings, Delete included, stay as they are", () => {
    const LINE = "Video calls are not switched on yet. They start working once the video service is connected, a one-time step for an owner.";
    assert.equal(MEDIA_NOT_READY, LINE, "the words are exactly these");
    const off = markup["panel.mediaNotReady"];
    // The line: once, a status, at the very top of the panel.
    assert.equal(count(off, /data-media-note/g), 1);
    assert.ok(text(off).startsWith(LINE), "the first thing on the panel");
    assert.match(tags(off, "p").find((t) => t.includes("data-media-note")) ?? "", /role="status"/);
    // Switched off, not hidden, and each says why by pointing at the line.
    for (const label of ["Start a meeting now", "Create link"]) {
      const attrs = buttonAttrs(off, label);
      assert.match(attrs, /\bdisabled=""/, `${label}: switched off`);
      assert.ok(attrs.includes('aria-describedby="meet-media-note"'), `${label}: pointing at the line that says why`);
      const on = buttonAttrs(markup["panel.mixedAvailable"], label);
      assert.ok(on.length > 0 && !/\bdisabled=""/.test(on) && !on.includes("aria-describedby"), `${label}: on, and pointing at nothing, when the list has not said false`);
    }
    // Create link has no switched-off look of its own in the stylesheet (.btn-primary has one), so the panel gives it one.
    assert.ok(buttonAttrs(off, "Create link").includes("disabled:opacity-50") && buttonAttrs(off, "Create link").includes("disabled:cursor-not-allowed"), "and it looks switched off");
    // The dialog's first focus goes to Start now only while it is on: a disabled button cannot take it.
    assert.doesNotMatch(buttonAttrs(off, "Start a meeting now"), /data-autofocus/);
    assert.match(buttonAttrs(markup["panel.mixedAvailable"], "Start a meeting now"), /data-autofocus/);
    // The rest of the panel is as it was: every meeting, its links, and Delete on the ones that are the person's.
    assert.equal(count(off, /<li\b/g), 5);
    assert.equal(count(off, />Copy link</g), 5);
    assert.deepEqual([...off.matchAll(/data-delete="([^"]+)"/g)].map((m) => m[1]), ["m1", "m3", "m4"]);
    assert.ok(!/<button\b[^>]*data-delete="[^"]*"[^>]*\bdisabled=""/.test(off) && !/<button\b[^>]*data-first="[^"]*"[^>]*\bdisabled=""/.test(off), "no meeting's button is switched off");
    assert.ok(text(markup["panel.mediaNotReadyEmpty"]).includes("No meetings yet. Start one above."), "the empty list still reads as it did");
    // No other screen carries the line.
    for (const id of ["panel.loading", "panel.error", "panel.empty", "panel.mixedAvailable", "panel.mixedUnavailable", "panel.startMade"]) {
      assert.ok(!markup[id].includes("meet-media-note") && !text(markup[id]).includes("not switched on"), `${id}: no line`);
    }
    // The list's flag decides it, and nothing else: before the list answers, or when it failed, the buttons stay on
    // and the server decides (its refusal shows the same line: panelErrorWords).
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /const mediaNotReady = load\.status === "ready" && !load\.mediaReady;/, "off only once the list has said false");
    assert.match(panel, /mediaReady: res\.value\.mediaReady/, "read from the list");
    assert.match(panel, /if \(startBusy \|\| mediaNotReady\) return;/, "Start now does nothing while off, not even open a tab");
    assert.match(panel, /if \(laterBusy \|\| mediaNotReady\) return;/, "and neither does a form submitted with Enter");
    // When the list says so after the panel opened, the Start button it focused goes off and focus must not leave the panel.
    assert.match(panel, /querySelector<HTMLElement>\("\[data-media-note\]"\)\?\.focus\(\)/, "focus goes to the line, not out of the panel");
  });

  // ---- transcripts are opened on purpose, one at a time --------------------------------------------------------------------------

  /** The meetings (by id) whose Transcript button a screen draws, and the dashed codes its transcript boxes were asked for. */
  const toggles = (id: string) => [...markup[id].matchAll(/data-transcript-toggle="([^"]+)"/g)].map((m) => m[1]);
  const slots = (id: string) => [...markup[id].matchAll(/data-transcript-slot="([^"]+)"/g)].map((m) => m[1]);
  /** The opening tag of one meeting's Transcript button on a screen. */
  const toggleTag = (id: string, meeting: string) => tags(markup[id], "button").find((t) => t.includes(`data-transcript-toggle="${meeting}"`)) ?? "";
  /** One meeting's part of a screen: the text from its <li> to the next one. */
  const rowOf = (id: string, title: string) => markup[id].split(/<li\b/).find((part) => part.includes(title)) ?? "";

  await check("a Transcript button is offered only for a finished meeting that recorded, where recording runs; it starts closed and nothing is mounted", () => {
    for (const status of ["scheduled", "live", "ended"] as const) {
      for (const recordAudio of [true, false]) {
        for (const available of [true, false]) {
          assert.equal(showsTranscript({ status, recordAudio }, available), status === "ended" && recordAudio && available, `${status} / recordAudio ${recordAudio} / available ${available}`);
        }
      }
    }
    assert.deepEqual(toggles("panel.mixedAvailable"), ["m3", "m5"], "ended and recorded: its own and someone else's");
    assert.deepEqual(toggles("panel.mixedUnavailable"), [], "not where recording does not run, whatever the meetings say");
    assert.deepEqual(toggles("panel.rows"), ["r3"]);
    for (const id of ["panel.mixedAvailable", "panel.mixedUnavailable", "panel.rows", "panel.loading", "panel.empty", "panel.deleteAsk"]) {
      assert.deepEqual(slots(id), [], `${id}: no transcript is mounted until one is opened, so nothing reads a recording`);
    }
    // Closed: the button says what it does, says it is collapsed, and points at the box the transcript will go in.
    const closed = markup["panel.mixedAvailable"];
    for (const meeting of ["m3", "m5"]) {
      const tag = toggleTag("panel.mixedAvailable", meeting);
      assert.match(tag, /aria-expanded="false"/, `${meeting}: collapsed`);
      assert.ok(tag.includes(`aria-controls="meet-transcript-${meeting}"`), `${meeting}: points at its box`);
      assert.ok(tag.includes("min-h-11"), `${meeting}: a 44 px target on a phone`);
    }
    assert.equal(count(closed, /Transcript<\/button>/g), 2);
    assert.ok(!text(closed).includes("Hide transcript"));
    assert.match(closed, /<button[^>]*data-transcript-toggle="m3"[^>]*><svg[^>]*lucide-file-text[\s\S]*?<\/svg>Transcript<\/button>/, "with the document icon, before the words");
    // The gate is showsTranscript, asked of the row's own status and recording and of whether recording runs; nothing else decides.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /showsTranscript\(\{ status: row\.status, recordAudio: row\.recordAudio \}, recordingAvailable\)/, "the panel asks showsTranscript, nothing else");
    assert.match(panel, /\{hasTranscript \? \(\s*<button/, "and the button follows it");
    const app = readFileSync(join(root, "components", "calendar", "CalendarApp.tsx"), "utf8");
    assert.match(app, /import \{ MeetRecording \} from "@\/components\/meet\/MeetRecording";/);
    assert.match(app, /renderEnded=\{\(code\) => <MeetRecording code=\{code\} \/>\}/, "the Schedule puts the recording panel in the box");
    assert.match(app, /onMeetingDeleted=\{\(\) => void data\.reload\(\)\}/, "and loads its events again when a meeting that had a time is deleted (its Schedule entry goes with it)");
  });

  await check("an opened transcript draws below its own meeting, in the box its button points at; the button says Hide transcript; no other meeting's opens", () => {
    const mine = markup["panel.transcriptOpenMine"];
    assert.deepEqual(slots("panel.transcriptOpenMine"), ["ggg-hhhh-jjj"], "only the opened meeting's transcript, asked for by its dashed code");
    assert.deepEqual(slots("panel.transcriptOpenTheirs"), ["pqr-stuv-wxy"], "someone else's too: reading a transcript is not Delete");
    assert.deepEqual(slots("panel.rowsOpen"), ["ggg-hhhh-jjj"], "and in the plain three-meeting list");
    const row = rowOf("panel.transcriptOpenMine", "Mine (ended, audio)");
    assert.match(row, /<div id="meet-transcript-m3" class="mt-2 scroll-mb-24"><div data-transcript-slot="ggg-hhhh-jjj">Transcript for ggg-hhhh-jjj<\/div><\/div>/, "in its box (with room to grow into view), in its own row");
    assert.equal(transcriptBoxId("m3"), "meet-transcript-m3", "the box's id has one source");
    assert.ok(!rowOf("panel.transcriptOpenMine", "Theirs (ended, audio)").includes("data-transcript-slot"), "none under the other finished meeting");
    // The open one's button is expanded, says Hide transcript and points at the box that now exists; the other still says Transcript.
    const open = toggleTag("panel.transcriptOpenMine", "m3");
    assert.match(open, /aria-expanded="true"/);
    assert.ok(open.includes('aria-controls="meet-transcript-m3"') && mine.includes('id="meet-transcript-m3"'), "the id it points at is on the page");
    assert.match(row, /Hide transcript<\/button>/);
    assert.match(toggleTag("panel.transcriptOpenMine", "m5"), /aria-expanded="false"/);
    assert.equal(count(mine, /Hide transcript</g), 1);
    assert.equal(count(mine, /Transcript<\/button>/g), 1, "the other finished meeting's still says Transcript");
    assert.equal(count(mine, /id="meet-transcript-/g), 1, "one box on the page");
    // Whatever id the state holds, showsTranscript decides: a meeting that is not finished and recorded opens nothing.
    for (const id of ["m1", "m2", "m4"]) {
      const screen = `panel.transcriptOpen.${id}`;
      assert.deepEqual(slots(screen), [], `${id}: not a finished recorded meeting, so nothing opens`);
      assert.deepEqual(toggles(screen), ["m3", "m5"], `${id}: the same buttons as when nothing is open`);
      assert.equal(count(markup[screen], /aria-expanded="true"/g), 0, `${id}: and none of them says it is open`);
    }
    assert.deepEqual([slots("panel.transcriptOpenUnavailable"), toggles("panel.transcriptOpenUnavailable")], [[], []], "where recording does not run an id that was open draws nothing, and there is no button");
    assert.deepEqual([slots("panel.transcriptOpenNoRenderer"), toggles("panel.transcriptOpenNoRenderer")], [[], []], "with nowhere to put it there is no button either");
    // Open beside a Delete question on the same meeting: both show, the question first.
    const both = markup["panel.transcriptOpenAndAsk"];
    assert.ok(both.includes("data-transcript-slot") && buttonNames(both).includes("Delete for good"), "both are there");
    assert.ok(both.indexOf("Delete for good") < both.indexOf("data-transcript-slot"), "the question sits above the transcript");
  });

  await check("one transcript is open at a time: pressing another meeting's button switches to it, pressing the open one closes it, and the panel wires it", () => {
    assert.equal(toggledTranscript(null, "a"), "a", "nothing open: it opens");
    assert.equal(toggledTranscript("a", "a"), null, "the open one: it closes");
    assert.equal(toggledTranscript("a", "b"), "b", "another one open: that one closes and this one opens");
    assert.equal(toggledTranscript(toggledTranscript("a", "b"), "a"), "a", "and back again");
    // One id, not a list, so two cannot be open; closing the panel and deleting the meeting both put it away.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /transcriptOpen: string \| null;/, "the view is handed one id");
    assert.match(panel, /const \[transcriptOpen, setTranscriptOpen\] = useState<string \| null>\(null\);/, "and none is open to begin with");
    assert.match(panel, /onToggleTranscript=\{\(id\) => setTranscriptOpen\(\(prev\) => toggledTranscript\(prev, id\)\)\}/, "a press goes through the one rule");
    assert.match(panel, /const closePanel = useCallback\(\(\) => \{[^}]*setTranscriptOpen\(null\);/, "closing the panel closes it");
    assert.match(panel, /setTranscriptOpen\(\(prev\) => \(prev === id \? null : prev\)\);/, "deleting the meeting that has it open closes it");
    // The only place a transcript is asked for is the open row's box.
    assert.equal(count(panel, /renderEnded\?\.\(/g), 1, "one call, inside that box");
    assert.equal(count(panel, /renderEnded\(/g), 0, "and no other");
    // The box can open below what a phone shows, so it is brought into view (the next check), by the same id.
    assert.match(panel, /if \(transcriptOpen !== null\) bringIntoView\(transcriptBoxId\(transcriptOpen\)\);/, "an opened transcript is brought into view");
    assert.equal(count(panel, /transcriptBoxId\(/g), 2, "one call names a row's box (its id and its button's aria-controls), one names the box to scroll to");
  });

  await check("a box that opens below its button is brought into view by the least scrolling, once per new link: the transcript, Create link's link, and Start now's link when its tab was blocked", () => {
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    // One mechanism: one place scrolls, by the least amount, and without the animation for a person who asked for less motion.
    assert.equal(count(panel, /scrollIntoView\(/g), 1, "one place scrolls");
    assert.match(panel, /getElementById\(id\)\?\.scrollIntoView\(\{ block: "nearest"/, "by the least amount, and a box already in view stays where it is");
    assert.match(panel, /prefers-reduced-motion: reduce/, "with none of the animation for a person who asked for less motion");
    // Who asks for it, and what it hangs on.
    assert.match(panel, /if \(transcriptOpen !== null\) bringIntoView\(transcriptBoxId\(transcriptOpen\)\);\s*\}, \[transcriptOpen\]\);/, "an opened transcript, when one opens");
    assert.match(panel, /if \(created\) bringIntoView\(MADE_BOX_LATER\);\s*\}, \[created\]\);/, "Create link's link, once per new link: it hangs on the made object, which only a new link replaces");
    assert.match(panel, /if \(started && !started\.opened\) bringIntoView\(MADE_BOX_START\);\s*\}, \[started\]\);/, "Start now's link, only when its tab was blocked (otherwise the person is in the new tab)");
    // The boxes carry the ids it scrolls to, with the room to leave below them, and they do not exist before a link is made.
    assert.equal(MADE_BOX_START, "meet-made-start");
    assert.equal(MADE_BOX_LATER, "meet-made-later");
    for (const [screen, box] of [["panel.startMade", MADE_BOX_START], ["panel.startBlocked", MADE_BOX_START], ["panel.laterAdded", MADE_BOX_LATER], ["panel.laterNoLine", MADE_BOX_LATER]] as const) {
      assert.equal(count(markup[screen], new RegExp(`id="${box}"`, "g")), 1, `${screen}: one box with its id`);
      assert.match(markup[screen], new RegExp(`<div id="${box}" class="scroll-mb-4 rounded-lg`), `${screen}: and room left below it`);
    }
    for (const screen of ["panel.loading", "panel.rows", "panel.mixedAvailable", "panel.empty"]) assert.ok(!markup[screen].includes("meet-made-"), `${screen}: no box before a link is made`);
  });

  await check("a meeting just made says what the server did about recording; the list parser reads the whole link only if it is one", () => {
    assert.ok(text(markup["panel.madeRecorded"]).includes("Recorded and transcribed. Guests agree to that before they join."));
    assert.ok(text(markup["panel.madeUnrecorded"]).includes("Not recorded."));
    assert.ok(!text(markup["panel.madeUnrecorded"]).includes("Recorded and transcribed"));
    assert.ok(text(markup["panel.noRecordingMadeStart"]).includes("Not recorded."));
    for (const id of ["panel.laterNoLine", "panel.startMade"]) {
      assert.ok(!text(markup[id]).includes("Not recorded.") && !text(markup[id]).includes("Recorded and transcribed. Guests"), `${id}: no claim when the server did not say`);
    }
    const whole = "https://oasisai.work/meet/aaa-bbbb-ccc";
    assert.equal(parseRoomItem(roomJson({ url: whole }))?.url, whole);
    for (const bad of ["javascript:alert(1)", "/meet/aaa-bbbb-ccc", "ftp://oasisai.work/x", `${whole} extra`, `${whole}"onmouseover="x`, 42, null, ""]) {
      assert.equal(parseRoomItem(roomJson({ url: bad }))?.url, undefined, `not a link to trust: ${String(bad)}`);
    }
    // Both ends of the link's journey: parsed from the list, then handed on when the Copy link button is pressed.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /onCopy=\{\(key, link, url\) => void copy\(key, link, url\)\}/, "the whole link is not dropped on the way");
    assert.match(panel, /url: r\.url,/, "and a row carries it");
  });

  // ---- delete a meeting ----------------------------------------------------------------------------------------------------------

  await check("Delete is offered on the meetings the person made, and on no others; a meeting a lead booked is the booking's, not theirs to delete", () => {
    assert.equal(canDelete({ mine: true, leadId: null }), true);
    assert.equal(canDelete({ mine: false, leadId: null }), false);
    assert.equal(canDelete({ mine: true, leadId: "7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b" }), false, "the host's own booked meeting: cancel the booking instead");
    assert.equal(canDelete({ mine: false, leadId: "7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b" }), false);
    const html = markup["panel.mixedAvailable"];
    const deletes = [...html.matchAll(/data-delete="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(deletes, ["m1", "m3", "m4"], "mine only: not the live one and the ended one that are someone else's");
    assert.equal(count(html, /aria-label="Delete /g), 3);
    assert.ok(html.includes('aria-label="Delete Mine (not started)"'), "each one is named for its meeting");
    assert.deepEqual(markup["panel.empty"].match(/data-delete=/g) ?? [], []);
    assert.deepEqual([...markup["panel.mixedUnavailable"].matchAll(/data-delete="([^"]+)"/g)].map((m) => m[1]), ["m1", "m3", "m4"], "delete does not depend on recording");
  });

  await check("a meeting a lead booked has no Delete, even on the host's own: a plain link to the lead's page says where to cancel it", () => {
    const html = markup["panel.booked"];
    // Delete is on the meeting the host made themselves and on neither booked one.
    assert.deepEqual([...html.matchAll(/data-delete="([^"]+)"/g)].map((m) => m[1]), ["b3"]);
    // Each booked row says so in one link to that lead's page. It is a plain <a> (this file is shared with the room page,
    // which has no app shell) that leaves in the same tab.
    const links = [...html.matchAll(/<a href="(\/pipeline\/[^"]+)"([^>]*)>([^<]*)<\/a>/g)];
    assert.deepEqual(
      links.map((m) => [m[1], m[3]]),
      [
        ["/pipeline/7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b", BOOKED_BY_LEAD],
        ["/pipeline/c0ffee00-1111-4222-8333-444455556666", BOOKED_BY_LEAD],
      ],
    );
    for (const m of links) assert.ok(!/target=|rel=/.test(m[2]), "it opens in the same tab, as a plain link");
    assert.equal(BOOKED_BY_LEAD, "Booked by a lead. Cancel it from their page.");
    assert.equal(count(text(html), /Booked by a lead\./g), 2, "the words appear on the booked rows only");
    // Meetings no lead booked are exactly as they were.
    assert.ok(!markup["panel.mixedAvailable"].includes("/pipeline/") && !text(markup["panel.mixedAvailable"]).includes("Booked by a lead"));
    // The lead's page, by the id encoded; the list's lead id is kept only if it is shaped like one.
    assert.equal(leadPagePath("7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b"), "/pipeline/7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b");
    assert.equal(leadPagePath("a b/c"), "/pipeline/a%20b%2Fc");
    const withLead = (leadId: unknown) => parseRoomItem(roomJson({ leadId }))?.leadId;
    assert.equal(withLead("7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b"), "7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b");
    for (const bad of ["", "a b", "../x", "x/y", "a?b=1", "<b>", "x".repeat(101), 42, null, undefined]) assert.equal(withLead(bad), null, `not a lead id: ${String(bad)}`);
    assert.equal(parseRoomItem(roomJson())?.leadId, null, "a meeting no lead booked");
    // A stale panel pressed Delete for good on one: the server's refusal reads in the open question.
    assert.equal(deleteErrorWords(409, "booked_meeting"), BOOKED_DELETE_REFUSED);
    assert.equal(BOOKED_DELETE_REFUSED, "This meeting was booked by a lead. Cancel it from their page in the pipeline.");
    assert.equal(deleteErrorWords(409, null), DELETE_FAILED, "any other refusal keeps the general words");
    assert.ok(text(markup["panel.bookedDeleteRefused"]).includes(BOOKED_DELETE_REFUSED));
    // The panel hands each row its lead, so the screen above can read it; and the list reads the key the server's list sends.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /leadId: r\.leadId,/, "a row carries its lead");
    assert.match(readFileSync(join(root, "lib", "meet", "handlers.ts"), "utf8"), /leadId: r\.leadId/, "the server's list sends `leadId`, the key the panel reads");
  });

  await check("Delete is two steps: the button only asks; the question, in plain words, holds Delete for good and Cancel", () => {
    // Nothing is asked until Delete is pressed: no question, no Delete for good, anywhere.
    for (const id of ["panel.mixedAvailable", "panel.rows", "panel.mixedUnavailable"]) {
      assert.ok(!buttonNames(markup[id]).includes("Delete for good"), `${id}: no confirmation before Delete is pressed`);
      assert.ok(!text(markup[id]).includes("This deletes the meeting"), `${id}: no question yet`);
    }
    const html = markup["panel.deleteAsk"];
    assert.ok(text(html).includes("This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone."));
    assert.match(html, /<div role="group" aria-label="Delete Mine \(ended, audio\)"/, "a named group");
    assert.equal(count(html, />Delete for good</g), 1, "one question, on one meeting");
    assert.equal(count(html, /data-cancel-delete/g), 1);
    assert.ok(buttonNames(html).includes("Cancel"));
    assert.deepEqual([...html.matchAll(/data-delete="([^"]+)"/g)].map((m) => m[1]), ["m1", "m4"], "the one being asked about has no Delete button of its own while it asks");
    // The click on Delete asks, only the one on Delete for good deletes: no other button is wired to delete.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.equal(count(panel, /props\.onDelete\(/g), 1, "onDelete is bound once");
    assert.match(panel, /onClick=\{\(\) => props\.onAskDelete\(row\.id\)\}/, "Delete asks");
    assert.match(panel, /onClick=\{\(\) => props\.onDelete\(row\.id\)\}[^>]*>\s*\{del\.busy \? "Deleting\.\.\." : "Delete for good"\}/, "Delete for good deletes");
    assert.match(panel, /if \(!room \|\| !canDelete\(room\)\) return;/, "and the delete call itself refuses a meeting that is not the person's");
    // A question about a meeting that is not the person's is never drawn, whatever state it is handed.
    assert.ok(!text(markup["panel.deleteAskNotMine"]).includes("This deletes the meeting"));
    assert.ok(!buttonNames(markup["panel.deleteAskNotMine"]).includes("Delete for good"));
  });

  await check("the Delete question says what goes with that meeting: a recording only if it recorded, and a meeting that is on now is ended for everyone", () => {
    const RECORDED = "This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone.";
    const UNRECORDED = "This deletes the meeting, and its link stops working. It cannot be undone.";
    const LIVE = "The meeting is on now: this ends it for everyone in it. ";
    // Every status and every recording choice, spelled out in full.
    for (const [status, recordAudio, expected] of [
      ["scheduled", true, "This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone."],
      ["ended", true, "This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone."],
      ["scheduled", false, "This deletes the meeting, and its link stops working. It cannot be undone."],
      ["ended", false, "This deletes the meeting, and its link stops working. It cannot be undone."],
      ["live", true, "The meeting is on now: this ends it for everyone in it. This deletes the meeting, its recording and its transcript, here and on OASIS's computer. It cannot be undone."],
      ["live", false, "The meeting is on now: this ends it for everyone in it. This deletes the meeting, and its link stops working. It cannot be undone."],
    ] as const) {
      assert.equal(deleteConfirm({ status, recordAudio }), expected, `${status}, recordAudio ${recordAudio}`);
    }
    // And on the screen, in the question on that meeting's own row.
    const question = (id: string) => decode(/<div role="group"[^>]*><p[^>]*>([^<]*)<\/p>/.exec(markup[id])?.[1] ?? "");
    assert.equal(question("panel.deleteAsk"), RECORDED, "ended, recorded");
    assert.equal(question("panel.deleteAskScheduled"), RECORDED, "scheduled, recorded");
    assert.equal(question("panel.deleteAskUnrecorded"), UNRECORDED, "ended, never recorded");
    assert.equal(question("panel.deleteAskLive"), LIVE + RECORDED, "on now and recorded");
    assert.equal(question("panel.deleteAskLiveUnrecorded"), LIVE + UNRECORDED, "on now, never recorded");
    assert.ok(!/recording|transcript/.test(question("panel.deleteAskUnrecorded")), "a meeting that never recorded does not promise to delete a recording");
    // The words come from the meeting being asked about: there is no one sentence for every row any more.
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /<p className="text-xs leading-5 text-fg">\{deleteConfirm\(row\)\}<\/p>/, "the question reads deleteConfirm of its own row");
    for (const file of shippedFiles) assert.ok(!readFileSync(file, "utf8").includes("DELETE_CONFIRM"), `${rel(file)}: no constant that is the same on every row`);
  });

  await check("while a delete runs the question is busy and cannot be answered twice; a refusal shows inside it, in words", () => {
    const busy = markup["panel.deleteBusy"];
    assert.ok(buttonNames(busy).includes("Deleting..."), "working");
    assert.ok(!buttonNames(busy).includes("Delete for good"));
    const disabled = [...busy.matchAll(/<button\b[^>]*\bdisabled=""[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));
    assert.deepEqual(disabled, ["Deleting...", "Cancel"], "both answers are off until the server has answered");
    const refused = markup["panel.deleteError"];
    assert.match(refused, /<p role="alert"[^>]*>Only the host can delete this meeting\.<\/p>/);
    assert.ok(buttonNames(refused).includes("Delete for good") && buttonNames(refused).includes("Cancel"), "and the question stays open to try again or give up");
    assert.match(markup["panel.deleteNote"], /<p role="status"[^>]*>The meeting was deleted\.<\/p>/, "the line after one is gone is a status");
    assert.match(markup["panel.deleteNote"], /data-list-heading/, "the heading is where focus lands when the last row goes");
    assert.equal(deletedNote(0), "The meeting was deleted.");
    assert.equal(deletedNote(3), "The meeting was deleted. Some of its audio is still being removed from the server.");
  });

  await check("deleteMeeting asks the host route for a delete and maps every answer to plain words; only a real 404 means it is already gone", async () => {
    const answer = async (status: number, json: unknown, throws = false, raw?: string) => deleteMeeting("abc-defg-hjk", fakeFetch({ status, json, throws, raw }).fetch);
    const sent = fakeFetch({ status: 200, json: { ok: true, deleted: true, relayRemaining: 0 } });
    assert.deepEqual(await deleteMeeting("abc-defg-hjk", sent.fetch), { ok: true, relayRemaining: 0 });
    const call = c0(sent.calls);
    assert.equal(call.url, "/api/meet/abc-defg-hjk/host");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, '{"action":"delete"}');
    assert.equal((call.init.headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.cache, "no-store");
    const encoded = fakeFetch({ status: 200, json: { ok: true, deleted: true } });
    await deleteMeeting("a b/c", encoded.fetch);
    assert.equal(c0(encoded.calls).url, "/api/meet/a%20b%2Fc/host", "a code is encoded into the path");

    // Deleted: how many relay copies are left is read as a count, never trusted as one.
    assert.deepEqual(await answer(200, { ok: true, deleted: true, relayRemaining: 3 }), { ok: true, relayRemaining: 3 });
    assert.deepEqual(await answer(200, { ok: true, deleted: true, relayRemaining: "2" }), { ok: true, relayRemaining: 2 });
    for (const odd of [undefined, -4, "x", null, Number.NaN]) {
      assert.deepEqual(await answer(200, { ok: true, deleted: true, relayRemaining: odd }), { ok: true, relayRemaining: 0 }, String(odd));
    }
    assert.deepEqual(await answer(200, { ok: true, deleted: true, relayRemaining: 2.9 }), { ok: true, relayRemaining: 2 });

    // Not deleted, and the meeting is still there.
    const refused = async (status: number, error: string) => {
      const res = await answer(status, { ok: false, error });
      assert.ok(!res.ok, `${status} ${error}`);
      return { words: res.words, gone: res.gone };
    };
    assert.deepEqual(await refused(401, "sign_in_required"), { words: "Sign in again, then try once more.", gone: false });
    assert.deepEqual(await refused(403, "host_only"), { words: "Only the host can delete this meeting.", gone: false });
    assert.deepEqual(await refused(403, "cross_origin_refused"), { words: "This page could not reach the meeting service. Reload it and try again.", gone: false });
    assert.deepEqual(await refused(429, "rate_limited"), { words: "Too many tries. Wait a moment and try again.", gone: false });
    assert.deepEqual(await refused(500, "meet_unavailable"), { words: DELETE_FAILED, gone: false });
    assert.deepEqual(await refused(400, "invalid_body"), { words: DELETE_FAILED, gone: false });
    assert.deepEqual(await refused(502, "sfu_failed"), { words: DELETE_FAILED, gone: false });

    // Not there: the meeting was already deleted, so its row goes too.
    assert.deepEqual(await refused(404, "room_not_found"), { words: "This meeting was already deleted.", gone: true });
    assert.equal(ALREADY_DELETED, "This meeting was already deleted.");

    // Anything that is not the room API's own answer is a failure, never "gone".
    const page = await answer(404, null, false, "<html>Not Found</html>");
    assert.ok(!page.ok && !page.gone && page.words === DELETE_FAILED, "a 404 page from the platform");
    const noCode = await answer(404, { ok: false });
    assert.ok(!noCode.ok && !noCode.gone, "a 404 without the room API's code");
    const oddOk = await answer(200, { ok: true });
    assert.ok(!oddOk.ok && !oddOk.gone && oddOk.words === DELETE_FAILED, "ok without deleted: true is not a delete");
    const notDeleted = await answer(200, { ok: true, deleted: false });
    assert.ok(!notDeleted.ok && notDeleted.words === DELETE_FAILED);
    const down = await answer(0, null, true);
    assert.deepEqual(down, { ok: false, words: NO_CONNECTION, gone: false });
    for (const [status, code, expected] of [
      [401, null, "Sign in again, then try once more."],
      [403, "host_only", "Only the host can delete this meeting."],
      [404, "room_not_found", ALREADY_DELETED],
      [429, null, "Too many tries. Wait a moment and try again."],
      [500, null, DELETE_FAILED],
    ] as const) {
      assert.equal(deleteErrorWords(status, code), expected, `${status} ${String(code)}`);
    }
  });

  await check("a deleted meeting leaves the list and focus has somewhere to go: the row after it, else the one before, else the heading", () => {
    const room = (id: string): MeetRoomItem => {
      const item = parseRoomItem(roomJson({ id }));
      assert.ok(item, `room ${id}`);
      return item;
    };
    const list = ["a", "b", "c"].map(room);
    const cut = (rooms: MeetRoomItem[], id: string) => {
      const res = withoutMeeting(rooms, id);
      return { ids: res.rooms.map((r) => r.id), focusId: res.focusId };
    };
    assert.deepEqual(cut(list, "b"), { ids: ["a", "c"], focusId: "c" }, "from the middle: the one after");
    assert.deepEqual(cut(list, "a"), { ids: ["b", "c"], focusId: "b" }, "the first: the one after");
    assert.deepEqual(cut(list, "c"), { ids: ["a", "b"], focusId: "b" }, "the last: the one before");
    assert.deepEqual(cut([room("a")], "a"), { ids: [], focusId: null }, "the only one: nowhere, so the heading");
    assert.deepEqual(cut(list, "zzz"), { ids: ["a", "b", "c"], focusId: null }, "not in the list: nothing leaves");
    assert.equal(withoutMeeting(list, "zzz").rooms, list, "and the same list comes back");
    assert.deepEqual(list.map((r) => r.id), ["a", "b", "c"], "the list it was given is left as it was");
  });

  await check("the link to show and copy is the server's whole link when it sent one, else the page's own address plus the path", () => {
    const link = "/meet/aaa-bbbb-ccc";
    const whole = "https://oasisai.work/meet/aaa-bbbb-ccc";
    assert.equal(linkToSend("https://preview.example.test", { link, url: whole }), whole, "the app's own address wins over the page's");
    assert.equal(linkToSend("https://preview.example.test", { link }), "https://preview.example.test/meet/aaa-bbbb-ccc", "else the page's own");
    assert.equal(linkToSend("https://preview.example.test/", { link: "meet/aaa-bbbb-ccc" }), "https://preview.example.test/meet/aaa-bbbb-ccc", "slashes are tidied as meetingUrl does");
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.equal(count(panel, /linkToSend\(window\.location\.origin, /g), 3, "the link shown after Start now, the one after Create link, and the one Copy puts on the clipboard");
    assert.equal(count(panel, /meetingUrl\(window\.location\.origin, /g), 1, "the page's own address is used on its own only to open the tab, never to name a link to send");
  });

  await check("a deleted meeting's row, copy button and made link go too, and the panel wires it (the panel's own rules, in its source)", () => {
    const panel = readFileSync(join(root, "components", "meet", "MeetPanel.tsx"), "utf8");
    assert.match(panel, /if \(!res\.ok && !res\.gone\) \{\s*setDeleteError\(res\.words\);\s*return;\s*\}/, "a refusal keeps the meeting and the question");
    assert.match(panel, /const \{ focusId \} = withoutMeeting\(rooms, id\);/, "focus goes by the list the person was looking at");
    assert.match(panel, /focusNext\.current = focusId \? \{ kind: "row", id: focusId \} : \{ kind: "heading" \};/, "next row, else the heading");
    assert.match(panel, /rooms: withoutMeeting\(prev\.rooms, id\)\.rooms/, "its row is taken out of the list as it is now");
    assert.match(panel, /setNote\(res\.ok \? deletedNote\(res\.relayRemaining\) : ALREADY_DELETED\)/, "and one line says which it was");
    assert.match(panel, /if \(room\.startsAt\) onMeetingDeleted\?\.\(\);/, "a meeting that had a time takes its Schedule entry with it: the page is told");
    assert.match(panel, /prev\?\.link === room\.link \? null : prev/, "a link just made for it is not left on the screen");
    // Escape takes back the question before it closes the panel, and never while the server is working.
    assert.match(panel, /if \(askingRef\.current !== null\) cancelDelete\(\);\s*else closePanel\(\);/);
    assert.match(panel, /useDialogFocus\(panelRef, onEscape, open\);/);
    assert.match(panel, /if \(deletingRef\.current\) return;/);
    // The ref Escape reads and the state that draws change together, in one place, so they cannot drift apart.
    assert.equal(count(panel, /askingRef\.current = /g), 1);
    assert.equal(count(panel, /\bsetAsking\(/g), 1);
  });

  // ---- shared rules over every screen --------------------------------------------------------------------------------------

  await check("every control on a screen is a 44 px touch target (a checkbox's label carries it)", () => {
    for (const [id, html] of Object.entries(markup)) {
      for (const tag of [...tags(html, "button"), ...tags(html, "a"), ...tags(html, "select"), ...tags(html, "input")]) {
        if (/type="checkbox"/.test(tag)) continue;
        assert.match(tag, /\b(min-h-11|min-h-14|h-11)\b/, `${id}: ${tag.slice(0, 140)}`);
      }
      for (const label of html.matchAll(/<label\b[^>]*>/g)) {
        if (/flex/.test(label[0])) assert.match(label[0], /min-h-11/, `${id}: a checkbox label is a 44 px target`);
      }
    }
  });

  await check("plain words and plain bytes: no internal name on any screen, ASCII only, no emoji", () => {
    for (const [id, html] of Object.entries(markup)) {
      assert.ok(!/turso|libsql|supabase|cloudflare|\bsfu\b|webrtc|realtime|maven|bravo|atlas|participant token|tenant/i.test(text(html)), `${id} names something internal`);
      assert.ok(!/[^\x00-\x7f]/.test(html), `${id} holds a non-ASCII byte`);
    }
  });

  await check("a page without the app shell: leaving it is a plain <a>, never next/link; no confirm(), alert() or prompt(); no console.log", () => {
    assert.ok(shippedFiles.some((f) => rel(f) === "components/meet/MeetEnded.tsx") && shippedFiles.some((f) => rel(f) === "app/meet/[code]/page.tsx"), "the walk found the screens");
    for (const file of shippedFiles) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "next/link") found.push("imports next/link");
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ["window", "console"].includes(callee.expression.text)
              ? `${callee.expression.text}.${callee.name.text}`
              : "";
          if (["confirm", "alert", "prompt", "window.confirm", "window.alert", "window.prompt", "console.log"].includes(name)) found.push(`${name}() at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      assert.deepEqual(found, [], `${rel(file)} breaks a rule`);
    }
  });

  await check("every file written for Oasis Meet's screens is ASCII", () => {
    assert.ok(ownFiles.length > 20, "the walk found the files");
    const bad: string[] = [];
    for (const file of ownFiles) {
      const bytes = readFileSync(file);
      const at = bytes.findIndex((b) => b > 0x7f);
      if (at >= 0) bad.push(`${rel(file)} byte ${at}`);
    }
    assert.deepEqual(bad, []);
  });

  await check("the room's page leaves the call when it closes: pagehide sends the beacon to this room's leave route, from the tab in the room only", () => {
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /addEventListener\("pagehide", onHide\)/);
    assert.match(room, /navigator\.sendBeacon\(`\/api\/meet\/\$\{code\}\/leave`\)/);
    assert.match(
      room,
      /if \(controller\.inRoom\(\) && typeof navigator\.sendBeacon === "function"\) navigator\.sendBeacon/,
      "only from the tab that holds the room: another tab of this browser shares its cookie, and its place must not end",
    );
    assert.match(room, /if \(inCall\(\)\) void controller\.leave\(\);/, "and unmounting in a call leaves properly");
  });

  await check("a meeting already open in another tab of this browser: the words, and Join here instead, offered for that failure only", () => {
    const html = markup["prejoin.openElsewhere"];
    assert.ok(text(html).includes(meetErrorWords("open_in_another_tab")), "the words");
    assert.ok(buttonNames(html).includes(JOIN_HERE), "and the way to move the meeting to this tab");
    assert.ok(!buttonNames(markup["prejoin.notWaiting"]).includes(JOIN_HERE), "never on a plain pre-join screen");
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(
      room,
      /onJoinHere=\{phase\.kind === "failed" && phase\.code === "open_in_another_tab" \? \(\) => void join\(\{ here: true \}\) : undefined\}/,
      "the room offers it only for that failure, and it joins through the same gates as Join now",
    );
  });

  // ---- the page's data: link, redirect, ended, who is looking --------------------------------------------------------------

  await check("the limits the screens use equal the server's", () => {
    assert.equal(NAME_MAX_CHARS, MEET_NAME_MAX);
    assert.equal(TITLE_MAX_CHARS, MEET_TITLE_MAX);
  });

  await check("every server code the panel words by name is one the server sends: a rename on either side fails here, not in front of a person", () => {
    // The codes are read out of the panel's own code, so a code added there is checked without anyone remembering to list it.
    const panelSource = ["meet-format.ts", "meet-api.ts"].map((f) => readFileSync(join(root, "components", "meet", f), "utf8")).join("\n");
    const named = new Set([...panelSource.matchAll(/(?:code|found) === "([a-z][a-z_]+)"/g)].map((m) => m[1]));
    const unreached = /const SCHEDULE_UNREACHED = "([a-z_]+)";/.exec(panelSource)?.[1];
    assert.ok(unreached, "the panel names the code for a Schedule that could not be reached");
    named.add(unreached);
    for (const code of ["sign_in_required", "invalid_body", "cross_origin_refused", "meet_not_configured", "host_only", "booked_meeting", "room_not_found", "rate_limited", "schedule_unavailable"]) {
      assert.ok(named.has(code), `${code} is one the panel words by name (found: ${[...named].join(", ")})`);
    }
    const server = ["handlers.ts", "access.ts", "http.ts"].map((f) => readFileSync(join(root, "lib", "meet", f), "utf8")).join("\n");
    for (const code of named) assert.ok(server.includes(`"${code}"`), `the panel words "${code}", but the server never sends it`);
    // The one whose wrong words would be harmful: a made meeting told to "try again" makes a second one.
    assert.match(server, /const SCHEDULE_UNAVAILABLE = "schedule_unavailable";/, "the server's code for a Schedule it could not reach");
    assert.ok(scheduleLine({ added: false, reason: "schedule_unavailable" }, messageFor).includes("could not be reached"), "is the one the panel says the special words for");
  });

  await check("/meet is public and drawn without the app shell, exactly like /book; the host's panel API stays signed in", () => {
    assert.ok(FULL_BLEED_PREFIXES.includes("/meet"));
    for (const path of ["/meet/abc-defg-hjk", "/meet/x"]) {
      assert.ok(isFullBleedPath(path), `${path} is full-bleed`);
      assert.ok(isPublic(path), `${path} is public`);
    }
    assert.ok(!isFullBleedPath("/meetings") && !isPublic("/meetings"), "a shared prefix is not enough");
    assert.ok(isPublic("/api/meet/abc-defg-hjk/join"));
    assert.ok(!isPublic("/api/calendar/meet"), "the Schedule panel's calls need a session");
  });

  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "meet-ui-")), "test.db")}` });
  await db.executeMultiple(readFileSync(join(root, "database", "turso", "bravo__230_meet_rooms.sql"), "utf8"));
  // What a booked room's page reads of its lead: the lead's own record in the room's workspace (an id, the workspace, the
  // kind of record, and the form's fields as JSON text).
  await db.execute("CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL)");
  const record = (id: string, tenantId: string, entityType: string, data: object) =>
    db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)", args: [id, tenantId, entityType, JSON.stringify(data)] });
  await record("lead-secret-1", OASIS, "lead", { contact_name: "jane doe", business_name: "Doe Plumbing", email: "jane@doeplumbing.example" });
  await record("lead-2", OASIS, "lead", { name: "Omar Haddad" });
  await record("lead-nameless", OASIS, "lead", { business_name: "Acme Plumbing", email: "info@acme.example" });
  await record("lead-company", OASIS, "lead", { name: "Acme Plumbing", business_name: "Acme Plumbing" });
  await record("lead-elsewhere", OTHER, "lead", { name: "Priya Raman" });
  await record("lead-not-a-lead", OASIS, "client", { name: "Sam Lee" });
  const recorded = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Quarterly review", recordAudio: true });
  const plain = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Standup", recordAudio: false, leadId: "lead-secret-1" });
  const finished = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Finished" });
  const bookedAt = "2026-10-20T18:00:00.000Z";
  const booked = (leadId: string, title: string) => createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title, recordAudio: true, leadId, startsAt: bookedAt });
  const bookedOmar = await booked("lead-2", "OASIS call with Omar");
  const bookedNameless = await booked("lead-nameless", "OASIS call with a lead");
  const bookedCompany = await booked("lead-company", "OASIS call with Acme");
  const bookedElsewhere = await booked("lead-elsewhere", "OASIS call with Priya");
  const bookedNotALead = await booked("lead-not-a-lead", "OASIS call with Sam");
  const bookedMissing = await booked("lead-gone", "OASIS call (lead deleted)");
  await endMeetRoom(db, finished, "host_ended", new Date());
  type Session = Parameters<typeof loadMeetPage>[1]["session"];
  const load = (raw: string, session: Session = signedOut) => loadMeetPage(raw, { db: () => db, session });
  const dashed = displayMeetCode(recorded.code);

  await check("the loader: not a code and no such room are not found; a wrong spelling goes to the dashed address", async () => {
    for (const junk of ["", "nope", "abc-defg", "abc-defg-hjkx", "abc_defg_hjk", "abc-defg-hj1", "a".repeat(80)]) {
      assert.deepEqual(await load(junk), { kind: "not_found" }, junk.slice(0, 20));
    }
    assert.deepEqual(await load("abc-defg-hjk"), { kind: "not_found" }, "a well-formed code nobody holds");
    assert.deepEqual(await load(dashed.toUpperCase()), { kind: "redirect", to: `/meet/${dashed}` }, "upper case");
    assert.deepEqual(await load(recorded.code), { kind: "redirect", to: `/meet/${dashed}` }, "no dashes");
    assert.deepEqual(await load(dashed.replace(/-/g, " ")), { kind: "redirect", to: `/meet/${dashed}` }, "spaces");
    assert.equal((await load(dashed)).kind, "room");
  });

  await check("the loader: the room's props are the eight the screen needs, and never the workspace, the host or a lead's id", async () => {
    const data = await load(dashed);
    assert.ok(data.kind === "room");
    assert.deepEqual(data.props, { code: dashed, title: "Quarterly review", status: "scheduled", recordAudio: true, viewer: "visitor", creator: false, startsAt: null, guestName: null });
    const json = JSON.stringify(data);
    for (const secret of [OASIS, CC, "tenant", "hostUser", "leadId", "lead-secret-1"]) assert.ok(!json.includes(secret), `the props leak ${secret}`);
    const other = await load(displayMeetCode(plain.code));
    assert.ok(other.kind === "room" && other.props.recordAudio === false && other.props.title === "Standup");
    assert.ok(!JSON.stringify(other).includes("lead-secret-1"));
  });

  await check("the loader: a booked room hands its visitor the lead's first name and the time, and nothing else about the lead; no name to give leaves the field empty", async () => {
    const props = async (room: { code: string }, session: Session = signedOut) => {
      const data = await load(displayMeetCode(room.code), session);
      assert.ok(data.kind === "room");
      return data.props;
    };
    // The first name only, written the way the CRM's emails greet them (an all-lowercase name is capitalised).
    const jane = await props(plain);
    assert.deepEqual([jane.guestName, jane.startsAt], ["Jane", null], "no time was given for this one");
    const omar = await props(bookedOmar);
    assert.deepEqual([omar.guestName, omar.startsAt], ["Omar", bookedAt], "the room's own time is kept");
    for (const [given, more] of [[omar, ["Haddad", "lead-2", "leadId", "lead_id"]], [jane, ["Doe", "Plumbing", "jane@", "lead-secret-1", "leadId"]]] as const) {
      const json = JSON.stringify(given);
      for (const leak of more) assert.ok(!json.includes(leak), `the props leak ${leak}`);
    }
    // Nothing to give: no name on the lead, a "name" that is really the company's, a lead of another workspace, a record that
    // is not a lead, a lead that is gone, and a room no lead booked.
    for (const [what, room] of [["no name on the lead", bookedNameless], ["the company's name", bookedCompany], ["a lead of another workspace", bookedElsewhere], ["a record that is not a lead", bookedNotALead], ["a lead that is gone", bookedMissing], ["a room no lead booked", recorded]] as const) {
      assert.equal((await props(room)).guestName, null, what);
    }
  });

  await check("the loader: only a visitor is offered the lead's name; the creator, a second host and a member use their own account", async () => {
    const nameFor = async (session: Session) => {
      const data = await load(displayMeetCode(bookedOmar.code), session);
      assert.ok(data.kind === "room");
      return data.props.guestName;
    };
    assert.equal(await nameFor(signedOut), "Omar");
    assert.equal(await nameFor(as(REP, OTHER, true)), "Omar", "signed in to another workspace reads as a visitor");
    for (const [who, session] of [["the creator", as(CC)], ["a second host", as(ADON, OASIS, true)], ["a member", as(REP)]] as const) {
      assert.equal(await nameFor(session), null, who);
    }
    // A visitor only because the session lookup failed may be the host, whose join then finds their session: handed the
    // lead's name, they would join, and be transcribed, as the lead.
    const lookupFails = () => sessionOrVisitor(async () => { throw new Error("the session store is down"); }, () => undefined);
    assert.equal(await nameFor(lookupFails), null, "a page that could not tell who this is never offers the lead's name");
    const host = await load(displayMeetCode(bookedOmar.code), as(CC));
    assert.ok(host.kind === "room" && host.props.startsAt === bookedAt, "a host's page still knows the time");
  });

  await check("the loader: a lead lookup that fails leaves the name empty and still opens the room, and says so in the log", async () => {
    const failing = Object.create(db, {
      execute: {
        value: (statement: unknown) => {
          const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
          return sql.includes("tenant_records") ? Promise.reject(new Error("the records are down")) : db.execute(statement as never);
        },
      },
    }) as typeof db;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const data = await loadMeetPage(displayMeetCode(bookedOmar.code), { db: () => failing, session: signedOut });
      assert.ok(data.kind === "room" && data.props.guestName === null && data.props.startsAt === bookedAt, "the room opens, without a name");
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1, "one line in the log");
    assert.match(String(logged[0][0]), /^\[meet\.guest_name\]/);
  });

  await check("the loader: who is looking is the host, a member or a visitor", async () => {
    const viewerOf = async (session: Session) => {
      const data = await load(dashed, session);
      assert.ok(data.kind === "room");
      return data.props.viewer;
    };
    assert.equal(await viewerOf(as(CC)), "host", "the room's creator");
    assert.equal(await viewerOf(as(ADON, OASIS, true)), "host", "an owner or admin of the workspace");
    assert.equal(await viewerOf(as(REP)), "member", "signed in to the workspace, not the host");
    assert.equal(await viewerOf(as(REP, OTHER, true)), "visitor", "signed in to ANOTHER workspace is a visitor, admin or not");
    assert.equal(await viewerOf(signedOut), "visitor");
    assert.equal(meetViewerFor({ ok: false }, { tenantId: OASIS, hostUserId: CC }), "visitor");
  });

  await check("the loader: `creator` is the person who made the room, signed in to its own workspace, and nobody else", async () => {
    const read = async (session: Session) => {
      const data = await load(dashed, session);
      assert.ok(data.kind === "room");
      return { creator: data.props.creator, viewer: data.props.viewer };
    };
    assert.deepEqual(await read(as(CC)), { creator: true, viewer: "host" }, "the room's creator");
    assert.deepEqual(await read(as(CC, OASIS, true)), { creator: true, viewer: "host" }, "the creator who is also an admin");
    assert.deepEqual(await read(as(ADON, OASIS, true)), { creator: false, viewer: "host" }, "a second host: another owner or admin of the workspace is a host, but not the creator");
    assert.deepEqual(await read(as(REP)), { creator: false, viewer: "member" }, "a member");
    // The same user id signed in to ANOTHER workspace is not the creator, whatever their role there: a user id alone is never enough.
    assert.deepEqual(await read(as(CC, OTHER)), { creator: false, viewer: "visitor" }, "the creator's user id in another workspace");
    assert.deepEqual(await read(as(CC, OTHER, true)), { creator: false, viewer: "visitor" }, "...even as an admin there");
    assert.deepEqual(await read(signedOut), { creator: false, viewer: "visitor" }, "signed out");
    // The helper alone, against the same row shape.
    const row = { tenantId: OASIS, hostUserId: CC };
    assert.equal(meetCreatorFor({ ok: true, tenantId: OASIS, userId: CC, isTrueAdmin: false }, row), true);
    assert.equal(meetCreatorFor({ ok: true, tenantId: OTHER, userId: CC, isTrueAdmin: true }, row), false, "the tenant is part of the rule");
    assert.equal(meetCreatorFor({ ok: true, tenantId: OASIS, userId: ADON, isTrueAdmin: true }, row), false);
    assert.equal(meetCreatorFor({ ok: false }, row), false);
    // The unrecorded room reads the same: who made it does not depend on whether it records.
    const plainData = await load(displayMeetCode(plain.code), as(CC));
    assert.ok(plainData.kind === "room" && plainData.props.creator === true && plainData.props.recordAudio === false);
    // It is one yes or no: even the creator's props carry no user or workspace id for the client to compare.
    const mine = JSON.stringify(await load(dashed, as(CC)));
    assert.ok(!mine.includes(CC) && !mine.includes(OASIS), "no ids in the creator's props");
  });

  await check("the seam: what the page's own loader makes of a real session and room, drawn by the real room: a second host reads the notice and waits for the tick, the creator does not", async () => {
    // Every kind of person, on a recorded room and on one that does not record. The props are exactly what the loader
    // answered; nothing is set by hand between who is looking and what the screen shows (the bug lived in this seam).
    const who: Record<string, Session> = { creator: as(CC), secondHost: as(ADON, OASIS, true), member: as(REP), creatorIdElsewhere: as(CC, OTHER), visitor: signedOut };
    const props: Record<string, object> = {};
    for (const [name, session] of Object.entries(who)) {
      for (const [room, code] of [["recorded", dashed], ["plain", displayMeetCode(plain.code)]] as const) {
        const data = await load(code, session);
        assert.ok(data.kind === "room", `${name} / ${room}`);
        props[`${room}.${name}`] = data.props;
      }
    }
    const drawn = renderMarkup(props);
    const screen = (key: string) => {
      const html = drawn[`loaded.${key}`];
      assert.ok(html, `${key} was drawn`);
      const words = text(html);
      return {
        notice: words.includes(RECORDING_NOTICE),
        tick: tags(html, "input").some((t) => t.includes('id="meet-consent"')),
        cameraStep: words.includes(DEVICES_BUTTON),
        waitsForTick: words.includes(TICK_FIRST),
      };
    };
    // A recorded room: only its creator is told and may go on. Everyone else, a second host included, reads the notice, and the camera waits.
    assert.deepEqual(screen("recorded.creator"), { notice: false, tick: false, cameraStep: true, waitsForTick: false }, "the creator");
    for (const name of ["secondHost", "member", "creatorIdElsewhere", "visitor"]) {
      assert.deepEqual(screen(`recorded.${name}`), { notice: true, tick: true, cameraStep: false, waitsForTick: true }, `${name}: the notice, and no camera step until the tick`);
    }
    // A room that does not record has no notice for anyone.
    for (const name of Object.keys(who)) {
      assert.deepEqual(screen(`plain.${name}`), { notice: false, tick: false, cameraStep: true, waitsForTick: false }, `plain.${name}`);
    }
  });

  await check("the seam, for a booked room: the loader's own props, drawn by the real room, start a visitor's name field with the lead's first name and a member's empty", async () => {
    const propsOf = async (session: Session) => {
      const data = await load(displayMeetCode(bookedOmar.code), session);
      assert.ok(data.kind === "room");
      return data.props;
    };
    const drawn = renderMarkup({ visitor: await propsOf(signedOut), member: await propsOf(as(REP)), host: await propsOf(as(CC)) });
    const field = (key: string) => tags(drawn[`loaded.${key}`], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(field("visitor"), /\bvalue="Omar"/);
    assert.match(field("member"), /\bvalue=""/);
    assert.match(field("host"), /\bvalue=""/);
    for (const key of ["visitor", "member", "host"]) assert.ok(!text(drawn[`loaded.${key}`]).includes("Haddad"), `${key}: only the first name reaches the page`);
  });

  await check("the loader: an ended room is the plain ended page, whoever opens it", async () => {
    assert.deepEqual(await load(displayMeetCode(finished.code)), { kind: "ended", viewer: "visitor" });
    assert.deepEqual(await load(displayMeetCode(finished.code), as(CC)), { kind: "ended", viewer: "host" });
    assert.ok(!JSON.stringify(await load(displayMeetCode(finished.code))).includes("Finished"), "not even its title");
  });

  await check("the loader reads the database only for a real-looking code; a session lookup that throws reads as signed out and is logged", async () => {
    let opened = 0;
    const lazy = { db: () => { opened += 1; return db; }, session: signedOut };
    await loadMeetPage("nope", lazy);
    await loadMeetPage(dashed.toUpperCase(), lazy);
    assert.equal(opened, 0, "junk and redirects never touch the database");
    await loadMeetPage(dashed, lazy);
    assert.equal(opened, 1);

    const logged: Array<[string, unknown]> = [];
    const outage = new Error("profile resolution unavailable");
    const session = await sessionOrVisitor(async () => { throw outage; }, (m, e) => logged.push([m, e]));
    assert.deepEqual(session, { ok: false, lookupFailed: true }, "signed out for the page, and known to be a failed lookup");
    assert.equal(logged.length, 1);
    assert.equal(logged[0][1], outage);
    assert.match(logged[0][0], /^\[meet\.page\]/);
    assert.deepEqual(await sessionOrVisitor(as(CC)), { ok: true, tenantId: OASIS, userId: CC, isTrueAdmin: false });
  });

  await check("the page is dynamic, calls notFound() and redirect(), and passes the client nothing but the loader's props", () => {
    const page = readFileSync(join(root, "app", "meet", "[code]", "page.tsx"), "utf8");
    assert.match(page, /export const dynamic = "force-dynamic";/);
    assert.match(page, /params: Promise<\{ code: string \}>/);
    assert.match(page, /notFound\(\);/);
    assert.match(page, /redirect\(data\.to\);/);
    assert.match(page, /<MeetRoomLive \{\.\.\.data\.props\} \/>/, "the room, with the host-browser recorder plugged in (components/meet/MeetRoomLive.tsx)");
    assert.match(page, /robots: \{ index: false, follow: false \}/);
    for (const secret of ["tenantId", "hostUserId", "leadId"]) assert.ok(!page.includes(secret), `the page names ${secret}`);
  });

  // ---- the Schedule panel's calls, against a stand-in fetch ----------------------------------------------------------------

  await check("Start now posts an empty body: no time, no time zone, nothing about the Schedule", async () => {
    const f = fakeFetch({ status: 201, json: { ok: true, room: roomJson() } });
    const made = await createMeeting({}, f.fetch);
    assert.ok(made.ok);
    assert.equal(made.value.room.link, "/meet/aaa-bbbb-ccc");
    assert.equal(made.value.schedule, null, "Start now gets no schedule answer");
    assert.deepEqual(f.calls.map((c) => [c.url, c.init.method, c.init.body]), [["/api/calendar/meet", "POST", "{}"]]);
    assert.equal((c0(f.calls).init.headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(c0(f.calls).init.credentials, "same-origin");
    assert.equal(c0(f.calls).init.cache, "no-store");
  });

  await check("a link for later sends the time with the browser's time zone, an optional length and the recording choice; the answer's schedule note is read", async () => {
    const body = { title: "Kickoff", startsAt: "2030-01-01T15:00:00.000Z", timeZone: "America/Toronto", minutes: 45, recordAudio: false };
    const added = fakeFetch({ status: 201, json: { ok: true, room: roomJson({ startsAt: body.startsAt }), schedule: { added: true } } });
    const a = await createMeeting(body, added.fetch);
    assert.ok(a.ok);
    assert.deepEqual(JSON.parse(String(c0(added.calls).init.body)), body);
    assert.deepEqual(a.value.schedule, { added: true });
    const refused = fakeFetch({ status: 201, json: { ok: true, room: roomJson(), schedule: { added: false, reason: "shabbat_protected" } } });
    const r = await createMeeting(body, refused.fetch);
    assert.ok(r.ok);
    assert.deepEqual(r.value.schedule, { added: false, reason: "shabbat_protected" });
    assert.equal(
      scheduleLine(r.value.schedule!, messageFor),
      "The link works, but it is not on your Schedule. That time is inside Shabbat, which is protected. Pick another time.",
    );
    assert.equal(scheduleLine({ added: true }, messageFor), "Added to your Schedule.");
    for (const junk of [undefined, null, 7, "yes", {}, { added: "true" }, { added: false }, { added: false, reason: "  " }, { added: false, reason: 5 }, { added: false, why: "the old shape" }]) {
      assert.equal(parseScheduleNote(junk), null, JSON.stringify(junk));
    }
    assert.equal((parseScheduleNote({ added: false, reason: "x".repeat(500) }) as { reason: string }).reason.length, 80, "a long code is cut");
  });

  await check("a refused create is plain words: signed out, a bad body, a server fault, no connection, a body that is not a meeting", async () => {
    const words = async (status: number, json: unknown, throws = false) => {
      const made = await createMeeting({}, fakeFetch({ status, json, throws }).fetch);
      assert.ok(!made.ok);
      return made.words;
    };
    assert.equal(await words(401, { ok: false, error: "sign_in_required" }), "Sign in again, then try once more.");
    assert.equal(await words(400, { ok: false, error: "invalid_body" }), "That title or time was not accepted. Check it and try again.");
    assert.equal(await words(403, { ok: false, error: "cross_origin_refused" }), "This page could not reach the meeting service. Reload it and try again.");
    assert.equal(await words(500, { ok: false, error: "meet_unavailable" }), meetErrorWords("unknown"));
    const page = await createMeeting({}, fakeFetch({ status: 500, raw: "<html>boom: stack trace</html>" }).fetch);
    assert.ok(!page.ok);
    assert.equal(page.words, "Something went wrong. Try again.", "a page of server text never reaches the screen");
    assert.equal(await words(0, null, true), "No connection. Check it and try again.");
    assert.equal(await words(201, { ok: true, room: { id: 1 } }), "Something went wrong. Try again.", "201 with a body that is not a meeting");
    // Video not connected yet: the panel says what to do about it, in the same words as its own line; the room page
    // keeps its own, shorter words for a guest, who can do nothing about it.
    assert.equal(await words(503, { ok: false, error: "meet_not_configured" }), "Video calls are not switched on yet. They start working once the video service is connected, a one-time step for an owner.");
    assert.equal(panelErrorWords(503, "meet_not_configured"), MEDIA_NOT_READY);
    assert.equal(meetErrorWords("meet_not_configured"), "Meetings are not set up yet. Ask the host to finish the setup.", "the room page's own words for a guest");
    assert.notEqual(MEDIA_NOT_READY, meetErrorWords("meet_not_configured"));
  });

  await check("listMeetings reads whether recording runs, and says false unless the server says true", async () => {
    const rooms = [roomJson(), roomJson({ id: "r2", code: "ddd-eeee-fff", status: "live" })];
    const read = async (extra: Record<string, unknown>) => {
      const res = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms, ...extra } }).fetch);
      assert.ok(res.ok);
      return res.value.recordingAvailable;
    };
    assert.equal(await read({ recordingAvailable: true }), true);
    assert.equal(await read({ recordingAvailable: false }), false);
    assert.equal(await read({}), false, "a missing field is false: a server that has not heard of recording does not record");
    for (const odd of ["true", 1, "yes", null, {}, []]) assert.equal(await read({ recordingAvailable: odd }), false, `${JSON.stringify(odd)} is not true`);
    const both = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms, recordingAvailable: true } }).fetch);
    assert.ok(both.ok && both.value.rooms.length === 2, "the meetings come with it");
    assert.deepEqual(parseRoomList({ rooms: [], recordingAvailable: true }), { rooms: [], recordingAvailable: true, mediaReady: false });
    assert.deepEqual(parseRoomList({ rooms: [] }), { rooms: [], recordingAvailable: false, mediaReady: false });
    assert.equal(parseRoomList({ recordingAvailable: true }), null, "no rooms list is not a list");
  });

  await check("listMeetings reads whether video calls can connect, and says false unless the server says true", async () => {
    const rooms = [roomJson()];
    const read = async (extra: Record<string, unknown>) => {
      const res = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms, ...extra } }).fetch);
      assert.ok(res.ok);
      return res.value.mediaReady;
    };
    assert.equal(await read({ mediaReady: true }), true);
    assert.equal(await read({ mediaReady: false }), false);
    assert.equal(await read({}), false, "a missing field is false, the same as recordingAvailable");
    for (const odd of ["true", 1, "yes", null, {}, []]) assert.equal(await read({ mediaReady: odd }), false, `${JSON.stringify(odd)} is not true`);
    // The two flags are read on their own.
    const mixed = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms, recordingAvailable: true, mediaReady: false } }).fetch);
    assert.ok(mixed.ok && mixed.value.recordingAvailable === true && mixed.value.mediaReady === false);
    assert.deepEqual(parseRoomList({ rooms: [], mediaReady: true }), { rooms: [], recordingAvailable: false, mediaReady: true });
  });

  await check("the recent list: the API's meetings, or plain words when it cannot", async () => {
    const ok = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms: [roomJson(), roomJson({ id: "r2", code: "ddd-eeee-fff", status: "live" })] } }).fetch);
    assert.ok(ok.ok);
    assert.deepEqual(ok.value.rooms.map((r) => [r.code, r.status]), [["aaa-bbbb-ccc", "scheduled"], ["ddd-eeee-fff", "live"]]);
    const get = fakeFetch({ status: 200, json: { ok: true, rooms: [] } });
    await listMeetings(get.fetch);
    assert.equal(c0(get.calls).init.method, "GET");
    const words = async (status: number, json: unknown, throws = false) => {
      const res = await listMeetings(fakeFetch({ status, json, throws }).fetch);
      assert.ok(!res.ok);
      return res.words;
    };
    assert.equal(await words(401, { ok: false }), "Sign in again, then try once more.");
    assert.equal(await words(500, { ok: false }), "Your meetings could not load.");
    assert.equal(await words(200, { ok: true, rooms: [{ id: "x" }] }), "Your meetings could not load.", "a meeting shaped wrong is not drawn");
    assert.equal(await words(200, { ok: true }), "Your meetings could not load.");
    assert.equal(await words(0, null, true), "No connection. Check it and try again.");
  });

  await check("meetings and times in words: status, when, link, initials, columns, who shares", () => {
    assert.deepEqual(STATUS_WORDS, { scheduled: "Scheduled", live: "Live now", ended: "Ended" });
    const when = timeFormatter("UTC", "en-US");
    const plainWhen = (iso: string) => when(iso).replace(NARROW_SPACES, " ");
    assert.equal(plainWhen("2026-10-19T18:00:00.000Z"), "Mon, Oct 19, 6:00 PM");
    assert.equal(when("not a time"), "");
    const room = (over: Partial<MeetRoomItem>): MeetRoomItem => ({ ...parseRoomItem(roomJson())!, ...over });
    const words = (r: MeetRoomItem) => whenText(r, plainWhen);
    assert.equal(words(room({ status: "scheduled", startsAt: "2026-10-19T18:00:00.000Z" })), "Mon, Oct 19, 6:00 PM");
    assert.equal(words(room({ status: "scheduled", startsAt: null, createdAt: "2026-10-17T20:00:00.000Z" })), "Link made Sat, Oct 17, 8:00 PM");
    assert.equal(words(room({ status: "live", startedAt: "2026-10-17T20:05:00.000Z" })), "Started Sat, Oct 17, 8:05 PM");
    assert.equal(words(room({ status: "live", startedAt: null })), "Happening now");
    assert.equal(words(room({ status: "ended", endedAt: "2026-10-17T21:00:00.000Z" })), "Ended Sat, Oct 17, 9:00 PM");
    assert.equal(words(room({ status: "ended", endedAt: null, startedAt: null })), "Ended");
    assert.equal(meetingUrl("https://oasisai.work", "/meet/aaa-bbbb-ccc"), "https://oasisai.work/meet/aaa-bbbb-ccc");
    assert.equal(meetingUrl("https://oasisai.work/", "meet/aaa-bbbb-ccc"), "https://oasisai.work/meet/aaa-bbbb-ccc");

    assert.equal(initialsOf("Jane Doe"), "JD");
    assert.equal(initialsOf("cher"), "C");
    assert.equal(initialsOf("  "), "?");
    assert.equal(initialsOf("Ada Lovelace Byron"), "AB");
    const smile = String.fromCodePoint(0x1f600);
    assert.equal(Array.from(initialsOf(`${smile} Smith`)).length, 2, "an emoji is one letter, never cut in half");
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(gridClasses), [
      "grid-cols-1", "grid-cols-1", "grid-cols-1 sm:grid-cols-2", "grid-cols-2", "grid-cols-2",
      "grid-cols-2 lg:grid-cols-3", "grid-cols-2 lg:grid-cols-3", "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4", "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
    ]);
    const t = (over: Partial<MeetTile>): MeetTile => ({ participantId: "p", name: "n", role: "guest", me: false, audio: null, video: null, screen: null, micOn: true, camOn: false, sharing: false, ...over });
    const screen = {} as MediaStreamTrack;
    assert.equal(sharerOf([t({}), t({ me: true })]), null);
    assert.equal(sharerOf([t({ participantId: "a", me: true, sharing: true, screen }), t({ participantId: "b", sharing: true, screen })])?.participantId, "b", "someone else's screen first");
    assert.equal(sharerOf([t({ participantId: "a", me: true, sharing: true, screen })])?.participantId, "a");
    assert.equal(sharerOf([t({ sharing: true, screen: null })]), null, "sharing without a track has nothing to show");
    assert.equal(parseRoomItem({ id: "1", code: "c", title: "t", status: "weird", link: "/l", createdAt: "x" }), null);
    assert.equal(parseRoomList({ rooms: "no" }), null);
  });

  await check("the faces' grid: --cols and --rows agree with the columns at every width, so every face has a place on a wide window", () => {
    const find = (classes: string, prefix: string, head: string, tail: string) => {
      const re = new RegExp(`^${prefix}${head}(\\d+)${tail}$`);
      for (const token of classes.split(" ")) {
        const m = token.match(re);
        if (m) return Number(m[1]);
      }
      return null;
    };
    const widths = ["", "sm:", "lg:"];
    const cascade = (classes: string, upTo: number, head: string, tail: string) => {
      let value: number | null = null;
      for (const prefix of widths.slice(0, upTo + 1)) value = find(classes, prefix, head, tail) ?? value;
      return value;
    };
    for (let faces = 1; faces <= 8; faces += 1) {
      const columns = gridClasses(faces);
      const fit = gridFit(faces);
      for (let w = 0; w < widths.length; w += 1) {
        const cols = cascade(columns, w, "grid-cols-", "");
        assert.ok(cols !== null && cols >= 1, `${faces} faces at width ${w}: columns`);
        assert.equal(cascade(fit, w, "\\[--cols:", "\\]"), cols, `${faces} faces at width ${w}: --cols`);
        assert.equal(cascade(fit, w, "\\[--rows:", "\\]"), Math.ceil(faces / cols), `${faces} faces at width ${w}: --rows`);
      }
      assert.ok(fit.includes("lg:max-w-[calc((100dvh-9.5rem)*1.7778*var(--cols)/var(--rows))]"), `${faces} faces: the fit rule`);
    }
  });

  console.log(failures ? `meet ui: ${failures} failure(s)` : "meet ui: all passed");
  process.exit(failures ? 1 : 0);
}

function c0<T>(calls: T[]): T {
  assert.ok(calls.length > 0, "a request was made");
  return calls[0];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
