/**
 * The server-render half of tests/meet-ui.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server does not resolve, so the test
 * spawns this file without that condition and asserts on the markup it prints: Oasis Meet's screens as the
 * server first draws them (the browser's first paint is the same markup). It asserts nothing itself.
 */

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
    notice: null,
    ...over,
  };
}

const roomProps = { code: "abc-defg-hjk", title: "Quarterly review", status: "scheduled" as const };

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MeetRoom } = await import("../components/meet/MeetRoom");
  const { MeetEnded } = await import("../components/meet/MeetEnded");
  const { CallScreen } = await import("../components/meet/CallScreen");
  const { PeoplePanel } = await import("../components/meet/PeoplePanel");
  const { MeetPanelView } = await import("../components/meet/MeetPanel");
  const h = React.createElement;
  const out: Record<string, string> = {};
  const draw = (id: string, el: ReturnType<typeof h>) => {
    out[id] = renderToStaticMarkup(el);
  };

  // The pre-join screen, as the server draws it for each kind of person and room.
  draw("room.visitorRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "visitor" }));
  draw("room.memberRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "member" }));
  draw("room.hostRecorded", h(MeetRoom, { ...roomProps, recordAudio: true, viewer: "host" }));
  draw("room.visitorPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "visitor" }));
  draw("room.memberPlain", h(MeetRoom, { ...roomProps, recordAudio: false, viewer: "member" }));
  draw("room.endedProp", h(MeetRoom, { ...roomProps, status: "ended", recordAudio: true, viewer: "visitor" }));

  // The ending screens, every reason, for a guest and for a host.
  for (const reason of ["left", "host_ended", "removed", "room_closed"] as MeetEndReason[]) {
    draw(`ended.${reason}.guest`, h(MeetEnded, { reason, isHost: false }));
    draw(`ended.${reason}.host`, h(MeetEnded, { reason, isHost: true }));
  }

  // The call: a guest, a host, a shared screen, and the Recording indicator's two conditions.
  const call = (snap: MeetSnapshot, over: { canShare?: boolean; recordAudio?: boolean } = {}) =>
    h(CallScreen, { controller, snapshot: snap, code: "abc-defg-hjk", title: "Quarterly review", recordAudio: over.recordAudio ?? true, canShare: over.canShare ?? true });
  draw("call.guest", call(snapshot()));
  draw("call.guestNoShare", call(snapshot(), { canShare: false }));
  draw("call.host", call(snapshot({ me: { id: "p-host", role: "host", name: "CC" } })));
  draw("call.noHostYet", call(snapshot({ hostPresent: false })));
  draw("call.notRecorded", call(snapshot({ room: { code: "abc-defg-hjk", title: "Quarterly review", status: "live", recordAudio: false, startedAt: null } }), { recordAudio: false }));
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
  };
  type Extra = { mine?: boolean; recordAudio?: boolean; url?: string };
  const row = (id: string, code: string, title: string, status: "scheduled" | "live" | "ended", statusWords: string, when: string, extra: Extra = {}) => ({
    id,
    code,
    title,
    status,
    statusWords,
    when,
    link: `/meet/${code}`,
    mine: extra.mine ?? true,
    recordAudio: extra.recordAudio ?? true,
    ...(extra.url ? { url: extra.url } : {}),
  });
  const panel = (over: object, renderEnded?: (code: string) => unknown) =>
    h(MeetPanelView, { ...base, ...over, renderEnded } as never);
  draw("panel.loading", panel({}));
  draw("panel.error", panel({ list: { status: "error", words: "Your meetings could not load." } }));
  draw("panel.empty", panel({ list: { status: "ready", rows: [] } }));
  draw(
    "panel.rows",
    panel(
      {
        list: {
          status: "ready",
          rows: [
            row("r1", "aaa-bbbb-ccc", "Discovery call", "scheduled", "Scheduled", "Mon, Oct 19, 2:00 PM"),
            row("r2", "ddd-eeee-fff", "Team sync", "live", "Live now", "Started Sat, Oct 17, 4:05 PM"),
            row("r3", "ggg-hhhh-jjj", "Old review", "ended", "Ended", "Ended Fri, Oct 16, 3:00 PM"),
          ],
        },
      },
      (code) => h("div", { "data-transcript-slot": code }, `Transcript for ${code}`),
    ),
  );
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
    "panel.laterNoLine",
    panel({ later: { title: "", startsAt: "", minutes: "", record: true, busy: false, error: null, made: { url: "https://oasisai.work/meet/aaa-bbbb-ccc", link: "/meet/aaa-bbbb-ccc", opened: false } } }),
  );
  draw("panel.laterUnticked", panel({ later: { title: "", startsAt: "", minutes: "", record: false, ...none } }));

  // Where recording does not run: no box, no claim that a meeting records, no transcript slot.
  const slot = (code: string) => h("div", { "data-transcript-slot": code }, `Transcript for ${code}`);
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

  process.stdout.write(JSON.stringify({ markup: out }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
