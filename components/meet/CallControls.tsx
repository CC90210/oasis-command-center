"use client";

/**
 * components/meet/CallControls.tsx - the bar along the bottom of a call: mic, camera, share screen, copy the
 * link, people, leave, and for a host End meeting.
 *
 * Every control is an icon over its own words (a phone has no hover to explain an icon), 44 px tall at least,
 * and the row wraps instead of clipping, so it fits a 320 px screen. Mic, camera and share are toggles: their
 * words stay the same and aria-pressed says whether they are on; the icon's slash and the red tint say it to
 * everyone else. End meeting is two steps on the spot ("End for everyone?" / "Cancel"), never a confirm().
 */

import { useEffect, useRef, useState, type ComponentType, type Ref } from "react";
import { Check, Link2, Mic, MicOff, MonitorUp, PhoneOff, Power, Users, Video, VideoOff } from "lucide-react";
import type { MeetRoomController, MeetSnapshot } from "@/lib/meet/room-client";
import { copyToClipboard } from "./clipboard";
import { FOCUS } from "./meet-classes";

type Tone = "neutral" | "off" | "active" | "leave" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "border-hairline bg-bg-raised text-fg hover:bg-bg-elev",
  off: "border-status-hot/50 bg-status-hot/15 text-fg hover:bg-status-hot/25",
  active: "border-bg-border-strong bg-active text-fg hover:bg-bg-elev",
  leave: "border-transparent bg-unread text-white hover:bg-red-700",
  danger: "border-status-hot/50 bg-transparent text-fg hover:bg-status-hot/15",
};

function BarButton({
  icon: Icon,
  label,
  tone = "neutral",
  iconClass = "",
  buttonRef,
  onClick,
  pressed,
  expanded,
  controls,
  disabled,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  tone?: Tone;
  iconClass?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  disabled?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
      className={`flex min-h-14 min-w-16 flex-col items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-center text-[11px] font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${TONE[tone]} ${FOCUS}`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${iconClass}`.trim()} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export function CallControls({
  controller,
  snapshot,
  code,
  isHost,
  canShare,
  peopleOpen,
  onTogglePeople,
  attempt,
}: {
  controller: MeetRoomController;
  snapshot: MeetSnapshot;
  /** The dashed code: the link people are sent is this page's own address. */
  code: string;
  isHost: boolean;
  /** Screen sharing exists in this browser (it does not on phones). Decided after mount by the caller. */
  canShare: boolean;
  peopleOpen: boolean;
  onTogglePeople: () => void;
  /** Runs a call on the controller; if it throws, the screen says so in plain words (it never rejects). */
  attempt: (task: Promise<unknown>) => Promise<void>;
}) {
  const [copy, setCopy] = useState<{ state: "idle" | "copied" | "failed"; url: string }>({ state: "idle", url: "" });
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  // Asking moves focus to the safe answer; cancelling gives it back to End meeting.
  useEffect(() => {
    if (confirmEnd) {
      cancelRef.current?.focus();
      wasConfirming.current = true;
    } else if (wasConfirming.current) {
      wasConfirming.current = false;
      endRef.current?.focus();
    }
  }, [confirmEnd]);

  const copyLink = async () => {
    const url = `${window.location.origin}/meet/${code}`;
    const ok = await copyToClipboard(url);
    setCopy({ state: ok ? "copied" : "failed", url });
    if (resetTimer.current) clearTimeout(resetTimer.current);
    if (ok) resetTimer.current = setTimeout(() => setCopy({ state: "idle", url: "" }), 2_000);
  };

  const endForEveryone = async () => {
    setEnding(true);
    await attempt(controller.end());
    setEnding(false);
    setConfirmEnd(false);
  };

  return (
    <div
      className="border-t border-hairline bg-bg-deep px-3 py-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirmEnd && !ending) {
          e.stopPropagation();
          setConfirmEnd(false);
        }
      }}
    >
      {copy.state === "failed" ? (
        <p role="status" className="mb-2 break-all text-xs text-fg-muted">
          Copy this link: <span className="select-all font-mono text-fg">{copy.url}</span>
        </p>
      ) : null}
      {confirmEnd ? (
        <div role="group" aria-label="End the meeting" className="mb-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void endForEveryone()}
            disabled={ending}
            className={`min-h-11 rounded-lg border border-transparent bg-unread px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`}
          >
            {ending ? "Ending..." : "End for everyone?"}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => setConfirmEnd(false)}
            disabled={ending}
            className={`min-h-11 rounded-lg border border-hairline px-4 text-sm font-medium text-fg hover:bg-active-hover disabled:opacity-50 ${FOCUS}`}
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div role="group" aria-label="Meeting controls" className="flex flex-wrap items-stretch justify-center gap-2">
        <BarButton
          icon={snapshot.micOn ? Mic : MicOff}
          label="Mic"
          tone={snapshot.micOn ? "neutral" : "off"}
          iconClass={snapshot.micOn ? "" : "text-status-hot"}
          pressed={snapshot.micOn}
          onClick={() => void attempt(controller.setMic(!snapshot.micOn))}
        />
        <BarButton
          icon={snapshot.camOn ? Video : VideoOff}
          label="Camera"
          tone={snapshot.camOn ? "neutral" : "off"}
          iconClass={snapshot.camOn ? "" : "text-status-hot"}
          pressed={snapshot.camOn}
          onClick={() => void attempt(controller.setCam(!snapshot.camOn))}
        />
        {canShare ? (
          <BarButton
            icon={MonitorUp}
            label="Share screen"
            tone={snapshot.sharing ? "active" : "neutral"}
            pressed={snapshot.sharing}
            onClick={() => void attempt(controller.shareScreen(!snapshot.sharing))}
          />
        ) : null}
        <BarButton
          icon={copy.state === "copied" ? Check : Link2}
          label={copy.state === "copied" ? "Link copied" : "Copy meeting link"}
          onClick={() => void copyLink()}
        />
        <BarButton
          icon={Users}
          label={`People (${snapshot.tiles.length})`}
          tone={peopleOpen ? "active" : "neutral"}
          expanded={peopleOpen}
          controls="meet-people"
          onClick={onTogglePeople}
        />
        <BarButton icon={PhoneOff} label="Leave" tone="leave" onClick={() => void attempt(controller.leave())} />
        {isHost ? (
          <BarButton
            buttonRef={endRef}
            icon={Power}
            label="End meeting"
            tone="danger"
            iconClass="text-status-hot"
            disabled={confirmEnd}
            onClick={() => setConfirmEnd(true)}
          />
        ) : null}
      </div>
    </div>
  );
}
