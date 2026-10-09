/**
 * Binds the whiteboard's stroke list (whiteboard-model.ts) to a real canvas.
 *
 * - Input: Pointer Events, one path for mouse, finger and pen. The first
 *   pointer down draws; a second finger is ignored until the first lifts, and
 *   a right or middle click never draws. A cancelled pointer (the phone took
 *   the gesture) ends the stroke where it was.
 * - Size: a ResizeObserver on the container, plus a resolution media query for
 *   devicePixelRatio (the window moved to another screen, or the browser was
 *   zoomed). Either one sizes the canvas to the container times the ratio and
 *   draws the whole board again from its strokes.
 * - Keys, anywhere on the page except while typing in a field: E toggles the
 *   eraser, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo.
 * - Download: the strokes on the board colour, as a PNG.
 *
 * Every listener it adds, dispose() removes. The browser objects come in
 * through `env`, never from globals, so tests/oasis-whiteboard.test.ts can
 * drive it with fakes and check what is still attached after dispose().
 */

import {
  BOARD_BG,
  DEFAULT_COLOR,
  DEFAULT_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  backingScale,
  backingSize,
  beginStroke,
  boardPoint,
  canRedo,
  canUndo,
  clearBoard,
  createBoard,
  downloadName,
  drawStroke,
  drawStrokeEnd,
  endStroke,
  exportArea,
  extendStroke,
  redoStep,
  renderBoard,
  undoStep,
  type View,
} from "@/components/founders/whiteboard-model";

/** A short line the board shows until the next stroke: what just happened, and the way back. */
export type Notice = "cleared" | "download_failed" | null;

export type WhiteboardState = {
  color: string;
  size: number;
  erasing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Nothing on the board: Clear and Download have nothing to act on. */
  empty: boolean;
  /** A stroke has been started, so the how-to hint can go. */
  started: boolean;
  notice: Notice;
};

export const INITIAL_STATE: WhiteboardState = {
  color: DEFAULT_COLOR,
  size: DEFAULT_SIZE,
  erasing: false,
  canUndo: false,
  canRedo: false,
  empty: true,
  started: false,
  notice: null,
};

type RatioQuery = Pick<MediaQueryList, "addEventListener" | "removeEventListener">;

export type SurfaceEnv = {
  win: Pick<Window, "addEventListener" | "removeEventListener" | "devicePixelRatio"> & {
    matchMedia?: (query: string) => RatioQuery;
  };
  doc: Pick<Document, "createElement">;
  ResizeObserver: new (callback: () => void) => Pick<ResizeObserver, "observe" | "disconnect">;
  now: () => Date;
};

export type WhiteboardHandle = {
  setColor: (hex: string) => void;
  setSize: (size: number) => void;
  toggleEraser: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  download: () => void;
  dispose: () => void;
};

/** True while the person is typing somewhere, so a letter is text and not a shortcut. */
function typingIn(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.isContentEditable === true || /^(input|textarea|select)$/i.test(el.tagName);
}

/**
 * Attaches the board to `canvas`, sized to `container`. `onState` hears every
 * change the toolbar shows. Null when the browser gives no 2D canvas.
 */
