"use client";

import { useEffect, useState } from "react";

/**
 * Client island for the /desktop-link page. Auto-fires the oasis:// deep
 * link on mount + provides a manual "Open in OASIS Desktop" button as a
 * fallback. Some browsers (Edge with corporate policy, fresh Firefox
 * profiles) prompt before launching custom URL schemes, so the visible
 * button is the user-driven path. Auto-fire just primes the prompt.
 */
export function DesktopLinkClient({
  code,
  deepLink,
  expiresMinutes,
  host,
}: {
  code: string;
  deepLink: string;
  expiresMinutes: number;
  host: string;
}) {
  const [launched, setLaunched] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(expiresMinutes * 60);

  useEffect(() => {
    // Auto-fire the deep link on mount with a 600ms delay so the page has
    // rendered the trust UI (host name, expiry) before the OS prompt
    // appears. Without the delay, Chrome's permission prompt covers a
    // blank-looking page and users dismiss out of confusion.
    const timer = setTimeout(() => {
      try {
        window.location.href = deepLink;
        setLaunched(true);
      } catch {
        /* anchor click fallback below still works */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [deepLink]);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const mm = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
  const ss = (secondsLeft % 60).toString().padStart(2, "0");
  const expired = secondsLeft === 0;

  return (
    <div>
      <a
        href={deepLink}
        className="block w-full text-center bg-accent text-bg-deep font-bold py-3.5 rounded-xl hover:brightness-110 transition-all"
        onClick={() => setLaunched(true)}
      >
        {launched ? "Re-open OASIS Desktop" : "Open in OASIS Desktop"}
      </a>
      <p className="mt-3 text-xs text-fg-mute leading-relaxed text-center">
        Your browser may ask permission to open <span className="text-accent font-mono">oasis://</span> — that&apos;s OASIS Desktop. Approve once and you&apos;re in.
      </p>
      <div className="mt-6 p-4 rounded-xl border border-bg-border bg-bg-deep/50 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-fg-mute uppercase tracking-[0.14em] mb-1">Verified by</div>
          <div className="text-fg font-medium break-all">{host}</div>
        </div>
        <div>
          <div className="text-fg-mute uppercase tracking-[0.14em] mb-1">Code expires in</div>
          <div className={`font-mono font-bold ${expired ? "text-status-hot" : "text-fg"}`}>
            {expired ? "expired — refresh" : `${mm}:${ss}`}
          </div>
        </div>
      </div>
    </div>
  );
}
