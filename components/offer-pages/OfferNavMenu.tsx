"use client";

/**
 * OfferNavMenu - the offer page's section list on phones (CC 2026-10-16: the
 * nav must take a visitor to the sections; on a phone it showed only the mark
 * and the button, and most ad traffic arrives on phones).
 *
 * A button in the header opens the same anchors the desktop nav draws, in a
 * panel under the bar; choosing one closes it and the browser follows the
 * plain anchor, so the header keeps its height and Section's scroll-mt still
 * clears it. Escape and a second press close it too; Escape puts focus back on
 * the button. The panel scrolls within the screen under the 4rem bar, so every
 * section stays reachable on a short (landscape) phone. md and up never render
 * it: OfferNav's own row is there.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import type { DrawnPage } from "@/lib/offer-pages/visibility";

export function OfferNavMenu({ nav }: { nav: DrawnPage["nav"] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // The focused link is about to be hidden: keep focus visible on the button (WCAG 2.4.7).
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!nav.length) return null;
  return (
    <div className="md:hidden">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close the page sections" : "Open the page sections"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
      </button>
      <nav
        id={panelId}
        aria-label="On this page"
        hidden={!open}
        className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-ops-line bg-ops-void/95 px-5 py-2 backdrop-blur-md"
      >
        <ul className="flex flex-col">
          {nav.map((n) => (
            <li key={n.key}>
              <a
                href={`#${n.anchor}`}
                onClick={() => setOpen(false)}
                className="block py-3 text-[16px] font-medium tracking-[-0.01em] text-fg-muted transition-colors hover:text-fg"
              >
                {n.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
