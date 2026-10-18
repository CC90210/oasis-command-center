/**
 * lib/meet/room-client.ts - the browser side of an Oasis Meet room. No React: the room page renders the
 * snapshot through useSyncExternalStore (components/meet/MeetRoom.tsx).
 *
 * One RTCPeerConnection to Cloudflare's SFU, for both directions, negotiated through our room API
 * (lib/meet/handlers.ts), and a 2-second poll of who is in the room. It follows Cloudflare's connection recipes
 * (developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/): a session first, then each change
 * (publish, pull, close) is one request plus its SDP exchange, and changes run strictly one at a time.
 *
 * What it publishes: "mic" and "cam" from the start (a camera that is off is a sender with no track, so turning
 * it on needs no renegotiation), and "screen" the first time the person shares.
 *   Mic off: the sender stops sending AND the track is disabled, so neither the room nor a recording hears it.
 *   Camera off: the camera is released (its light goes out); turning it on asks the browser again.
 * A pulled track whose sender stopped reads as muted in the receiving browser: that is how a tile knows a
 * camera is off or a mic is silent, with nothing extra on the server.
 *
 * The host's recorder (lib/meet/recorder.ts, e9) plugs in through `recorder`: it is handed the host's own
 * microphone and every remote microphone as it arrives, and told when someone leaves. It runs in the one browser
 * the room names its recorder (`records`, on the join and on every poll), whichever host's that is: a host whose
 * browser takes over mid-call (the recorder left or went silent) starts recording then, on new segments, and one
 * whose recording another browser has taken stops. End asks the room to end FIRST and stops the recorder only once
 * it has: an End that fails leaves the meeting going and still recorded, where stopping first would lose the rest
 * of the call. The recorder's last chunks go up after the end (the chunk route takes them for ten minutes), and then
 * the PC is told the recording is whole.
 *
 * One tab per browser (lib/meet/tabs.ts): a join first holds the room for this tab, and only the tab in the room
 * tells it this person left.
 */

import { browserTabs, type MeetTabs } from "./tabs";

export type { MeetTabs };

export type MeetRole = "host" | "guest";

export type MeetTile = {
  participantId: string;
  name: string;
  role: MeetRole;
  me: boolean;
  /** A remote microphone to play (never the person's own). */
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
};

/**
 * Why the person is out of the call. `dropped`: the room no longer knows them, most often a browser silent past
 * lib/meet/participants.ts MEET_STALE_MS (a laptop asleep); coming back is a new join (Rejoin), whose recording notice
 * the person ticks again, so nothing rejoins them by itself. `moved`: they took the call over in another tab of this
 * browser ("Join here instead"), which carries on as the same person.
 */
export type MeetEndReason = "host_ended" | "removed" | "left" | "dropped" | "moved" | "room_closed";

export type MeetPhase =
  | { kind: "idle" }
  | { kind: "joining" }
  | { kind: "waiting_for_host" }
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "ended"; reason: MeetEndReason }
  /** `error` is what to show; `code` is the room API's code, for a page that acts on the kind of failure (never on the words). */
  | { kind: "failed"; error: string; code?: string };

export type MeetRoomInfo = { code: string; title: string; status: string; recordAudio: boolean; startedAt: string | null };

export type MeetSnapshot = {
  phase: MeetPhase;
  room: MeetRoomInfo | null;
  me: { id: string; role: MeetRole; name: string } | null;
  tiles: MeetTile[];
  hostPresent: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  /** This browser's recorder is running (only ever in the one browser the room names its recorder). */
  recording: boolean;
  /**
   * The room's recording is running now: it records, and the browser that records it is in the call. What the
   * page says "recorded" from, for everyone in the call; a host being present is not enough.
   */
  roomRecording: boolean;
  /** One plain sentence about something that went wrong but did not end the call. */
  notice: string | null;
};

/** The recorder's interface (lib/meet/recorder.ts createMeetRecorder), as this room uses it. */
export type RecorderPort = {
  addTrack(input: { participantId: string; displayName: string; track: MediaStreamTrack }): void;
  removeTrack(participantId: string, track?: MediaStreamTrack): void;
  stop(): Promise<{ errored?: number } | unknown>;
};

export type MeetRoomController = {
  subscribe(listener: () => void): () => void;
  snapshot(): MeetSnapshot;
  /**
   * Enter the room with the tracks the pre-join screen already has (either may be null: joined muted or camera off).
   * `here`: the room is open in another tab of this browser, and the person chose to join here instead (MeetTabs).
   */
  join(input: { name?: string; consent: boolean; mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; here?: boolean }): Promise<void>;
  /**
   * This tab holds a place in the room: it got in, and has not left or let go. Only then may it tell the room it left
   * (the page's pagehide beacon): another tab of this browser shares its cookie, and that tab's place must not end.
   */
  inRoom(): boolean;
  setMic(on: boolean): Promise<void>;
  setCam(on: boolean): Promise<void>;
  shareScreen(on: boolean): Promise<void>;
  remove(participantId: string): Promise<void>;
  end(): Promise<void>;
  leave(): Promise<void>;
};

