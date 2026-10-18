"use client";

/**
 * components/meet/PreJoin.tsx - the screen before the call: the meeting's name, the recording notice, the
 * person's name, then (only once the notice is out of the way) the camera and microphone step, then Join now.
 *
 * THE ORDER IS THE RULE. The notice and its tick come first in the markup and the camera step is not drawn at
 * all until `devicesOpen` is true (components/meet/notice.ts mayAskForDevices), so nothing on this screen asks
 * for the camera or microphone before anyone but the room's creator (a second host included) has been told the
 * meeting is recorded and has agreed.
 *
 * Presentational: MeetRoom owns the state, so a join that fails comes back to this screen with the name, the
 * tick and the camera preview as they were. Validation is ours (noValidate), so the words match the server's.
 * A meeting made for a time says when it starts under its name (`startsLine`, worked out in the browser, in the
 * viewer's own time zone: components/meet/useStartsLine.ts).
 *
 * Join now is off while the browser has not answered a request for the camera or microphone (the person just
 * allowed it; joining then would leave without it). A browser may never answer, so that wait always has a way out
 * beside it: a button that names what is still waiting and joins without it (devices.ts waitingWords).
 */

import type { Ref } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { meetErrorWords } from "@/lib/meet/room-client";
import { waitingWords } from "./devices";
import { FOCUS } from "./meet-classes";
import { NAME_MAX_CHARS } from "./meet-format";
import { CONSENT_LABEL, CREATOR_RECORDING_LINE, DEVICES_BUTTON, DEVICES_OPTIONAL, JOIN_HERE, MEET_BRAND, RECORDING_NOTICE, TICK_FIRST } from "./meet-words";
import { TrackVideo } from "./TrackVideo";
import type { JoinDevices } from "./useJoinDevices";

export type PreJoinProps = {
  title: string;
  /** "Your call starts at 2:00 PM." for a meeting made for a time that is not open yet (useStartsLine), else null. */
  startsLine: string | null;
  recordAudio: boolean;
  /** This person must read and tick the recording notice. */
  needsNotice: boolean;
  nameRequired: boolean;
  name: string;
  onName: (value: string) => void;
  consent: boolean;
  onConsent: (value: boolean) => void;
  /** The gate: false until the notice is ticked (or when there is none). The camera step is not drawn while false. */
  devicesOpen: boolean;
  devices: JoinDevices;
  /** Plain words from a join that just failed. */
  error: string | null;
  nameMissing: boolean;
  consentMissing: boolean;
  nameRef?: Ref<HTMLInputElement>;
  consentRef?: Ref<HTMLInputElement>;
  onJoin: () => void;
  /** The way out of waiting on the browser: join now with what is already held, through the same gates as onJoin. */
  onJoinWithout: () => void;
  /**
   * Set when the join was refused because this browser has the meeting open in another tab: move it here, through
   * the same gates as onJoin (lib/meet/room-client.ts MeetTabs).
   */
  onJoinHere?: () => void;
};

const SECONDARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-hairline bg-bg-raised px-4 text-sm font-medium text-fg hover:bg-bg-elev disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

