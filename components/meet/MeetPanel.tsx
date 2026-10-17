"use client";

/**
 * components/meet/MeetPanel.tsx - Oasis Meet on the Schedule page: a "Meet" button for the top right of the
 * toolbar that opens a panel (a popover on a wide screen, a sheet from the bottom on a phone) with
 *   1. Start a meeting now   - makes a room and opens it in a new tab,
 *   2. Create a link for later - a title, an optional time, and whether to record; shows the link to send,
 *   3. Recent meetings       - each with Copy link, and Join unless it has ended.
 *
 * CC (2026-10-17): "add it as a feature on the schedule page and put it on the top right... Then you send
 * people specific links, and they can join the meeting."
 *
 * Start now opens its tab in the click itself (an empty window), then points it at the room once it exists:
 * a popup blocker lets a window opened by a click and refuses one opened after an await. If the browser blocks
 * even that, the link is shown to open by hand.
 *
 * MeetPanelView is the panel's body as plain props, so the same markup runs in tests/meet-ui.test.ts and in the
 * real browser harness. `renderEnded` is the slot where a finished meeting's transcript goes once it exists.
 * Lives inside the calendar's `.cal` surface (its `.btn` look) and borrows its focus/outside-press helpers.
 * ASCII only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Video, X } from "lucide-react";
import { messageFor } from "@/components/calendar/useCalendarData";
import { useDialogFocus, useOutsidePress } from "@/components/calendar/ui";
import { copyToClipboard } from "./clipboard";
import { createMeeting, listMeetings } from "./meet-api";
import { FOCUS } from "./meet-classes";
import {
  LENGTH_CHOICES,
  STATUS_WORDS,
  TITLE_MAX_CHARS,
  lengthWords,
  meetingUrl,
  scheduleLine,
  timeFormatter,
  whenText,
  type MeetRoomItem,
  type MeetRoomStatus,
  type ScheduleNote,
} from "./meet-format";

/** A meeting that was just made: its address and path, whether its tab opened, and what the Schedule said (a link made for a time). */
export type MadeMeeting = { url: string; link: string; opened: boolean; schedule?: ScheduleNote | null };

/** `url` is the whole link from the app's canonical address (the server sends it), so a copy never carries a preview host. */
export type PanelRow = { id: string; code: string; title: string; status: MeetRoomStatus; statusWords: string; when: string; link: string; url?: string };

export type PanelList =
  | { status: "loading" }
  | { status: "error"; words: string }
  | { status: "ready"; rows: PanelRow[] };

export type MeetPanelViewProps = {
  list: PanelList;
  start: { busy: boolean; error: string | null; made: MadeMeeting | null };
  later: {
    title: string;
    startsAt: string;
    /** The length picked, in minutes as text; empty means the host's usual length. Only used with a time. */
    minutes: string;
    record: boolean;
    busy: boolean;
    error: string | null;
    made: MadeMeeting | null;
  };
  /** What was just copied: "start", "later" or a meeting's id. `ok` false means the browser refused, so the link is shown to copy by hand. */
  copied: { key: string; ok: boolean; url: string } | null;
  onStart: () => void;
  onTitle: (value: string) => void;
  onStartsAt: (value: string) => void;
  onMinutes: (value: string) => void;
  onRecord: (value: boolean) => void;
  onCreate: () => void;
  onCopy: (key: string, link: string, url?: string) => void;
  onRetry: () => void;
  /** Where a finished meeting's transcript goes. Called with the meeting's dashed code. */
  renderEnded?: (code: string) => ReactNode;
};

const TAP = "min-h-11 sm:min-h-9";
const SECONDARY = `btn-secondary inline-flex ${TAP} items-center justify-center gap-1.5 text-[13px]`;
const LINK_ACTION = `inline-flex ${TAP} items-center justify-center gap-1.5 rounded-md border border-hairline px-3 text-[13px] font-medium text-fg hover:bg-active-hover ${FOCUS}`;

