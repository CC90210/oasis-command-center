/**
 * The server-render half of tests/meet-ui.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server does not resolve, so the test
 * spawns this file without that condition and asserts on the markup it prints: Oasis Meet's screens as the
 * server first draws them (the browser's first paint is the same markup). It asserts nothing itself.
 */

import type { PreJoinProps } from "../components/meet/PreJoin";
import type { JoinDevices } from "../components/meet/useJoinDevices";
import type { MeetEndReason, MeetRoomController, MeetSnapshot, MeetTile } from "../lib/meet/room-client";

// A module, not a global script, so its names cannot collide under tsc.
export {};

const noop = async () => undefined;

/** A controller that is never called: server rendering runs no handlers. */
const controller: MeetRoomController = {
  subscribe: () => () => undefined,
  snapshot: () => {
    throw new Error("the snapshot is passed in");
  },
  join: noop,
  setMic: noop,
  setCam: noop,
  shareScreen: noop,
  remove: noop,
  end: noop,
  leave: noop,
  inRoom: () => false,
};

const track = (kind: string) => ({ kind }) as unknown as MediaStreamTrack;

function tile(over: Partial<MeetTile> & Pick<MeetTile, "participantId" | "name">): MeetTile {
  return {
    role: "guest",
    me: false,
    audio: null,
    video: null,
    screen: null,
    micOn: true,
    camOn: false,
    sharing: false,
    ...over,
  };
}

function snapshot(over: Partial<MeetSnapshot> = {}): MeetSnapshot {
  return {
    phase: { kind: "live" },
    room: { code: "abc-defg-hjk", title: "Quarterly review", status: "live", recordAudio: true, startedAt: "2026-10-17T16:00:00.000Z" },
    me: { id: "p-me", role: "guest", name: "Jane Doe" },
    tiles: [
      tile({ participantId: "p-host", name: "CC", role: "host", video: track("video"), camOn: true, audio: track("audio") }),
      tile({ participantId: "p-me", name: "Jane Doe", me: true, video: track("video"), camOn: true }),
      tile({ participantId: "p-sam", name: "Samantha Lee-Whitfield", micOn: false }),
    ],
    hostPresent: true,
    micOn: true,
    camOn: true,
    sharing: false,
    recording: false,
    // The recording is running: the room records and the browser recording it is in the call.
    roomRecording: true,
    notice: null,
    ...over,
  };
}