function ToggleChip({ on, label, onIcon: OnIcon, offIcon: OffIcon, onClick }: {
  on: boolean;
  label: string;
  onIcon: typeof Mic;
  offIcon: typeof MicOff;
  onClick: () => void;
}) {
  const Icon = on ? OnIcon : OffIcon;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium text-fg ${
        on ? "border-hairline bg-bg-raised hover:bg-bg-elev" : "border-status-hot/50 bg-status-hot/15 hover:bg-status-hot/25"
      } ${FOCUS}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${on ? "" : "text-status-hot"}`} aria-hidden />
      {label}
    </button>
  );
}

export function PreJoin(props: PreJoinProps) {
  const { devices } = props;
  const selectedMic = devices.mic?.getSettings?.().deviceId ?? devices.micId;
  const selectedCam = devices.cam?.getSettings?.().deviceId ?? devices.camId;
  const hasPickers = devices.mics.length > 0 || devices.cams.length > 0;
  // While the browser has not answered, Join now is off. The way out says what is still waiting and joins without it;
  // it exists only behind the same gate as the camera step, so it can never be drawn before the notice is ticked.
  const way = props.devicesOpen && devices.asking ? waitingWords(devices.waiting, { mic: !!devices.mic, cam: !!devices.cam }) : null;

  return (
    <main className="min-h-screen min-h-dvh bg-bg px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <p className="text-xs text-fg-dim">{MEET_BRAND}</p>
        <h1 className="mt-1 break-words text-xl font-semibold text-fg sm:text-2xl">{props.title}</h1>
        {props.startsLine ? <p className="mt-2 text-sm text-fg-muted">{props.startsLine}</p> : null}

        {props.error ? (
          <p role="alert" className="mt-4 rounded-lg border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-sm text-fg">
            {props.error}
          </p>
        ) : null}
        {/* Off while the browser's own camera prompt is open, like Join now: the join it starts waits for that answer. */}
        {props.onJoinHere ? (
          <button type="button" onClick={props.onJoinHere} disabled={devices.asking} className={`${SECONDARY} mt-2`}>
            {JOIN_HERE}
          </button>
        ) : null}

        <form
          noValidate
          className="mt-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            props.onJoin();
          }}
        >
          {props.needsNotice ? (
            <fieldset className="rounded-lg border border-hairline bg-bg-panel p-4">
              <legend className="sr-only">Recording notice</legend>
              <p id="meet-notice" className="text-sm leading-relaxed text-fg">
                {RECORDING_NOTICE}
              </p>
              <label htmlFor="meet-consent" className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg">
                <input
                  ref={props.consentRef}
                  id="meet-consent"
                  type="checkbox"
                  required
                  checked={props.consent}
                  onChange={(e) => props.onConsent(e.target.checked)}
                  aria-describedby="meet-notice"
                  aria-invalid={props.consentMissing || undefined}
                  className={`h-5 w-5 shrink-0 accent-accent ${FOCUS}`}
                />
                <span>{CONSENT_LABEL}</span>
              </label>
              {props.consentMissing ? (
                <p role="alert" className="mt-1 text-sm text-status-hot">
                  {meetErrorWords("consent_required")}
                </p>
              ) : null}
            </fieldset>
          ) : props.recordAudio ? (
            <p className="rounded-lg border border-hairline bg-bg-panel px-4 py-3 text-sm leading-relaxed text-fg-muted">{CREATOR_RECORDING_LINE}</p>
          ) : null}

          <div>
            <label htmlFor="meet-name" className="label">
              {props.nameRequired ? "Your name" : "Your name (optional)"}
            </label>
            <input
              ref={props.nameRef}
              id="meet-name"
              type="text"
              className="input min-h-11"
              value={props.name}
              onChange={(e) => props.onName(e.target.value)}
              maxLength={NAME_MAX_CHARS}
              required={props.nameRequired}
              autoComplete="name"
              aria-invalid={props.nameMissing || undefined}
              aria-describedby={props.nameRequired ? undefined : "meet-name-hint"}
              placeholder={props.nameRequired ? "" : "Your account name"}
            />
            {props.nameRequired ? null : (
              <p id="meet-name-hint" className="mt-1.5 text-xs text-fg-muted">
                Leave it empty to use your account name.
              </p>
            )}
            {props.nameMissing ? (
              <p role="alert" className="mt-1.5 text-sm text-status-hot">
                {meetErrorWords("name_required")}
              </p>
            ) : null}
          </div>

          <section aria-label="Camera and microphone" className="space-y-3">
            {!props.devicesOpen ? (
              <p className="text-sm text-fg-muted">{TICK_FIRST}</p>
            ) : !devices.asked ? (
              <div>
                <button type="button" onClick={devices.turnOn} disabled={devices.asking} className={SECONDARY}>
                  <Video className="h-4 w-4 shrink-0" aria-hidden />
                  {devices.asking ? "Waiting for your browser..." : DEVICES_BUTTON}
                </button>
                <p className="mt-2 text-xs text-fg-muted">{DEVICES_OPTIONAL}</p>
              </div>
            ) : (
              <>
                <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-hairline bg-bg-panel">
                  {devices.cam ? (
                    <TrackVideo track={devices.cam} mirrored label="Your camera" />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center px-4">
                      <p className="text-sm text-fg-muted">Camera is off.</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ToggleChip on={!!devices.mic} label="Microphone" onIcon={Mic} offIcon={MicOff} onClick={devices.toggleMic} />
                  <ToggleChip on={!!devices.cam} label="Camera" onIcon={Video} offIcon={VideoOff} onClick={devices.toggleCam} />
                </div>
                {devices.words ? (
                  <p role="status" className="text-sm leading-relaxed text-fg-muted">
                    {devices.words}
                  </p>
                ) : null}
                {!devices.mic && !devices.cam && devices.words ? (
                  <button type="button" onClick={devices.turnOn} disabled={devices.asking} className={SECONDARY}>
                    Try again
                  </button>
                ) : null}
                {hasPickers ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {devices.mics.length > 0 ? (
                      <div className="min-w-0">
                        <label htmlFor="meet-mic" className="label">
                          Microphone
                        </label>
                        <select id="meet-mic" className="select min-h-11" value={selectedMic} onChange={(e) => devices.pickMic(e.target.value)}>
                          {devices.mics.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {devices.cams.length > 0 ? (
                      <div className="min-w-0">
                        <label htmlFor="meet-cam" className="label">
                          Camera
                        </label>
                        <select id="meet-cam" className="select min-h-11" value={selectedCam} onChange={(e) => devices.pickCam(e.target.value)}>
                          {devices.cams.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            {way ? (
              <div>
                <button type="button" onClick={props.onJoinWithout} aria-describedby="meet-waiting-hint" className={`${SECONDARY} w-full py-2 text-center`}>
                  {way.button}
                </button>
                <p id="meet-waiting-hint" className="mt-2 text-xs leading-relaxed text-fg-muted">
                  {way.hint}
                </p>
              </div>
            ) : null}
          </section>

          {/* Not while the browser's own camera prompt is open: joining then would leave without the camera the person
              just allowed. The way out above is the choice to join without it. */}
          <button type="submit" disabled={devices.asking} className="btn-primary inline-flex min-h-11 w-full items-center justify-center">
            Join now
          </button>
        </form>
      </div>
    </main>
  );
}
