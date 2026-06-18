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
