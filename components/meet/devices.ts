/**
 * components/meet/devices.ts - asking the browser for the camera and microphone on the pre-join screen, and the
 * plain words for what it said. No React, and the browser comes in as an argument, so tests/meet-ui.test.ts runs
 * it against a stand-in that counts the calls.
 *
 * openDevices never touches getUserMedia unless `allowed` is true. `allowed` is components/meet/notice.ts
 * mayAskForDevices: the recording notice is ticked, or there is none to tick (Quebec Law 25, notice before
 * collection). One device that is missing or busy does not cost the person the other.
 *
 * createDeviceRequests is the other half: an answer from the browser can arrive after the person has moved on
 * (asked again, withdrawn consent, joined, left, stopped waiting), and it must then be stopped, not held. The call
 * does the same for one device at a time, and for a shared screen (lib/meet/room-client.ts `asks`).
 *
 * A browser may also never answer (the person ignores its prompt), so a screen that waits on a request needs a way
 * out: waitingWords says what that way out is called and what to do instead, from what is still being waited for.
 */

export type DeviceProblem = "not_yet" | "blocked" | "policy" | "none" | "busy" | "unsupported" | "unknown";

/** The page's own permissions policy (document.permissionsPolicy, or document.featurePolicy in older Chrome). */
export type PolicyLike = { allowsFeature(feature: string): boolean };

type MediaLike = Pick<MediaDevices, "getUserMedia">;

export type OpenedDevices = {
  mic: MediaStreamTrack | null;
  cam: MediaStreamTrack | null;
  /** Why a wanted device did not come back, per device. Empty when everything asked for arrived. */
  problems: { mic?: DeviceProblem; cam?: DeviceProblem };
};

export type OpenInput = {
  /** The recording notice is ticked, or there is none to tick. */
  allowed: boolean;
  media: MediaLike | null | undefined;
  want: { mic: boolean; cam: boolean };
  /** A device the person picked; empty or absent means the browser's default. */
  micId?: string;
  camId?: string;
  /**
   * The page's permissions policy. A site header can forbid the camera for the whole page, and the browser then
   * answers exactly as if the person had said no; telling them to click the address bar would send them nowhere.
   */
  policy?: PolicyLike | null;
};