export type MeetRoomOptions = {
  /** The room's code, dashed ("abc-defg-hjk"). */
  code: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  /**
   * Made for a host whose browser the room names its recorder, once they are in. `clock.now` is the room's clock (the
   * server's, as this browser reckons it), for the recorder's segment times (lib/meet/recorder.ts `now`).
   */
  recorder?: (clock: { now: () => number }) => RecorderPort;
  media?: Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;
  makePeer?: (config: RTCConfiguration) => RTCPeerConnection;
  /** How long to wait for ICE candidates before sending a description (non-trickle), and for "connected". */
  gatherMs?: number;
  connectMs?: number;
  /** How long a poll may hang before it counts as failed (default POLL_TIMEOUT_MS). */
  pollTimeoutMs?: number;
  /** How long any other call to the room may hang before it counts as failed (default REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /** Makes what gives up on a call after `ms` (default timeoutAfter); tests read what each call asked for. */
  deadline?: (ms: number) => Deadline;
  /** The wait before the first reconnect try, growing by this much each try (default 1 s). */
  reconnectMs?: number;
  /** This browser's own clock (default Date.now), which the room's clock is reckoned against; tests drive it. */
  now?: () => number;
  /** One tab per browser in the room (default lib/meet/tabs.ts browserTabs). */
  tabs?: MeetTabs;
};

/** `session` is a tag of their current SFU session (never the session itself): it changes when they reconnect. */
type Participant = {
  id: string;
  name: string;
  role: MeetRole;
  me: boolean;
  session: string | null;
  tracks: Array<{ trackName: string; kind: "audio" | "video" }>;
};
type Pulled = { participantId: string; trackName: string; mid: string | null; track: MediaStreamTrack | null };

/**
 * What a pull is kept under: the participant, their session's tag and the track's name. A participant who
 * reconnects publishes the same names on a new session, so their tracks get a new key and are pulled anew (and the
 * old ones closed), instead of a track from a session that no longer exists standing in for them all call long.
 */
const pullKey = (participantId: string, session: string | null, trackName: string) => `${participantId}:${session ?? "-"}:${trackName}`;

/**
 * How long the room's poll waits for an answer before it counts as failed and the next one is scheduled: far longer
 * than any answer takes, far shorter than lib/meet/participants.ts MEET_STALE_MS, after which a silent person has left.
 */
export const POLL_TIMEOUT_MS = 10_000;
/**
 * How long a join, an SFU step or a host action waits before it counts as failed. The room's API answers in a second or
 * two; a call that hangs past this is not coming, and without a deadline the page would sit on "Joining..." for good.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** What gives up on one call: `signal` aborts once the deadline passes, `done` stops its timer when the call is over. */
export type Deadline = { signal: AbortSignal; done: () => void };

/**
 * A deadline of `ms`, made the way lib/meet/recorder.ts gives up on an upload: an AbortController and a timer, which
 * every browser a guest may bring has (AbortSignal.timeout is missing in Safari before 16).
 */
function timeoutAfter(ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}
/** Reconnect tries before the call gives up: more when the video service itself refused (it can be a passing blip). */
const RECONNECT_TRIES = 3;
const RECONNECT_TRIES_SFU = 6;

const TRACK_MIC = "mic";
const TRACK_CAM = "cam";
const TRACK_SCREEN = "screen";

class RoomCallError extends Error {
  /** `reason` is why an ended room ended (host_ended, host_left, expired), when the answer says. */
  constructor(readonly status: number, readonly code: string, readonly reason: string | null = null) {
    super(code);
  }
}

/** Plain words for what the room API said, for the page's notice line. */
export function meetErrorWords(code: string): string {
  switch (code) {
    case "meet_not_configured":
      return "Meetings are not set up yet. Ask the host to finish the setup.";
    case "room_full":
      return "This meeting is full.";
    case "room_ended":
      return "This meeting has ended.";
    case "room_not_found":
      return "This meeting link does not exist.";
    case "removed":
      return "The host removed you from this meeting.";
    case "consent_required":
      return "Tick the recording notice to join.";
    case "name_required":
      return "Enter your name to join.";
    case "rate_limited":
      return "Too many tries. Wait a moment and try again.";
    case "sfu_failed":
      return "The video service did not answer. Try again in a moment.";
    // Not the server's: this browser has the meeting open in another tab (MeetTabs).
    case "open_in_another_tab":
      return "This meeting is already open in another tab of this browser.";
    default:
      return "Something went wrong. Try again.";
  }
}

