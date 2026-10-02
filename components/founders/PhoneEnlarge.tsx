"use client";

/**
 * PhoneEnlarge - any asset in Content, in a big iPhone.
 *
 * CC, 2026-10-01: "make all of these videos that are currently displayed as
 * rectangular shapes into iPhone shapes. Let's get an iPhone template for each
 * of these, and when I click on it and make it big screen, it turns into a big
 * iPhone." The Library has drawn every asset in a phone since W8a; this is the
 * big screen. On 2026-09-30 he asked for the ad to show "as if they were
 * watching that literal ad creative directly on Instagram or TikTok itself",
 * so the big phone is the same PhoneFrame, chrome and all, as tall as the
 * screen allows - not a plain video player.
 *
 * HOW IT IS USED. The caller draws the asset as it sits in place (a Library
 * tile's phone or card, the asset page's preview) as `children`, and hands the
 * media again as `media` for the big phone, with the same frame shape. Inside
 * `children`:
 *   - a Library video's cover (TileVideo) opens the big phone and plays there:
 *     tapping the video IS pressing play, so it is the one press that loads it;
 *   - <EnlargeButton /> opens the big phone and plays nothing.
 * A video already playing in place (the asset page's player) carries on in the
 * big phone from the same second, and is paused in place, so two never play.
 * Both learn where they are from enlargeSlotContext(), not from props: the
 * media is drawn by the server, and a server element cannot carry a callback.
 *
 * NOTHING LOADS UNTIL PLAY. The big phone mounts the caller's media afresh. A
 * Library video there is a cover until its play button is pressed, unless the
 * big phone was opened BY a play press; that rule and its test
 * (tests/library-phone-preview.test.ts) are why the Library opens in seconds,
 * not minutes. Nothing is mounted at all until the phone is opened.
 *
 * KEYBOARD AND FOCUS. A modal dialog. Focus moves to Close when it opens; Tab
 * and Shift+Tab stay inside it (focus-trap.ts, the Connections drawer's trap);
 * Esc, Close and a click outside the phone close it; and focus goes back to the
 * button that opened it - recorded at open, because Safari does not focus a
 * button on click. The page behind does not scroll while it is open. The fade
 * and the rise run only when the viewer has not asked for reduced motion.
 *
 * SIZE. The frame is 2.106 times as tall as it is wide (a 9:19.5 screen inside
 * a bezel of 2.6% of the width on every side), so the tallest phone that fits
 * is the viewport height over 2.11. From `sm` up it takes the full height, with
 * Close beside it; below that it takes the width and leaves room above it for
 * Close. A 1280x800 window: 356 x 751 px. A 390x844 phone: 347 x 731 px.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";

import { PhoneFrame, type PhoneFrameShape } from "@/components/founders/PhoneFrame";
import { FOCUSABLE_SELECTOR, trapTab } from "@/components/os/connections/focus-trap";

/** How the big phone starts: whether its video plays, and from which second. */
export type EnlargeStart = { play: boolean; at: number };

/** Where a player is drawn: in place, able to open the big phone, or in the big phone itself. */
export type EnlargeSlot =
  | { place: "tile"; enlarge: (asked: EnlargeStart, opener?: HTMLElement | null) => void }
  | { place: "big"; start: EnlargeStart };

let slotContext: Context<EnlargeSlot | null> | null = null;

/**
 * The context a player reads its slot from. Made on first use, never at
 * import: React's server build (the react-server condition the page tests run
 * under, which loads this file through marketing-shared) has no createContext.
 */
export function enlargeSlotContext(): Context<EnlargeSlot | null> {
  if (!slotContext) slotContext = createContext<EnlargeSlot | null>(null);
  return slotContext;
}

/**
 * The big phone's width. Two classes, so Tailwind finds both as literal text.
 * Below `sm` 7rem of the height is kept for Close above the phone; from `sm`
 * Close sits beside it and the phone takes all but the padding.
 */