function Made({ made, headline, copyKey, copied, onCopy }: {
  made: MadeMeeting;
  headline: string;
  copyKey: string;
  copied: MeetPanelViewProps["copied"];
  onCopy: MeetPanelViewProps["onCopy"];
}) {
  const done = copied?.key === copyKey && copied.ok;
  return (
    <div className="rounded-lg border border-hairline bg-bg-panel p-3">
      <p className="text-xs text-fg-muted">{headline}</p>
      <p className="mt-1 break-all font-mono text-xs text-fg">{made.url.replace(/^https?:\/\//, "")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => onCopy(copyKey, made.link, made.url)} className={LINK_ACTION}>
          {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {done ? "Copied" : "Copy link"}
        </button>
        <a href={made.url} target="_blank" rel="noopener noreferrer" className={LINK_ACTION}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {made.opened ? "Open again" : "Open meeting"}
        </a>
      </div>
      {made.schedule ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          {scheduleLine(made.schedule, messageFor)}
        </p>
      ) : null}
    </div>
  );
}

export function MeetPanelView(props: MeetPanelViewProps) {
  const { list, start, later, copied } = props;
  return (
    <div className="space-y-4 text-[13px]">
      <section aria-label="Start a meeting now" className="space-y-2">
        <button
          type="button"
          data-autofocus
          onClick={props.onStart}
          disabled={start.busy}
          className={`btn-primary inline-flex ${TAP} w-full items-center justify-center gap-2`}
        >
          <Video className="h-4 w-4 shrink-0" aria-hidden />
          {start.busy ? "Starting..." : "Start a meeting now"}
        </button>
        <p className="text-xs text-fg-muted">Opens in a new tab. It is recorded and transcribed, and guests agree to that before they join.</p>
        {start.error ? (
          <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-2.5 py-2 text-xs text-fg">
            {start.error}
          </p>
        ) : null}
        {start.made ? (
          <Made
            made={start.made}
            headline={start.made.opened ? "Your meeting is open in a new tab. Send this link so people can join." : "Your browser blocked the new tab. Open the meeting here, and send this link so people can join."}
            copyKey="start"
            copied={copied}
            onCopy={props.onCopy}
          />
        ) : null}
      </section>

      <section aria-label="Create a link for later" className="space-y-3 border-t border-hairline pt-4">
        <h3 className="text-sm font-semibold text-fg">Create a link for later</h3>
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            props.onCreate();
          }}
        >
          <div>
            <label htmlFor="meet-later-title" className="label">
              Title (optional)
            </label>
            <input
              id="meet-later-title"
              type="text"
              className={`input ${TAP}`}
              value={later.title}
              onChange={(e) => props.onTitle(e.target.value)}
              maxLength={TITLE_MAX_CHARS}
              placeholder="Meeting"
            />
          </div>
          <div>
            <label htmlFor="meet-later-when" className="label">
              Date and time (optional)
            </label>
            <input
              id="meet-later-when"
              type="datetime-local"
              className={`input ${TAP}`}
              value={later.startsAt}
              onChange={(e) => props.onStartsAt(e.target.value)}
            />
            <p className="mt-1.5 text-xs text-fg-muted">With a time, the meeting is added to your Schedule too.</p>
          </div>
          {later.startsAt ? (
            <div>
              <label htmlFor="meet-later-length" className="label">
                Length
              </label>
              <select id="meet-later-length" className={`select ${TAP}`} value={later.minutes} onChange={(e) => props.onMinutes(e.target.value)}>
                <option value="">Your usual length</option>
                {LENGTH_CHOICES.map((m) => (
                  <option key={m} value={String(m)}>
                    {lengthWords(m)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <label htmlFor="meet-later-record" className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-fg sm:min-h-0">
            <input
              id="meet-later-record"
              type="checkbox"
              checked={later.record}
              onChange={(e) => props.onRecord(e.target.checked)}
              className={`mt-0.5 h-4 w-4 shrink-0 accent-accent ${FOCUS}`}
            />
            <span className="min-w-0">
              Record and transcribe
              <span className="mt-0.5 block text-xs text-fg-muted">Guests agree to this before they join.</span>
            </span>
          </label>
          {later.error ? (
            <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-2.5 py-2 text-xs text-fg">
              {later.error}
            </p>
          ) : null}
          <button type="submit" disabled={later.busy} className={`${SECONDARY} w-full`}>
            {later.busy ? "Creating..." : "Create link"}
          </button>
        </form>
        {later.made ? (
          <Made
            made={later.made}
            headline="Link ready. Send it to the people you want in the meeting."
            copyKey="later"
            copied={copied}
            onCopy={props.onCopy}
          />
        ) : null}
      </section>

      <section aria-label="Recent meetings" className="space-y-2 border-t border-hairline pt-4">
        <h3 className="text-sm font-semibold text-fg">Recent meetings</h3>
        {list.status === "loading" ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading meetings...
          </p>
        ) : list.status === "error" ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-fg-muted">
              {list.words}
            </p>
            <button type="button" onClick={props.onRetry} className={SECONDARY}>
              Try again
            </button>
          </div>
        ) : list.rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No meetings yet. Start one above.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.rows.map((row) => {
              const failedCopy = copied && copied.key === row.id && !copied.ok ? copied.url : null;
              const copiedNow = copied?.key === row.id && copied.ok;
              return (
                <li key={row.id} className="py-3 first:pt-0">
                  <p className="break-words text-sm font-medium text-fg">{row.title}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-muted">
                    <span className={row.status === "live" ? "font-medium text-status-engaged" : "font-medium text-fg"}>{row.statusWords}</span>
                    <span>{row.when}</span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => props.onCopy(row.id, row.link, row.url)} className={LINK_ACTION}>
                      {copiedNow ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      {copiedNow ? "Copied" : "Copy link"}
                    </button>
                    {row.status === "ended" ? null : (
                      <a href={row.link} target="_blank" rel="noopener noreferrer" className={LINK_ACTION}>
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Join
                      </a>
                    )}
                  </div>
                  {failedCopy ? (
                    <p role="status" className="mt-2 break-all text-xs text-fg-muted">
                      Copy this link: <span className="select-all font-mono text-fg">{failedCopy}</span>
                    </p>
                  ) : null}
                  {row.status === "ended" && props.renderEnded ? <div className="mt-2">{props.renderEnded(row.code)}</div> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

type Load = { status: "loading" } | { status: "error"; words: string } | { status: "ready"; rooms: MeetRoomItem[] };

/** The browser's own IANA time zone ("America/Toronto"), or undefined when it cannot say. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function MeetPanel({
  renderEnded,
  onScheduleAdded,
  className = "",
}: {
  /** Where a finished meeting's transcript goes. Called with the meeting's dashed code ("abc-defg-hjk"). */
  renderEnded?: (code: string) => ReactNode;
  /** Called when a meeting made for later was added to the host's Schedule, so the page can load its events again. */
  onScheduleAdded?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<MadeMeeting | null>(null);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [minutes, setMinutes] = useState("");
  const [record, setRecord] = useState(true);
  const [laterBusy, setLaterBusy] = useState(false);
  const [laterError, setLaterError] = useState<string | null>(null);
  const [created, setCreated] = useState<MadeMeeting | null>(null);
  const [copied, setCopied] = useState<MeetPanelViewProps["copied"]>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const latest = useRef(0);
  const resetCopied = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useDialogFocus(panelRef, close, open);
  useOutsidePress(wrapRef, close, open);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    const quiet = loaded.current;
    if (!quiet) setLoad({ status: "loading" });
    const res = await listMeetings();
    if (mine !== latest.current) return;
    if (res.ok) {
      loaded.current = true;
      setLoad({ status: "ready", rooms: res.value });
    } else if (!quiet) {
      setLoad({ status: "error", words: res.words });
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    return () => {
      if (resetCopied.current) clearTimeout(resetCopied.current);
    };
  }, []);

  const remember = (room: MeetRoomItem) => {
    setLoad((prev) => (prev.status === "ready" ? { status: "ready", rooms: [room, ...prev.rooms.filter((r) => r.id !== room.id)] } : prev));
  };

  const startNow = async () => {
    if (startBusy) return;
    // The window is opened here, inside the click and before any await, or a popup blocker refuses it.
    const win = window.open("about:blank", "_blank");
    if (win) {
      try {
        win.opener = null;
      } catch {
        // A locked-down browser: the new tab works the same without this.
      }
    }
    setStartBusy(true);
    setStartError(null);
    setStarted(null);
    const made = await createMeeting({});
    setStartBusy(false);
    if (!made.ok) {
      win?.close();
      setStartError(made.words);
      return;
    }
    const url = made.value.room.url ?? meetingUrl(window.location.origin, made.value.room.link);
    const opened = !!win && !win.closed;
    if (win && opened) win.location.href = url;
    setStarted({ url, link: made.value.room.link, opened });
    remember(made.value.room);
  };

  const createLater = async () => {
    if (laterBusy) return;
    let when: string | undefined;
    if (startsAt) {
      const at = new Date(startsAt);
      if (!Number.isFinite(at.getTime())) {
        setLaterError("Pick a valid date and time, or leave it empty.");
        return;
      }
      if (at.getTime() < Date.now()) {
        setLaterError("That time has passed. Pick a later time, or leave it empty.");
        return;
      }
      when = at.toISOString();
    }
    setLaterBusy(true);
    setLaterError(null);
    setCreated(null);
    // A time goes with the browser's time zone (and a length if one was picked): that is what puts the meeting
    // on the Schedule. Without a time none of the three is sent.
    const zone = when ? browserTimeZone() : undefined;
    const made = await createMeeting({
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(when ? { startsAt: when } : {}),
      ...(zone ? { timeZone: zone } : {}),
      ...(when && minutes ? { minutes: Number(minutes) } : {}),
      recordAudio: record,
    });
    setLaterBusy(false);
    if (!made.ok) {
      setLaterError(made.words);
      return;
    }
    setCreated({
      url: made.value.room.url ?? meetingUrl(window.location.origin, made.value.room.link),
      link: made.value.room.link,
      opened: false,
      schedule: made.value.schedule,
    });
    setTitle("");
    setStartsAt("");
    setMinutes("");
    remember(made.value.room);
    if (made.value.schedule?.added) onScheduleAdded?.();
  };

  const copy = async (key: string, link: string, absolute?: string) => {
    const url = absolute ?? meetingUrl(window.location.origin, link);
    const ok = await copyToClipboard(url);
    setCopied({ key, ok, url });
    if (resetCopied.current) clearTimeout(resetCopied.current);
    if (ok) resetCopied.current = setTimeout(() => setCopied(null), 2_000);
  };

  // The viewer's own time zone, read when the panel is used in the browser (the list only exists after a fetch).
  const format = useMemo(() => timeFormatter(), []);
  const list: PanelList =
    load.status === "ready"
      ? {
          status: "ready",
          rows: load.rooms.map((r) => ({
            id: r.id,
            code: r.code,
            title: r.title,
            status: r.status,
            statusWords: STATUS_WORDS[r.status],
            when: whenText(r, format),
            link: r.link,
            url: r.url,
          })),
        }
      : load;

  return (
    <div ref={wrapRef} className={`relative ${className}`.trim()}>
      <button
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="meet-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <Video className="h-4 w-4" aria-hidden />
        Meet
      </button>
      {open ? (
        <>
          <div aria-hidden className="fixed inset-0 z-40 bg-bg-rail/60 sm:hidden" onClick={close} />
          <div
            id="meet-panel"
            ref={panelRef}
            role="dialog"
            aria-modal="false"
            aria-label="Oasis Meet"
            className="cal-float cal-enter fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-xl border border-hairline bg-bg-elev p-4 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[calc(100dvh-6rem)] sm:w-[26rem] sm:rounded-lg"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-fg">Oasis Meet</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-active-hover hover:text-fg sm:h-8 sm:w-8 ${FOCUS}`}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <MeetPanelView
              list={list}
              start={{ busy: startBusy, error: startError, made: started }}
              later={{ title, startsAt, minutes, record, busy: laterBusy, error: laterError, made: created }}
              copied={copied}
              onStart={() => void startNow()}
              onTitle={setTitle}
              onStartsAt={setStartsAt}
              onMinutes={setMinutes}
              onRecord={setRecord}
              onCreate={() => void createLater()}
              onCopy={(key, link) => void copy(key, link)}
              onRetry={() => void refresh()}
              renderEnded={renderEnded}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
