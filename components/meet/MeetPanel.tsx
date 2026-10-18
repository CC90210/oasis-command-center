"use client";

/**
 * components/meet/MeetPanel.tsx - Oasis Meet on the Schedule page: a "Meet" button for the top right of the
 * toolbar that opens a panel (a popover on a wide screen, a sheet from the bottom on a phone) with
 *   1. Start a meeting now   - makes a room and opens it in a new tab,
 *   2. Create a link for later - a title, an optional time, and (where recording runs) whether to record;
 *      shows the link to send,
 *   3. Recent meetings       - each with Copy link, Join unless it has ended, Delete on the ones the person
 *      made, and for a finished recorded one a Transcript button that opens its transcript (`renderEnded`).
 *
 * CC (2026-10-17): "add it as a feature on the schedule page and put it on the top right... Then you send
 * people specific links, and they can join the meeting."
 *
 * RECORDING IS OFFERED ONLY WHERE IT RUNS. GET /api/calendar/meet says `recordingAvailable`; until it says true
 * (and while the list has not loaded) there is no "Record and transcribe" box, nothing says a meeting is
 * recorded, and no Transcript button is drawn. Once the list says recording does not run, meetings are asked for
 * with recordAudio false; before it answers, nothing is sent and the server decides (startBody, laterBody). A
 * meeting that was just made says what the server did with it ("Recorded and transcribed" / "Not recorded").
 *
 * VIDEO CALLS MAY NOT BE SWITCHED ON YET. The list also says `mediaReady`; once it says false (the video service is
 * not connected: a one-time step for an owner) the panel puts one plain line at the top and switches off Start a
 * meeting now and Create link: disabled, not hidden, and pointing at the line that says why. Recent meetings, Delete
 * included, work as before. Before the list answers the buttons stay on and the server decides: if it refuses
 * (503 meet_not_configured) the same line shows where the person pressed (meet-format.ts panelErrorWords).
 *
 * TRANSCRIPTS ARE OPENED ON PURPOSE. A transcript is a whole section with a list up to 28rem tall that reads the
 * recording when it mounts, so it is not drawn for every finished meeting when the panel opens: that would turn
 * a 26rem popover into a long scroll and fire a read per meeting. Each finished recorded meeting (showsTranscript,
 * the one gate) has a Transcript button; pressing it mounts `renderEnded` below the row, in a box the button
 * points at, and the button says Hide transcript. One is open at a time, and closing the panel or deleting the
 * meeting closes it.
 *
 * A BOX THAT OPENS BELOW ITS BUTTON IS BROUGHT INTO VIEW (bringIntoView): an opened transcript, the link Create link
 * just made, and Start now's link when its tab was blocked. A phone shows about 480 px of the panel, so such a box
 * can open entirely below it and the button seems to do nothing. The least scrolling that does it, none of the
 * animation under reduced motion, and a link made once is brought into view once.
 *
 * DELETE is two steps on the spot, like End and Remove in the call (never a browser dialog): Delete opens the
 * confirmation (focus on Cancel, Escape cancels it before it closes the panel), Delete for good asks the server.
 * The question says what goes with that meeting (deleteConfirm): a recording and a transcript only if it
 * recorded, and that a meeting that is on now is ended for everyone in it. The row leaves the list when the
 * meeting is gone (deleted now, or already: a 404), and focus moves to the next row, or to the list's heading
 * when none is left.
 *
 * Start now opens its tab in the click itself (an empty window), then points it at the room once it exists:
 * a popup blocker lets a window opened by a click and refuses one opened after an await. If the browser blocks
 * even that, the link is shown to open by hand. Opening stays on the page's own address (the host is signed in
 * there); the link that is shown and copied for guests is the server's whole one (`url`), from the app's own
 * canonical address.
 *
 * MeetPanelView is the panel's body as plain props, so the same markup runs in tests/meet-ui.test.ts and in the
 * real browser harness. Lives inside the calendar's `.cal` surface (its `.btn` look) and borrows its
 * focus/outside-press helpers. ASCII only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, ExternalLink, FileText, Trash2, Video, X } from "lucide-react";
import { messageFor } from "@/components/calendar/useCalendarData";
import { useDialogFocus, useOutsidePress } from "@/components/calendar/ui";
import { copyToClipboard } from "./clipboard";
import { createMeeting, deleteMeeting, laterBody, listMeetings, startBody, type RecordingAvailability } from "./meet-api";
import { FOCUS } from "./meet-classes";
import {
  ALREADY_DELETED,
  BOOKED_BY_LEAD,
  LENGTH_CHOICES,
  MADE_BOX_LATER,
  MADE_BOX_START,
  MEDIA_NOT_READY,
  STATUS_WORDS,
  TITLE_MAX_CHARS,
  canDelete,
  deleteConfirm,
  deletedNote,
  leadPagePath,
  lengthWords,
  linkToSend,
  meetingUrl,
  scheduleLine,
  showsTranscript,
  timeFormatter,
  toggledTranscript,
  transcriptBoxId,
  whenText,
  withoutMeeting,
  type MeetRoomItem,
  type MeetRoomStatus,
  type ScheduleNote,
} from "./meet-format";

/**
 * A meeting that was just made: the whole link to send (`url`), its path (to open it from here), whether its tab
 * opened, what the Schedule said (a link made for a time) and what the server did about recording.
 */
