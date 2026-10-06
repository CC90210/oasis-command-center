"use client";

/**
 * Oasis Whiteboard — the flagship Content Tools surface.
 *
 * Ported 2026-10-06 from the standalone tool at
 * Business-Empire-Agent/oasis-whiteboard/index.html. The drawing engine is
 * carried over unchanged: quadratic midpoint smoothing between samples,
 * devicePixelRatio-scaled backing store (retina), destination-out eraser,
 * dot-grid board. What changed is the chassis: vanilla DOM listeners became
 * React state + a single mount effect, and window-sized canvas became a
 * container-sized canvas driven by a ResizeObserver so the board fits the
 * dashboard instead of the viewport.
 *
 * The mutable stroke state lives in a ref, not React state: mousemove fires
 * far faster than a render cycle and the handlers must never read a stale
 * closure. React state only mirrors what the toolbar RENDERS (active color,
 * brush size, eraser on/off, hint visibility).
 */

import { useEffect, useRef, useState } from "react";

const PALETTE = [
  { color: "#38bdf8", name: "Sky" },
  { color: "#d946ef", name: "Magenta" },
  { color: "#ec4899", name: "Pink" },
  { color: "#22c55e", name: "Green" },
  { color: "#f59e0b", name: "Amber" },
  { color: "#f8fafc", name: "White" },
];

/** Matches `bg-bg-deep` so the exported PNG is the board the operator saw. */
const BOARD_BG = "#0a0c10";

type StrokeState = {
  isDrawing: boolean;
  isErasing: boolean;
  color: string;
  size: number;
  lastX: number;
  lastY: number;
  midX: number;
  midY: number;
};

