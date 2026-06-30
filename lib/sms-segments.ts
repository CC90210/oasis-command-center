/**
 * lib/sms-segments.ts — GSM-7 / UCS-2 SMS segment counting.
 *
 * Pure + dependency-free so it's unit-testable and importable from both client
 * compose widgets and server routes. Drives the Text Torrent pre-send credit
 * estimate (credits = recipients × 3 × segments) and the cold-outreach SMS
 * counter. Carrier rules:
 *   - GSM-7:  ≤160 septets = 1 segment, else 153 septets/segment.
 *   - UCS-2:  ≤70 UTF-16 units = 1 segment, else 67 units/segment.
 *   - GSM-7 extension chars ( ^ { } \ [ ~ ] | € and form-feed ) cost 2 septets.
 *   - Any char outside the GSM-7 set forces the whole message to UCS-2.
 */

// GSM 03.38 basic set (1 septet each), including LF (0x0A) and CR (0x0D),
// skipping the ESC marker (0x1B). Order follows the standard code table.
const GSM7_BASIC = new Set(
  ("@£$¥èéùìòÇ\nØø\rÅå" +
    "Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
    " !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
    "¿abcdefghijklmnopqrstuvwxyzäöñüà").split(""),
);

// GSM-7 extension chars — reachable only via ESC, so they cost 2 septets each.
const GSM7_EXT = new Set("\f^{}\\[~]|€".split(""));

export type SmsEncoding = "GSM-7" | "UCS-2";

/** GSM-7 if every char is encodable in GSM 03.38 (basic or extension); else UCS-2. */
export function detectEncoding(text: string): SmsEncoding {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXT.has(ch)) return "UCS-2";
  }
  return "GSM-7";
}

/** Septet weight of a GSM-7 string (extension chars = 2). */
function gsm7Septets(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXT.has(ch) ? 2 : 1;
  return n;
}

/** Number of SMS segments the message splits into. Empty text → 0. */
export function countSegments(text: string): number {
  if (!text) return 0;
  if (detectEncoding(text) === "GSM-7") {
    const septets = gsm7Septets(text);
    if (septets <= 160) return 1;
    return Math.ceil(septets / 153);
  }
  // UCS-2 counts UTF-16 code units (an emoji = 2). Segment splits don't break
  // surrogate pairs in practice; the unit count is what carriers bill on.
  const units = text.length;
  if (units <= 70) return 1;
  return Math.ceil(units / 67);
}

export type SmsSegmentInfo = {
  encoding: SmsEncoding;
  /** GSM-7: septet weight; UCS-2: UTF-16 code-unit count. */
  length: number;
  segments: number;
  /** Chars allowed in a single segment for this encoding. */
  singleLimit: number;
};

/** Full breakdown for compose widgets. */
export function segmentInfo(text: string): SmsSegmentInfo {
  const encoding = detectEncoding(text);
  const length = encoding === "GSM-7" ? gsm7Septets(text) : text.length;
  return {
    encoding,
    length,
    segments: countSegments(text),
    singleLimit: encoding === "GSM-7" ? 160 : 70,
  };
}
