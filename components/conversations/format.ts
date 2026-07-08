/**
 * components/conversations/format.ts — pure formatting/display helpers
 * shared across the inbox component tree (InboxShell, ConversationRow,
 * ContactChip, SegmentCounter, MessageList day dividers). No React, no
 * fetch — safe to import from any client component.
 */

/** "3m" / "2h" / "5d" / "Jun 12" — same vocabulary as the old ConversationsClient. */
export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Display formatter: E.164 "+15551234567" -> "(555) 123-4567". Falls back
 *  to the raw value for anything that doesn't cleanly parse as a US/CA
 *  10-digit number (international numbers just render as-is). */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) {
    return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return raw;
}

/** Day-divider label: "Today" / "Yesterday" / "Wednesday" (within 7 days) /
 *  "Jun 12" / "Jun 12, 2025" (older, cross-year). */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Calendar-day key (local time) for grouping messages into day buckets. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "invalid";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Deterministic hash → HSL avatar color. Same contact always gets the same
 *  color across renders/sessions (no stored color needed). */
export function hashHsl(seed: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    bg: `hsl(${hue}, 45%, 24%)`,
    fg: `hsl(${hue}, 70%, 78%)`,
  };
}

/** First-letter-of-first-two-words initials, uppercased, for the avatar. */
export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* SMS segment counting — GSM-7 vs UCS-2 (Unicode), single vs multipart limits */
/* -------------------------------------------------------------------------- */

// GSM 03.38 default alphabet (basic set) — characters that encode as one
// 7-bit septet each.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// GSM extension table — each of these costs TWO septets (escape + char).
const GSM_EXT = "^{}\\[~]|€";

const GSM_BASIC_SET = new Set(GSM_BASIC.split(""));
const GSM_EXT_SET = new Set(GSM_EXT.split(""));

export type SegmentInfo = {
  encoding: "GSM-7" | "Unicode";
  length: number; // character count
  units: number; // septets (GSM-7) or UTF-16 code units (Unicode)
  segments: number;
  limitPerSegment: number; // for the CURRENT segment count (1 vs multipart)
  remainingInSegment: number;
  hasEmoji: boolean;
  hasSmartPunctuation: boolean;
};

const EMOJI_RE = /\p{Extended_Pictographic}/u;
// Curly quotes / em dash / en dash — common autocorrect artifacts that push
// a GSM-7-eligible message into Unicode encoding (each one, silently, cuts
// the per-segment budget from 160/153 to 70/67).
const SMART_PUNCT_RE = /[‘’“”—–]/;

export function countSegments(text: string): SegmentInfo {
  const hasEmoji = EMOJI_RE.test(text);
  const hasSmartPunctuation = SMART_PUNCT_RE.test(text);
  const isGsm7 = !hasEmoji && [...text].every((ch) => GSM_BASIC_SET.has(ch) || GSM_EXT_SET.has(ch));

  if (isGsm7) {
    const units = [...text].reduce((n, ch) => n + (GSM_EXT_SET.has(ch) ? 2 : 1), 0);
    const segments = units <= 160 ? (units === 0 ? 1 : 1) : Math.ceil(units / 153);
    const limitPerSegment = segments <= 1 ? 160 : 153;
    return {
      encoding: "GSM-7",
      length: text.length,
      units,
      segments: Math.max(1, segments),
      limitPerSegment,
      remainingInSegment: limitPerSegment * Math.max(1, segments) - units,
      hasEmoji,
      hasSmartPunctuation,
    };
  }

  const units = [...text].length; // UTF-16 code-point count (surrogate pairs collapse via spread)
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  const limitPerSegment = segments <= 1 ? 70 : 67;
  return {
    encoding: "Unicode",
    length: text.length,
    units,
    segments: Math.max(1, segments),
    limitPerSegment,
    remainingInSegment: limitPerSegment * Math.max(1, segments) - units,
    hasEmoji,
    hasSmartPunctuation,
  };
}
