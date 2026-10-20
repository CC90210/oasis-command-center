/**
 * notify/telegram-format.ts — pure formatting helpers for Telegram messages.
 *
 * Deliberately free of `server-only` + any network/secret code so message
 * builders that use it stay unit-testable. The actual sender lives in
 * telegram.ts (server-only).
 */

/** Escape the three chars Telegram's HTML parse_mode treats as markup. Always
 *  run user-supplied substrings (names, free-text answers) through this. */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram's limit on one message's text. */
export const TELEGRAM_TEXT_MAX = 4096;

/**
 * `s` cut to `max` whole characters, with `marker` after it when it was cut.
 * Whole characters, not UTF-16 units: slice() and lib/fmt.ts truncate can
 * leave half an emoji (a lone surrogate, which is not valid text, and Telegram
 * refuses the message). Plain text: escape after, never before.
 */
export function clipText(s: string, max: number, marker = ""): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}${marker}` : s;
}

/**
 * A user-supplied value cut to at most `max` characters, then escaped: the cut
 * comes first, so it can never land inside an escape ("&am"), and it counts
 * whole characters (clipText). Trimmed first, as the alert builders always did.
 */
export function clipAndEscape(s: string, max: number): string {
  return escapeTelegramHtml(clipText(s.trim(), max));
}

/**
 * One message's HTML, fitted to `max` characters without breaking its markup.
 *
 * Cut at a fixed length, a message could end inside an escape ("&am"), inside
 * a tag ("<a hr"), between the halves of an emoji, or with a tag left open.
 * Telegram's HTML parse mode refuses each of those outright ("can't parse
 * entities"), so the whole alert was lost, not just its tail. The cut now
 * backs off to before any unfinished escape or tag, never splits an emoji,
 * ends with "…", and closes the tags still open, innermost first, all within
 * `max`. A message within `max` is returned unchanged.
 */
export function fitTelegramHtml(text: string, max: number = TELEGRAM_TEXT_MAX): string {
  if (text.length <= max) return text;
  const ELLIPSIS = "…";
  let budget = max - ELLIPSIS.length;
  for (;;) {
    let cut = text.slice(0, Math.max(0, budget));
    const tag = cut.lastIndexOf("<");
    if (tag > cut.lastIndexOf(">")) cut = cut.slice(0, tag);
    const amp = cut.lastIndexOf("&");
    if (amp >= 0 && !cut.includes(";", amp)) cut = cut.slice(0, amp);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    const open: string[] = [];
    for (const m of cut.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*>/g)) {
      const name = m[2].toLowerCase();
      if (!m[1]) open.push(name);
      else {
        const at = open.lastIndexOf(name);
        if (at >= 0) open.splice(at, 1);
      }
    }
    const fitted = cut + ELLIPSIS + open.reverse().map((name) => `</${name}>`).join("");
    if (fitted.length <= max || budget <= 0) return fitted;
    budget -= fitted.length - max;
  }
}
