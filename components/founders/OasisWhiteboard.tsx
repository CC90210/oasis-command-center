"use client";

/**
 * Oasis Whiteboard: the sketching board on Content > Content Tools, made for
 * sharing a tab on a Google Meet call from a computer or a phone.
 *
 * Ported 2026-10-06 from Business-Empire-Agent/oasis-whiteboard/index.html
 * (same pens, palette, smoothing and eraser). Since the 2026-10-08 review:
 * - the drawing is a list of strokes (whiteboard-model.ts), so resizing the
 *   window, rotating a phone or moving to another screen draws it again
 *   instead of cutting it off;
 * - Clear happens at once and Undo brings it back; nothing waits on a timer;
 * - every control is at least 44 x 44 px at every width, the colour and
 *   eraser buttons say which one is on (aria-pressed), and the toolbar sits
 *   above the board so it never covers the drawing on a phone;
 * - the board lives in this tab only, and the page says so: Download keeps a
 *   picture.
 *
 * whiteboard-surface.ts owns the canvas (input, size, keys, download);
 * whiteboard-present.ts owns the Present (full screen) mode as data; this
 * file is the toolbar, the frame, and the one place that calls the browser's
 * real Fullscreen API. tests/oasis-whiteboard.test.ts covers all four files.
 *
 * PRESENT (2026-10-10): the board's own container (containerRef, already
 * sized to fit the page) is the Fullscreen target - the drawing fills the
 * screen for whoever is watching the Google Meet share, the way presenting a
 * canvas-only surface usually works. The toolbar sits above it and is NOT
 * inside it, so a floating "Exit presentation" control is rendered inside
 * the container itself (the only thing still on screen while presenting) -
 * the same control for both real full screen and the CSS-only "maximized"
 * fallback below. Escape exits native full screen on its own (every
 * browser's default); "maximized" has no such default, so this file adds
 * its own Escape listener only while that fallback is showing.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { MAX_SIZE, MIN_SIZE, PALETTE } from "@/components/founders/whiteboard-model";
import {
  BOARD_PRESENTING_ATTR,
  boardContainerClasses,
  isPresenting,
  modeAfterRequest,
  needsShellRaise,
  presentButtonLabel,
  type PresentMode,
} from "@/components/founders/whiteboard-present";
import {
  INITIAL_STATE,
  mountWhiteboard,
  type WhiteboardHandle,
  type WhiteboardState,
} from "@/components/founders/whiteboard-surface";

export type ToolbarActions = {
  setColor: (hex: string) => void;
  setSize: (size: number) => void;
  toggleEraser: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  download: () => void;
  present: () => void;
};

/** Every control's touch target: at least 44 x 44 CSS px, at every width. */
export const TAP_TARGET = "min-h-11 min-w-11";
const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70";
const TOOL_BUTTON = `${TAP_TARGET} ${FOCUS} inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-3 text-[0.85rem] font-medium text-fg transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10 hover:shadow-[0_6px_16px_rgba(0,0,0,0.3)] active:translate-y-0 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40`;
const TOOL_ON = "border-sky-400/50 bg-sky-400/[0.18] text-sky-400";
/**
 * The floating controls painted inside the board's own container while
 * presenting (both Exit buttons, and the touch Undo/Eraser cluster) - no
 * `absolute` here, so a positioning class is never doubled up the way
 * `relative`+`fixed` was (whiteboard-present.ts boardContainerClasses):
 * callers that need `absolute` add it themselves; the cluster's own
 * children do not, since their flex parent already positions them.
 */
const FLOATING_BUTTON =
  "z-10 inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-bg-panel/85 px-3 text-[0.85rem] font-medium text-fg backdrop-blur-md hover:bg-bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70";
