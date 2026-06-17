"use client";

/**
 * SignatureField — canvas-based e-signature for the public form.
 *
 * Replaces the deferred-v2 "type your name" text input on the
 * full-application's Sign step. Works with touch (phone) and mouse /
 * trackpad (desktop) — signature_pad handles both pointer types natively;
 * `touch-action: none` on the canvas stops a finger-drag from scrolling the
 * page instead of drawing.
 *
 * Emits a PNG data-URI on every stroke-end, and "" when the canvas is empty
 * — so a `required` signature field's truthiness gate correctly blocks
 * "Submit" until the merchant actually draws. (A blank canvas's toDataURL is
 * a non-empty string, which would otherwise pass the gate.)
 *
 * The captured PNG has a transparent background so it embeds cleanly onto the
 * white application PDF (see lib/forms/application-pdf.ts).
 */

import { useEffect, useRef } from "react";
import SignaturePad from "signature_pad";

type Props = {
  value: string;
  onChange: (v: string) => void;
};

export function SignatureField({ value, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePad | null>(null);
  // Keep the latest onChange without re-running the mount effect (which owns
  // the canvas lifecycle — re-creating the pad on every render would wipe the
  // drawing).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mount-only restore of an already-captured signature (navigating back to
  // the step). Read via ref so it isn't a mount-effect dependency.
  const initialRef = useRef(value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePad(canvas, {
      penColor: "#0f172a",
      backgroundColor: "rgba(0,0,0,0)", // transparent — clean PDF embed
      minWidth: 0.7,
      maxWidth: 2.2,
    });
    padRef.current = pad;

    // High-DPI: scale the backing store to devicePixelRatio so the line is
    // crisp and the pointer maps 1:1 on retina + phones. Preserve any drawn
    // strokes across the resize (orientation change) — a naive resize blanks
    // the canvas.
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = pad.toData();
      canvas.width = Math.max(canvas.offsetWidth, 1) * ratio;
      canvas.height = Math.max(canvas.offsetHeight, 1) * ratio;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(ratio, ratio);
      pad.clear(); // resizing the backing store wipes it; clear keeps isEmpty() honest
      if (data.length) pad.fromData(data);
    };
    resize();

    if (initialRef.current) {
      // fromDataURL is async (loads the image) — fire-and-forget restore.
      pad.fromDataURL(initialRef.current).catch(() => {
        /* malformed prior value — start blank */
      });
    }

    const emit = () => {
      onChangeRef.current(pad.isEmpty() ? "" : pad.toDataURL("image/png"));
    };
    pad.addEventListener("endStroke", emit);
    window.addEventListener("resize", resize);

    return () => {
      pad.removeEventListener("endStroke", emit);
      window.removeEventListener("resize", resize);
      pad.off();
      padRef.current = null;
    };
  }, []);

  const clear = () => {
    padRef.current?.clear();
    onChangeRef.current("");
  };

  return (
    <div className="space-y-1.5">
      <div className="rounded-md border border-bg-border bg-white">
        <canvas
          ref={canvasRef}
          className="w-full touch-none rounded-md"
          style={{ height: 160 }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">
          Draw your signature above — use your finger on a phone or your mouse on a computer.
        </span>
        <button
          type="button"
          onClick={clear}
          className="text-[11px] font-bold text-fg-muted hover:text-fg underline-offset-2 hover:underline"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
