"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

/**
 * Scroll-reveal wrapper.
 *
 * One IntersectionObserver per instance, disconnected the moment it fires —
 * these are one-shot entrances, so keeping observers alive for the life of
 * the page buys nothing and costs main-thread work on every scroll.
 *
 * The hidden start state lives in marketing.css behind `.js`, not here, so
 * a visitor without JavaScript never gets an invisible page. This component
 * only adds the class that ends the animation.
 *
 * Reduced motion short-circuits before the observer is created: the CSS
 * already neutralises the transition, and there is no reason to run an
 * observer whose only job is to trigger an animation that will not play.
 */
export function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  as?: ElementType;
  /** Stagger, in ms. Applied via a CSS custom property, not a timer. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }

    // Already in view on load (above the fold): reveal immediately rather
    // than waiting for a scroll that may never come on a short page.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={`m-reveal ${shown ? "is-in" : ""} ${className}`}
      style={delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
