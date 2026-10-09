"use client";

/**
 * ResultsViewer - the evidence wall (design sections 2.3 and 2.5).
 *
 * Every card is a result an owner confirmed, with the client's permission
 * (lib/offer-pages/visibility.ts decides; nothing unconfirmed reaches here).
 * Phones show the first six, then "Show all N". A tap on a screenshot, quote
 * or metric opens a full-screen <dialog>; a video plays in place through its
 * facade. Without JavaScript every card is visible and readable.
 */
import { useRef, useState } from "react";
import type { Aspect } from "@/lib/offer-pages/types";
import { VideoFacade, type FacadeSource } from "./VideoFacade";
import { ACCENT_BORDER, ACCENT_TEXT, DATA_LABEL } from "./styles";

export type ResultCard =
  | { kind: "screenshot"; key: string; imageUrl: string; width: number | null; height: number | null; alt: string; label?: string; who?: string }
  | {
      kind: "video";
      key: string;
      source: FacadeSource;
      posterUrl: string | null;
      aspect: Aspect;
      duration: string;
      label?: string;
      who?: string;
    }
  | { kind: "quote"; key: string; quote: string; who: string; role?: string }
  | { kind: "metric"; key: string; value: string; label: string; source: string };

const PHONE_FIRST = 6;

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className={`inline-block w-fit border ${ACCENT_BORDER} px-2 py-0.5 ${DATA_LABEL} text-[9px] ${ACCENT_TEXT}`}>
      {children}
    </span>
  );
}

function CardBody({ card, large = false }: { card: ResultCard; large?: boolean }) {
  switch (card.kind) {
    case "screenshot":
      return (
        <figure className="flex h-full flex-col gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed private-bucket image */}
          <img
            src={card.imageUrl}
            alt={card.alt}
            {...(card.width && card.height ? { width: card.width, height: card.height } : {})}
            loading="lazy"
            decoding="async"
            className={`w-full rounded-md border border-ops-line bg-ops-panel object-contain ${large ? "max-h-[78vh]" : "aspect-[4/3]"}`}
          />
          {card.label || card.who ? (
            <figcaption className="flex flex-col gap-1.5">
              {card.label ? <Chip>{card.label}</Chip> : null}
              {card.who ? <span className="text-[13px] text-fg-muted">{card.who}</span> : null}
            </figcaption>
          ) : null}
        </figure>
      );
    case "quote":
      return (
        <figure className="flex h-full flex-col justify-between gap-5">
          <blockquote className={`font-display ${large ? "text-2xl" : "text-[17px]"} font-medium leading-snug tracking-tight text-fg`}>
            {card.quote}
          </blockquote>
          <figcaption className="text-[13px] text-fg-muted">
            <span className="font-semibold text-fg">{card.who}</span>
            {card.role ? <span>{` - ${card.role}`}</span> : null}
          </figcaption>
        </figure>
      );
    case "metric":
      return (
        <div className="flex h-full flex-col justify-between gap-4">
          <p className={`font-display ${large ? "text-6xl" : "text-4xl"} font-bold tracking-tight ${ACCENT_TEXT}`}>{card.value}</p>
          <div className="space-y-1.5">
            <p className="text-[15px] font-medium text-fg">{card.label}</p>
            <p className={`${DATA_LABEL} text-[9px] text-fg-dim`}>Source: {card.source}</p>
          </div>
        </div>
      );
    case "video":
      return (
        <div className="flex h-full flex-col gap-3">
          <VideoFacade source={card.source} posterUrl={card.posterUrl} aspect={card.aspect} label={card.label || "Result"} duration={card.duration} />
          {card.label || card.who ? (
            <div className="flex flex-col gap-1.5">
              {card.label ? <Chip>{card.label}</Chip> : null}
              {card.who ? <span className="text-[13px] text-fg-muted">{card.who}</span> : null}
            </div>
          ) : null}
        </div>
      );
  }
}

export function ResultsViewer({ cards }: { cards: ResultCard[] }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<ResultCard | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);

  function openCard(card: ResultCard) {
    setOpen(card);
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }

  function close() {
    dialog.current?.close();
    setOpen(null);
  }

  return (
    <>
      <ul className="mt-12 grid grid-cols-2 gap-px border border-ops-line bg-ops-line lg:grid-cols-3">
        {cards.map((card, i) => (
          <li
            key={card.key}
            className={`bg-ops-void p-4 sm:p-6 ${!showAll && i >= PHONE_FIRST ? "hidden sm:block" : ""} ${
              card.kind === "quote" || card.kind === "video" ? "col-span-2 sm:col-span-1" : ""
            }`}
          >
            {card.kind === "video" ? (
              <CardBody card={card} />
            ) : (
              <button
                type="button"
                onClick={() => openCard(card)}
                className="block h-full w-full text-left transition-opacity hover:opacity-90"
                aria-label={card.kind === "screenshot" ? `Open: ${card.alt}` : "Open full size"}
              >
                <CardBody card={card} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!showAll && cards.length > PHONE_FIRST ? (
        <div className="mt-6 sm:hidden">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full rounded-md border border-ops-edge px-5 py-3 text-[15px] font-medium text-fg-muted hover:text-fg"
          >
            Show all {cards.length}
          </button>
        </div>
      ) : null}
      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
        className="m-auto max-h-[92vh] w-[min(92vw,960px)] overflow-y-auto rounded-xl border border-ops-line bg-ops-void p-6 text-fg backdrop:bg-ops-void/85 sm:p-10"
      >
        {open ? (
          <div className="space-y-6">
            <CardBody card={open} large />
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-ops-edge px-5 py-2.5 text-[14px] font-medium text-fg-muted hover:text-fg"
            >
              Close
            </button>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
