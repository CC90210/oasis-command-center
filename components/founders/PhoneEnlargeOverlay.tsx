"use client";

/**
 * The big phone itself: the dialog PhoneEnlarge opens. Fetched in the browser
 * only, the first time a viewer reaches for a tile (loadBigPhone in
 * PhoneEnlarge.tsx); the server never compiles it.
 *
 * WHY ITS OWN MODULE. Nothing here can run on the server: it exists only after
 * a click. And the server build copies a module into every route that uses it
 * when it misses webpack's sharing limits (PR #531 found lib/api-auth.ts
 * emitted 161 times). Compiled for server rendering in each Content route, this
 * code, PhoneFrame for the browser, its icons and the focus trap put the first
 * version of this change 129 KiB over main in CI (2026-10-02), past the
 * Worker's upload budget. Behind loadBigPhone's `typeof window` test the server
 * compile drops it, and the browser fetches it once, as one small chunk shared
 * by every tile.
 *
 * KEYBOARD AND FOCUS. A modal dialog. Focus moves to Close when it opens; Tab
 * and Shift+Tab stay inside it (focus-trap.ts, the Connections drawer's trap);
 * Esc, Close and a click on the dark area around the phone close it; and focus
 * goes back to the button that opened it - recorded at open by PhoneEnlarge,
 * because Safari does not focus a button on click. The page behind does not
 * scroll while it is open. The fade and the rise run only when the viewer has
 * not asked for reduced motion.
 *
 * SIZE. The frame is 2.106 times as tall as it is wide (a 9:19.5 screen inside
 * a bezel of 2.6% of the width on every side), so the tallest phone that fits
 * is the viewport height over 2.11. From `sm` up it takes the full height, with
 * Close beside it; below that it takes the width and leaves room above it for
 * Close. A 1280x800 window: 356 x 751 px. A 390x844 phone: 347 x 731 px.
 *
 * NOTHING LOADS UNTIL PLAY. The media is the caller's own element, mounted
 * afresh here: a Library video is a cover until its play button is pressed,
 * unless the big phone was opened BY a play press (TileVideo reads that from
 * the slot this provides).
 */

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { PhoneFrame, type PhoneFrameShape } from "@/components/founders/PhoneFrame";
import { FOCUSABLE_SELECTOR, trapTab } from "@/components/os/connections/focus-trap";
import { enlargeSlotContext, type EnlargeSlot, type EnlargeStart } from "@/components/founders/PhoneEnlarge";

/**
 * The big phone's width. Two classes, so Tailwind finds both as literal text.
 * Below `sm` 7rem of the height is kept for Close above the phone; from `sm`
 * Close sits beside it and the phone takes all but the padding.
 */
export const BIG_PHONE_WIDTH =
  "w-[min(calc(100vw-2rem),calc((100dvh-7rem)/2.11))] sm:w-[min(calc(100vw-10rem),calc((100dvh-3rem)/2.11))]";

export type BigPhoneProps = {
  /** The asset's title: names the dialog and the frame for assistive tech. */
  title: string;
  /** The same shape the asset is drawn with in place. */
  frame: PhoneFrameShape;
  /** The asset's phone media, mounted afresh. */
  media: ReactNode;
  /** Whether its video plays, and from which second. */
  start: EnlargeStart;
  /** Where focus goes back to on close. */
  opener: HTMLElement | null;
  onClose: () => void;
};

const isElement = (x: unknown): x is HTMLElement =>
  typeof HTMLElement !== "undefined" && x instanceof HTMLElement;

export function BigPhone({ title, frame, media, start, opener, onClose }: BigPhoneProps) {
  const Slot = enlargeSlotContext();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const slot = useMemo<EnlargeSlot>(() => ({ place: "big", start }), [start]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // aria-modal: Tab stays inside the dialog (focus-trap.ts).
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const active = isElement(document.activeElement) ? document.activeElement : null;
      const move = trapTab(
        Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        active,
        e.shiftKey,
        !!active && panel.contains(active),
      );
      if (move.prevent) e.preventDefault();
      move.focus?.focus();
    };
    window.addEventListener("keydown", onKey);
    const body = document.body.style;
    const overflow = body.overflow;
    body.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      body.overflow = overflow;
      // Back to the button that opened it, if it is still on the page.
      if (opener && opener.isConnected) opener.focus();
    };
  }, [onClose, opener]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${title}, enlarged`}
      data-phone-enlarged=""
      // A click on the dark area around the phone closes it; a click on the
      // phone itself is the phone's.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/85 p-4 backdrop-blur-sm motion-safe:animate-fade-in sm:p-6"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
      >
        <X aria-hidden className="h-5 w-5" />
      </button>
      <div className={`${BIG_PHONE_WIDTH} motion-safe:animate-slide-up`}>
        <Slot.Provider value={slot}>
          <PhoneFrame {...frame} label={title}>
            {media}
          </PhoneFrame>
        </Slot.Provider>
      </div>
    </div>,
    document.body,
  );
}
