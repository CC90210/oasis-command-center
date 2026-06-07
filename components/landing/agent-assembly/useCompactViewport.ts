"use client";

import { useEffect, useState } from "react";

/**
 * useCompactViewport — single source of truth for the "is this a phone-
 * sized viewport?" check shared by the scroll scene shell and the WebGL
 * figure. Mirrors the (max-width: 640px) breakpoint baked into the
 * scene's Tailwind classes (`min-[641px]:...`), so any code that needs
 * to fork desktop vs mobile behaviour stays in lockstep with the layout
 * breakpoint. Returns `false` during SSR.
 */
export function useCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isCompact;
}
