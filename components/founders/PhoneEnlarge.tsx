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
 * TWO MODULES. This one is the part every tile needs on arrival: the state,
 * the slot, the Enlarge button. The big phone itself (the dialog, PhoneFrame
 * for the browser, its icons, the focus trap) is PhoneEnlargeOverlay.tsx. It
 * only exists after a click, which the server never sees, so it is fetched in
 * the browser only - when the pointer or keyboard first reaches a tile, so it
 * is usually there before the press - and the server compile never carries
 * it (with this change the Worker gained no chunk and no async load, CI
 * 2026-10-09). If the fetch fails (offline, or an old page after a deploy),
 * the tile says so instead of doing nothing.
 *
 * The context is made on first use, not at import: React's server build (the
 * react-server condition the page tests run under, which loads this file
 * through marketing-shared) has no createContext.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Context,
  type ReactNode,
} from "react";
import { Maximize2 } from "lucide-react";

import type { PhoneFrameShape } from "@/components/founders/PhoneFrame";
import type { BigPhoneProps } from "@/components/founders/PhoneEnlargeOverlay";

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

type BigPhoneComponent = ComponentType<BigPhoneProps>;

/**
 * The big phone's code, fetched in the browser only.
 *
 * `typeof window` is a build-time constant in Next: "undefined" when the server
 * compiles this client component for server-side rendering. Webpack drops the
 * dead branch without following its import, so the Worker never carries the
 * big phone; it is only ever drawn after a click, which the server never sees.
 * In the browser this is one lazy chunk, fetched once and shared by every tile
 * (the same idiom as three.js in components/marketing/CarStage.tsx, PR #531).
 * Keep the import inside this branch (tests/content-iphone.test.ts).
 */
export function loadBigPhone(): Promise<BigPhoneComponent> {
  return typeof window === "undefined"
    ? Promise.reject(new Error("the big phone draws in the browser only"))
    : import("@/components/founders/PhoneEnlargeOverlay").then((m) => m.BigPhone);
}

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
  const [open, setOpen] = useState<{ start: EnlargeStart; opener: HTMLElement | null } | null>(null);
  const [BigPhone, setBigPhone] = useState<BigPhoneComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const inlineRef = useRef<HTMLDivElement | null>(null);

  // Fetch the big phone's code: when the pointer or keyboard reaches the tile
  // (`pressed` false) and again on the press; the module system fetches it
  // once. A press whose fetch fails is dropped, not kept waiting: otherwise
  // the pointer passing over the tile later, with the network back, would
  // open a big phone nobody asked for. The tile says what happened instead.
  const fetchBigPhone = useCallback(
    (pressed: boolean) => {
      if (BigPhone) return;
      loadBigPhone().then(
        (C) => {
          setBigPhone(() => C);
          setFailed(false);
        },
        (e: unknown) => {
          console.warn("[content:big-phone] could not load", e);
          if (!pressed) return;
          setOpen(null);
          setFailed(true);
        },
      );
    },
    [BigPhone],
  );
  const prefetch = useCallback(() => fetchBigPhone(false), [fetchBigPhone]);

  const enlarge = useCallback(
    (asked: EnlargeStart, opener?: HTMLElement | null) => {
      // A video playing in place carries on in the big phone from the same
      // second, and stops in place so two never play at once.
      const playing = inlineRef.current?.querySelector("video") ?? null;
      const start: EnlargeStart = playing
        ? { play: asked.play || !playing.paused, at: playing.currentTime || 0 }
        : asked;
      if (playing && !playing.paused) playing.pause();
      const active = typeof document === "undefined" ? null : document.activeElement;
      setFailed(false);
      setOpen({ start, opener: opener ?? (isElement(active) ? active : null) });
      fetchBigPhone(true);
    },
    [fetchBigPhone],
  );
  const close = useCallback(() => setOpen(null), []);

  const tileSlot = useMemo<EnlargeSlot>(() => ({ place: "tile", enlarge }), [enlarge]);

  return (
    <Slot.Provider value={tileSlot}>
      <div ref={inlineRef} className={className} onPointerEnter={prefetch} onFocus={prefetch}>
        {children}
        {failed ? (
          <p role="status" className="mt-2 text-[11px] leading-4 text-status-warm">
            Couldn&apos;t open the big phone. Reload the page and try again.
          </p>
        ) : null}
      </div>
      {open && BigPhone ? (
        <BigPhone title={title} frame={frame} media={media} start={open.start} opener={open.opener} onClose={close} />
      ) : null}
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
