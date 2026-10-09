"use client";

/**
 * StickyBookBar - phones only (design 2.5): a "Book" bar pinned to the bottom
 * of the screen once the hero has scrolled away, hidden again while the Book
 * section itself is on screen. Two IntersectionObservers, no scroll handler.
 * Without JavaScript it never appears; the header's Book button is always there.
 */
import { useEffect, useState } from "react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";

export function StickyBookBar({ label }: { label: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const heroEnd = document.getElementById("offer-hero-end");
    const book = document.getElementById("book");
    if (!heroEnd || !book || typeof IntersectionObserver === "undefined") return;
    let pastHero = false;
    let bookOnScreen = false;
    const update = () => setShow(pastHero && !bookOnScreen);
    const heroIo = new IntersectionObserver(([e]) => {
      pastHero = !e.isIntersecting && e.boundingClientRect.top < 0;
      update();
    });
    const bookIo = new IntersectionObserver(
      ([e]) => {
        bookOnScreen = e.isIntersecting;
        update();
      },
      { threshold: 0.05 },
    );
    heroIo.observe(heroEnd);
    bookIo.observe(book);
    return () => {
      heroIo.disconnect();
      bookIo.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden={!show}
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-ops-line bg-ops-void/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-md transition-transform duration-300 md:hidden ${
        show ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <a href="#book" tabIndex={show ? 0 : -1} className={`${CTA_PRIMARY} w-full`}>
        {label}
      </a>
    </div>
  );
}