const ICON = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function WhiteboardToolbar({
  ui,
  actions,
  presentMode = "idle",
  presentButtonRef,
}: {
  ui: WhiteboardState;
  actions: ToolbarActions;
  presentMode?: PresentMode;
  /** Focused back on exiting Present, so a keyboard user lands where they started (Codex review round 3). */
  presentButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const customOn = !ui.erasing && !PALETTE.some((s) => s.color === ui.color);
  return (
    <div
      role="group"
      aria-label="Whiteboard tools"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-bg-border bg-bg-panel px-2 py-1 shadow-elev"
    >
      <div className="hidden select-none items-center gap-2 whitespace-nowrap px-2 text-[1.05rem] font-bold text-fg md:flex">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12h4l3-9 5 18 3-9h5" />
        </svg>
        Oasis Whiteboard
      </div>

      <div className="flex flex-wrap items-center">
        <span className="mr-1 hidden text-[0.75rem] font-medium uppercase tracking-[0.06em] text-fg-muted md:inline">
          Color
        </span>
        <label title="Any color" className={`${TAP_TARGET} relative flex cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent/70`}>
          <span
            aria-hidden
            style={{ background: ui.color }}
            className={`h-[30px] w-[30px] rounded-full ${customOn ? "ring-2 ring-fg ring-offset-2 ring-offset-bg-panel" : "ring-2 ring-white/10"}`}
          />
          <input
            type="color"
            aria-label="Pick any color"
            value={ui.color}
            onChange={(e) => actions.setColor(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        {PALETTE.map((s) => {
          const on = !ui.erasing && ui.color === s.color;
          return (
            <button
              key={s.color}
              type="button"
              title={s.name}
              aria-label={`Draw in ${s.name}`}
              aria-pressed={on}
              onClick={() => actions.setColor(s.color)}
              className={`${TAP_TARGET} ${FOCUS} group flex items-center justify-center rounded-full`}
            >
              <span
                aria-hidden
                style={{ background: s.color }}
                className={`h-[22px] w-[22px] rounded-full border-2 transition-transform duration-200 group-hover:scale-125 ${
                  on ? "scale-[1.12] border-white ring-2 ring-fg ring-offset-2 ring-offset-bg-panel" : "border-transparent"
                }`}
              />
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2">
        <span className="hidden text-[0.75rem] font-medium uppercase tracking-[0.06em] text-fg-muted md:inline">
          Size
        </span>
        <input
          type="range"
          aria-label="Brush size"
          min={MIN_SIZE}
          max={MAX_SIZE}
          value={ui.size}
          onChange={(e) => actions.setSize(Number(e.target.value))}
          className={`${FOCUS} h-11 w-28 cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-sm [&::-webkit-slider-runnable-track]:bg-white/[0.12] [&::-webkit-slider-thumb]:-mt-5 [&::-webkit-slider-thumb]:box-border [&::-webkit-slider-thumb]:h-11 [&::-webkit-slider-thumb]:w-11 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[13px] [&::-webkit-slider-thumb]:border-solid [&::-webkit-slider-thumb]:border-transparent [&::-webkit-slider-thumb]:bg-sky-400 [&::-webkit-slider-thumb]:bg-clip-padding [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-sm [&::-moz-range-track]:bg-white/[0.12] [&::-moz-range-thumb]:box-border [&::-moz-range-thumb]:h-11 [&::-moz-range-thumb]:w-11 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[13px] [&::-moz-range-thumb]:border-solid [&::-moz-range-thumb]:border-transparent [&::-moz-range-thumb]:bg-sky-400 [&::-moz-range-thumb]:bg-clip-padding`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          title="Eraser (E)"
          aria-label="Eraser"
          aria-pressed={ui.erasing}
          onClick={actions.toggleEraser}
          className={`${TOOL_BUTTON} ${ui.erasing ? TOOL_ON : ""}`}
        >
          <svg {...ICON}>
            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
            <path d="M22 21H7" />
            <path d="m5 11 9 9" />
          </svg>
          <span className="hidden sm:inline">Eraser</span>
        </button>
        <button type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!ui.canUndo} onClick={actions.undo} className={TOOL_BUTTON}>
          <svg {...ICON}>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
          <span className="hidden sm:inline">Undo</span>
        </button>
        <button type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!ui.canRedo} onClick={actions.redo} className={TOOL_BUTTON}>
          <svg {...ICON}>
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
          <span className="hidden sm:inline">Redo</span>
        </button>
        <button type="button" title="Clear the board (Undo brings it back)" aria-label="Clear" disabled={ui.empty} onClick={actions.clear} className={TOOL_BUTTON}>
          <svg {...ICON}>
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
          <span className="hidden sm:inline">Clear</span>
        </button>
        <button type="button" title="Download the board as a picture (PNG)" aria-label="Download" disabled={ui.empty} onClick={actions.download} className={TOOL_BUTTON}>
          <svg {...ICON}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span className="hidden sm:inline">Download</span>
        </button>
        <button
          ref={presentButtonRef}
          type="button"
          title={presentMode === "idle" ? "Full screen, for a Google Meet call" : "Back to the normal page"}
          aria-label={presentButtonLabel(presentMode)}
          onClick={actions.present}
          className={`${TOOL_BUTTON} ${isPresenting(presentMode) ? TOOL_ON : ""}`}
        >
          {isPresenting(presentMode) ? (
            <svg {...ICON}>
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg {...ICON}>
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
          <span className="hidden sm:inline">{presentButtonLabel(presentMode)}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The controls painted inside the board's own container while presenting:
 * two independent Exit buttons (so one is always reachable regardless of
 * where the app shell's chrome sits) and the one touch path to Undo or the
 * eraser (the toolbar above is covered by native full screen, or hidden
 * under the CSS-only "maximized" fallback; keyboard users still have
 * Ctrl/Cmd+Z and E). A function on its own, not inlined, so
 * tests/oasis-whiteboard.test.ts can render it directly with an explicit
 * `presentMode`, the same way it already tests WhiteboardToolbar - the
 * host component's internal state has no server-renderable way to reach
 * "presenting" on its own.
 */
export function PresentingOverlay({
  presentMode,
  ui,
  actions,
  exitButtonRef,
}: {
  presentMode: PresentMode;
  ui: Pick<WhiteboardState, "erasing" | "canUndo">;
  actions: Pick<ToolbarActions, "present" | "toggleEraser" | "undo">;
  /** Focused on entering Present; read by OasisWhiteboard's own effect, not by this component. */
  exitButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const label = presentButtonLabel(presentMode);
  return (
    <>
      {/* Top: offset by the device's own safe area (notch, Dynamic Island), never a bare fixed inset - the same control is also focused on entering Present. */}
      <button
        ref={exitButtonRef}
        type="button"
        onClick={actions.present}
        aria-label={label}
        className={`absolute ${FLOATING_BUTTON} right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))]`}
      >
        <svg {...ICON}>
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
          <path d="M3 16h3a2 2 0 0 1 2 2v3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
        </svg>
        <span>{label}</span>
      </button>
      {/* Bottom: a second, independent way out - away from any app chrome and reachable with a thumb while sharing from a phone held in one hand. */}
      <button
        type="button"
        onClick={actions.present}
        aria-label={label}
        className={`absolute ${FLOATING_BUTTON} right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))]`}
      >
        <svg {...ICON}>
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
          <path d="M3 16h3a2 2 0 0 1 2 2v3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
        </svg>
        <span>{label}</span>
      </button>
      <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Eraser"
          aria-pressed={ui.erasing}
          onClick={actions.toggleEraser}
          className={`${FLOATING_BUTTON} ${ui.erasing ? TOOL_ON : ""}`}
        >
          <svg {...ICON}>
            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
            <path d="M22 21H7" />
            <path d="m5 11 9 9" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Undo"
          disabled={!ui.canUndo}
          onClick={actions.undo}
          className={`${FLOATING_BUTTON} disabled:pointer-events-none disabled:opacity-40`}
        >
          <svg {...ICON}>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
      </div>
    </>
  );
}

/** What the line at the foot of the board says: what just happened, or how to start. */
export function boardHint(ui: WhiteboardState): { text: string | null; visible: boolean } {
  if (ui.notice === "cleared") return { text: "Board cleared. Undo brings it back.", visible: true };
  if (ui.notice === "download_failed") {
    return { text: "Couldn't make the picture. Try again, or take a screenshot.", visible: true };
  }
  return { text: null, visible: !ui.started };
}

export function OasisWhiteboard() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<WhiteboardHandle | null>(null);
  const [ui, setUi] = useState<WhiteboardState>(INITIAL_STATE);
  const [unsupported, setUnsupported] = useState(false);
  const [presentMode, setPresentMode] = useState<PresentMode>("idle");
  /** Read inside the mount-only effect below without making it re-run per toggle. */
  const presentModeRef = useRef<PresentMode>("idle");
  presentModeRef.current = presentMode;
  const presentButtonRef = useRef<HTMLButtonElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const presentModeDidMount = useRef(false);

  async function present(): Promise<void> {
    if (presentMode !== "idle") {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setPresentMode("idle");
      return;
    }
    const el = containerRef.current;
    const apiAvailable = Boolean(el && typeof el.requestFullscreen === "function" && document.fullscreenEnabled !== false);
    if (!el || !apiAvailable) {
      setPresentMode(modeAfterRequest(false, false));
      return;
    }
    try {
      await el.requestFullscreen();
      setPresentMode(modeAfterRequest(true, true));
    } catch {
      setPresentMode(modeAfterRequest(true, false));
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const handle = mountWhiteboard(
      canvas,
      container,
      { win: window, doc: document, ResizeObserver: window.ResizeObserver, now: () => new Date() },
      setUi,
    );
    if (!handle) {
      setUnsupported(true);
      return;
    }
    handleRef.current = handle;
    return () => {
      handle.dispose();
      handleRef.current = null;
    };
  }, []);

  // Mount-only, same lifetime as the board above but its own effect (so the
  // board's own mount/cleanup stays pendingEffects[0] for anything that
  // reads hooks in call order, tests included): the browser's own
  // fullscreenchange (covers Escape, which every browser already exits
  // native full screen on) and, only while the CSS-only "maximized"
  // fallback is showing, this file's own Escape handler (nothing native is
  // active to catch it there).
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setPresentMode((m) => (m === "fullscreen" ? "idle" : m));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && presentModeRef.current === "maximized") setPresentMode("idle");
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Raises <main> above the app shell's own top bar and side rail (Codex
  // review round 3, HIGH) only while the CSS-only "maximized" fallback is
  // showing - app/globals.css's html[data-board-presenting] rule reads this
  // same flag. Removed on exit AND on unmount, so a navigation away while
  // presenting never leaves the rest of the app stuck under a raised <main>.
  useEffect(() => {
    if (!needsShellRaise(presentMode)) return;
    document.documentElement.dataset[BOARD_PRESENTING_ATTR] = "1";
    return () => {
      delete document.documentElement.dataset[BOARD_PRESENTING_ATTR];
    };
  }, [presentMode]);

  // Moves focus WITH the mode, never on first mount (Codex review round 3):
  // into the in-board Exit control on entering (so a keyboard user is never
  // left focused on a button the presentation just covered), and back onto
  // the toolbar's own Present button on exiting.
  useEffect(() => {
    if (!presentModeDidMount.current) {
      presentModeDidMount.current = true;
      return;
    }
    if (presentMode !== "idle") exitButtonRef.current?.focus();
    else presentButtonRef.current?.focus();
  }, [presentMode]);

  const actions: ToolbarActions = {
    setColor: (hex) => handleRef.current?.setColor(hex),
    setSize: (size) => handleRef.current?.setSize(size),
    toggleEraser: () => handleRef.current?.toggleEraser(),
    undo: () => handleRef.current?.undo(),
    redo: () => handleRef.current?.redo(),
    clear: () => handleRef.current?.clear(),
    download: () => handleRef.current?.download(),
    present: () => void present(),
  };
  const hint = boardHint(ui);
  const presenting = isPresenting(presentMode);

  return (
    <div className="flex flex-col gap-3">
      <WhiteboardToolbar ui={ui} actions={actions} presentMode={presentMode} presentButtonRef={presentButtonRef} />
      <div ref={containerRef} className={boardContainerClasses(presentMode)}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Whiteboard. Draw with a mouse, a finger or a pen."
          className={`absolute inset-0 block h-full w-full touch-none select-none ${
            ui.erasing ? "cursor-cell" : "cursor-crosshair"
          }`}
        />
        {unsupported ? (
          <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-sm text-fg-muted">
            This browser can&apos;t draw here. Open the page in Chrome, Safari or Edge.
          </p>
        ) : null}
        {presenting && <PresentingOverlay presentMode={presentMode} ui={ui} actions={actions} exitButtonRef={exitButtonRef} />}
        <p
          aria-live="polite"
          className={`pointer-events-none absolute bottom-6 left-1/2 max-w-[90%] -translate-x-1/2 rounded-full border border-white/10 bg-bg-panel/70 px-[18px] py-2 text-center text-[0.78rem] text-fg-muted backdrop-blur-md transition-opacity duration-500 ${
            hint.visible ? "opacity-75" : "opacity-0"
          }`}
        >
          {hint.text ?? (
            <>
              <span className="md:hidden">Draw with your finger or a pen.</span>
              <span className="hidden md:inline">
                Drag to sketch &bull; E for the eraser &bull; Ctrl+Z to undo &bull; Share this tab on Google Meet
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
