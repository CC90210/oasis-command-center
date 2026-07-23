/**
 * Copy text to the clipboard with a graceful fallback.
 *
 * Uses the async Clipboard API on secure origins and falls back to
 * window.prompt() when it's unavailable (insecure origin / older browser)
 * or permission-blocked. Never throws.
 *
 * Returns true when the primary path completed without throwing (async
 * write, or the window.prompt fallback we chose deliberately), false when
 * an exception forced the catch-path fallback. Callers that surface a
 * "Copied" affordance should show it only when this returns true — that
 * preserves the existing behavior across CopyButton and the prompts library.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else if (typeof window !== "undefined") {
      window.prompt("Copy:", value);
    }
    return true;
  } catch {
    try {
      if (typeof window !== "undefined") window.prompt("Copy:", value);
    } catch {
      /* ignore */
    }
    return false;
  }
}