export function OasisWhiteboard() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<StrokeState>({
    isDrawing: false,
    isErasing: false,
    color: PALETTE[0].color,
    size: 4,
    lastX: 0,
    lastY: 0,
    midX: 0,
    midY: 0,
  });

  const [color, setColorState] = useState(PALETTE[0].color);
  const [size, setSizeState] = useState(4);
  const [erasing, setErasingState] = useState(false);
  const [hintVisible, setHintVisible] = useState(true);

  // Toolbar buttons render outside the mount effect below, so the effect
  // stashes its actions here for them to call. Defaults are inert until the
  // effect runs on mount.
  const actionsRef = useRef<{
    toggleEraser: () => void;
    clear: () => void;
    save: () => void;
  }>({ toggleEraser: () => {}, clear: () => {}, save: () => {} });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const stroke = strokeRef.current;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;

    function resizeCanvas() {
      if (!canvas || !ctx || !container) return;
      // Preserve the current drawing across the resize: copy it out at device
      // pixels, resize (which wipes the backing store), then paint it back.
      const temp = document.createElement("canvas");
      const tctx = temp.getContext("2d");
      temp.width = canvas.width;
      temp.height = canvas.height;
      if (tctx && canvas.width > 0) tctx.drawImage(canvas, 0, 0);

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(container.clientWidth * dpr);
      canvas.height = Math.round(container.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (tctx && temp.width > 0) ctx.drawImage(temp, 0, 0, temp.width / dpr, temp.height / dpr);
    }

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(container);

    function getXY(e: MouseEvent | TouchEvent): [number, number] {
      const rect = canvas!.getBoundingClientRect();
      const point =
        "touches" in e
          ? (e.touches[0] ?? e.changedTouches[0])
          : e;
      return [point.clientX - rect.left, point.clientY - rect.top];
    }

    function applyBrush() {
      if (!ctx) return;
      if (stroke.isErasing) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineWidth = stroke.size * 2.5;
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.shadowBlur = 0;
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.lineWidth = stroke.size;
        ctx.strokeStyle = stroke.color;
        ctx.shadowBlur = 4;
        ctx.shadowColor = stroke.color;
      }
    }

    function startDrawing(e: MouseEvent | TouchEvent) {
      e.preventDefault();
      stroke.isDrawing = true;
      setHintVisible(false);
      [stroke.lastX, stroke.lastY] = getXY(e);
      stroke.midX = stroke.lastX;
      stroke.midY = stroke.lastY;
      applyBrush();
      if (!ctx) return;
      ctx.beginPath();
      ctx.arc(
        stroke.lastX,
        stroke.lastY,
        (stroke.isErasing ? ctx.lineWidth : stroke.size) / 2,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = stroke.isErasing ? "rgba(0,0,0,1)" : stroke.color;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(stroke.lastX, stroke.lastY);
    }

    function draw(e: MouseEvent | TouchEvent) {
      if (!stroke.isDrawing || !ctx) return;
      e.preventDefault();
      const [x, y] = getXY(e);
      const newMidX = (stroke.lastX + x) / 2;
      const newMidY = (stroke.lastY + y) / 2;
      applyBrush();
      ctx.beginPath();
      ctx.moveTo(stroke.midX, stroke.midY);
      ctx.quadraticCurveTo(stroke.lastX, stroke.lastY, newMidX, newMidY);
      ctx.stroke();
      ctx.shadowBlur = 0;
      stroke.lastX = x;
      stroke.lastY = y;
      stroke.midX = newMidX;
      stroke.midY = newMidY;
    }

    function stopDrawing() {
      stroke.isDrawing = false;
      ctx?.beginPath();
    }

    function toggleEraser() {
      stroke.isErasing = !stroke.isErasing;
      setErasingState(stroke.isErasing);
    }

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if (e.key === "e" || e.key === "E") toggleEraser();
    }

    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    window.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("touchstart", startDrawing, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    window.addEventListener("touchend", stopDrawing);
    window.addEventListener("keydown", onKeyDown);

    // Exposed to the toolbar buttons below through the stable refs — the
    // buttons live outside this effect, so the effect stashes the actions.
    actionsRef.current = {
      toggleEraser,
      clear: () => {
        if (!canvas || !ctx) return;
        canvas.style.transition = "opacity 0.3s ease";
        canvas.style.opacity = "0";
        clearTimer = setTimeout(() => {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
          canvas.style.opacity = "1";
          clearTimer = setTimeout(() => {
            canvas.style.transition = "";
            clearTimer = null;
          }, 300);
        }, 300);
      },
      save: () => {
        if (!canvas) return;
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const octx = out.getContext("2d");
        if (!octx) return;
        octx.fillStyle = BOARD_BG;
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(canvas, 0, 0);
        const link = document.createElement("a");
        link.download = `Oasis-Whiteboard-${new Date().toISOString().slice(0, 10)}.png`;
        link.href = out.toDataURL("image/png");
        link.click();
      },
    };

    return () => {
      observer.disconnect();
      canvas.removeEventListener("mousedown", startDrawing);
      canvas.removeEventListener("mousemove", draw);
      window.removeEventListener("mouseup", stopDrawing);
      canvas.removeEventListener("touchstart", startDrawing);
      canvas.removeEventListener("touchmove", draw);
      window.removeEventListener("touchend", stopDrawing);
      window.removeEventListener("keydown", onKeyDown);
      if (clearTimer) clearTimeout(clearTimer);
    };
  }, []);

  function selectColor(hex: string) {
    strokeRef.current.color = hex;
    strokeRef.current.isErasing = false;
    setColorState(hex);
    setErasingState(false);
  }

  const toolButton =
    "flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[0.85rem] font-medium text-fg transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10 hover:shadow-[0_6px_16px_rgba(0,0,0,0.3)] active:translate-y-0 active:scale-[0.97]";
  const eraserActive =
    "border-sky-400/50 bg-sky-400/[0.18] text-sky-400 shadow-[0_0_16px_rgba(56,189,248,0.25)]";

  return (
    <div
      ref={containerRef}
      className="relative h-[70vh] min-h-[420px] w-full overflow-hidden rounded-2xl border border-bg-border bg-bg-deep"
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 block h-full w-full touch-none ${
          erasing ? "cursor-cell" : "cursor-crosshair"
        }`}
      />

      {/* Floating toolbar — glass pill, wraps into a rounded card on narrow
          screens (the original's 820px breakpoint, expressed responsively). */}
      <div className="absolute left-1/2 top-4 z-10 flex max-w-[94%] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-3xl border border-white/10 bg-bg-panel/70 px-4 py-2.5 shadow-elev backdrop-blur-xl backdrop-saturate-150 animate-slide-up md:flex-nowrap md:gap-5 md:rounded-[999px] md:px-6 md:py-3">
        <div className="flex select-none items-center gap-2 whitespace-nowrap text-[1.05rem] font-bold text-fg">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 12h4l3-9 5 18 3-9h5" />
          </svg>
          <span className="hidden md:inline">Oasis Whiteboard</span>
        </div>

        <div className="hidden h-6 w-px bg-white/10 md:block" aria-hidden />

        <div className="flex items-center gap-2">
          <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-fg-muted">
            Color
          </span>
          <input
            type="color"
            value={color}
            title="Custom color"
            onChange={(e) => selectColor(e.target.value)}
            className="h-[30px] w-[30px] cursor-pointer appearance-none overflow-hidden rounded-full border-none bg-none p-0 shadow-[0_0_0_2px_rgba(255,255,255,0.09)] transition-all duration-200 hover:scale-[1.12] hover:shadow-[0_0_0_2px_#38bdf8] [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
          />
        </div>

        <div className="flex items-center gap-[7px]">
          {PALETTE.map((s) => (
            <button
              key={s.color}
              type="button"
              title={s.name}
              aria-label={`Draw in ${s.name}`}
              onClick={() => selectColor(s.color)}
              style={{ background: s.color }}
              className={`h-[22px] w-[22px] rounded-full border-2 p-0 transition-transform duration-200 hover:scale-125 ${
                !erasing && color === s.color
                  ? "scale-[1.12] border-white shadow-[0_0_10px_rgba(255,255,255,0.3)]"
                  : "border-transparent"
              }`}
            />
          ))}
        </div>

        <div className="hidden h-6 w-px bg-white/10 md:block" aria-hidden />

        <div className="flex items-center gap-2">
          <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-fg-muted">
            Size
          </span>
          <input
            type="range"
            min={1}
            max={50}
            value={size}
            title="Brush size"
            onChange={(e) => {
              const n = Number(e.target.value);
              strokeRef.current.size = n;
              setSizeState(n);
            }}
            className="w-[70px] cursor-pointer appearance-none bg-transparent md:w-[100px] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:cursor-pointer [&::-webkit-slider-runnable-track]:rounded-sm [&::-webkit-slider-runnable-track]:bg-white/[0.12] [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-400 [&::-webkit-slider-thumb]:shadow-[0_0_12px_rgba(56,189,248,0.6)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-200 [&::-webkit-slider-thumb]:hover:scale-125"
          />
        </div>

        <div className="hidden h-6 w-px bg-white/10 md:block" aria-hidden />

        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Eraser (E)"
            onClick={() => actionsRef.current.toggleEraser()}
            className={`${toolButton} ${erasing ? eraserActive : ""}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
              <path d="M22 21H7" />
              <path d="m5 11 9 9" />
            </svg>
            Eraser
          </button>
          <button
            type="button"
            title="Clear board"
            onClick={() => actionsRef.current.clear()}
            className={toolButton}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            Clear
          </button>
          <button
            type="button"
            title="Download PNG"
            onClick={() => actionsRef.current.save()}
            className={toolButton}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Save
          </button>
        </div>
      </div>

      <div
        className={`pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/10 bg-bg-panel/70 px-[18px] py-2 text-[0.78rem] text-fg-muted backdrop-blur-md transition-opacity duration-500 ${
          hintVisible ? "opacity-75" : "opacity-0"
        }`}
      >
        Drag to sketch &nbsp;•&nbsp; E = eraser &nbsp;•&nbsp; Works great for Google Meet screenshares
      </div>
    </div>
  );
}
