/**
 * lib/ai-audit/transcript.ts — a discovery call's transcript as numbered lines.
 *
 * Three ways in, one shape out:
 *   - pasted text or a .txt file ("Speaker: words", with or without a time);
 *   - a .vtt (WebVTT) or .srt caption file, which every meeting tool exports;
 *   - an Oasis Meet transcript (meet_transcripts.lines_json), already timed.
 *
 * Every line gets a number from 1, so an extracted fact can say exactly which
 * lines it came from and code can check that its quote is really there.
 *
 * CREDENTIALS ARE TAKEN OUT ON THE WAY IN, AS FAR AS CODE CAN TELL. A client
 * who reads out a password on a call has made a mistake; storing it would make
 * ours permanent. The value after a label such as "password", "PIN", "security
 * code", "API key", "account number" or "SIN" (also when the label ends one
 * line or caption and the value starts the next), and anything shaped like a
 * card number, a key or a token, is replaced with a marker before the
 * transcript is stored, hashed or shown to any model. Talk ABOUT passwords
 * ("our login is slow", "passwords are a pain, we reset 40 a month") is kept:
 * the audit needs it. No scrub catches every way a person can say a secret, so
 * CC reads the stored lines before he authorizes them (the transcript viewer),
 * and the handbook tells him to stop a client who starts reading one out.
 *
 * PURE: no I/O, no clock. The hash is taken by the store, over these lines.
 */

export const TRANSCRIPT_MAX_BYTES = 500_000;
export const TRANSCRIPT_MAX_LINES = 20_000;
export const LINE_MAX_CHARS = 2_000;
export const SPEAKER_MAX_CHARS = 60;
/** Characters of numbered transcript per extraction window (plan section 4). */
export const WINDOW_CHARS = 12_000;

export const TRANSCRIPT_FORMATS = ["txt", "vtt", "srt", "meet"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];
export function isOneOfFormat(v: unknown): v is TranscriptFormat {
  return typeof v === "string" && (TRANSCRIPT_FORMATS as readonly string[]).includes(v);
}
export const UPLOAD_EXTENSIONS = [".txt", ".vtt", ".srt"] as const;

export type TranscriptLine = {
  /** 1-based line number. */
  n: number;
  /** "hh:mm:ss" from the start of the call (or of the transcript, for clock times), when the source had times. */
  t: string | null;
  speaker: string | null;
  text: string;
};

export type ParsedTranscript = {
  format: TranscriptFormat;
  lines: TranscriptLine[];
  speakers: string[];
  chars: number;
  /** How many credential-like pieces were taken out. */
  redactions: number;
};

export type ParseError = "empty" | "too_large" | "too_many_lines" | "unsupported_type";

export const CREDENTIAL_MARKER = "[removed: possible password or account detail]";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * What a label introduces, which decides what may follow it as a value:
 *   password  a mixed token, 3+ digits, or (after "is", ":" and the like) a plain word or a spoken passphrase;
 *   code      3+ digits, spoken or written, or a mixed token (PIN, CVV, door code);
 *   number    5+ digits (card, bank, SIN, social security);
 *   token     a mixed token of 8+ characters, or 8+ digits (API key, client secret);
 *   pass      a mixed token only ("the pass is hunter2", never "the pass rate").
 */
type ValueKind = "password" | "code" | "number" | "token" | "pass";
const KINDS: readonly ValueKind[] = ["password", "code", "number", "token", "pass"];

