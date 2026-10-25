"use client";

/**
 * Counts a view of the client's private audit only once the page has been
 * visible for a few seconds. A GET is not a view: mail scanners and link
 * previews open links too, and "Proposal Under Review" must mean a person
 * opened it. One beacon per tab.
 */
import { useEffect } from "react";

const VISIBLE_MS = 4_000;

export function ViewBeacon({ token }: { token: string }) {
  useEffect(() => {
    const key = `oasis-audit-viewed:${token.slice(0, 12)}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
    } catch {
      // Storage blocked: count at most once per page load instead.
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        // Ignore: the server also counts at most one first view.
      }
      void fetch(`/api/your-audit/${encodeURIComponent(token)}/viewed`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true }).catch(() => undefined);
    };
    const arm = () => {
      if (timer || sent) return;
      if (document.visibilityState === "visible") timer = setTimeout(send, VISIBLE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible" && timer) {
        clearTimeout(timer);
        timer = null;
      } else {
        arm();
      }
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [token]);
  return null;
}