export type MadeMeeting = { url: string; link: string; opened: boolean; schedule?: ScheduleNote | null; recorded?: boolean };

/** `url` is the whole link from the app's canonical address (the server sends it), so a copy never carries a preview host. */
export type PanelRow = {
  id: string;
  code: string;
  title: string;
  status: MeetRoomStatus;
  statusWords: string;
  when: string;
  link: string;
  url?: string;
  /** The person made this meeting: Delete is theirs. */
  mine: boolean;
  /** The lead who booked this meeting, if one did: no Delete, a link to their page instead (canDelete). */
  leadId: string | null;
  /** This meeting recorded: a finished one offers its transcript, and Delete says a recording goes with it. */
  recordAudio: boolean;
};

export type PanelList =
  | { status: "loading" }
  | { status: "error"; words: string }
  | { status: "ready"; rows: PanelRow[] };

/** Which row is asking "Delete for good?" (by id), whether the server is working on it, and why it refused. */
export type DeleteState = { asking: string | null; busy: boolean; error: string | null };

export type MeetPanelViewProps = {
  list: PanelList;
  /** This workspace records and its recording is installed. False until the list says true. */
  recordingAvailable: boolean;
  /**
   * The list said video calls cannot connect yet (the video service is not connected). False until it says so: before
   * the list answers, or when it failed, the buttons stay on and the server decides (a refusal shows the same line).
   */
  mediaNotReady: boolean;
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
  del: DeleteState;
  /** One quiet line about the list (a meeting was deleted), or null. */
  note: string | null;
  /** What was just copied: "start", "later" or a meeting's id. `ok` false means the browser refused, so the link is shown to copy by hand. */
  copied: { key: string; ok: boolean; url: string } | null;
  onStart: () => void;
  onTitle: (value: string) => void;
  onStartsAt: (value: string) => void;
  onMinutes: (value: string) => void;
  onRecord: (value: boolean) => void;
  onCreate: () => void;
  onCopy: (key: string, link: string, url?: string) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
  onRetry: () => void;
  /** The meeting (by id) whose transcript is open, or null. One at a time; nothing is mounted for the others. */
  transcriptOpen: string | null;
  /** The Transcript button on a meeting was pressed: open its transcript, or close it if it is the open one. */
  onToggleTranscript: (id: string) => void;
  /**
   * Where an opened transcript goes. Called with the meeting's dashed code, and only for the one meeting whose
   * Transcript button was pressed: a meeting that is over, recorded, in a workspace where recording runs
   * (showsTranscript). Nothing calls it until then, so opening the panel reads no recording.
   */
  renderEnded?: (code: string) => ReactNode;
};

