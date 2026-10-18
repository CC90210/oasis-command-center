"use client";

/**
 * components/meet/useStartsLine.ts - "Your call starts at 2:00 PM." for the person on the pre-join screen or in the
 * waiting lobby of a meeting made for a time (components/meet/meet-format.ts startsLine).
 *
 * The server cannot know the viewer's time zone or clock, so the line is worked out in the browser once the page is
 * drawn: the server's markup and the first paint carry none (null), and nothing disagrees at hydration. While the line
 * is up it is looked at again, so it goes the moment the room opens and its date turns over at midnight.
 */

import { useEffect, useState } from "react";
import { EARLY_START_MIN, englishLocaleOf, startsLine } from "./meet-format";

/** The longest the line goes unchecked: the room opening and midnight both change what it says. */
const LOOK_AGAIN_MS = 30_000;

export function useStartsLine(startsAt: string | null): string | null {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    if (!startsAt) {
      setLine(null);
      return;
    }
    const locale = englishLocaleOf(navigator.languages?.length ? navigator.languages : [navigator.language ?? ""]);
    const opensAt = Date.parse(startsAt) - EARLY_START_MIN * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const now = Date.now();
      const next = startsLine(startsAt, now, { locale });
      setLine(next);
      // While it is up: look again within half a minute, sooner if the room opens before that.
      if (next !== null) timer = setTimeout(look, Math.min(LOOK_AGAIN_MS, Math.max(1_000, opensAt - now)));
    };
    look();
    return () => clearTimeout(timer);
  }, [startsAt]);
  return line;
}