export function createMeetRoomController(options: MeetRoomOptions): MeetRoomController {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const pollMs = options.pollMs ?? 2_000;
  const gatherMs = options.gatherMs ?? 3_000;
  const connectMs = options.connectMs ?? 15_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = options.deadline ?? timeoutAfter;
  const reconnectMs = options.reconnectMs ?? 1_000;
  const media = options.media ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
  const makePeer = options.makePeer ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
  const localNow = options.now ?? (() => Date.now());
  const tabs = options.tabs ?? browserTabs(options.code);
  const base = `/api/meet/${options.code}`;

  let phase: MeetPhase = { kind: "idle" };
  let room: MeetRoomInfo | null = null;
  let me: { id: string; role: MeetRole; name: string } | null = null;
  let iceServers: RTCIceServer[] = [];
  let participants: Participant[] = [];
  let hostPresent = false;
  let roomRecording = false;
  let notice: string | null = null;

  let pc: RTCPeerConnection | null = null;
  const local: { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; screen: MediaStreamTrack | null } = { mic: null, cam: null, screen: null };
  const tx: { mic?: RTCRtpTransceiver; cam?: RTCRtpTransceiver; screen?: RTCRtpTransceiver } = {};
  let micOn = false;
  /**
   * Each ask for the microphone, the camera or a screen takes a number. Asking again, turning it off, or the call
   * ending makes an earlier number stale, and an answer that comes back on a stale number is stopped, never kept:
   * the browser's prompt can sit open, and a light left on by an answer nobody wants any more is a camera running
   * unseen. The same numbering as the Schedule panel's stale list answers (components/meet/MeetPanel.tsx), and
   * the pre-join screen's twin for its two devices at once (components/meet/devices.ts createDeviceRequests).
   */
  const asks = { mic: 0, cam: 0, screen: 0 };
  const stale = (kind: keyof typeof asks, mine: number) => closed || asks[kind] !== mine;
  const pulled = new Map<string, Pulled>();
  const byMid = new Map<string, string>();
  const inFlight = new Set<string>();
  /** This tab's hold on the room while it is in it (MeetTabs), and what stops it listening for a hand-over. */
  let tabHold: { release(): void } | null = null;
  let stopListening: (() => void) | null = null;
  function letTabGo() {
    stopListening?.();
    stopListening = null;
    tabHold?.release();
    tabHold = null;
  }
  /** The Leave on its way: a call is left once, and only that Leave lets go of the room (controller.leave). */
  let leaving: Promise<void> | null = null;
  /** This tab's /join is on its way, and another tab asked for the room meanwhile (it is handed over once it answers). */
  let joinInFlight = false;
  let handOverAsked = false;
  /**
   * Another tab of this browser took the room ("Join here instead"): out of the call, telling the room nothing, and
   * letting go only once no SFU step of this tab's is still on its way. That tab is now this very participant, and a
   * session or publish of this one's landing after would act on its session and tracks.
   */
  function moved() {
    if (closed) return;
    ended("moved");
    void chain.then(() => letTabGo());
  }
  let recorder: RecorderPort | null = null;
  /** The room names this browser its recorder: its join said so, then each poll (it can change mid-call). */
  let records = false;
  /**
   * The room's clock as this browser reckons it: the server's time on the join and poll answers, taken from the
   * quickest answer so far (the least time in transit, so the closest reading). Segment times come from it, so when
   * the recording passes to another host's browser, the two recordings line up whatever their own clocks say.
   */
  let clockOffset = 0;
  let clockRtt = Number.POSITIVE_INFINITY;
  const roomNow = () => localNow() + clockOffset;
  function heardTime(serverTime: unknown, sent: number, received: number) {
    if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) return;
    const rtt = received - sent;
    if (rtt >= clockRtt) return;
    clockRtt = rtt;
    clockOffset = serverTime - (sent + received) / 2;
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollFailures = 0;
  let closed = false;
  let reconnects = 0;
  /**
   * The latest /join, settled either way. A leave sent before it answers carries no participant cookie (that comes in
   * its answer), so the room could not tell who left and would keep the place the join then makes. leave() waits on it.
   */
  let joinSettled: Promise<unknown> = Promise.resolve();

  const listeners = new Set<() => void>();
  let current: MeetSnapshot = build();

  function build(): MeetSnapshot {
    const tiles: MeetTile[] = participants.map((p) => {
      if (p.me) {
        return {
          participantId: p.id, name: p.name, role: p.role, me: true, audio: null,
          video: local.cam, screen: local.screen, micOn, camOn: !!local.cam, sharing: !!local.screen,
        };
      }
      const get = (name: string) => pulled.get(pullKey(p.id, p.session, name))?.track ?? null;
      const live = (t: MediaStreamTrack | null) => !!t && t.readyState === "live" && !t.muted;
      const audio = get(TRACK_MIC);
      const video = get(TRACK_CAM);
      const screen = get(TRACK_SCREEN);
      return {
        participantId: p.id, name: p.name, role: p.role, me: false,
        audio, video, screen, micOn: live(audio), camOn: live(video), sharing: live(screen),
      };
    });
    return {
      phase, room, me, tiles, hostPresent, micOn, camOn: !!local.cam, sharing: !!local.screen,
      recording: !!recorder, roomRecording, notice,
    };
  }

  function emit() {
    current = build();
    for (const l of listeners) l();
  }

  // Every call has a deadline: one that hangs fails like any other, so no screen waits on it for good.
  async function call<T = Record<string, unknown>>(path: string, body?: unknown, method = "POST", timeoutMs = requestTimeoutMs): Promise<T> {
    // The deadline covers the answer's body too: a reply whose body stalls is given up like one that never came.
    const limit = deadline(timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: limit.signal,
      });
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        // the status below says what happened
      }
      if (!res.ok || json.ok === false) {
        throw new RoomCallError(res.status, String(json.error ?? `http_${res.status}`), typeof json.reason === "string" ? json.reason : null);
      }
      return json as T;
    } finally {
      limit.done();
    }
  }

  const sfu = <T = Record<string, unknown>>(body: unknown) => call<T>("/sfu", body);

  // Every change to the session runs alone: Cloudflare needs each SDP exchange finished before the next change.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  function gathered(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        peer.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => {
        if (peer.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, gatherMs);
      peer.addEventListener("icegatheringstatechange", onChange);
    });
  }

  function connected(peer: RTCPeerConnection): Promise<void> {
    if (peer.connectionState === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        peer.removeEventListener("connectionstatechange", onChange);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const onChange = () => {
        if (peer.connectionState === "connected") finish();
        else if (peer.connectionState === "failed") finish(new Error("connection_failed"));
      };
      const timer = setTimeout(() => finish(new Error("connection_timeout")), connectMs);
      peer.addEventListener("connectionstatechange", onChange);
    });
  }

  function ended(reason: MeetEndReason) {
    if (phase.kind === "ended") return;
    phase = { kind: "ended", reason };
    teardown();
    emit();
  }

  function failed(error: string, code?: string) {
    phase = code ? { kind: "failed", error, code } : { kind: "failed", error };
    teardown();
    emit();
  }

  function teardown() {
    closed = true;
    // Any camera, microphone or screen still being asked for is no longer wanted. stale() reads `closed` too; the
    // numbers also cover a join tried again after a failure, which opens the controller again.
    asks.mic += 1;
    asks.cam += 1;
    asks.screen += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pc?.close();
    pc = null;
    // Its senders went with it: a device turned on or off after this never touches a closed connection.
    tx.mic = tx.cam = tx.screen = undefined;
    for (const t of [local.mic, local.cam, local.screen]) t?.stop();
    local.mic = local.cam = local.screen = null;
    micOn = false;
    pulled.clear();
    byMid.clear();
    // A room that is over for everyone (a host ended it, or it closed) has its recording finished and handed over;
    // leaving or being removed only stops it (the room's end hands it over later).
    void finishRecording(phase.kind === "ended" && (phase.reason === "host_ended" || phase.reason === "room_closed"));
    // Another tab of this browser may have the room now. Not yet on Leave: leave() lets go once the room has heard,
    // since a tab joining in its place before then would come back as the very participant the leave then ends. Nor
    // on a move: moved() lets go once this tab's SFU steps have answered.
    if (!(phase.kind === "ended" && (phase.reason === "left" || phase.reason === "moved"))) letTabGo();
  }

  /**
   * Stop the recording, if this browser runs one. When the room is over (`whole`), tell the PC the recording is
   * complete, with the recorder's counts; without that word the server hands it over ten minutes after the end.
   */
  async function finishRecording(whole: boolean): Promise<void> {
    const running = recorder;
    recorder = null;
    if (!running) return;
    let report: unknown;
    try {
      report = await running.stop();
    } catch (err) {
      // A recorder that cannot stop cleanly must not keep the call from ending; the server hands the recording
      // over ten minutes after the end without the report.
      console.error("[meet.room] the recorder did not stop cleanly", err instanceof Error ? err.message : err);
      return;
    }
    if ((report as { errored?: number } | null)?.errored) {
      notice = "Part of the audio may be missing from the recording.";
      emit();
    }
    if (whole && report) await call("/recording/finalize", report).catch(() => undefined);
  }

  // Answers that mean this person is no longer in the room.
  function endedBy(err: unknown): boolean {
    if (!(err instanceof RoomCallError)) return false;
    if (err.code === "removed") ended("removed");
    // "The host ended the meeting" only when a host did; a room that closed itself (its host gone ten minutes)
    // or any other end is "This meeting has ended."
    else if (err.status === 410) ended(err.reason === "host_ended" && me?.role !== "host" ? "host_ended" : "room_closed");
    // A meeting its host deleted is gone for everyone in it: not a connection to wait for.
    else if (err.status === 404 && err.code === "room_not_found") ended("room_closed");
    else if (err.status === 401 && phase.kind !== "joining") ended("dropped");
    else return false;
    return true;
  }

  // The room's poll: who is here, and the pulls that follow from it.

  function schedulePoll(delay = pollMs) {
    if (closed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll(), delay);
  }

  async function poll() {
    if (closed) return;
    // A poll that hangs is abandoned after POLL_TIMEOUT_MS and counted as a failed one: it must never stop the polls
    // after it, or a person still in the call goes silent to the room (lib/meet/participants.ts MEET_STALE_MS).
    try {
      const sent = localNow();
      const state = await call<{
        room: MeetRoomInfo;
        hostPresent: boolean;
        records?: boolean;
        recording?: boolean;
        serverTime?: number;
        me: { id: string; role: MeetRole; name: string };
        participants: Array<{ id: string; name: string; role: MeetRole; me: boolean; session?: string | null; tracks: Participant["tracks"] }>;
      }>("/state", undefined, "GET", pollTimeoutMs);
      heardTime(state.serverTime, sent, localNow());
      pollFailures = 0;
      room = state.room;
      me = state.me;
      hostPresent = state.hostPresent;
      roomRecording = state.recording === true;
      // Who records can change mid-call. Taken over (the recorder left or went silent): record from now, once live
      // (connect() starts it otherwise). Taken from this browser: stop, with no finalize, since the recording is
      // another browser's now.
      if (typeof state.records === "boolean" && state.records !== records) {
        records = state.records;
        if (!records) void finishRecording(false);
        else if (phase.kind === "live") startRecorder();
      }
      participants = state.participants.map((p) => ({ ...p, session: p.session ?? null, tracks: p.tracks ?? [] }));
      if (notice === "Reconnecting to the room...") notice = null;
      if (phase.kind === "waiting_for_host" && hostPresent) void connect();
      if (phase.kind === "live") void syncPulls();
      emit();
    } catch (err) {
      if (endedBy(err)) return;
      pollFailures += 1;
      if (pollFailures >= 3) {
        notice = "Reconnecting to the room...";
        emit();
      }
    }
    schedulePoll(pollFailures ? Math.min(pollMs * 2 ** pollFailures, 15_000) : pollMs);
  }

  /** Pull what others publish and is not pulled yet; close what was pulled from someone who left or stopped. */
  async function syncPulls() {
    const wanted = new Map<string, { participantId: string; trackName: string; session: string | null }>();
    for (const p of participants) {
      if (p.me) continue;
      for (const t of p.tracks) wanted.set(pullKey(p.id, p.session, t.trackName), { participantId: p.id, trackName: t.trackName, session: p.session });
    }
    const toPull = [...wanted.entries()].filter(([key]) => !pulled.has(key) && !inFlight.has(key));
    const toDrop = [...pulled.keys()].filter((key) => !wanted.has(key));
    if (toPull.length) {
      for (const [key] of toPull) inFlight.add(key);
      try {
        await serial(() => pull(toPull.map(([, w]) => w)));
      } catch (err) {
        // The exchange did not finish (an answer the browser or the SFU refused), so no media comes for these:
        // forget them, and the next poll pulls them again rather than leave the person silent all call long.
        for (const [key] of toPull) {
          const entry = pulled.get(key);
          if (entry?.mid) byMid.delete(entry.mid);
          pulled.delete(key);
        }
        console.error("[meet.room] a pull did not finish; the next poll tries again", err instanceof Error ? err.message : err);
      } finally {
        for (const [key] of toPull) inFlight.delete(key);
      }
    }
    if (toDrop.length) {
      // What is dropped is already forgotten here; a close the SFU refused only leaves tracks the room's end cuts.
      await serial(() => drop(toDrop)).catch((err: unknown) => console.error("[meet.room] a close did not finish", err instanceof Error ? err.message : err));
    }
  }

  /** The call ended, or reconnected onto a new connection, while a step was waiting: the step's answer is moot. */
  const moot = (peer: RTCPeerConnection) => closed || pc !== peer;

  async function pull(list: Array<{ participantId: string; trackName: string; session: string | null }>) {
    const peer = pc;
    if (!peer || closed) return;
    let res: {
      requiresImmediateRenegotiation: boolean;
      sessionDescription: RTCSessionDescriptionInit | null;
      tracks: Array<{ participantId: string | null; trackName: string | null; mid: string | null; errorCode: string | null }>;
    };
    // Each answer is kept under the session tag the poll showed when it was asked for.
    const sessionOf = new Map(list.map((w) => [`${w.participantId}\n${w.trackName}`, w.session]));
    try {
      res = await sfu({ action: "pull", tracks: list.map(({ participantId, trackName }) => ({ participantId, trackName })) });
    } catch (err) {
      if (endedBy(err)) return;
      // A track that went away between the poll and the pull: the next poll sorts it out.
      if (err instanceof RoomCallError && err.code === "track_not_found") return;
      throw err;
    }
    if (moot(peer)) return;
    for (const t of res.tracks) {
      if (!t.participantId || !t.trackName || t.errorCode || !t.mid) continue;
      const key = pullKey(t.participantId, sessionOf.get(`${t.participantId}\n${t.trackName}`) ?? null, t.trackName);
      pulled.set(key, { participantId: t.participantId, trackName: t.trackName, mid: t.mid, track: null });
      byMid.set(t.mid, key);
    }
    if (res.requiresImmediateRenegotiation && res.sessionDescription) {
      await peer.setRemoteDescription(res.sessionDescription);
      await peer.setLocalDescription(await peer.createAnswer());
      await gathered(peer);
      if (moot(peer)) return;
      await sfu({ action: "renegotiate", answer: { type: "answer", sdp: peer.localDescription?.sdp ?? "" } });
    }
  }

  async function drop(keys: string[]) {
    const peer = pc;
    if (!peer || closed) return;
    const mids: string[] = [];
    for (const key of keys) {
      const p = pulled.get(key);
      if (!p) continue;
      if (p.trackName === TRACK_MIC && p.track && recorder) recorder.removeTrack(p.participantId, p.track);
      if (p.mid) {
        mids.push(p.mid);
        byMid.delete(p.mid);
        peer.getTransceivers().find((t) => t.mid === p.mid)?.stop();
      }
      pulled.delete(key);
    }
    emit();
    if (!mids.length) return;
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    if (moot(peer)) return;
    const res = await sfu<{ sessionDescription: RTCSessionDescriptionInit | null }>({
      action: "close",
      mids,
      offer: { type: "offer", sdp: peer.localDescription?.sdp ?? "" },
    });
    if (res.sessionDescription && !moot(peer)) await peer.setRemoteDescription(res.sessionDescription);
  }

  function onRemoteTrack(event: RTCTrackEvent) {
    const key = event.transceiver.mid ? byMid.get(event.transceiver.mid) : undefined;
    const entry = key ? pulled.get(key) : undefined;
    if (!entry) return;
    entry.track = event.track;
    for (const type of ["mute", "unmute", "ended"]) event.track.addEventListener(type, emit);
    if (entry.trackName === TRACK_MIC && recorder) {
      recorder.addTrack({ participantId: entry.participantId, displayName: speakerName(entry.participantId), track: event.track });
    }
    emit();
  }

  /** The name a speaker's lines carry in the transcript: their name in the room as the last poll said. */
  function speakerName(participantId: string): string {
    return participants.find((p) => p.id === participantId)?.name ?? "Guest";
  }

  // Connecting: a session, then publish mic and camera on one offer, then wait for the line to come up.

  async function connect() {
    if (closed || phase.kind === "connecting" || phase.kind === "live") return;
    phase = { kind: "connecting" };
    emit();
    try {
      await serial(async () => {
        // Ended while this step waited its turn: no session is asked for at all.
        if (closed) return;
        await sfu({ action: "session" });
        // Ended while connecting (left, removed, moved to another tab): nothing more is set up. The room cuts the
        // session it just made (on the leave, or when the tab that took the meeting over connects in its place).
        if (closed) return;
        pc?.close();
        pulled.clear();
        byMid.clear();
        const peer = makePeer({ iceServers, bundlePolicy: "max-bundle" });
        pc = peer;
        peer.addEventListener("track", onRemoteTrack);
        peer.addEventListener("connectionstatechange", () => {
          if (peer === pc && peer.connectionState === "failed") void reconnect();
        });
        tx.mic = peer.addTransceiver(local.mic ?? "audio", { direction: "sendonly" });
        tx.cam = peer.addTransceiver(local.cam ?? "video", { direction: "sendonly" });
        // A screen shared before a reconnect goes out on the new session too: the person is still told they share it.
        // One the browser has stopped meanwhile is let go here, whether or not its "ended" handler has run yet.
        if (local.screen?.readyState === "ended") local.screen = null;
        tx.screen = local.screen ? peer.addTransceiver(local.screen, { direction: "sendonly" }) : undefined;
        if (!micOn) await tx.mic.sender.replaceTrack(null);
        await peer.setLocalDescription(await peer.createOffer());
        await gathered(peer);
        if (moot(peer)) return;
        const res = await sfu<{ sessionDescription: RTCSessionDescriptionInit | null }>({
          action: "publish",
          offer: { type: "offer", sdp: peer.localDescription?.sdp ?? "" },
          tracks: [
            { mid: tx.mic.mid, trackName: TRACK_MIC, kind: "audio" },
            { mid: tx.cam.mid, trackName: TRACK_CAM, kind: "video" },
            ...(tx.screen ? [{ mid: tx.screen.mid, trackName: TRACK_SCREEN, kind: "video" }] : []),
          ],
        });
        if (moot(peer)) return;
        if (!res.sessionDescription) throw new Error("no_answer");
        await peer.setRemoteDescription(res.sessionDescription);
        await connected(peer);
      });
      // A call that ended while it was connecting stays over: it is never brought back to live.
      if (closed) return;
      reconnects = 0;
      phase = { kind: "live" };
      startRecorder();
      emit();
      void syncPulls();
    } catch (err) {
      if (endedBy(err)) return;
      if (err instanceof RoomCallError && err.code === "waiting_for_host") {
        phase = { kind: "waiting_for_host" };
        emit();
        return;
      }
      if (err instanceof RoomCallError && err.code === "meet_not_configured") return failed(meetErrorWords(err.code), err.code);
      // A reconnect waits until the old session is cut (the server answers 502 sfu_failed until it is), so the
      // video service's own refusals get a longer run of tries than anything else.
      if (reconnects < (err instanceof RoomCallError && err.code === "sfu_failed" ? RECONNECT_TRIES_SFU : RECONNECT_TRIES)) return void reconnect();
      failed("Could not connect to the meeting. Check your connection and try again.");
    }
  }

  async function reconnect() {
    if (closed) return;
    reconnects += 1;
    notice = "Reconnecting...";
    phase = { kind: "joining" };
    emit();
    await new Promise((r) => setTimeout(r, reconnectMs * reconnects));
    // Left (or removed) during the wait: the call stays ended.
    if (closed) return;
    phase = { kind: "waiting_for_host" };
    notice = null;
    await connect();
  }

  function startRecorder() {
    if (recorder || !options.recorder || !records) return;
    recorder = options.recorder({ now: roomNow });
    if (local.mic && me) recorder.addTrack({ participantId: me.id, displayName: me.name, track: local.mic });
    // Taking over mid-call: the voices already coming in are recorded from now on too (a new recorder starts new
    // segments for each). At the start of a call there are none yet; onRemoteTrack hands each one over as it comes.
    for (const p of pulled.values()) {
      if (p.trackName === TRACK_MIC && p.track && p.track.readyState !== "ended") {
        recorder.addTrack({ participantId: p.participantId, displayName: speakerName(p.participantId), track: p.track });
      }
    }
  }

  const controller: MeetRoomController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,

    async join({ name, consent, mic, cam, here }) {
      if (phase.kind !== "idle" && phase.kind !== "failed") return;
      closed = false;
      phase = { kind: "joining" };
      notice = null;
      local.mic = mic;
      local.cam = cam;
      micOn = !!mic;
      emit();
      // One tab per browser (MeetTabs): another tab of this browser is the same participant, so it would cut this
      // one's media and record the room twice. It is told so; "Join here instead" (`here`) takes the room over, and the
      // tab that had it ends as `moved`, telling the room nothing: this one carries on as that participant.
      const held = here ? await tabs.take() : await tabs.hold();
      if (closed) return void held?.release();
      if (!held) return failed(meetErrorWords("open_in_another_tab"), "open_in_another_tab");
      tabHold = held;
      // Asked for the room while this join is on its way: hand it over only once the join has answered, and before
      // setting up any media. Its answer sets the cookie the other tab joins with, so that tab comes in as the
      // participant this one made (two joins with no cookie would make two), and no SFU step is left to drain.
      handOverAsked = false;
      stopListening = tabs.onAskedFor(() => {
        if (joinInFlight) handOverAsked = true;
        else moved();
      });
      try {
        const sent = localNow();
        joinInFlight = true;
        const asked = call<{
          participantId: string; role: MeetRole; name: string; records?: boolean; serverTime?: number; room: MeetRoomInfo; iceServers: RTCIceServer[];
        }>("/join", {
          ...(name ? { name } : {}),
          consent,
        });
        joinSettled = asked.catch(() => undefined);
        const res = await asked.finally(() => {
          joinInFlight = false;
        });
        heardTime(res.serverTime, sent, localNow());
        // Left while the join was on its way: the call stays ended, and leave() tells the room now that it can.
        if (closed) return;
        if (handOverAsked) return moved();
        me = { id: res.participantId, role: res.role, name: res.name };
        records = res.records === true;
        room = res.room;
        iceServers = res.iceServers ?? [];
        participants = [{ id: me.id, name: me.name, role: me.role, me: true, session: null, tracks: [] }];
        phase = { kind: "waiting_for_host" };
        emit();
        schedulePoll(0);
        if (res.role === "host") await connect();
      } catch (err) {
        // Left while the join was on its way: the call stays left, whatever the join's answer.
        if (closed) return;
        const code = err instanceof RoomCallError ? err.code : "unknown";
        if (code === "removed") return ended("removed");
        // The same end as any other failure: the tracks handed in are stopped, and a camera or microphone asked for
        // while the join was on its way is no longer wanted (its answer is stopped, even after a join tried again).
        failed(meetErrorWords(code), code);
      }
    },

    async setMic(on) {
      if (!on) asks.mic += 1; // a microphone still being asked for is no longer wanted
      if (on && !local.mic) {
        const mine = ++asks.mic;
        let got: MediaStreamTrack | null;
        try {
          got = (await media!.getUserMedia({ audio: true })).getAudioTracks()[0] ?? null;
        } catch {
          if (stale("mic", mine)) return;
          notice = "Your microphone is blocked. Allow it in the browser's address bar.";
          return emit();
        }
        if (stale("mic", mine)) return void got?.stop();
        local.mic = got;
        if (recorder && local.mic && me) recorder.addTrack({ participantId: me.id, displayName: me.name, track: local.mic });
      }
      if (local.mic) local.mic.enabled = on;
      micOn = on && !!local.mic;
      if (tx.mic) await tx.mic.sender.replaceTrack(on ? local.mic : null);
      emit();
    },

    async setCam(on) {
      if (on) {
        if (!local.cam) {
          const mine = ++asks.cam;
          let got: MediaStreamTrack | null;
          try {
            got = (await media!.getUserMedia({ video: true })).getVideoTracks()[0] ?? null;
          } catch {
            if (stale("cam", mine)) return;
            notice = "Your camera is blocked. Allow it in the browser's address bar.";
            return emit();
          }
          if (stale("cam", mine)) return void got?.stop();
          local.cam = got;
        }
        if (tx.cam) await tx.cam.sender.replaceTrack(local.cam);
      } else {
        asks.cam += 1; // a camera still being asked for is no longer wanted
        if (tx.cam) await tx.cam.sender.replaceTrack(null);
        local.cam?.stop();
        local.cam = null;
      }
      emit();
    },

    async shareScreen(on) {
      if (!on) {
        // Stopping works in every phase: the browser's own "Stop sharing" can come during a reconnect, and a share
        // stopped then must not go out again on the new session.
        asks.screen += 1; // a screen still being picked is no longer wanted
        if (tx.screen) await tx.screen.sender.replaceTrack(null);
        local.screen?.stop();
        local.screen = null;
        return emit();
      }
      if (!pc || phase.kind !== "live") return;
      const mine = ++asks.screen;
      let track: MediaStreamTrack | null = null;
      try {
        track = (await media!.getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0] ?? null;
      } catch {
        return; // the person closed the picker
      }
      if (stale("screen", mine) || phase.kind !== "live") return void track?.stop();
      if (!track) return;
      local.screen?.stop(); // a share already running is replaced, never left running unseen
      local.screen = track;
      // The browser's own "Stop sharing" button ends the track: the room hears about it the same way.
      track.addEventListener("ended", () => {
        if (local.screen === track) void controller.shareScreen(false);
      });
      emit();
      if (tx.screen) {
        await tx.screen.sender.replaceTrack(track);
        return;
      }
      try {
        await serial(async () => {
          const peer = pc;
          if (!peer || closed) return;
          tx.screen = peer.addTransceiver(track!, { direction: "sendonly" });
          await peer.setLocalDescription(await peer.createOffer());
          await gathered(peer);
          if (moot(peer)) return;
          const res = await sfu<{ sessionDescription: RTCSessionDescriptionInit | null }>({
            action: "publish",
            offer: { type: "offer", sdp: peer.localDescription?.sdp ?? "" },
            tracks: [{ mid: tx.screen.mid, trackName: TRACK_SCREEN, kind: "video" }],
          });
          if (res.sessionDescription && !moot(peer)) await peer.setRemoteDescription(res.sessionDescription);
        });
      } catch (err) {
        if (endedBy(err)) return;
        notice = "Could not share your screen. Try again.";
        // The SFU never took this transceiver's track: take it back, so the next share publishes anew instead of
        // feeding a sender nobody receives. (Set inside the publish step, which the type narrowing cannot see.)
        const unpublished = tx.screen as RTCRtpTransceiver | undefined;
        unpublished?.stop();
        tx.screen = undefined;
        local.screen?.stop();
        local.screen = null;
        emit();
      }
    },

    async remove(participantId) {
      try {
        await call("/host", { action: "remove", participantId });
        participants = participants.filter((p) => p.id !== participantId);
        emit();
        void syncPulls();
      } catch (err) {
        if (endedBy(err)) return;
        notice = "Could not remove them. Try again.";
        emit();
      }
    },

    async end() {
      if (closed) return;
      // The room is asked first; the recorder runs on until it has ended (see the top of this file). A poll that
      // sees the end first finishes the recording the same way: whichever comes first takes the recorder.
      try {
        await call("/host", { action: "end" });
      } catch (err) {
        if (endedBy(err)) return;
        // Still in the meeting, and still recorded.
        notice = "Could not end the meeting. Try again.";
        return emit();
      }
      // Best effort: if the PC is never told, it takes the recording ten minutes after the end anyway.
      await finishRecording(true);
      ended("host_ended");
    },

    leave() {
      // One Leave a call: a second (a double click) waits on the first, which alone lets go of the room once the room
      // has heard it. Letting go sooner would let another tab of this browser join as this participant first.
      leaving ??= leaveOnce();
      return leaving;
    },

    inRoom: () => tabHold !== null && !closed,
  };

  async function leaveOnce(): Promise<void> {
    // Only a tab in the room tells it so: another tab of this browser shares its cookie, and a leave from a tab that
    // never got in (or already let go) would end THAT tab's place.
    const inRoom = controller.inRoom();
    // Out at once: the camera and microphone stop now, whatever the network does (a dropped network is a common
    // reason to leave). The room is told after; if that never arrives, it drops anyone who stops polling.
    ended("left");
    if (!inRoom) return letTabGo();
    // A join still on its way makes this person's place when it answers, and only its answer carries the cookie a
    // leave needs: wait for it (its own deadline bounds the wait), so the room hears who left and frees the place.
    await joinSettled;
    const limit = deadline(requestTimeoutMs);
    try {
      await fetchImpl(`${base}/leave`, { method: "POST", credentials: "same-origin", keepalive: true, signal: limit.signal });
    } catch {
      // already out of the call; see above
    } finally {
      limit.done();
      letTabGo();
    }
  }

  return controller;
}
