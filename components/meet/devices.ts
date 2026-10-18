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
 * (asked again, withdrawn consent, joined, left), and it must then be stopped, not held.
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

/** What a request for devices was given when it began: a number for each device it asked for, null for one it did not. */
export type DeviceTicket = { mic: number | null; cam: number | null };

/**
 * Which request for the camera and microphone still counts. A request is an await on the browser (it can sit behind
 * the browser's own prompt), and the person can move on while it is open: ask again, un-tick the notice, Join, leave
 * the page. An answer that arrives after that must not be held, or its camera light stays on with nobody looking at it.
 *
 * Each request takes a number for each device it asks for. Asking for that device again, or cancel(), makes the
 * number stale, and settle() stops the tracks of a stale answer instead of handing them back. The numbers are per
 * device, so asking for the microphone while the camera is still opening does not cost the person the camera.
 */
export type DeviceRequests = {
  /** A request starts: the ticket it must be settled with. */
  begin(want: { mic: boolean; cam: boolean }): DeviceTicket;
  /** Nothing open is wanted any more: devices released, a join took its copies, the screen went away, consent was withdrawn. */
  cancel(): void;
  /**
   * An answer came back. The tracks that are still wanted are returned and the others are stopped here. `allowed` is
   * the recording-notice gate as it is now: if it has closed since the request began, nothing is wanted. `current`
   * says whether any of the request is still wanted; `pending` whether another request is still open.
   */
  settle(
    ticket: DeviceTicket,
    opened: OpenedDevices,
    allowed: boolean,
  ): { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; current: boolean; pending: boolean };
};

export function createDeviceRequests(): DeviceRequests {
  const latest: Record<DeviceKind, number> = { mic: 0, cam: 0 };
  let open = 0;
  return {
    begin(want) {
      open += 1;
      if (want.mic) latest.mic += 1;
      if (want.cam) latest.cam += 1;
      return { mic: want.mic ? latest.mic : null, cam: want.cam ? latest.cam : null };
    },
    cancel() {
      latest.mic += 1;
      latest.cam += 1;
    },
    settle(ticket, opened, allowed) {
      open -= 1;
      const wanted = (kind: DeviceKind) => allowed && ticket[kind] !== null && ticket[kind] === latest[kind];
      const keep = (kind: DeviceKind): MediaStreamTrack | null => {
        const track = opened[kind];
        if (!track) return null;
        if (wanted(kind)) return track;
        track.stop();
        return null;
      };
      return { mic: keep("mic"), cam: keep("cam"), current: wanted("mic") || wanted("cam"), pending: open > 0 };
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
    lines.push(`To allow ${blocked === 2 ? "them" : "it"}, click the camera or lock icon in the address bar, choose Allow, then try again.`);
  }
  lines.push(`You can still join without ${list.length === 2 ? "them" : "it"}.`);
  return lines.join(" ");
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
