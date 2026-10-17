/**
 * components/meet/clipboard.ts - copy a meeting link. lib/clipboard.ts falls back to window.prompt(), which
 * Oasis Meet's screens never use, so this one tells the caller when the copy did not work and the screen shows
 * the link to copy by hand instead. Never throws. ASCII only.
 */

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.top = "0";
  box.style.opacity = "0";
  document.body.appendChild(box);
  try {
    box.select();
    box.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove();
  }
}

/** True when the text is on the clipboard. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not allowed here (an insecure page, or the browser said no): try the older way.
  }
  return legacyCopy(text);
}
