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
 * microphone and every remote microphone as it arrives, and told when someone leaves. End asks the room to end
 * FIRST and stops the recorder only once it has: an End that fails leaves the meeting going and still recorded,
 * where stopping first would lose the rest of the call. The recorder's last chunks go up after the end (the
 * chunk route takes them for ten minutes), and then the PC is told the recording is whole.
 */

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

export type MeetEndReason = "host_ended" | "removed" | "left" | "room_closed";

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
  /** The host's recorder is running. */
  recording: boolean;
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
  /** Enter the room with the tracks the pre-join screen already has (either may be null: joined muted or camera off). */
  join(input: { name?: string; consent: boolean; mic: MediaStreamTrack | null; cam: MediaStreamTrack | null }): Promise<void>;
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
  /** Made for a host in a recorded room, once they are in. */
  recorder?: () => RecorderPort;
  media?: Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;
  makePeer?: (config: RTCConfiguration) => RTCPeerConnection;
  /** How long to wait for ICE candidates before sending a description (non-trickle), and for "connected". */
  gatherMs?: number;
  connectMs?: number;
};

type Participant = { id: string; name: string; role: MeetRole; me: boolean; tracks: Array<{ trackName: string; kind: "audio" | "video" }> };
type Pulled = { participantId: string; trackName: string; mid: string | null; track: MediaStreamTrack | null };

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
    default:
      return "Something went wrong. Try again.";
  }
}

