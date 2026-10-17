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
import { loadMeetPage, meetViewerFor, sessionOrVisitor } from "../app/meet/[code]/load";
import { deviceWords, listInputs, openDevices, problemOf } from "../components/meet/devices";
import { messageFor } from "../components/calendar/useCalendarData";
import { createMeeting, listMeetings } from "../components/meet/meet-api";
import {
  LENGTH_CHOICES,
  NAME_MAX_CHARS,
  STATUS_WORDS,
  TITLE_MAX_CHARS,
  gridClasses,
  gridFit,
  initialsOf,
  lengthWords,
  meetingUrl,
  panelErrorWords,
  parseRoomItem,
  parseRoomList,
  parseScheduleNote,
  scheduleLine,
  sharerOf,
  timeFormatter,
  whenText,
  type MeetRoomItem,
} from "../components/meet/meet-format";
import { CONSENT_LABEL, DEVICES_BUTTON, ENDED_WORDS, RECORDING_NOTICE, TICK_FIRST } from "../components/meet/meet-words";
import { mayAskForDevices, needsRecordingNotice } from "../components/meet/notice";
import { MEET_NAME_MAX } from "../lib/meet/access";
import { endMeetRoom } from "../lib/meet/participants";
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

function renderMarkup(): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/meet-ui.render.ts"], {
    cwd: root,
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step; react-dom/server refuses to load under it.
    env: { ...process.env, NODE_OPTIONS: "" },
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

  await check("the recording notice rule: everyone but the host, in a recorded room; the camera step waits for the tick", () => {
    for (const viewer of ["visitor", "member"] as const) {
      assert.equal(needsRecordingNotice({ viewer, recordAudio: true }), true, viewer);
      assert.equal(needsRecordingNotice({ viewer, recordAudio: false }), false, `${viewer}, not recorded`);
    }
    assert.equal(needsRecordingNotice({ viewer: "host", recordAudio: true }), false, "a host runs the recording, they do not tick it");
    assert.equal(mayAskForDevices({ needsNotice: true, ticked: false }), false, "notice shown, not ticked: no camera");
    assert.equal(mayAskForDevices({ needsNotice: true, ticked: true }), true);
    assert.equal(mayAskForDevices({ needsNotice: false, ticked: false }), true, "no notice to tick: the camera step is open");
  });

  await check("(a) a visitor or member in a recorded room: the notice and a required unticked box come first; nothing asks for the camera", () => {
    for (const id of ["room.visitorRecorded", "room.memberRecorded"]) {
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

  await check("(a) a visitor must give a name; a member may leave it empty (the server uses their account)", () => {
    const visitorName = tags(markup["room.visitorRecorded"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(visitorName, /\brequired=""/);
    assert.ok(text(markup["room.visitorRecorded"]).includes("Your name"));
    assert.ok(!text(markup["room.visitorRecorded"]).includes("(optional)"));
    const memberName = tags(markup["room.memberRecorded"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.doesNotMatch(memberName, /\brequired=""/);
    assert.ok(text(markup["room.memberRecorded"]).includes("Your name (optional)"));
    assert.ok(text(markup["room.memberRecorded"]).includes("Leave it empty to use your account name."));
    assert.match(memberName, new RegExp(`maxLength="${NAME_MAX_CHARS}"`), "the box stops at the length the server keeps");
  });

  await check("(b) a host sees no tick, no gate, and is told the meeting records", () => {
    const html = markup["room.hostRecorded"];
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
    for (const id of ["room.visitorPlain", "room.memberPlain"]) {
      const html = markup[id];
      assert.ok(!/type="checkbox"/.test(html), `${id}: no tick`);
      assert.ok(!text(html).includes("recorded"), `${id}: nothing says it records`);
      assert.ok(text(html).includes(DEVICES_BUTTON), `${id}: the camera step is open`);
    }
    const visitorName = tags(markup["room.visitorPlain"], "input").find((t) => t.includes('id="meet-name"')) ?? "";
    assert.match(visitorName, /\brequired=""/, "a visitor still gives a name");
  });

  await check("the camera step is a button: the page never asks the browser on its own (no autostart in the markup)", () => {
    for (const html of [markup["room.hostRecorded"], markup["room.visitorPlain"]]) {
      assert.equal(count(html, /<video\b/g), 0, "no preview until the person turns the camera on");
      assert.ok(buttonNames(html).includes(DEVICES_BUTTON));
    }
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
    assert.match(hook, /if \(allowed\) return;\s*hold\("mic", null\);\s*hold\("cam", null\);/, "un-ticking the notice lets go of the devices");
    const pre = readFileSync(join(root, "components", "meet", "PreJoin.tsx"), "utf8");
    assert.match(pre, /!props\.devicesOpen \?\s*\(\s*<p className="text-sm text-fg-muted">\{TICK_FIRST\}<\/p>/, "the camera step is behind the gate");
  });

  // ---- the ending screens ------------------------------------------------------------------------------------------------

  await check("(d) every ending says the right words; Rejoin only after leaving; the way back only for a host", () => {
    const words = {
      left: "You left the meeting.",
      host_ended: "The host ended the meeting.",
      removed: "The host removed you from this meeting.",
      room_closed: "This meeting has ended.",
    } as const;
    assert.deepEqual(ENDED_WORDS, words);
    for (const [reason, sentence] of Object.entries(words)) {
      const guest = markup[`ended.${reason}.guest`];
      const host = markup[`ended.${reason}.host`];
      assert.match(guest, new RegExp(`<h1[^>]*>${sentence.replace(/\./g, "\\.")}</h1>`), `${reason}: the words`);
      assert.equal(buttonNames(guest).includes("Rejoin"), reason === "left", `${reason}: Rejoin only after the person left`);
      assert.equal(buttonNames(host).includes("Rejoin"), reason === "left", `${reason}: ... for a host too`);
      assert.ok(!guest.includes("/schedule"), `${reason}: a guest is not sent to the Schedule`);
      assert.match(host, /<a href="\/schedule"[^>]*>Back to Schedule<\/a>/, `${reason}: a host gets the way back, as a plain link`);
    }
    assert.match(text(markup["room.endedProp"]), /This meeting has ended\./, "a room that ended before the link was opened");
    assert.ok(!/type="checkbox"/.test(markup["room.endedProp"]) && !text(markup["room.endedProp"]).includes("Join now"), "and offers no way in");
  });

  // ---- the call -----------------------------------------------------------------------------------------------------------

  await check("the call: the Recording indicator is a dot WITH the word, for everyone, while the room records and its host is in it", () => {
    for (const id of ["call.guest", "call.host"]) {
      assert.match(markup[id], /<span aria-hidden="true" class="h-2 w-2 rounded-full bg-status-hot"><\/span>Recording<\/p>/, `${id}: red dot and the word`);
    }
    assert.ok(!text(markup["call.noHostYet"]).includes("Recording"), "no host in the call yet: no indicator");
    assert.ok(!text(markup["call.notRecorded"]).includes("Recording"), "a room that does not record: no indicator");
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

  await check("(c) a meeting is a title, a plain status, a time, Copy link, and Join unless it ended; the transcript goes in a named slot", () => {
    const html = markup["panel.rows"];
    assert.equal(count(html, /<li\b/g), 3);
    for (const [title, status] of [["Discovery call", "Scheduled"], ["Team sync", "Live now"], ["Old review", "Ended"]]) {
      assert.ok(text(html).includes(title) && text(html).includes(status), `${title} / ${status}`);
    }
    assert.equal(count(html, />Copy link</g), 3, "every meeting can have its link copied");
    const joins = [...html.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Join<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(joins, ["/meet/aaa-bbbb-ccc", "/meet/ddd-eeee-fff"], "Join for scheduled and live, not for ended");
    assert.equal(count(html, /data-transcript-slot=/g), 1, "the slot renders only for the ended meeting");
    assert.match(html, /Old review[\s\S]*data-transcript-slot="ggg-hhhh-jjj">Transcript for ggg-hhhh-jjj/, "...inside that meeting's row, with its code");
    assert.ok(!markup["panel.empty"].includes("data-transcript-slot"));
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

  await check("the room's page leaves the call when it closes: pagehide sends the beacon to this room's leave route", () => {
    const room = readFileSync(join(root, "components", "meet", "MeetRoom.tsx"), "utf8");
    assert.match(room, /addEventListener\("pagehide", onHide\)/);
    assert.match(room, /navigator\.sendBeacon\(`\/api\/meet\/\$\{code\}\/leave`\)/);
    assert.match(room, /if \(inCall\(\)\) void controller\.leave\(\);/, "and unmounting in a call leaves properly");
  });

  // ---- the page's data: link, redirect, ended, who is looking --------------------------------------------------------------

  await check("the limits the screens use equal the server's", () => {
    assert.equal(NAME_MAX_CHARS, MEET_NAME_MAX);
    assert.equal(TITLE_MAX_CHARS, MEET_TITLE_MAX);
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
  const recorded = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Quarterly review", recordAudio: true });
  const plain = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Standup", recordAudio: false, leadId: "lead-secret-1" });
  const finished = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Finished" });
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

  await check("the loader: the room's props are the five the screen needs, and never the workspace, the host or a lead", async () => {
    const data = await load(dashed);
    assert.ok(data.kind === "room");
    assert.deepEqual(data.props, { code: dashed, title: "Quarterly review", status: "scheduled", recordAudio: true, viewer: "visitor" });
    const json = JSON.stringify(data);
    for (const secret of [OASIS, CC, "tenant", "hostUser", "leadId", "lead-secret-1"]) assert.ok(!json.includes(secret), `the props leak ${secret}`);
    const other = await load(displayMeetCode(plain.code));
    assert.ok(other.kind === "room" && other.props.recordAudio === false && other.props.title === "Standup");
    assert.ok(!JSON.stringify(other).includes("lead-secret-1"));
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
    assert.deepEqual(session, { ok: false });
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
    assert.match(page, /<MeetRoom \{\.\.\.data\.props\} \/>/);
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
    assert.equal(panelErrorWords(503, "meet_not_configured"), meetErrorWords("meet_not_configured"));
  });

  await check("the recent list: the API's meetings, or plain words when it cannot", async () => {
    const ok = await listMeetings(fakeFetch({ status: 200, json: { ok: true, rooms: [roomJson(), roomJson({ id: "r2", code: "ddd-eeee-fff", status: "live" })] } }).fetch);
    assert.ok(ok.ok);
    assert.deepEqual(ok.value.map((r) => [r.code, r.status]), [["aaa-bbbb-ccc", "scheduled"], ["ddd-eeee-fff", "live"]]);
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