/** The labels, one capture group per kind, in KINDS order. */
const LABEL = new RegExp(
  [
    String.raw`(\bpass(?:word|code|phrase)s?\b|\bpass\s+(?:word|code|phrase)s?\b|\bpasswd\b|\bpwd\b|\bpw\b)`,
    String.raw`(\bpin(?:\s+(?:numbers?|codes?))?\b|\bpins\b|\bcv[vc]2?\b|\bcsc\b|\bsecurity\s+(?:codes?|answers?|questions?(?:\s+answers?)?)\b|\b(?:one[\s-]?time|verification|confirmation|2fa|two[\s-]factor|mfa|recovery|backup|door|alarm|gate|lock|safe|garage|entry|access)\s+codes?\b|\botp\b)`,
    String.raw`(\b(?:credit\s+|debit\s+)?card\s+numbers?\b|\bcard\b|\baccount\s+(?:numbers?\b|no\b\.?|#)|\bacct\s*(?:numbers?\b|no\b\.?|#)|\b(?:routing|transit|institution)\s+numbers?\b|\bbank\s+account(?:\s+numbers?)?\b|\bsin(?:\s+numbers?)?\b|\bsocial\s+(?:insurance|security)(?:\s+numbers?)?\b|\bssn\b|\bsocial\b)`,
    String.raw`(\b(?:auth(?:entication|orization)?|access|refresh|bearer|api|session|bot|app|integration|personal\s+access)\s+tokens?\b|\btokens?\b|\bapi[\s_-]?keys?\b|\bapikeys?\b|\b(?:secret|private|license|licence)[\s_-]?keys?\b|\bclient[\s_-]?secrets?\b|\bsecrets?\b)`,
    String.raw`(\bpass\b)`,
  ].join("|"),
  "gi",
);