export function mountWhiteboard(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  env: SurfaceEnv,
  onState: (state: WhiteboardState) => void,
): WhiteboardHandle | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const board = createBoard();
  let view: View = { width: 0, height: 0, scale: 1 };
  let color = DEFAULT_COLOR;
  let size = DEFAULT_SIZE;
  let erasing = false;
  let started = false;
  let notice: Notice = null;
  let pointerId: number | null = null;
  let ratioQuery: RatioQuery | null = null;
  let disposed = false;

  function emit(): void {
    if (disposed) return;
    onState({
      color,
      size,
      erasing,
      canUndo: canUndo(board),
      canRedo: canRedo(board),
      empty: board.strokes.length === 0,
      started,
      notice,
    });
  }

  function redraw(): void {
    renderBoard(ctx!, board, view);
  }

  /** Sizes the canvas to its container at the current pixel ratio and redraws every stroke. */
  function fit(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = backingScale(width, height, env.win.devicePixelRatio);
    if (width === view.width && height === view.height && scale === view.scale) return;
    view = { width, height, scale };
    const px = backingSize(view);
    // Setting the size wipes the bitmap and every context setting; the board
    // is drawn again from its strokes, so nothing drawn is lost.
    canvas.width = px.width;
    canvas.height = px.height;
    redraw();
  }

  function onRatioChange(): void {
    fit();
    watchRatio();
  }

  /** A resolution query matches only the ratio it was made for, so it is remade after each change. */
  function watchRatio(): void {
    ratioQuery?.removeEventListener("change", onRatioChange);
    ratioQuery = env.win.matchMedia ? env.win.matchMedia(`(resolution: ${env.win.devicePixelRatio}dppx)`) : null;
    ratioQuery?.addEventListener("change", onRatioChange);
  }

  function onPointerDown(e: PointerEvent): void {
    if (pointerId !== null && pointerId !== e.pointerId) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    pointerId = e.pointerId;
    // A stroke this pointer never lifted from (its pointerup was lost) is
    // finished here, the way a redraw would show it.
    if (board.active) drawStrokeEnd(ctx!, board.active);
    const [x, y] = boardPoint(e.clientX, e.clientY, canvas.getBoundingClientRect());
    const stroke = beginStroke(board, erasing ? "eraser" : "pen", color, size, x, y);
    drawStroke(ctx!, stroke);
    started = true;
    notice = null;
    emit();
  }

  function onPointerEnd(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    const stroke = board.active;
    if (!stroke) return;
    drawStrokeEnd(ctx!, stroke);
    endStroke(board);
    emit();
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    // A mouse released outside the window sends no pointerup here; its next
    // move, with no button held, ends the stroke instead of drawing on.
    if (e.pointerType === "mouse" && e.buttons === 0) {
      onPointerEnd(e);
      return;
    }
    const [x, y] = boardPoint(e.clientX, e.clientY, canvas.getBoundingClientRect());
    const stroke = extendStroke(board, x, y);
    if (!stroke) return;
    e.preventDefault();
    drawStroke(ctx!, stroke, stroke.points.length / 2 - 1);
  }

  function setColor(hex: string): void {
    color = hex;
    erasing = false;
    emit();
  }

  function setSize(next: number): void {
    if (!Number.isFinite(next)) return;
    size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(next)));
    emit();
  }

  function toggleEraser(): void {
    erasing = !erasing;
    emit();
  }

  function clear(): void {
    if (!clearBoard(board)) return;
    redraw();
    notice = "cleared";
    emit();
  }

  function undo(): void {
    if (!undoStep(board)) return;
    redraw();
    notice = null;
    emit();
  }

  function redo(): void {
    if (!redoStep(board)) return;
    redraw();
    notice = null;
    emit();
  }

  function download(): void {
    const area = exportArea(board, view);
    const out: View = { ...area, scale: backingScale(area.width, area.height, env.win.devicePixelRatio) };
    const px = backingSize(out);
    const ink = env.doc.createElement("canvas");
    const sheet = env.doc.createElement("canvas");
    ink.width = sheet.width = px.width;
    ink.height = sheet.height = px.height;
    const inkCtx = ink.getContext("2d");
    const sheetCtx = sheet.getContext("2d");
    let href = "";
    if (inkCtx && sheetCtx && px.width > 0 && px.height > 0) {
      // The strokes go on their own transparent layer first, so the eraser
      // cuts strokes away instead of punching holes in the background.
      renderBoard(inkCtx, board, out);
      sheetCtx.fillStyle = BOARD_BG;
      sheetCtx.fillRect(0, 0, px.width, px.height);
      sheetCtx.drawImage(ink, 0, 0);
      href = sheet.toDataURL("image/png");
    }
    // A canvas the browser cannot encode (too big for its memory) gives
    // "data:," rather than an error; say so instead of saving an empty file.
    if (!href.startsWith("data:image/png")) {
      notice = "download_failed";
      emit();
      return;
    }
    const link = env.doc.createElement("a");
    link.download = downloadName(env.now());
    link.href = href;
    link.click();
    if (notice === "download_failed") {
      notice = null;
      emit();
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (typingIn(e.target)) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    // Ctrl+Y only: Cmd+Y is the browser's History on a Mac.
    if (e.ctrlKey && !e.metaKey && !e.altKey && key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (key === "e" && !mod && !e.altKey && !e.repeat) toggleEraser();
  }

  const observer = new env.ResizeObserver(fit);
  fit();
  observer.observe(container);
  watchRatio();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  env.win.addEventListener("pointerup", onPointerEnd);
  env.win.addEventListener("pointercancel", onPointerEnd);
  env.win.addEventListener("keydown", onKeyDown);
  emit();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    ratioQuery?.removeEventListener("change", onRatioChange);
    ratioQuery = null;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    env.win.removeEventListener("pointerup", onPointerEnd);
    env.win.removeEventListener("pointercancel", onPointerEnd);
    env.win.removeEventListener("keydown", onKeyDown);
  }

  return { setColor, setSize, toggleEraser, undo, redo, clear, download, dispose };
}
