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

/** Focus a section by id (tabindex -1 if it has none); false when it is not on the page. */
function focusTarget(anchor: string): boolean {
  const target = anchor ? document.getElementById(anchor) : null;
  if (!target) return false;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}

export function OfferNavMenu({ nav }: { nav: DrawnPage["nav"] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  // The panel's room is measured from where it actually starts: an owner's
  // preview banner above the sticky bar pushes it down, and a fixed 100dvh-4rem
  // would then run past the screen (Codex on #665, third pass).
  useEffect(() => {
    if (!open || !panel.current) return;
    const measure = () => {
      const top = panel.current?.getBoundingClientRect().top ?? 0;
      setMaxHeight(Math.max(160, Math.floor(window.innerHeight - top)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // The focused link is about to be hidden: keep focus visible on the button (WCAG 2.4.7).
      trigger.current?.focus();
    };
    // Anything outside the menu closes it: a tap (the Book button, the mark's
    // #top), focus moving out of it, or the page's hash changing. Otherwise the
    // panel stays open over the section a sibling link just went to (Codex on #665).
    const outside = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    // A hash change while a link in the panel has focus (Back, Alt+Left) would
    // hide that link under the focus: carry focus to where the page went.
    const onHash = () => {
      const hadFocus = !!root.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocus && !focusTarget(window.location.hash.slice(1))) trigger.current?.focus();
    };
    // Rotating past md hides this menu with display:none: close it rather than
    // leave a stale open panel, and keep focus on a control that is visible.
    const wide = window.matchMedia("(min-width: 768px)");
    const onWide = () => {
      if (!wide.matches) return;
      const hadFocus = !!root.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocus) document.querySelector<HTMLElement>('header a[href="#book"]')?.focus();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("hashchange", onHash);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("hashchange", onHash);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);


  // A chosen section: close, and put focus on that section once the anchor has
  // scrolled to it, so a keyboard user carries on from there instead of from a
  // link that is no longer on screen (Codex on #665).
  function choose(anchor: string) {
    setOpen(false);
    requestAnimationFrame(() => focusTarget(anchor));
  }

  if (!nav.length) return null;
  return (
    <div ref={root} className="md:hidden">
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
        ref={panel}
        id={panelId}
        aria-label="On this page"
        hidden={!open}
        style={maxHeight ? { maxHeight } : undefined}
        className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-ops-line bg-ops-void/95 px-5 py-2 backdrop-blur-md"
      >
        <ul className="flex flex-col">
          {nav.map((n) => (
            <li key={n.key}>
              <a
                href={`#${n.anchor}`}
                onClick={() => choose(n.anchor)}
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