export const BIG_PHONE_WIDTH =
  "w-[min(calc(100vw-2rem),calc((100dvh-7rem)/2.11))] sm:w-[min(calc(100vw-10rem),calc((100dvh-3rem)/2.11))]";

const isElement = (x: unknown): x is HTMLElement =>
  typeof HTMLElement !== "undefined" && x instanceof HTMLElement;

export function PhoneEnlarge({
  title,
  frame,
  media,
  children,
  className,
}: {
  /** The asset's title: names the dialog and the frame for assistive tech. */
  title: string;
  /** The same shape the asset is drawn with in place. */
  frame: PhoneFrameShape;
  /** What the big phone shows: the asset's phone media, mounted afresh on open. */
  media: ReactNode;
  /** The asset as it sits in place, with an EnlargeButton somewhere inside. */
  children: ReactNode;
  className?: string;
}) {
  const Slot = enlargeSlotContext();
  const [start, setStart] = useState<EnlargeStart | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const open = start !== null;

  const enlarge = useCallback((asked: EnlargeStart, opener?: HTMLElement | null) => {
    // A video playing in place carries on in the big phone from the same
    // second, and stops in place so two never play at once.
    const playing = inlineRef.current?.querySelector("video") ?? null;
    const next: EnlargeStart = playing
      ? { play: asked.play || !playing.paused, at: playing.currentTime || 0 }
      : asked;
    if (playing && !playing.paused) playing.pause();
    const active = typeof document === "undefined" ? null : document.activeElement;
    openerRef.current = opener ?? (isElement(active) ? active : null);
    setStart(next);
  }, []);
  const close = useCallback(() => setStart(null), []);

  const tileSlot = useMemo<EnlargeSlot>(() => ({ place: "tile", enlarge }), [enlarge]);
  const bigSlot = useMemo<EnlargeSlot | null>(() => (start ? { place: "big", start } : null), [start]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
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
      const back = openerRef.current;
      openerRef.current = null;
      if (back && back.isConnected) back.focus();
    };
  }, [open, close]);

  const overlay =
    bigSlot && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${title}, enlarged`}
            data-phone-enlarged=""
            // A click on the dark area around the phone closes it; a click on
            // the phone itself is the phone's.
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
            className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/85 p-4 backdrop-blur-sm motion-safe:animate-fade-in sm:p-6"
          >
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
            >
              <X aria-hidden className="h-5 w-5" />
            </button>
            <div className={`${BIG_PHONE_WIDTH} motion-safe:animate-slide-up`}>
              <Slot.Provider value={bigSlot}>
                <PhoneFrame {...frame} label={title}>
                  {media}
                </PhoneFrame>
              </Slot.Provider>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <Slot.Provider value={tileSlot}>
      <div ref={inlineRef} className={className}>
        {children}
      </div>
      {overlay}
    </Slot.Provider>
  );
}

/**
 * The control that opens the big phone without playing anything. `corner`
 * draws it as a round icon over the media (the plain grid's card); otherwise it
 * is a labelled button for a row of controls. Outside a PhoneEnlarge it renders
 * nothing, since there is nothing for it to open.
 */
export function EnlargeButton({ title, corner = false }: { title: string; corner?: boolean }) {
  const slot = useContext(enlargeSlotContext());
  if (slot?.place !== "tile") return null;
  return (
    <button
      type="button"
      onClick={(e) => slot.enlarge({ play: false, at: 0 }, e.currentTarget)}
      aria-haspopup="dialog"
      aria-label={`Enlarge ${title}`}
      title="See it in a big phone"
      className={
        corner
          ? "absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-full bg-bg-deep/80 text-fg-muted ring-1 ring-white/10 transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
          : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border bg-bg-deep/40 px-2.5 py-1 text-[11px] font-semibold text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
      }
    >
      <Maximize2 aria-hidden className="h-3.5 w-3.5" />
      {corner ? null : "Enlarge"}
    </button>
  );
}