const roomProps = {
  code: "abc-defg-hjk",
  title: "Quarterly review",
  status: "scheduled" as const,
  startsAt: null as string | null,
  guestName: null as string | null,
};

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MeetRoom } = await import("../components/meet/MeetRoom");
  const { MeetEnded } = await import("../components/meet/MeetEnded");
  const { PreJoin } = await import("../components/meet/PreJoin");
  const { Lobby } = await import("../components/meet/Lobby");
  const { CallScreen } = await import("../components/meet/CallScreen");
  const { PeoplePanel } = await import("../components/meet/PeoplePanel");
  const { MeetPanelView } = await import("../components/meet/MeetPanel");
  const h = React.createElement;
  const out: Record<string, string> = {};
  const draw = (id: string, el: ReturnType<typeof h>) => {
    out[id] = renderToStaticMarkup(el);
  };

  // Rooms drawn from the props the page's own loader made for a real session and room row (tests/meet-ui.test.ts hands
  // them in): nothing is set by hand between who is looking and what the screen shows. Only these are drawn.
  const loaded = process.env.MEET_RENDER_LOADED_ROOMS;
  if (loaded) {
    for (const [name, props] of Object.entries(JSON.parse(loaded) as Record<string, object>)) draw(`loaded.${name}`, h(MeetRoom, props as never));
    process.stdout.write(JSON.stringify({ markup: out }));
    return;
  }

  // The pre-join screen, as the server draws it for each kind of person and room. `viewer` is how the page sees
  // them (the name field, the host controls); `creator` is whether they made the room, which alone decides the
  // recording notice: a second host is a "host" viewer who did not make it.
  draw("room.visitorRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "visitor", creator: false }));
  draw("room.memberRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "member", creator: false }));
  draw("room.creatorRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "host", creator: true }));
  draw("room.secondHostRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "host", creator: false }));
  draw("room.visitorPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "visitor", creator: false }));
  draw("room.memberPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "member", creator: false }));
  draw("room.creatorPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "host", creator: true }));
  draw("room.secondHostPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "host", creator: false }));
  draw("room.endedProp", h(MeetRoom, { ...roomProps, status: "ended", recordAudio: true, viewer: "visitor", creator: false }));

  // A room a lead booked: made for a time, with the lead's first name for the visitor's name field to start with. The
  // server draws no time line (it cannot know the viewer's zone or clock); the browser adds it once the page is up.
  const booked = { ...roomProps, title: "OASIS call with Jane", startsAt: "2026-10-20T18:00:00.000Z", recordAudio: true, creator: false };
  draw("room.bookedVisitor", h(MeetRoom, { ...booked, viewer: "visitor", guestName: "Jane" }));
  draw("room.bookedVisitorNoName", h(MeetRoom, { ...booked, viewer: "visitor", guestName: null }));
  draw("room.bookedLongName", h(MeetRoom, { ...booked, viewer: "visitor", guestName: "J".repeat(90) }));
  draw("room.bookedMember", h(MeetRoom, { ...booked, viewer: "member", guestName: null }));

  // The pre-join screen while the browser has not answered a request for the camera or microphone: the way out, by what
  // is waited for and what is already held. The hook is not run (a server render has no browser), so the devices are
  // handed in as the hook would hold them.
  const devicesWith = (over: Partial<JoinDevices>): JoinDevices => ({
    asked: false,
    asking: false,
    waiting: { mic: false, cam: false },
    mic: null,
    cam: null,
    words: null,
    mics: [],
    cams: [],
    micId: "",
    camId: "",
    turnOn: () => undefined,
    toggleMic: () => undefined,
    toggleCam: () => undefined,
    pickMic: () => undefined,
    pickCam: () => undefined,
    takeForJoin: () => ({ mic: null, cam: null }),
    stopWaiting: () => undefined,
    release: () => undefined,
    ...over,
  });
  const preJoin = (devices: JoinDevices, over: Partial<PreJoinProps> = {}) =>
    h(PreJoin, {
      title: "Quarterly review",
      startsLine: null,
      recordAudio: true,
      needsNotice: true,
      nameRequired: true,
      name: "Jane Doe",
      onName: () => undefined,
      consent: true,
      onConsent: () => undefined,
      devicesOpen: true,
      devices,
      error: null,
      nameMissing: false,
      consentMissing: false,
      onJoin: () => undefined,
      onJoinWithout: () => undefined,
      ...over,
    });
  draw("prejoin.notWaiting", preJoin(devicesWith({})));
  // A meeting made for a time says when it starts under its name; one with no time says nothing of the kind.
  draw("prejoin.starts", preJoin(devicesWith({}), { startsLine: "Your call starts at 2:00 PM." }));
  // This browser has the meeting open in another tab: the words, and the way to move it here.
  draw(
    "prejoin.openElsewhere",
    preJoin(devicesWith({}), { error: "This meeting is already open in another tab of this browser.", onJoinHere: () => undefined }),
  );
  draw("prejoin.waitingBoth", preJoin(devicesWith({ asking: true, waiting: { mic: true, cam: true } })));
  draw("prejoin.waitingCamera", preJoin(devicesWith({ asked: true, asking: true, waiting: { mic: false, cam: true }, mic: track("audio") })));
  draw("prejoin.waitingMicrophone", preJoin(devicesWith({ asked: true, asking: true, waiting: { mic: true, cam: false }, cam: track("video") })));
  // A switch to another camera while the first one runs: nothing is missing, so the way out keeps the one they have.
  draw("prejoin.switching", preJoin(devicesWith({ asked: true, asking: true, waiting: { mic: false, cam: true }, mic: track("audio"), cam: track("video") })));
  // The same wait with the notice un-ticked: the camera step, and so the way out, is not drawn behind a shut gate.
  draw("prejoin.waitingGateShut", preJoin(devicesWith({ asking: true, waiting: { mic: true, cam: true } }), { devicesOpen: false, consent: false }));

  // The quiet screens between Join now and the call, each with the way to leave MeetRoom hands it. The same Lobby
  // with none given draws no button: it offers Leave when told to, whatever its mode.
  const leave = () => undefined;
  for (const mode of ["joining", "connecting", "waiting"] as const) {
    draw(`lobby.${mode}`, h(Lobby, { mode, title: "Quarterly review", preview: mode === "joining" ? null : track("video"), onLeave: leave }));
    draw(`lobby.${mode}.bare`, h(Lobby, { mode, title: "Quarterly review", preview: null }));
  }
  // The waiting lobby of a meeting made for a time says when it starts, under the waiting line.
  draw("lobby.waiting.starts", h(Lobby, { mode: "waiting", title: "Quarterly review", preview: null, startsLine: "Your call starts on Tuesday, October 20 at 2:00 PM.", onLeave: leave }));

  // The ending screens, every reason, for a guest and for a host.
  for (const reason of ["left", "dropped", "host_ended", "removed", "moved", "room_closed"] as MeetEndReason[]) {
    draw(`ended.${reason}.guest`, h(MeetEnded, { reason, isHost: false }));
    draw(`ended.${reason}.host`, h(MeetEnded, { reason, isHost: true }));
  }

  // The call: a guest, a host, a shared screen, and the Recording indicator, which follows the room's own answer
  // (`roomRecording`: the room records and the browser recording it is in the call), never the room's setting alone.
  const call = (snap: MeetSnapshot, over: { canShare?: boolean } = {}) =>
    h(CallScreen, { controller, snapshot: snap, code: "abc-defg-hjk", title: "Quarterly review", canShare: over.canShare ?? true });
  draw("call.guest", call(snapshot()));
  draw("call.guestNoShare", call(snapshot(), { canShare: false }));
  draw("call.host", call(snapshot({ me: { id: "p-host", role: "host", name: "CC" } })));
  draw("call.noHostYet", call(snapshot({ hostPresent: false, roomRecording: false })));
  draw("call.notRecorded", call(snapshot({ room: { code: "abc-defg-hjk", title: "Quarterly review", status: "live", recordAudio: false, startedAt: null }, roomRecording: false })));
  // A recorded room whose creator is not in the call: a second host (an admin) is the host who is present, and his
  // browser records it (any host's does).
  const adonAlone = { me: { id: "p-adon", role: "host" as const, name: "Adon" }, tiles: [tile({ participantId: "p-adon", name: "Adon", role: "host", me: true, video: track("video"), camOn: true })] };
  const guestWithAdon = { tiles: [tile({ participantId: "p-adon", name: "Adon", role: "host" }), tile({ participantId: "p-me", name: "Jane Doe", me: true })] };
  draw("call.secondHostAlone", call(snapshot({ ...adonAlone, roomRecording: true })));
  draw("call.guestWithSecondHost", call(snapshot({ ...guestWithAdon, roomRecording: true })));
  // The same calls while no browser records yet (the recorder has just left, and no other host's has taken over).
  draw("call.hostNotRecording", call(snapshot({ ...adonAlone, roomRecording: false })));
  draw("call.guestHostNotRecording", call(snapshot({ ...guestWithAdon, roomRecording: false })));
  draw("call.notice", call(snapshot({ notice: "Reconnecting..." })));
  draw(
    "call.sharing",
    call(
      snapshot({
        tiles: [
          tile({ participantId: "p-host", name: "CC", role: "host", video: track("video"), camOn: true, screen: track("video"), sharing: true }),
          tile({ participantId: "p-me", name: "Jane Doe", me: true }),
        ],
      }),
    ),
  );
  draw(
    "call.ownShare",
    call(
      snapshot({
        sharing: true,
        tiles: [
          tile({ participantId: "p-host", name: "CC", role: "host" }),
          tile({ participantId: "p-me", name: "Jane Doe", me: true, screen: track("video"), sharing: true }),
        ],
      }),
    ),
  );

  // The people list, for a host and for a guest.
  const people = snapshot().tiles;
  draw("people.host", h(PeoplePanel, { tiles: people, isHost: true, onRemove: noop, onClose: () => undefined }));
  draw("people.guest", h(PeoplePanel, { tiles: people, isHost: false, onRemove: noop, onClose: () => undefined }));

  // The Schedule panel body: its four list states, and the two things a link made for later can say.
  const none = { busy: false, error: null, made: null };
  const noDelete = { asking: null, busy: false, error: null };
  const base = {
    list: { status: "loading" as const },
    recordingAvailable: true,
    mediaNotReady: false,
    start: none,
    later: { title: "", startsAt: "", minutes: "", record: true, ...none },
    del: noDelete,
    note: null,
    copied: null,
    onStart: () => undefined,
    onTitle: () => undefined,
    onStartsAt: () => undefined,
    onMinutes: () => undefined,
    onRecord: () => undefined,
    onCreate: () => undefined,
    onCopy: () => undefined,
    onAskDelete: () => undefined,
    onCancelDelete: () => undefined,
    onDelete: () => undefined,
    onRetry: () => undefined,
    transcriptOpen: null as string | null,
    onToggleTranscript: () => undefined,
  };
  type Extra = { mine?: boolean; recordAudio?: boolean; url?: string; leadId?: string };
  const row = (id: string, code: string, title: string, status: "scheduled" | "live" | "ended", statusWords: string, when: string, extra: Extra = {}) => ({
    id,
    code,
    title,
    status,
    statusWords,
    when,
    link: `/meet/${code}`,
    mine: extra.mine ?? true,
    leadId: extra.leadId ?? null,
    recordAudio: extra.recordAudio ?? true,
    ...(extra.url ? { url: extra.url } : {}),
  });
  const panel = (over: object, renderEnded?: (code: string) => unknown) =>
    h(MeetPanelView, { ...base, ...over, renderEnded } as never);
  // What the page puts in a transcript's box: a marker that says which meeting it was asked for.
  const slot = (code: string) => h("div", { "data-transcript-slot": code }, `Transcript for ${code}`);
  draw("panel.loading", panel({}));
  draw("panel.error", panel({ list: { status: "error", words: "Your meetings could not load." } }));
  draw("panel.empty", panel({ list: { status: "ready", rows: [] } }));
  const threeRows = {
    status: "ready" as const,
    rows: [
      row("r1", "aaa-bbbb-ccc", "Discovery call", "scheduled", "Scheduled", "Mon, Oct 19, 2:00 PM"),
      row("r2", "ddd-eeee-fff", "Team sync", "live", "Live now", "Started Sat, Oct 17, 4:05 PM"),
      row("r3", "ggg-hhhh-jjj", "Old review", "ended", "Ended", "Ended Fri, Oct 16, 3:00 PM"),
    ],
  };
  draw("panel.rows", panel({ list: threeRows }, slot));
  draw("panel.rowsOpen", panel({ list: threeRows, transcriptOpen: "r3" }, slot));
  draw("panel.copyFailed", panel({ list: { status: "ready", rows: [row("r1", "aaa-bbbb-ccc", "Discovery call", "scheduled", "Scheduled", "Mon, Oct 19, 2:00 PM")] }, copied: { key: "r1", ok: false, url: "https://oasisai.work/meet/aaa-bbbb-ccc" } }));
  draw("panel.startMade", panel({ start: { busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: true } } }));
  draw("panel.startBlocked", panel({ start: { busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false } } }));
  draw("panel.startError", panel({ start: { busy: false, error: "Sign in again, then try once more.", made: null } }));
  draw("panel.laterNoTime", panel({}));
  draw("panel.laterWithTime", panel({ later: { title: "Kickoff", startsAt: "2030-01-01T10:00", minutes: "45", record: true, ...none } }));
  draw(
    "panel.laterAdded",
    panel({ later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, schedule: { added: true } } } }),
  );
  draw(
    "panel.laterNotAdded",
    panel({
      later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, schedule: { added: false, reason: "shabbat_protected" } } },
    }),
  );
  draw(
    "panel.laterNotAddedOther",
    panel({
      later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, schedule: { added: false, reason: "time_zone_invalid" } } },
    }),
  );
  draw(
    "panel.laterScheduleUnreached",
    panel({
      later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, schedule: { added: false, reason: "schedule_unavailable" } } },
    }),
  );
  draw(
    "panel.laterNoLine",
    panel({ later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false } } }),
  );
  draw("panel.laterUnticked", panel({ later: { title: "", startsAt: "", minutes: "", record: false, ...none } }));

  // Where recording does not run: no box, no claim that a meeting records, no Transcript button.
  const mixed = {
    status: "ready" as const,
    rows: [
      row("m1", "aaa-bbbb-ccc", "Mine (not started)", "scheduled", "Scheduled", "Mon, Oct 19, 2:00 PM", { mine: true, recordAudio: true }),
      row("m2", "ddd-eeee-fff", "Theirs (live)", "live", "Live now", "Started Sat, Oct 17, 4:05 PM", { mine: false, recordAudio: true }),
      row("m3", "ggg-hhhh-jjj", "Mine (ended, audio)", "ended", "Ended", "Ended Fri, Oct 16, 3:00 PM", { mine: true, recordAudio: true }),
      row("m4", "kkk-mmmm-nnn", "Mine (ended, no audio)", "ended", "Ended", "Ended Thu, Oct 15, 3:00 PM", { mine: true, recordAudio: false }),
      row("m5", "pqr-stuv-wxy", "Theirs (ended, audio)", "ended", "Ended", "Ended Wed, Oct 14, 3:00 PM", { mine: false, recordAudio: true }),
    ],
  };
  draw("panel.mixedAvailable", panel({ list: mixed, recordingAvailable: true }, slot));
  draw("panel.mixedUnavailable", panel({ list: mixed, recordingAvailable: false }, slot));
  // Video calls cannot connect yet (the list said mediaReady false): the line at the top, Start now and Create link
  // switched off, the meetings as they were.
  draw("panel.mediaNotReady", panel({ list: mixed, mediaNotReady: true }, slot));
  draw("panel.mediaNotReadyEmpty", panel({ list: { status: "ready", rows: [] }, mediaNotReady: true }));
  draw("panel.noRecording", panel({ recordingAvailable: false }));
  draw("panel.noRecordingMadeStart", panel({ recordingAvailable: false, start: { busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: true, recorded: false } } }));
  draw("panel.madeRecorded", panel({ later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, recorded: true } } }));
  draw("panel.madeUnrecorded", panel({ later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false, recorded: false } } }));

  // Delete: the question open on a meeting that is the person's, working, refused, and the line after one is gone.
  draw("panel.deleteAsk", panel({ list: mixed, del: { asking: "m3", busy: false, error: null } }, slot));
  draw("panel.deleteBusy", panel({ list: mixed, del: { asking: "m3", busy: true, error: null } }, slot));
  draw("panel.deleteError", panel({ list: mixed, del: { asking: "m3", busy: false, error: "Only the host can delete this meeting." } }, slot));
  draw("panel.deleteAskNotMine", panel({ list: mixed, del: { asking: "m2", busy: false, error: null } }, slot));
  draw("panel.deleteNote", panel({ list: { status: "ready", rows: [] }, note: "The meeting was deleted." }));

  // The question says what goes with that meeting: a recording only if it recorded, and a live one is ended.
  const asking = (id: string) => ({ asking: id, busy: false, error: null });
  const liveMine = {
    status: "ready" as const,
    rows: [
      row("l1", "aaa-bbbb-ccc", "Mine (live, audio)", "live", "Live now", "Started Sat, Oct 17, 4:05 PM", { mine: true, recordAudio: true }),
      row("l2", "ddd-eeee-fff", "Mine (live, no audio)", "live", "Live now", "Started Sat, Oct 17, 4:05 PM", { mine: true, recordAudio: false }),
    ],
  };
  draw("panel.deleteAskScheduled", panel({ list: mixed, del: asking("m1") }, slot));
  draw("panel.deleteAskUnrecorded", panel({ list: mixed, del: asking("m4") }, slot));
  draw("panel.deleteAskLive", panel({ list: liveMine, del: asking("l1") }, slot));
  draw("panel.deleteAskLiveUnrecorded", panel({ list: liveMine, del: asking("l2") }, slot));

  // Transcripts: a button on each finished recorded meeting, nothing mounted until one is pressed, one open at a time.
  draw("panel.transcriptOpenMine", panel({ list: mixed, transcriptOpen: "m3" }, slot));
  draw("panel.transcriptOpenTheirs", panel({ list: mixed, transcriptOpen: "m5" }, slot));
  for (const id of ["m1", "m2", "m4"]) draw(`panel.transcriptOpen.${id}`, panel({ list: mixed, transcriptOpen: id }, slot));
  draw("panel.transcriptOpenUnavailable", panel({ list: mixed, recordingAvailable: false, transcriptOpen: "m3" }, slot));
  draw("panel.transcriptOpenNoRenderer", panel({ list: mixed, transcriptOpen: "m3" }));
  draw("panel.transcriptOpenAndAsk", panel({ list: mixed, transcriptOpen: "m3", del: asking("m3") }, slot));

  // Meetings a lead booked: no Delete, even on the host's own; a link to the lead's page says where to cancel it. A
  // meeting the host made themselves, beside them, keeps its Delete. A stale panel's refusal reads in the open question.
  const bookedLead = "7f9c2a10-1b34-4e55-9d6a-0c1d2e3f4a5b";
  const bookedRows = {
    status: "ready" as const,
    rows: [
      row("b1", "aaa-bbbb-ccc", "OASIS call with Jane", "scheduled", "Scheduled", "Tue, Oct 20, 2:00 PM", { mine: true, recordAudio: true, leadId: bookedLead }),
      row("b2", "ddd-eeee-fff", "OASIS call with Omar", "scheduled", "Scheduled", "Wed, Oct 21, 10:30 AM", { mine: false, recordAudio: true, leadId: "c0ffee00-1111-4222-8333-444455556666" }),
      row("b3", "ggg-hhhh-jjj", "Planning (made by me)", "scheduled", "Scheduled", "Thu, Oct 22, 9:00 AM", { mine: true, recordAudio: false }),
    ],
  };
  draw("panel.booked", panel({ list: bookedRows }, slot));
  draw("panel.bookedDeleteRefused", panel({ list: { status: "ready", rows: [row("s1", "aaa-bbbb-ccc", "Stale row", "scheduled", "Scheduled", "Tue, Oct 20, 2:00 PM")] }, del: { asking: "s1", busy: false, error: "This meeting was booked by a lead. Cancel it from their page in the pipeline." } }));

  process.stdout.write(JSON.stringify({ markup: out }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