/** The id of the line that says video calls are not switched on yet: the two buttons it switches off point at it. */
const MEDIA_NOTE = "meet-media-note";

const TAP = "min-h-11 sm:min-h-9";
// .btn-secondary has no disabled look of its own (.btn-primary does), and a switched-off Create link must look switched off.
const SECONDARY = `btn-secondary inline-flex ${TAP} items-center justify-center gap-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50`;
const LINK_ACTION = `inline-flex ${TAP} items-center justify-center gap-1.5 rounded-md border border-hairline px-3 text-[13px] font-medium text-fg hover:bg-active-hover ${FOCUS}`;
const DANGER = `inline-flex ${TAP} items-center justify-center gap-1.5 rounded-md border border-transparent bg-unread px-3 text-[13px] font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

function Made({ made, headline, boxId, copyKey, copied, onCopy }: {
  made: MadeMeeting;
  headline: string;
  /** The id the panel scrolls to when this box is new (MADE_BOX_START, MADE_BOX_LATER). */
  boxId: string;
  copyKey: string;
  copied: MeetPanelViewProps["copied"];
  onCopy: MeetPanelViewProps["onCopy"];
}) {
  const done = copied?.key === copyKey && copied.ok;
  return (
    <div id={boxId} className="scroll-mb-4 rounded-lg border border-hairline bg-bg-panel p-3">
      <p className="text-xs text-fg-muted">{headline}</p>
      <p className="mt-1 break-all font-mono text-xs text-fg">{made.url.replace(/^https?:\/\//, "")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => onCopy(copyKey, made.link, made.url)} className={LINK_ACTION}>
          {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {done ? "Copied" : "Copy link"}
        </button>
        <a href={made.link} target="_blank" rel="noopener noreferrer" className={LINK_ACTION}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {made.opened ? "Open again" : "Open meeting"}
        </a>
      </div>
      {made.recorded === undefined ? null : (
        <p className="mt-2 text-xs text-fg-muted">
          {made.recorded ? "Recorded and transcribed. Guests agree to that before they join." : "Not recorded."}
        </p>
      )}
      {made.schedule ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          {scheduleLine(made.schedule, messageFor)}
        </p>
      ) : null}
    </div>
  );
}

export function MeetPanelView(props: MeetPanelViewProps) {
  const { list, start, later, copied, del, recordingAvailable, mediaNotReady, renderEnded } = props;
  return (
    <div className="space-y-4 text-[13px]">
      {mediaNotReady ? (
        <p
          id={MEDIA_NOTE}
          data-media-note
          role="status"
          tabIndex={-1}
          className="rounded-lg border border-hairline bg-bg-panel px-3 py-2.5 text-xs leading-5 text-fg"
        >
          {MEDIA_NOT_READY}
        </p>
      ) : null}

      <section aria-label="Start a meeting now" className="space-y-2">
        <button
          type="button"
          {...(mediaNotReady ? {} : { "data-autofocus": true })}
          onClick={props.onStart}
          disabled={start.busy || mediaNotReady}
          aria-describedby={mediaNotReady ? MEDIA_NOTE : undefined}
          className={`btn-primary inline-flex ${TAP} w-full items-center justify-center gap-2`}
        >
          <Video className="h-4 w-4 shrink-0" aria-hidden />
          {start.busy ? "Starting..." : "Start a meeting now"}
        </button>
        <p className="text-xs text-fg-muted">
          {recordingAvailable
            ? "Opens in a new tab. It is recorded and transcribed, and guests agree to that before they join."
            : "Opens in a new tab."}
        </p>
        {start.error ? (
          <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-2.5 py-2 text-xs text-fg">
            {start.error}
          </p>
        ) : null}
        {start.made ? (
          <Made
            made={start.made}
            headline={start.made.opened ? "Your meeting is open in a new tab. Send this link so people can join." : "Your browser blocked the new tab. Open the meeting here, and send this link so people can join."}
            boxId={MADE_BOX_START}
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
          {recordingAvailable ? (
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
          ) : null}
          {later.error ? (
            <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-2.5 py-2 text-xs text-fg">
              {later.error}
            </p>
          ) : null}
          <button type="submit" disabled={later.busy || mediaNotReady} aria-describedby={mediaNotReady ? MEDIA_NOTE : undefined} className={`${SECONDARY} w-full`}>
            {later.busy ? "Creating..." : "Create link"}
          </button>
        </form>
        {later.made ? (
          <Made
            made={later.made}
            headline="Link ready. Send it to the people you want in the meeting."
            boxId={MADE_BOX_LATER}
            copyKey="later"
            copied={copied}
            onCopy={props.onCopy}
          />
        ) : null}
      </section>

      <section aria-label="Recent meetings" className="space-y-2 border-t border-hairline pt-4">
        <h3 tabIndex={-1} data-list-heading className="text-sm font-semibold text-fg">
          Recent meetings
        </h3>
        {props.note ? (
          <p role="status" className="text-xs text-fg-muted">
            {props.note}
          </p>
        ) : null}
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
              const asking = del.asking === row.id && canDelete(row);
              // A finished recorded meeting offers its transcript on a button; nothing is mounted (or read) until it is pressed.
              const hasTranscript = renderEnded !== undefined && showsTranscript({ status: row.status, recordAudio: row.recordAudio }, recordingAvailable);
              const transcriptShown = hasTranscript && props.transcriptOpen === row.id;
              const transcriptBox = transcriptBoxId(row.id);
              return (
                <li key={row.id} className="py-3 first:pt-0">
                  <p className="break-words text-sm font-medium text-fg">{row.title}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-muted">
                    <span className={row.status === "live" ? "font-medium text-status-engaged" : "font-medium text-fg"}>{row.statusWords}</span>
                    <span>{row.when}</span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" data-first={row.id} onClick={() => props.onCopy(row.id, row.link, row.url)} className={LINK_ACTION}>
                      {copiedNow ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      {copiedNow ? "Copied" : "Copy link"}
                    </button>
                    {row.status === "ended" ? null : (
                      <a href={row.link} target="_blank" rel="noopener noreferrer" className={LINK_ACTION}>
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Join
                      </a>
                    )}
                    {hasTranscript ? (
                      <button
                        type="button"
                        data-transcript-toggle={row.id}
                        aria-expanded={transcriptShown}
                        aria-controls={transcriptBox}
                        onClick={() => props.onToggleTranscript(row.id)}
                        className={LINK_ACTION}
                      >
                        <FileText className="h-3.5 w-3.5" aria-hidden />
                        {transcriptShown ? "Hide transcript" : "Transcript"}
                      </button>
                    ) : null}
                    {canDelete(row) && !asking ? (
                      <button
                        type="button"
                        data-delete={row.id}
                        aria-label={`Delete ${row.title}`}
                        onClick={() => props.onAskDelete(row.id)}
                        className={LINK_ACTION}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-status-hot" aria-hidden />
                        Delete
                      </button>
                    ) : null}
                  </div>
                  {row.leadId ? (
                    // A plain <a>, like "Back to Schedule": this file is shared with the room page, which has no app shell.
                    <div className="mt-2">
                      <a href={leadPagePath(row.leadId)} className={`inline-flex ${TAP} items-center text-[13px] font-medium text-fg underline underline-offset-4 ${FOCUS}`}>
                        {BOOKED_BY_LEAD}
                      </a>
                    </div>
                  ) : null}
                  {asking ? (
                    <div role="group" aria-label={`Delete ${row.title}`} className="mt-2 rounded-lg border border-status-hot/40 bg-status-hot/10 p-3">
                      <p className="text-xs leading-5 text-fg">{deleteConfirm(row)}</p>
                      {del.error ? (
                        <p role="alert" className="mt-2 text-xs leading-5 text-fg">
                          {del.error}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" onClick={() => props.onDelete(row.id)} disabled={del.busy} className={DANGER}>
                          {del.busy ? "Deleting..." : "Delete for good"}
                        </button>
                        <button
                          type="button"
                          data-cancel-delete
                          onClick={props.onCancelDelete}
                          disabled={del.busy}
                          className={`${LINK_ACTION} disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {failedCopy ? (
                    <p role="status" className="mt-2 break-all text-xs text-fg-muted">
                      Copy this link: <span className="select-all font-mono text-fg">{failedCopy}</span>
                    </p>
                  ) : null}
                  {transcriptShown ? (
                    <div id={transcriptBox} className="mt-2 scroll-mb-24">
                      {renderEnded?.(row.code)}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

type Load =
  | { status: "loading" }
  | { status: "error"; words: string }
  | { status: "ready"; rooms: MeetRoomItem[]; recordingAvailable: boolean; mediaReady: boolean };

/** Where focus goes once the next render has put it on the screen. */
type FocusTarget = { kind: "cancel" } | { kind: "delete"; id: string } | { kind: "row"; id: string } | { kind: "heading" };

/** The browser's own IANA time zone ("America/Toronto"), or undefined when it cannot say. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring a box that just opened below the person's button into view: the least scrolling that does it, a box
 * already in view is left where it is, and a person who asked for less motion gets none of the animation. A phone
 * shows about 480 px of the panel, so without this the box can open entirely below it and the button seems to do
 * nothing. A box's own scroll-mb class says how much room to leave below it.
 */
function bringIntoView(id: string): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

export function MeetPanel({
  renderEnded,
  onScheduleAdded,
  onMeetingDeleted,
  className = "",
}: {
  /** Where a finished recorded meeting's transcript goes. Called with the meeting's dashed code ("abc-defg-hjk"). */
  renderEnded?: (code: string) => ReactNode;
  /** Called when a meeting made for later was added to the host's Schedule, so the page can load its events again. */
  onScheduleAdded?: () => void;
  /**
   * Called when a meeting that had a time is gone: deleting a meeting also takes its entry off the creator's
   * Schedule (docs/OASIS_MEET.md), so the page loads its events again rather than show one that is no longer there.
   */
  onMeetingDeleted?: () => void;
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
  const [asking, setAsking] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The one meeting (by id) whose transcript is open. Mounting a transcript reads its recording, so none is open
  // until a Transcript button is pressed.
  const [transcriptOpen, setTranscriptOpen] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const latest = useRef(0);
  const resetCopied = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the Escape key and the delete calls must see right now, where state would be a render behind.
  const askingRef = useRef<string | null>(null);
  const deletingRef = useRef(false);
  const focusNext = useRef<FocusTarget | null>(null);

  // Recording is offered only once the list has said it runs; until then (loading, or the list failed) it is not,
  // and what is sent leaves the choice to the server (startBody, laterBody).
  const availability: RecordingAvailability = load.status !== "ready" ? "unknown" : load.recordingAvailable ? "available" : "unavailable";
  const recordingAvailable = availability === "available";
  // Video calls are switched off only once the list has said so; until then (loading, or the list failed) the buttons
  // stay on and the server decides, answering with the same line if it refuses (panelErrorWords).
  const mediaNotReady = load.status === "ready" && !load.mediaReady;

  // Which row is asking "Delete for good?". The ref is what Escape and the delete call read right now and the state
  // is what draws, so they change together, here and nowhere else.
  const setAskingId = useCallback((id: string | null) => {
    askingRef.current = id;
    setAsking(id);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    setNote(null);
    setDeleteError(null);
    setAskingId(null);
    setTranscriptOpen(null);
  }, [setAskingId]);

  const cancelDelete = useCallback(() => {
    if (deletingRef.current) return;
    const id = askingRef.current;
    if (id === null) return;
    setAskingId(null);
    setDeleteError(null);
    focusNext.current = { kind: "delete", id };
  }, [setAskingId]);

  // Escape takes back an open "Delete for good?" first; only then does it close the panel.
  const onEscape = useCallback(() => {
    if (deletingRef.current) return;
    if (askingRef.current !== null) cancelDelete();
    else closePanel();
  }, [cancelDelete, closePanel]);

  useDialogFocus(panelRef, onEscape, open);
  useOutsidePress(wrapRef, closePanel, open);

  // Focus moves after the render that put its target on the screen: to Cancel when a delete asks, back to
  // Delete when it is taken back, and to the next row (or the heading) when a meeting is gone.
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const root = panelRef.current;
    if (!root) return;
    const find = (selector: string) => root.querySelector<HTMLElement>(selector);
    const byId = (attr: string, id: string) => find(`[${attr}="${CSS.escape(id)}"]`);
    const target =
      want.kind === "cancel"
        ? find("[data-cancel-delete]")
        : want.kind === "delete"
          ? byId("data-delete", want.id)
          : want.kind === "row"
            ? (byId("data-first", want.id) ?? find("[data-list-heading]"))
            : find("[data-list-heading]");
    target?.focus();
  });

  // What a button opens below itself is brought into view (bringIntoView). A transcript box starts as one line and
  // grows once the recording loads, so its scroll-mb class leaves it room to grow into view.
  useEffect(() => {
    if (transcriptOpen !== null) bringIntoView(transcriptBoxId(transcriptOpen));
  }, [transcriptOpen]);

  // A link just made: once per new link, because `created` is a new object each time one is made and is not touched
  // by anything else (a copy, a keystroke, closing and opening the panel leave it alone).
  useEffect(() => {
    if (created) bringIntoView(MADE_BOX_LATER);
  }, [created]);

  // Start now's box only when its tab was blocked: then the person has to open the meeting from here and send the
  // link. When the tab opened they are in it, and the panel is left as it was.
  useEffect(() => {
    if (started && !started.opened) bringIntoView(MADE_BOX_START);
  }, [started]);

  // The list can say "not switched on" after the panel opened, which disables the Start button the dialog had just
  // focused. A disabled button drops focus to the page, where Escape no longer reaches the panel: take it to the
  // line that says why instead. Only when focus was lost (a reopen starts with focus on the Meet button).
  useEffect(() => {
    if (!open || !mediaNotReady || document.activeElement !== document.body) return;
    panelRef.current?.querySelector<HTMLElement>("[data-media-note]")?.focus();
  }, [open, mediaNotReady]);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    const quiet = loaded.current;
    if (!quiet) setLoad({ status: "loading" });
    const res = await listMeetings();
    if (mine !== latest.current) return;
    if (res.ok) {
      loaded.current = true;
      setLoad({ status: "ready", rooms: res.value.rooms, recordingAvailable: res.value.recordingAvailable, mediaReady: res.value.mediaReady });
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
    setLoad((prev) => (prev.status === "ready" ? { ...prev, rooms: [room, ...prev.rooms.filter((r) => r.id !== room.id)] } : prev));
  };

  const startNow = async () => {
    if (startBusy || mediaNotReady) return;
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
    setNote(null);
    const made = await createMeeting(startBody(availability));
    setStartBusy(false);
    if (!made.ok) {
      win?.close();
      setStartError(made.words);
      return;
    }
    const room = made.value.room;
    const opened = !!win && !win.closed;
    // The tab goes to the page's own address (the host is signed in there); the link to send is the server's whole one.
    if (win && opened) win.location.href = meetingUrl(window.location.origin, room.link);
    setStarted({ url: linkToSend(window.location.origin, room), link: room.link, opened, recorded: room.recordAudio });
    remember(room);
  };

  const createLater = async () => {
    if (laterBusy || mediaNotReady) return;
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
    setNote(null);
    const made = await createMeeting(
      laterBody({ title, startsAt: when, timeZone: when ? browserTimeZone() : undefined, minutes, record, availability }),
    );
    setLaterBusy(false);
    if (!made.ok) {
      setLaterError(made.words);
      return;
    }
    const room = made.value.room;
    setCreated({
      url: linkToSend(window.location.origin, room),
      link: room.link,
      opened: false,
      schedule: made.value.schedule,
      recorded: room.recordAudio,
    });
    setTitle("");
    setStartsAt("");
    setMinutes("");
    remember(room);
    if (made.value.schedule?.added) onScheduleAdded?.();
  };

  const copy = async (key: string, link: string, absolute?: string) => {
    const url = linkToSend(window.location.origin, { link, url: absolute });
    const ok = await copyToClipboard(url);
    setCopied({ key, ok, url });
    if (resetCopied.current) clearTimeout(resetCopied.current);
    if (ok) resetCopied.current = setTimeout(() => setCopied(null), 2_000);
  };

  const askDelete = (id: string) => {
    if (deletingRef.current || askingRef.current === id) return;
    setAskingId(id);
    setDeleteError(null);
    setNote(null);
    focusNext.current = { kind: "cancel" };
  };

  const deleteRow = async (id: string) => {
    if (deletingRef.current || load.status !== "ready") return;
    const rooms = load.rooms;
    const room = rooms.find((r) => r.id === id);
    if (!room || !canDelete(room)) return;
    deletingRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await deleteMeeting(room.code);
    deletingRef.current = false;
    setDeleteBusy(false);
    // Refused, and the meeting is still there: say why, and keep the question open.
    if (!res.ok && !res.gone) {
      setDeleteError(res.words);
      return;
    }
    // Gone, deleted now or already: its row, its copy button and any link just made for it go too.
    const { focusId } = withoutMeeting(rooms, id);
    focusNext.current = focusId ? { kind: "row", id: focusId } : { kind: "heading" };
    setLoad((prev) => (prev.status === "ready" ? { ...prev, rooms: withoutMeeting(prev.rooms, id).rooms } : prev));
    setStarted((prev) => (prev?.link === room.link ? null : prev));
    setCreated((prev) => (prev?.link === room.link ? null : prev));
    setCopied((prev) => (prev?.key === id ? null : prev));
    setTranscriptOpen((prev) => (prev === id ? null : prev));
    setAskingId(null);
    setNote(res.ok ? deletedNote(res.relayRemaining) : ALREADY_DELETED);
    if (room.startsAt) onMeetingDeleted?.();
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
            mine: r.mine,
            leadId: r.leadId,
            recordAudio: r.recordAudio,
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
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <Video className="h-4 w-4" aria-hidden />
        Meet
      </button>
      {open ? (
        <>
          <div aria-hidden className="fixed inset-0 z-40 bg-bg-rail/60 sm:hidden" onClick={closePanel} />
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
                onClick={closePanel}
                aria-label="Close"
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-active-hover hover:text-fg sm:h-8 sm:w-8 ${FOCUS}`}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <MeetPanelView
              list={list}
              recordingAvailable={recordingAvailable}
              mediaNotReady={mediaNotReady}
              start={{ busy: startBusy, error: startError, made: started }}
              later={{ title, startsAt, minutes, record, busy: laterBusy, error: laterError, made: created }}
              del={{ asking, busy: deleteBusy, error: deleteError }}
              note={note}
              copied={copied}
              onStart={() => void startNow()}
              onTitle={setTitle}
              onStartsAt={setStartsAt}
              onMinutes={setMinutes}
              onRecord={setRecord}
              onCreate={() => void createLater()}
              onCopy={(key, link, url) => void copy(key, link, url)}
              onAskDelete={askDelete}
              onCancelDelete={cancelDelete}
              onDelete={(id) => void deleteRow(id)}
              onRetry={() => void refresh()}
              transcriptOpen={transcriptOpen}
              onToggleTranscript={(id) => setTranscriptOpen((prev) => toggledTranscript(prev, id))}
              renderEnded={renderEnded}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