/** What joins a label to its value: "is", "was", "'s", ":", "=", " - ", "would be". */
const JOINER = /[ \t]*(?:['\u2019]s\b[ \t]*:?|=|:|-(?=\s)|[\u2013\u2014]|(?:is|was|are|were)\b(?:[ \t]+(?:just|actually|still|now|basically|simply|literally|currently)\b)?[ \t]*[:-]?|(?:would|will|should)[ \t]+be\b)[ \t]*/iy;
/** A word between the label and its joiner: "the password FOR THE PORTAL is ...". Letters only, so it never swallows the value or crosses punctuation. */
const FILLER = /[ \t]+([A-Za-z][A-Za-z'\u2019]*)(?=[ \t:=]|$)/y;
const MAX_FILLER = 6;
/**
 * A filler must start like "for the portal", "on the back" or "we use
 * everywhere". "The password RESET volume is 400" starts with a noun: the label
 * only describes another thing, and its "value" is a business figure.
 */
const FILLER_STARTS = new Set(["for", "to", "on", "of", "at", "in", "into", "with", "from", "we", "i", "you", "they", "he", "she", "that", "which", "our", "my", "your", "their", "his", "her", "it", "we've", "i've", "you've", "we'd", "i'd"]);

/** Words people use to talk about a password, never the password: "passwords are A pain", "the PIN is ON a sticky note". */
const COMMON = new Set(
  (
    "a an the on in at by for to of from with without not never always usually often sometimes really very too so just still also only already " +
    "either both each every any all some most many few no none same different shared stored saved kept written taped stuck posted listed reset " +
    "changed expired expiring locked lost forgotten missing unknown known given sent emailed texted printed required needed managed handled set " +
    "generated random simple easy hard difficult weak strong secure insecure long short complicated complex annoying painful fine ok okay good bad " +
    "terrible great broken slow fast new old default temporary generic personal private public something nothing anything everything somewhere " +
    "everywhere what where how who which that this these those it its them they we our my your their his her being been getting going like about " +
    "around pretty quite super honestly basically actually probably maybe definitely mostly mine yours ours theirs there here now then when if " +
    "because and but or nor yet as than more less much why um uh eh yeah yes nope right sure true false case sensitive numeric numbers letters " +
    "digits characters chars words rotated updated synced linked connected attached tied owned controlled used reused recycled identical similar " +
    "unique separate individual centralized wait hold stop sorry hmm well one two three four five six seven eight nine ten"
  ).split(" "),
);
/** Words that end a spoken passphrase: "my password is blue falcon AND ...". */
const STOP = new Set(["and", "but", "so", "or", "then", "okay", "ok", "right", "which", "because", "if", "for", "to", "um", "uh", "yeah", "alright", "please", "thanks", "that", "i", "we", "you", "it", "is", "was", "are"]);

const MIN_DIGITS: Readonly<Record<ValueKind, number>> = { password: 3, code: 3, number: 5, token: 8, pass: 99 };
const DIGIT_RUN = /\d(?:[ .\/-]?\d)*/y;
const SPOKEN_DIGIT = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const SPOKEN_RUN = new RegExp(`${SPOKEN_DIGIT}(?:[ \\t,.-]+${SPOKEN_DIGIT})*\\b`, "iy");
const TOKEN = /[^\s]+/y;
const TRAILING_PUNCT = /[.,;:!?)"'\u2019\u201D]+$/;

/** A token that is not a word: letters with digits ("hunter2"), letters or digits with symbols ("p@ss!"), or one long run ("8f3a9c1d..."). */
function looksSecret(tok: string): boolean {
  if (/\d/.test(tok) && /\p{L}/u.test(tok)) return true;
  if (/[!@#$%^&*_+=~|<>{}[\]\\/]/.test(tok) && /[\p{L}\d]/u.test(tok)) return true;
  return tok.length >= 16 && /^[A-Za-z0-9_\-+/=.]+$/.test(tok);
}

/** After a label: its joiner (skipping a few filler words), or where a value would follow it directly. */
function afterLabel(s: string, at: number): { at: number; joined: boolean } {
  let pos = at;
  for (let i = 0; i <= MAX_FILLER; i++) {
    JOINER.lastIndex = pos;
    if (JOINER.exec(s)) return { at: JOINER.lastIndex, joined: true };
    if (i === MAX_FILLER) break;
    FILLER.lastIndex = pos;
    const f = FILLER.exec(s);
    if (!f) break;
    const w = f[1].toLowerCase();
    if (i === 0 && !FILLER_STARTS.has(w)) break;
    pos = FILLER.lastIndex;
  }
  return { at, joined: false };
}

/** The value a label introduces, "end" when the line ends first (the value is on the next line), or null when what follows is no secret. */
function readValue(s: string, at: number, kind: ValueKind, joined: boolean): { start: number; end: number } | "end" | null {
  let i = at;
  while (i < s.length && /[ \t"'\u2018\u201C(]/.test(s[i])) i++;
  if (i >= s.length) return "end";
  const start = i;

  DIGIT_RUN.lastIndex = i;
  const d = DIGIT_RUN.exec(s);
  if (d && !/\p{L}/u.test(s[DIGIT_RUN.lastIndex] ?? "")) {
    return d[0].replace(/\D/g, "").length >= MIN_DIGITS[kind] ? { start, end: DIGIT_RUN.lastIndex } : null;
  }
  if (kind !== "token" && kind !== "pass") {
    SPOKEN_RUN.lastIndex = i;
    const w = SPOKEN_RUN.exec(s);
    if (w && w[0].split(/[^a-z]+/i).filter(Boolean).length >= MIN_DIGITS[kind]) return { start, end: SPOKEN_RUN.lastIndex };
  }

  TOKEN.lastIndex = i;
  const t = TOKEN.exec(s);
  if (!t) return null;
  let tok = t[0];
  let end = TOKEN.lastIndex;
  const trail = tok.match(TRAILING_PUNCT);
  if (trail) {
    tok = tok.slice(0, -trail[0].length);
    end -= trail[0].length;
  }
  if (!tok) return null;
  if (looksSecret(tok)) {
    if (kind === "number") return null;
    if (kind === "token" && tok.length < 8) return null;
    if (kind === "pass" && tok.length < 4) return null;
    return { start, end };
  }
  if (kind !== "password" || !joined) return null;
  // A plain word after "password is": the password itself, unless it is a word people use to talk about one.
  if (!/^[\p{L}'\u2019-]+$/u.test(tok) || COMMON.has(tok.toLowerCase())) return null;
  // ... and the words after it, for a passphrase read out loud ("blue falcon river").
  let last = end;
  let words = 1;
  let stopped = !!trail;
  while (words < 4 && !stopped) {
    const m = /^[ \t]+([\p{L}'\u2019-]+)([.,;:!?)"'\u2019\u201D]*)/u.exec(s.slice(last));
    if (!m) break;
    const w = m[1].toLowerCase();
    if (STOP.has(w) || (COMMON.has(w) && !/^(?:one|two|three|four|five|six|seven|eight|nine|ten)$/.test(w))) break;
    last += m[0].length - m[2].length;
    words += 1;
    stopped = !!m[2];
  }
  return { start, end: last };
}

/** Shapes that are secrets whatever surrounds them. */
const SHAPES: RegExp[] = [
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g, // Stripe
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\b(?:sk|key)-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style and similar
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bshp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32}\b/g, // Shopify
  /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{16,}/g, // an Authorization header's value
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, // PEM, to the line's end when cut
  /\b[0-9a-fA-F]{32,}\b/g, // long hex: API keys, webhook secrets
  /\b\d{3}-\d{2}-\d{4}\b/g, // a US social security number
  new RegExp(`\\b${SPOKEN_DIGIT}(?:[ \\t,.-]+${SPOKEN_DIGIT}){11,}\\b`, "gi"), // a card read out, digit by digit
];
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?!.*-----END [A-Z0-9 ]*PRIVATE KEY-----)/;
const BASE64_LINE = /^[A-Za-z0-9+/=]{20,}$/;

/** 13 to 19 digits, spaces, dashes or dots between them, that pass the Luhn check. */
const CARD = /\b(?:\d[ .-]?){12,18}\d\b/g;
/** A Canadian SIN written in groups: "046 454 286" (Luhn-checked). */
const SIN_GROUPED = /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A run of 24+ letters and digits with lower case, upper case and a digit: a key, not a word ("MIIEvQIBADANBgkqhkiG9w0..."). */
function mixedRuns(s: string, cuts: Array<[number, number]>): void {
  for (const m of s.matchAll(/[A-Za-z0-9_-]{24,}/g)) {
    const w = m[0];
    if (/\d/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w)) cuts.push([m.index ?? 0, (m.index ?? 0) + w.length]);
  }
}

/** Replace the cut spans (merged where they overlap) with the marker. */
function applyCuts(s: string, cuts: Array<[number, number]>): { text: string; hits: number } {
  if (!cuts.length) return { text: s, hits: 0 };
  const sorted = [...cuts].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([c[0], c[1]]);
  }
  let out = "";
  let pos = 0;
  for (const [a, b] of merged) {
    out += s.slice(pos, a) + CREDENTIAL_MARKER;
    pos = b;
  }
  return { text: out + s.slice(pos), hits: merged.length };
}

/** One line. `carry` is a label the previous line ended on, still waiting for its value. */
function scrubLine(s: string, carry: ValueKind | null): { text: string; hits: number; pending: ValueKind | null; pemOpen: boolean } {
  const cuts: Array<[number, number]> = [];
  let pending: ValueKind | null = null;
  if (carry) {
    const v = readValue(s, 0, carry, true);
    if (v && v !== "end") cuts.push([v.start, v.end]);
  }
  LABEL.lastIndex = 0;
  for (let m = LABEL.exec(s); m; m = LABEL.exec(s)) {
    const kind = KINDS[m.slice(1).findIndex((g) => g !== undefined)] ?? "password";
    const after = afterLabel(s, m.index + m[0].length);
    const v = readValue(s, after.at, kind, after.joined);
    if (v === "end") {
      if (after.joined) pending = kind;
      continue;
    }
    if (v) {
      cuts.push([v.start, v.end]);
      LABEL.lastIndex = Math.max(LABEL.lastIndex, v.end);
    }
  }
  for (const re of SHAPES) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of s.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of s.matchAll(SIN_GROUPED)) {
    if (luhn(m[0].replace(/\D/g, ""))) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  mixedRuns(s, cuts);
  const done = applyCuts(s, cuts);
  return { ...done, pending, pemOpen: PEM_OPEN.test(s) };
}

/** A card number read across two lines ("4111 1111" / "1111 1111"): both halves go. */
function joinSplitCards(out: string[]): number {
  let hits = 0;
  for (let i = 1; i < out.length; i++) {
    const tail = out[i - 1].match(/(\d[\d .-]*\d)\s*$/);
    const head = out[i].match(/^\s*(\d[\d .-]*\d)/);
    if (!tail || !head) continue;
    const digits = (tail[1] + head[1]).replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
    out[i - 1] = out[i - 1].slice(0, tail.index) + CREDENTIAL_MARKER;
    out[i] = CREDENTIAL_MARKER + out[i].slice((head.index ?? 0) + head[0].length);
    hits += 2;
  }
  return hits;
}

/**
 * Scrub consecutive lines (a transcript's, or a note's), carrying what one
 * line leaves open into the next: a label at a line's end, a private key's
 * body, a card number cut in two.
 */
export function scrubTexts(texts: readonly string[]): { texts: string[]; hits: number } {
  const out: string[] = [];
  let hits = 0;
  let carry: ValueKind | null = null;
  let pem = false;
  for (const raw of texts) {
    if (pem && BASE64_LINE.test(raw.trim())) {
      out.push(CREDENTIAL_MARKER);
      hits += 1;
      continue;
    }
    pem = false;
    const r = scrubLine(raw, carry);
    carry = r.pending;
    pem = r.pemOpen;
    hits += r.hits;
    out.push(r.text);
  }
  hits += joinSplitCards(out);
  return { texts: out, hits };
}

/** Remove credential-like text from one piece of text (lines kept). Returns the scrubbed text and how many pieces went. */
export function scrubCredentials(text: string): { text: string; hits: number } {
  const r = scrubTexts(text.split(/\r\n|\r|\n/));
  return { text: r.texts.join("\n"), hits: r.hits };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function formatFor(filename: string | null | undefined, text: string): TranscriptFormat | null {
  const name = (filename ?? "").toLowerCase().trim();
  if (name) {
    if (name.endsWith(".vtt")) return "vtt";
    if (name.endsWith(".srt")) return "srt";
    if (name.endsWith(".txt")) return "txt";
    return null;
  }
  const head = text.replace(/^\uFEFF/, "").trimStart();
  if (/^WEBVTT\b/.test(head)) return "vtt";
  if (/^\d+\s*(?:\r\n|\r|\n)\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return "srt";
  return "txt";
}

const pad2 = (x: number) => String(x).padStart(2, "0");
const hms = (total: number) => `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;

/** "01:02:03.456" / "1:02:03,456" / "02:03.4": time from the start, "01:02:03". */
function clock(raw: string): string | null {
  const m = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?$/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (min > 59 || s > 59) return null;
  return `${pad2(h)}:${pad2(min)}:${pad2(s)}`;
}

/** "10:32 AM": seconds since midnight. */
function wallSeconds(raw: string, ampm: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d{1,3})?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h < 1 || h > 12 || min > 59 || s > 59) return null;
  if (h === 12) h = 0;
  if (/^p/i.test(ampm)) h += 12;
  return h * 3600 + min * 60 + s;
}

/** Clock times ("10:32 AM") become times from the transcript's first clock time. */
type ClockBase = { base: number | null };
function stamp(raw: string, ampm: string | undefined, ref: ClockBase): string | null {
  if (!ampm) return clock(raw);
  const secs = wallSeconds(raw, ampm);
  if (secs === null) return null;
  if (ref.base === null) ref.base = secs;
  return hms((secs - ref.base + 86_400) % 86_400);
}

function cleanSpeaker(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, SPEAKER_MAX_CHARS);
}

/** Words that start a sentence or a note, never a name: "The first thing:", "Honestly:", "Note:". */
const NOT_SPEAKERS = new Set(
  (
    "the a an so and but or note notes also first second third then next finally here there this that these those what why how when where who " +
    "well okay ok yes no honestly basically actually anyway seriously frankly look listen right sure exactly absolutely step example eg ie ps re " +
    "fyi http https www update summary agenda todo important warning tip question answer action item items reminder because if"
  ).split(" "),
);
/** A label that introduces an account detail, never a speaker: "Password: ...", "Login: ...", "PIN: ...". */
const CREDENTIAL_LABEL = /\b(?:pass(?:word|code|phrase)?s?|passwd|pwd|pw|pins?|cv[vc]2?|csc|logins?|user ?names?|users?|e-?mails?|tokens?|secrets?|keys?|api|codes?|cards?|accounts?|acct|sin|ssn|social|otp|2fa|mfa)\b/i;
const ROLE = /^(?:speaker|interviewer|interviewee|host|guest|client|customer|caller|agent|rep|me|you|unknown)(?:\s+\d+)?$/i;

/**
 * A speaker's name before a colon: one to four capitalised words ("Dana Lee",
 * "Dr. Smith", "Speaker 1", "CC"), or a role. `afterTime`: the line began with
 * a timestamp ("[0:32] dana: ..." as Oasis Meet copies it), which makes a name
 * likely enough that lower case is accepted.
 */
export function speakerLabel(raw: string, afterTime = false): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s.length > 40) return null;
  const words = s.split(" ");
  if (words.length > 4) return null;
  if (NOT_SPEAKERS.has(s.toLowerCase().replace(/[.']/g, "")) || NOT_SPEAKERS.has(words[0].toLowerCase().replace(/[.']/g, ""))) return null;
  if (CREDENTIAL_LABEL.test(s)) return null;
  if (!afterTime && !ROLE.test(s) && !words.every((w) => /^[\p{Lu}\d(]/u.test(w))) return null;
  return s.slice(0, SPEAKER_MAX_CHARS);
}

/** "Speaker: words" at the start of a text line; speakerLabel decides whether it is a speaker. */
const SPEAKER_PREFIX = /^([^\s:\[(][^:]{0,40}?)[ \t]*:[ \t]+(\S.*)$/;
const AMPM = String.raw`([AaPp]\.?[Mm]\.?)`;
const TIME = String.raw`((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)`;
/** "[10:32 AM] ...", "(00:12:03) ...": a time in brackets. */
const BRACKET_TIME = new RegExp(String.raw`^[[(][ \t]*${TIME}[ \t]*${AMPM}?[ \t]*[\])][ \t]*(?:[-|${"\u2013"}][ \t]*)?`);
/** "00:12:03 ...": three parts, so a time. */
const LONG_TIME = new RegExp(String.raw`^(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)[ \t]*${AMPM}?(?:[ \t]+[-|${"\u2013"}])?(?:[ \t]+|$)`);
/** "12:03 - ...": two parts, then a separator. */
const SHORT_TIME_SEP = new RegExp(String.raw`^(\d{1,2}:\d{2})[ \t]*${AMPM}?[ \t]+[-|${"\u2013"}][ \t]+`);
/** "12:03 Dana: ...": two parts, then a speaker (checked). "9:00 to 5:00 weekdays" stays text. */
const SHORT_TIME = new RegExp(String.raw`^(\d{1,2}:\d{2})[ \t]*${AMPM}?[ \t]+`);
/**
 * "Dana Lee  0:32" on its own line (Otter's export: two spaces or a tab before
 * the time): who speaks next, and when. One space is ordinary text ("Monday 9:00").
 */
const NAME_THEN_TIME = new RegExp(String.raw`^(.{1,40}?)(?: {2,}|\t)[ \t]*${TIME}$`);

function timePrefix(line: string, ref: ClockBase): { t: string; rest: string } | null {
  for (const re of [BRACKET_TIME, LONG_TIME, SHORT_TIME_SEP]) {
    const m = line.match(re);
    if (!m) continue;
    const t = stamp(m[1], m[2], ref);
    if (t) return { t, rest: line.slice(m[0].length).trim() };
  }
  const m = line.match(SHORT_TIME);
  if (m) {
    const rest = line.slice(m[0].length).trim();
    const sp = rest.match(SPEAKER_PREFIX);
    if (sp && speakerLabel(sp[1])) {
      const t = stamp(m[1], m[2], ref);
      if (t) return { t, rest };
    }
  }
  return null;
}

type RawLine = { t: string | null; speaker: string | null; text: string };

function parseTxt(text: string): RawLine[] {
  const out: RawLine[] = [];
  const ref: ClockBase = { base: null };
  let speaker: string | null = null;
  let held: string | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const head = line.match(NAME_THEN_TIME);
    if (head) {
      const who = speakerLabel(head[1]);
      const at = clock(head[2]);
      if (who && at) {
        speaker = who;
        held = at;
        continue;
      }
    }
    let t: string | null = null;
    const time = timePrefix(line, ref);
    if (time) {
      t = time.t;
      line = time.rest;
      if (!line) {
        held = t;
        continue;
      }
    }
    const sp = line.match(SPEAKER_PREFIX);
    const who = sp ? speakerLabel(sp[1], !!time) : null;
    if (sp && who) {
      speaker = who;
      line = sp[2].trim();
    }
    out.push({ t: t ?? held, speaker, text: line });
    held = null;
  }
  return out;
}

/** Strip caption markup: {\an8}, <v Name>, <c.color>, <00:00:01.000>, <b>, &amp; and friends. */
function stripCueMarkup(s: string): { text: string; speaker: string | null } {
  let speaker: string | null = null;
  const voice = s.match(/<v(?:\.[^\s>]+)*\s+([^>]+)>/);
  if (voice) speaker = voice[1];
  const text = s
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  return { text, speaker };
}

function parseCues(text: string, format: "vtt" | "srt"): RawLine[] {
  const out: RawLine[] = [];
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    if (!rows.length) continue;
    // NOTE, STYLE and REGION blocks carry no speech. The WEBVTT header may run
    // straight into the first cue with no blank line: rows before the timing are skipped below.
    if (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(rows[0])) continue;
    const timing = rows.findIndex((r) => r.includes("-->"));
    if (timing === -1) continue;
    const start = clock(rows[timing].split("-->")[0]);
    const body = rows.slice(timing + 1);
    if (!body.length) continue;
    const { text: joined, speaker: voice } = stripCueMarkup(body.join(" "));
    let line = joined.replace(/\s+/g, " ").trim();
    if (!line) continue;
    let speaker = cleanSpeaker(voice);
    if (!speaker) {
      const sp = line.match(SPEAKER_PREFIX);
      const who = sp ? speakerLabel(sp[1]) : null;
      if (sp && who) {
        speaker = who;
        line = sp[2].trim();
      }
    }
    out.push({ t: start, speaker, text: line });
  }
  return out;
}

/** Oasis Meet's stored lines: [{ t | time, speaker, text }], t in seconds or "hh:mm:ss". */
function parseMeet(rows: unknown): RawLine[] {
  if (!Array.isArray(rows)) return [];
  const out: RawLine[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    const rawT = o.t ?? o.time ?? o.start ?? null;
    let t: string | null = null;
    if (typeof rawT === "number" && Number.isFinite(rawT) && rawT >= 0) t = hms(Math.floor(rawT));
    else if (typeof rawT === "string") t = clock(rawT);
    out.push({ t, speaker: cleanSpeaker(typeof o.speaker === "string" ? o.speaker : null), text });
  }
  return out;
}

/** Split a long line at word boundaries so no numbered line exceeds LINE_MAX_CHARS. */
function splitLong(line: RawLine): RawLine[] {
  if (line.text.length <= LINE_MAX_CHARS) return [line];
  const parts: RawLine[] = [];
  let rest = line.text;
  while (rest.length > LINE_MAX_CHARS) {
    let cut = rest.lastIndexOf(" ", LINE_MAX_CHARS);
    if (cut < LINE_MAX_CHARS / 2) cut = LINE_MAX_CHARS;
    parts.push({ ...line, text: rest.slice(0, cut).trim() });
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push({ ...line, text: rest });
  return parts;
}

function finish(format: TranscriptFormat, raw: RawLine[]): { ok: true; value: ParsedTranscript } | { ok: false; error: ParseError } {
  if (raw.length > TRANSCRIPT_MAX_LINES) return { ok: false, error: "too_many_lines" };
  // Scrub before anything else, whole lines in order (a label at one line's end
  // reaches the next), and before long lines are cut, so no cut separates a label from its value.
  const scrubbed = scrubTexts(raw.map((r) => r.text));
  let redactions = scrubbed.hits;
  const lines: TranscriptLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const sp = raw[i].speaker ? scrubCredentials(raw[i].speaker as string) : null;
    if (sp) redactions += sp.hits;
    for (const piece of splitLong({ ...raw[i], text: scrubbed.texts[i] })) {
      lines.push({ n: lines.length + 1, t: piece.t, speaker: sp ? sp.text : null, text: piece.text });
      if (lines.length > TRANSCRIPT_MAX_LINES) return { ok: false, error: "too_many_lines" };
    }
  }
  if (!lines.length) return { ok: false, error: "empty" };
  const speakers = [...new Set(lines.map((l) => l.speaker).filter((s): s is string => !!s))];
  return { ok: true, value: { format, lines, speakers, chars: lines.reduce((n, l) => n + l.text.length, 0), redactions } };
}

/** Parse pasted text or an uploaded file. `filename` decides the format when given. */
export function parseTranscriptText(text: string, filename?: string | null): { ok: true; value: ParsedTranscript } | { ok: false; error: ParseError } {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty" };
  if (utf8Bytes(text) > TRANSCRIPT_MAX_BYTES) return { ok: false, error: "too_large" };
  const format = formatFor(filename, text);
  if (!format) return { ok: false, error: "unsupported_type" };
  const raw = format === "txt" ? parseTxt(text) : parseCues(text, format as "vtt" | "srt");
  return finish(format, raw);
}

/** An Oasis Meet transcript's stored lines (for attaching a Meet call, phase 2c). */
export function parseMeetLines(rows: unknown): { ok: true; value: ParsedTranscript } | { ok: false; error: ParseError } {
  return finish("meet", parseMeet(rows));
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/** One line as a model or a reviewer reads it: "L12 [00:03:10] Dana: words". */
export function renderLine(l: TranscriptLine): string {
  return `L${l.n}${l.t ? ` [${l.t}]` : ""}${l.speaker ? ` ${l.speaker}:` : ""} ${l.text}`;
}

/**
 * Consecutive windows of at most `maxChars` rendered characters, never
 * splitting a line, for extraction. Each says its first and last line number.
 */
export function transcriptWindows(lines: readonly TranscriptLine[], maxChars = WINDOW_CHARS): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  let buf: string[] = [];
  let from = 0;
  let to = 0;
  let size = 0;
  for (const l of lines) {
    const r = renderLine(l);
    if (buf.length && size + r.length + 1 > maxChars) {
      out.push({ from, to, text: buf.join("\n") });
      buf = [];
      size = 0;
    }
    if (!buf.length) from = l.n;
    buf.push(r);
    to = l.n;
    size += r.length + 1;
  }
  if (buf.length) out.push({ from, to, text: buf.join("\n") });
  return out;
}

function norm(s: string): string {
  return (
    s
      // "café" and "cafe" are the same word to a quote check.
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      // "$" and "%" are words of their own, so "1,500 a month" is found in "$1,500 a month".
      .replace(/[$%]/g, (m) => ` ${m} `)
      // A comma or point inside a number ("1,200", "2.5") is part of the figure; anywhere else it is punctuation.
      .replace(/(?<!\d)[.,]|[.,](?!\d)/g, " ")
      .replace(/[^a-z0-9'$%.,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const MARKER_WORDS = ` ${norm(CREDENTIAL_MARKER)} `;

/**
 * Does `quote` really appear in lines `from`..`to`? Compared without case,
 * accents, spacing or most punctuation, so a model's tidy copy of a messy line
 * still matches. Whole words only: "40" is not found in "400", "500" not in
 * "$1,500", "ice" not in "invoice". A quote of the redaction marker is never
 * evidence.
 */
export function quoteInLines(lines: readonly TranscriptLine[], from: number, to: number, quote: string): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from > 40) return false;
  const q = norm(quote);
  if (q.length < 3) return false;
  if (MARKER_WORDS.includes(` ${q} `) || q.includes("possible password or account detail") || q.includes("removed possible")) return false;
  const span = norm(lines.filter((l) => l.n >= from && l.n <= to).map((l) => l.text).join(" "));
  return ` ${span} `.includes(` ${q} `);
}
