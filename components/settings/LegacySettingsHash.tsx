"use client";

/**
 * Forwards an old single-page Settings anchor to the section page it moved to.
 *
 * `/settings#providers` and `/settings#agents` are linked from chat failure
 * states, and `/settings#integrations` is where the Google OAuth callback and
 * the setup checklist land. A fragment never reaches the server, so only the
 * browser can see which one was asked for. The query string comes along
 * (the OAuth callback reports `?gmail_oauth=connected` there), and the target's
 * own OpenSectionOnHash then opens the right section.
 *
 * `targets` is computed on the server from what this viewer may open, so a
 * link to an admin-only section leaves a rep on their own Settings rather than
 * forwarding them to a 404.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LegacySettingsHash({ targets }: { targets: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    function forward() {
      const hash = window.location.hash.slice(1);
      const target = hash ? targets[hash] : undefined;
      if (!target || target === window.location.pathname) return;
      router.replace(`${target}${window.location.search}#${hash}`);
    }
    forward();
    window.addEventListener("hashchange", forward);
    return () => window.removeEventListener("hashchange", forward);
  }, [router, targets]);
  return null;
}