export function createMeetRoomController(options: MeetRoomOptions): MeetRoomController {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const pollMs = options.pollMs ?? 2_000;
  const gatherMs = options.gatherMs ?? 3_000;
  const connectMs = options.connectMs ?? 15_000;
  const media = options.media ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
  const makePeer = options.makePeer ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
  const base = `/api/meet/${options.code}`;

  let phase: MeetPhase = { kind: "idle" };
  let room: MeetRoomInfo | null = null;
  let me: { id: string; role: MeetRole; name: string } | null = null;
  let iceServers: RTCIceServer[] = [];
  let participants: Participant[] = [];
  let hostPresent = false;
  let notice: string | null = null;

  let pc: RTCPeerConnection | null = null;
  const local: { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; screen: MediaStreamTrack | null } = { mic: null, cam: null, screen: null };
  const tx: { mic?: RTCRtpTransceiver; cam?: RTCRtpTransceiver; screen?: RTCRtpTransceiver } = {};
  let micOn = false;
  const pulled = new Map<string, Pulled>();
  const byMid = new Map<string, string>();
  const inFlight = new Set<string>();
  let recorder: RecorderPort | null = null;
  /** The join said this browser records (the room creator's, in a recorded room). */
  let records = false;
  const recorded = new Map<string, MediaStreamTrack>();

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollFailures = 0;
  let closed = false;
  let reconnects = 0;

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
      const get = (name: string) => pulled.get(`${p.id}:${name}`)?.track ?? null;
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
      recording: !!recorder, notice,
    };
  }

  function emit() {
    current = build();
    for (const l of listeners) l();
  }

  async function call<T = Record<string, unknown>>(path: string, body?: unknown, method = "POST"): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
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
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pc?.close();
    pc = null;
    for (const t of [local.mic, local.cam, local.screen]) t?.stop();
    local.mic = local.cam = local.screen = null;
    micOn = false;
    pulled.clear();
    byMid.clear();
    // A room that is over for everyone (a host ended it, or it closed) has its recording finished and handed over;
    // leaving or being removed only stops it (the room's end hands it over later).
    void finishRecording(phase.kind === "ended" && (phase.reason === "host_ended" || phase.reason === "room_closed"));
  }

  /**
   * Stop the recording, if this browser runs one. When the room is over (`whole`), tell the PC the recording is
   * complete, with the recorder's counts; without that word the server hands it over ten minutes after the end.
   */
  async function finishRecording(whole: boolean): Promise<void> {
    const running = recorder;
    recorder = null;
    if (!running) return;
    const report = await running.stop();
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
    else if (err.status === 401 && phase.kind !== "joining") ended("left");
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
    try {
      const state = await call<{
        room: MeetRoomInfo;
        hostPresent: boolean;
        me: { id: string; role: MeetRole; name: string };
        participants: Array<{ id: string; name: string; role: MeetRole; me: boolean; tracks: Participant["tracks"] }>;
      }>("/state", undefined, "GET");
      pollFailures = 0;
      room = state.room;
      me = state.me;
      hostPresent = state.hostPresent;
      participants = state.participants.map((p) => ({ ...p, tracks: p.tracks ?? [] }));
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
    const wanted = new Map<string, { participantId: string; trackName: string }>();
    for (const p of participants) {
      if (p.me) continue;
      for (const t of p.tracks) wanted.set(`${p.id}:${t.trackName}`, { participantId: p.id, trackName: t.trackName });
    }
    const toPull = [...wanted.entries()].filter(([key]) => !pulled.has(key) && !inFlight.has(key));
    const toDrop = [...pulled.keys()].filter((key) => !wanted.has(key));
    if (toPull.length) {
      for (const [key] of toPull) inFlight.add(key);
      await serial(() => pull(toPull.map(([, w]) => w))).finally(() => {
        for (const [key] of toPull) inFlight.delete(key);
      });
    }
    if (toDrop.length) await serial(() => drop(toDrop));
  }

  /** The call ended, or reconnected onto a new connection, while a step was waiting: the step's answer is moot. */
  const moot = (peer: RTCPeerConnection) => closed || pc !== peer;

  async function pull(list: Array<{ participantId: string; trackName: string }>) {
    const peer = pc;
    if (!peer || closed) return;
    let res: {
      requiresImmediateRenegotiation: boolean;
      sessionDescription: RTCSessionDescriptionInit | null;
      tracks: Array<{ participantId: string | null; trackName: string | null; mid: string | null; errorCode: string | null }>;
    };
    try {
      res = await sfu({ action: "pull", tracks: list });
    } catch (err) {
      if (endedBy(err)) return;
      // A track that went away between the poll and the pull: the next poll sorts it out.
      if (err instanceof RoomCallError && err.code === "track_not_found") return;
      throw err;
    }
    if (moot(peer)) return;
    for (const t of res.tracks) {
      if (!t.participantId || !t.trackName || t.errorCode || !t.mid) continue;
      const key = `${t.participantId}:${t.trackName}`;
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
      recorded.delete(p.participantId);
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
      const name = participants.find((p) => p.id === entry.participantId)?.name ?? "Guest";
      recorder.addTrack({ participantId: entry.participantId, displayName: name, track: event.track });
      recorded.set(entry.participantId, event.track);
    }
    emit();
  }

  // Connecting: a session, then publish mic and camera on one offer, then wait for the line to come up.

  async function connect() {
    if (closed || phase.kind === "connecting" || phase.kind === "live") return;
    phase = { kind: "connecting" };
    emit();
    try {
      await serial(async () => {
        await sfu({ action: "session" });
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
        tx.screen = undefined;
        if (!micOn) await tx.mic.sender.replaceTrack(null);
        await peer.setLocalDescription(await peer.createOffer());
        await gathered(peer);
        const res = await sfu<{ sessionDescription: RTCSessionDescriptionInit | null }>({
          action: "publish",
          offer: { type: "offer", sdp: peer.localDescription?.sdp ?? "" },
          tracks: [
            { mid: tx.mic.mid, trackName: TRACK_MIC, kind: "audio" },
            { mid: tx.cam.mid, trackName: TRACK_CAM, kind: "video" },
          ],
        });
        if (!res.sessionDescription) throw new Error("no_answer");
        await peer.setRemoteDescription(res.sessionDescription);
        await connected(peer);
      });
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
      if (reconnects < 3) return void reconnect();
      failed("Could not connect to the meeting. Check your connection and try again.");
    }
  }

  async function reconnect() {
    if (closed) return;
    reconnects += 1;
    notice = "Reconnecting...";
    phase = { kind: "joining" };
    emit();
    await new Promise((r) => setTimeout(r, 1_000 * reconnects));
    // Left (or removed) during the wait: the call stays ended.
    if (closed) return;
    phase = { kind: "waiting_for_host" };
    notice = null;
    await connect();
  }

  function startRecorder() {
    if (recorder || !options.recorder || !records) return;
    recorder = options.recorder();
    if (local.mic && me) recorder.addTrack({ participantId: me.id, displayName: me.name, track: local.mic });
  }

  const controller: MeetRoomController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,

    async join({ name, consent, mic, cam }) {
      if (phase.kind !== "idle" && phase.kind !== "failed") return;
      closed = false;
      phase = { kind: "joining" };
      notice = null;
      local.mic = mic;
      local.cam = cam;
      micOn = !!mic;
      emit();
      try {
        const res = await call<{ participantId: string; role: MeetRole; name: string; records?: boolean; room: MeetRoomInfo; iceServers: RTCIceServer[] }>("/join", {
          ...(name ? { name } : {}),
          consent,
        });
        // Left while the join was on its way: the call stays ended (the room drops a participant who never polls).
        if (closed) return;
        me = { id: res.participantId, role: res.role, name: res.name };
        records = res.records === true;
        room = res.room;
        iceServers = res.iceServers ?? [];
        participants = [{ id: me.id, name: me.name, role: me.role, me: true, tracks: [] }];
        phase = { kind: "waiting_for_host" };
        emit();
        schedulePoll(0);
        if (res.role === "host") await connect();
      } catch (err) {
        const code = err instanceof RoomCallError ? err.code : "unknown";
        if (code === "removed") return ended("removed");
        phase = { kind: "failed", error: meetErrorWords(code), code };
        for (const t of [local.mic, local.cam]) t?.stop();
        local.mic = local.cam = null;
        emit();
      }
    },

    async setMic(on) {
      if (on && !local.mic) {
        try {
          local.mic = (await media!.getUserMedia({ audio: true })).getAudioTracks()[0] ?? null;
        } catch {
          notice = "Your microphone is blocked. Allow it in the browser's address bar.";
          return emit();
        }
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
          try {
            local.cam = (await media!.getUserMedia({ video: true })).getVideoTracks()[0] ?? null;
          } catch {
            notice = "Your camera is blocked. Allow it in the browser's address bar.";
            return emit();
          }
        }
        if (tx.cam) await tx.cam.sender.replaceTrack(local.cam);
      } else {
        if (tx.cam) await tx.cam.sender.replaceTrack(null);
        local.cam?.stop();
        local.cam = null;
      }
      emit();
    },

    async shareScreen(on) {
      if (!pc || phase.kind !== "live") return;
      if (!on) {
        if (tx.screen) await tx.screen.sender.replaceTrack(null);
        local.screen?.stop();
        local.screen = null;
        return emit();
      }
      let track: MediaStreamTrack | null = null;
      try {
        track = (await media!.getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0] ?? null;
      } catch {
        return; // the person closed the picker
      }
      if (!track) return;
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
          const peer = pc!;
          tx.screen = peer.addTransceiver(track!, { direction: "sendonly" });
          await peer.setLocalDescription(await peer.createOffer());
          await gathered(peer);
          const res = await sfu<{ sessionDescription: RTCSessionDescriptionInit | null }>({
            action: "publish",
            offer: { type: "offer", sdp: peer.localDescription?.sdp ?? "" },
            tracks: [{ mid: tx.screen.mid, trackName: TRACK_SCREEN, kind: "video" }],
          });
          if (res.sessionDescription) await peer.setRemoteDescription(res.sessionDescription);
        });
      } catch (err) {
        if (endedBy(err)) return;
        notice = "Could not share your screen. Try again.";
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

    async leave() {
      try {
        await fetchImpl(`${base}/leave`, { method: "POST", credentials: "same-origin", keepalive: true });
      } catch {
        // leaving locally regardless: the room drops anyone who stops polling
      }
      ended("left");
    },
  };
  return controller;
}