/** What a getUserMedia failure means for the person, from the error's name (DOMException names, with the old Chrome ones). */
export function problemOf(err: unknown): DeviceProblem {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name?: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "blocked";
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "none";
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return "busy";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

async function alone(
  ask: (mic: boolean, cam: boolean) => Promise<{ mic: MediaStreamTrack | null; cam: MediaStreamTrack | null }>,
  kind: "mic" | "cam",
): Promise<{ track: MediaStreamTrack | null; problem: DeviceProblem | null }> {
  try {
    const got = await ask(kind === "mic", kind === "cam");
    return { track: got[kind], problem: null };
  } catch (err) {
    return { track: null, problem: problemOf(err) };
  }
}

export async function openDevices(input: OpenInput): Promise<OpenedDevices> {
  const { want } = input;
  const all = (problem: DeviceProblem): OpenedDevices["problems"] => ({
    ...(want.mic ? { mic: problem } : {}),
    ...(want.cam ? { cam: problem } : {}),
  });
  if (!want.mic && !want.cam) return { mic: null, cam: null, problems: {} };
  // The hard rule: until the recording notice is ticked, the browser is not asked for anything.
  if (!input.allowed) return { mic: null, cam: null, problems: all("not_yet") };
  const media = input.media;
  if (!media || typeof media.getUserMedia !== "function") return { mic: null, cam: null, problems: all("unsupported") };

  const constraint = (id: string | undefined) => (id ? { deviceId: { exact: id } } : true);
  const ask = async (mic: boolean, cam: boolean) => {
    const stream = await media.getUserMedia({
      audio: mic ? constraint(input.micId) : false,
      video: cam ? constraint(input.camId) : false,
    });
    return { mic: stream.getAudioTracks()[0] ?? null, cam: stream.getVideoTracks()[0] ?? null };
  };

  try {
    return { ...(await ask(want.mic, want.cam)), problems: {} };
  } catch (err) {
    const problem = problemOf(err);
    if (problem === "blocked") {
      const forbids = (feature: string) => input.policy?.allowsFeature(feature) === false;
      if ((want.cam && forbids("camera")) || (want.mic && forbids("microphone"))) {
        return {
          mic: null,
          cam: null,
          problems: {
            ...(want.mic ? { mic: forbids("microphone") ? ("policy" as const) : ("blocked" as const) } : {}),
            ...(want.cam ? { cam: forbids("camera") ? ("policy" as const) : ("blocked" as const) } : {}),
          },
        };
      }
    }
    // Blocked and unsupported are the same for both devices. Missing or busy is not: ask for each on its own.
    if (!(want.mic && want.cam) || problem === "blocked" || problem === "unsupported") {
      return { mic: null, cam: null, problems: all(problem) };
    }
    const [mic, cam] = await Promise.all([alone(ask, "mic"), alone(ask, "cam")]);
    return {
      mic: mic.track,
      cam: cam.track,
      problems: { ...(mic.problem ? { mic: mic.problem } : {}), ...(cam.problem ? { cam: cam.problem } : {}) },
    };
  }
}

type DeviceKind = "mic" | "cam";

/** Which devices the requests still open are waiting on the browser for. */
export type Waiting = { mic: boolean; cam: boolean };

/** Nothing is being waited for. One shared object, so setting state to it again does not draw the screen again. */
export const NOT_WAITING: Waiting = Object.freeze({ mic: false, cam: false });

/** What a finished request hands back. */
export type DeviceAnswer = {
  /** The tracks that are still wanted; a track that is not has been stopped. */
  mic: MediaStreamTrack | null;
  cam: MediaStreamTrack | null;
  /** Some device this request asked for is still wanted (not asked for again, not cancelled, the gate still open). */
  current: boolean;
  /** Another request is still open and still waited on (a cancelled one is not). */
  pending: boolean;
  /** Which devices those requests are waiting for; `pending` is whether this has any. */
  waiting: Waiting;
  /** Why a wanted device did not come back, per device (see OpenedDevices). */
  problems: OpenedDevices["problems"];
};

/**
 * Which request for the camera and microphone still counts. A request is an await on the browser (it can sit behind
 * the browser's own prompt), and the person can move on while it is open: ask again, un-tick the notice, leave the
 * page. An answer that arrives after that must not be held, or its camera light stays on with nobody looking at it.
 *
 * A request is opened only through run(), which settles it when the browser answers or throws, so a request that
 * fails cannot leave the count of open requests up. A browser that never answers (the person ignores its prompt:
 * getUserMedia may neither resolve nor reject) leaves its request open, which is true, until the person stops
 * waiting and cancel() lets it go. Each request takes a number for each device it asks for. Asking for that device
 * again, or cancel(), makes the number stale, and the tracks of a stale answer are stopped instead of handed back.
 * The numbers are per device, so asking for the microphone while the camera is still opening does not cost the
 * person the camera.
 */
export type DeviceRequests = {
  /**
   * One whole request: take the numbers, ask (`ask` is what talks to the browser), settle the answer when it comes.
   * `allowed` is the recording-notice gate, read when the answer arrives: if it has closed, nothing is wanted.
   *
   * It settles when `ask` answers or throws. openDevices answers with problems rather than throwing, so an `ask` that
   * throws is a bug or a browser object that misbehaves; the error goes to `onError`, nothing is in hand, and every
   * device asked for reads "unknown" (the person is told it did not start and can try again). The count goes down
   * either way, so a throw cannot leave `pending` up. An `ask` the browser never answers does not settle, and
   * `pending` is then rightly true until the person stops waiting (cancel()).
   */
  run(
    want: { mic: boolean; cam: boolean },
    ask: () => Promise<OpenedDevices>,
    allowed: () => boolean,
    onError: (err: unknown) => void,
  ): Promise<DeviceAnswer>;
  /** Which devices the requests still open are waiting on the browser for, right now (run has counted its request on the way in). */
  waiting(): Waiting;
  /**
   * Nothing open is wanted any more: the devices were released, the screen went away, consent was withdrawn, or the
   * person chose to stop waiting. A request still open stops being counted at once (waiting() reads empty and `pending`
   * false, though the browser has not answered), and its answer is stopped when it does come. A join is not one of
   * these: if it fails the person stays on this screen, which is where a late answer belongs.
   */
  cancel(): void;
};

export function createDeviceRequests(): DeviceRequests {
  const latest: Record<DeviceKind, number> = { mic: 0, cam: 0 };
  // The requests still open and still waited on, each by what it asked for. cancel() empties this at once, so a request
  // it abandoned is not counted although the browser has not answered. When that answer does come, delete() finds
  // nothing to take out: it can neither push the count below zero nor take the place of a newer request.
  const open = new Set<Waiting>();
  const waiting = (): Waiting => {
    let mic = false;
    let cam = false;
    for (const asked of open) {
      mic ||= asked.mic;
      cam ||= asked.cam;
    }
    return mic || cam ? { mic, cam } : NOT_WAITING;
  };
  return {
    waiting,
    cancel() {
      latest.mic += 1;
      latest.cam += 1;
      open.clear();
    },
    async run(want, ask, allowed, onError) {
      const asked: Waiting = { mic: want.mic, cam: want.cam }; // one object per request: the set tells requests apart by it
      open.add(asked);
      if (want.mic) latest.mic += 1;
      if (want.cam) latest.cam += 1;
      const ticket: Record<DeviceKind, number | null> = { mic: want.mic ? latest.mic : null, cam: want.cam ? latest.cam : null };
      // Not started, unless the browser says otherwise.
      let opened: OpenedDevices = {
        mic: null,
        cam: null,
        problems: { ...(want.mic ? { mic: "unknown" as const } : {}), ...(want.cam ? { cam: "unknown" as const } : {}) },
      };
      try {
        opened = await ask();
      } catch (err) {
        onError(err);
      } finally {
        open.delete(asked);
      }
      const gate = allowed();
      const wanted = (kind: DeviceKind) => gate && ticket[kind] !== null && ticket[kind] === latest[kind];
      const keep = (kind: DeviceKind): MediaStreamTrack | null => {
        const track = opened[kind];
        if (!track) return null;
        if (wanted(kind)) return track;
        track.stop();
        return null;
      };
      const still = waiting();
      return { mic: keep("mic"), cam: keep("cam"), current: wanted("mic") || wanted("cam"), pending: still.mic || still.cam, waiting: still, problems: opened.problems };
    },
  };
}

type Thing = "camera" | "microphone";

function sentence(problem: DeviceProblem, thing: string): string {
  switch (problem) {
    case "blocked":
      return `Your browser blocked the ${thing}.`;
    case "policy":
      return `This page is not allowed to use the ${thing}. That is a setup problem on our side, not a setting you can change.`;
    case "none":
      return `No ${thing.replace(" and ", " or ")} was found.`;
    case "busy":
      return `Another app is using your ${thing}.`;
    case "unsupported":
      return `This browser cannot use the ${thing} here.`;
    default:
      return `The ${thing} did not start.`;
  }
}

/** How a person lets a blocked or waiting camera or microphone through, said the same wherever a screen says it. */
const ALLOW_STEPS = "click the camera or lock icon in the address bar, choose Allow";

/**
 * Plain words for what did not come back, ending with how to fix a blocked one and that joining still works.
 * Null when nothing went wrong (or the page simply has not asked yet).
 */
export function deviceWords(problems: OpenedDevices["problems"]): string | null {
  const list: Array<{ thing: Thing; problem: DeviceProblem }> = [];
  if (problems.cam && problems.cam !== "not_yet") list.push({ thing: "camera", problem: problems.cam });
  if (problems.mic && problems.mic !== "not_yet") list.push({ thing: "microphone", problem: problems.mic });
  if (!list.length) return null;
  const same = list.length === 2 && list[0].problem === list[1].problem;
  const lines = same ? [sentence(list[0].problem, "camera and microphone")] : list.map((l) => sentence(l.problem, l.thing));
  const blocked = list.filter((l) => l.problem === "blocked").length;
  if (blocked) {
    lines.push(`To allow ${blocked === 2 ? "them" : "it"}, ${ALLOW_STEPS}, then try again.`);
  }
  lines.push(`You can still join without ${list.length === 2 ? "them" : "it"}.`);
  return lines.join(" ");
}

/**
 * The way out of waiting on the browser, in plain words: what the button says, and what to do instead. `waiting` is
 * what is still being asked for, `held` what the person already has running. A device that is waiting and not held is
 * one they would join without. One that is waiting and already held is a switch to another one (the picker): the way
 * out keeps the one they have. Null when nothing is being waited for.
 */
export function waitingWords(waiting: Waiting, held: Waiting): { button: string; hint: string } | null {
  if (!waiting.mic && !waiting.cam) return null;
  const named = (w: Waiting) => (w.cam && w.mic ? "camera and microphone" : w.cam ? "camera" : "microphone");
  const missing: Waiting = { mic: waiting.mic && !held.mic, cam: waiting.cam && !held.cam };
  if (missing.mic || missing.cam) {
    return {
      button: `Join without your ${named(missing)}`,
      hint: `Or, to allow ${missing.mic && missing.cam ? "them" : "it"}, ${ALLOW_STEPS}.`,
    };
  }
  return { button: `Join with your current ${named(waiting)}`, hint: "Or wait: your browser is still opening the one you picked." };
}

export type DeviceChoice = { id: string; label: string };

/** The cameras and microphones the browser lists (names appear once permission is granted). Never throws. */
export async function listInputs(
  media: Pick<MediaDevices, "enumerateDevices"> | null | undefined,
): Promise<{ mics: DeviceChoice[]; cams: DeviceChoice[] }> {
  if (!media || typeof media.enumerateDevices !== "function") return { mics: [], cams: [] };
  try {
    const found = await media.enumerateDevices();
    const pick = (kind: MediaDeviceKind, fallback: string): DeviceChoice[] =>
      found
        .filter((d) => d.kind === kind && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    return { mics: pick("audioinput", "Microphone"), cams: pick("videoinput", "Camera") };
  } catch {
    // The list is a convenience: without it the pickers stay hidden and the default devices still work.
    return { mics: [], cams: [] };
  }
}
