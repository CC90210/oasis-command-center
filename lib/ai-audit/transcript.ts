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
 *   passphrase  a phrase, which may start with "the" ("the quick brown fox");
 *   answer      a security answer: a plain word or a few;
 *   password    a mixed token, 3+ digits, spoken digits or letters, or (after a
 *               joiner, singular label only) a plain word that is not a description;
 *   code        3+ digits, written, grouped or spoken, or a mixed token: PIN, CVV,
 *               door or alarm code, combination;
 *   codeword    the word "code" alone: only after a joiner ("the code for the safe
 *               is 4421"), never "area code 403" or "zip code";
 *   number      5+ digits (8+ after a plural label, which usually counts things):
 *               card, bank, routing, SIN, social security, IBAN;
 *   account     the word "account" alone: 5+ digits straight after it;
 *   social      "social" alone: only after a joiner ("my social is 078-05-1120"),
 *               never "social 12000 followers";
 *   token       a mixed token of 8+ characters, or 8+ digits: API key, client secret;
 *   pass        a mixed token only ("the pass is hunter2", never "the pass rate").
 */
type ValueKind = "passphrase" | "answer" | "password" | "code" | "codeword" | "number" | "account" | "social" | "token" | "pass";
const KINDS: readonly ValueKind[] = ["passphrase", "answer", "password", "code", "codeword", "number", "account", "social", "token", "pass"];

/** The labels, one capture group per kind, in KINDS order (earlier groups win at the same place). */
const LABEL = new RegExp(
  [
    String.raw`(\bpass[ \t]?phrases?\b)`,
    String.raw`(\bsecurity[ \t]+(?:question[ \t]+)?answers?\b|\banswer[ \t]+to[ \t]+(?:the|my|our)[ \t]+security[ \t]+question\b)`,
    String.raw`(\bpass[ \t]?(?:word|code)s?\b|\bpasswd\b|\bpwd\b|\bpw\b)`,
    String.raw`(\bpin(?:[ \t]+(?:numbers?|codes?))?\b|\bpins\b|\bcv[vc]2?\b|\bcsc\b|\bsecurity[ \t]+(?:codes?|questions?)\b|\b(?:one[ \t-]?time|verification|confirmation|2fa|two[ \t-]factor|mfa|recovery|backup|door|alarm|gate|lock|safe|garage|entry|access)[ \t]+codes?\b|\botp\b|\bcombinations?\b)`,
    String.raw`((?<!\b(?:zip|postal|area|promo|discount|coupon|tax|source|dress|country|error|status|qr|bar|reference|tracking|product|style|morse|post|colour|color|ethics|building)[ \t])\bcodes?\b)`,
    String.raw`(\b(?:credit[ \t]+|debit[ \t]+)?card[ \t]+numbers?\b|\bcard\b|\baccount[ \t]+(?:numbers?\b|no\b\.?|#)|\bacct[ \t]*(?:numbers?\b|no\b\.?|#)|\b(?:routing|transit|institution|sort)[ \t]+(?:numbers?|codes?)\b|\bbank[ \t]+account(?:[ \t]+numbers?)?\b|\bsin(?:[ \t]+numbers?)?\b|\bsocial[ \t]+(?:insurance|security)(?:[ \t]+numbers?)?\b|\bssn\b|\biban\b)`,
    String.raw`(\baccount\b)`,
    String.raw`(\bsocial\b)`,
    String.raw`(\b(?:auth(?:entication|orization)?|access|refresh|bearer|api|session|bot|app|integration|personal[ \t]+access)[ \t]+tokens?\b|\btokens?\b|\bapi[ \t_-]?keys?\b|\bapikeys?\b|\b(?:secret|private|license|licence)[ \t_-]?keys?\b|\bclient[ \t_-]?secrets?\b|\bsecrets?\b)`,
    String.raw`(\bpass\b)`,
  ].join("|"),
  "gi",
);

/** What joins a label to its value: "is", "was", "'s", ":", "=", " - ", a dash, "would be". Bounded, so long runs of spaces cost nothing. */
const JOINER = /[ \t]{0,8}(?:['\u2019]s\b[ \t]{0,3}:?|=|:|-(?=\s)|[\u2013\u2014]|(?:is|was|are|were)\b(?:[ \t]{1,4}(?:just|actually|still|now|basically|simply|literally|currently)\b)?[ \t]{0,3}[:-]?|(?:would|will|should)[ \t]{1,4}be\b)[ \t]{0,8}/iy;
/** A word between the label and its joiner: "the password FOR THE PORTAL is ...". Letters only, so it never swallows the value or crosses punctuation. */
const FILLER = /[ \t]{1,8}([A-Za-z][A-Za-z'\u2019]{0,30})(?=[ \t:=]|$)/y;
const MAX_FILLER = 6;
/**
 * A filler must start like "for the portal", "on the back", "we use
 * everywhere" or "the portal gave me". "The password RESET volume is 400"
 * starts with a noun: the label only describes another thing.
 */
const FILLER_STARTS = new Set(["for", "to", "on", "of", "at", "in", "into", "with", "from", "we", "i", "you", "they", "he", "she", "that", "which", "our", "my", "your", "their", "his", "her", "it", "the", "a", "an", "this", "these", "those", "we've", "i've", "you've", "we'd", "i'd"]);
/** What people say between the joiner and the value: "my password is, um, hunter2", "the password... it's hunter2". */
const INTERJECTION = /(?:um+|uh+|erm?|ah+|hmm+|like|so|well|okay|ok|just|it['\u2019]?s|it[ \t]{1,4}is|that['\u2019]?s|actually|basically|honestly|literally)\b/iy;
const PUNCT_AND_SPACE = /[ \t,.;:\u2026"'\u2018\u201C(\-\u2013\u2014]{1,40}/y;

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
    "unique separate individual centralized wait hold stop sorry hmm well one two three four five six seven eight nine ten " +
    "incorrect correct wrong invalid valid chaos mess messy overdue due unclear compromised leaked stolen guessable obvious predictable permanent " +
    "universal nowhere rubbish awful horrible alright gone changing stale ancient outdated inconsistent consistent problem problems issue issues " +
    "disaster nightmare joke fine-ish everywhere unmanaged scattered excel spreadsheet paper"
  ).split(" "),
);
/** Nouns that follow "password" as a compound, never as the password: "password manager", "password reset". */
const PASSWORD_COMPOUNDS = new Set(
  (
    "reset resets manager managers policy policies protected protection change changes rotation field box prompt hint hints strength length expiry " +
    "expiration sharing vault list lists sheet spreadsheet file document doc notebook book sticky note notes reuse recovery requirements rules complexity " +
    "hygiene issues problems problem issue fatigue emails email link links screen page form request requests approach system tool tools app"
  ).split(" "),
);
/** A word ending like a description, not a password: "unmanaged", "inconsistent", "Excel-based", "Dana's". */
const DESCRIPTIVE_ENDING = /(?:ed|ing|ent|ant|ous|ive|ful|less|able|ible|ical|ary|ory|based|like|wise|['\u2019]s)$/i;
/** Words that end a spoken passphrase or a value: "my password is blue falcon AND ...". */
const STOP = new Set(["and", "but", "so", "or", "then", "okay", "ok", "right", "which", "because", "if", "for", "to", "um", "uh", "yeah", "alright", "please", "thanks", "that", "i", "we", "you", "it", "is", "was", "are"]);

const SPOKEN_DIGIT = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
const SPOKEN_LETTER = "(?:alpha|alfa|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliett?|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiske?y|x-?ray|yankee|zulu)";
const SPOKEN_WORD = `(?:${SPOKEN_DIGIT}|${SPOKEN_LETTER})`;
const SPOKEN_RUN = new RegExp(`${SPOKEN_WORD}(?:[ \\t,.-]{1,4}${SPOKEN_WORD}){0,40}\\b`, "iy");
/** Digits, written or grouped: "4421", "4 4 2 1", "4, 4, 2, 1", "4 - 4 - 2 - 1", "078-05-1120". */
const DIGIT_RUN = /\d(?:(?:[ \t]{0,2}[,.\/-][ \t]{0,2}|[ \t]{1,2})?\d){0,60}/y;
const TOKEN = /[^\s]{1,400}/y;
const TRAILING_PUNCT = /[.,;:!?)"'\u2019\u201D]+$/;

function minDigits(kind: ValueKind, plural: boolean): number {
  switch (kind) {
    case "number":
      return plural ? 8 : 5;
    case "account":
    case "social":
      return 5;
    case "token":
      return 8;
    case "pass":
      return Number.POSITIVE_INFINITY;
    default:
      return 3;
  }
}

/** A token that is not a word: letters with digits ("hunter2"), letters or digits with symbols ("p@ss!"), or one long run ("8f3a9c1d..."). */
function looksSecret(tok: string): boolean {
  if (/\d/.test(tok) && /\p{L}/u.test(tok)) return true;
  if (/[!@#$%^&*_+=~|<>{}[\]\\/]/.test(tok) && /[\p{L}\d]/u.test(tok)) return true;
  return tok.length >= 16 && /^[A-Za-z0-9_\-+/=.]+$/.test(tok);
}

type Carry = { kind: ValueKind; plural: boolean; needJoiner: boolean; digitsOnly: boolean; lines: number };

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

/** Skip spaces, punctuation and filler talk ("um", "it's") before a value; at most a few of each. */
function skipTalk(s: string, at: number): number {
  let i = at;
  for (let n = 0; n < 6; n++) {
    PUNCT_AND_SPACE.lastIndex = i;
    if (PUNCT_AND_SPACE.exec(s)) i = PUNCT_AND_SPACE.lastIndex;
    INTERJECTION.lastIndex = i;
    const m = INTERJECTION.exec(s);
    if (!m) break;
    i = INTERJECTION.lastIndex;
  }
  PUNCT_AND_SPACE.lastIndex = i;
  if (PUNCT_AND_SPACE.exec(s)) i = PUNCT_AND_SPACE.lastIndex;
  return i;
}

/** Only spaces and punctuation from `at` to the end of the line. */
function restIsEmpty(s: string, at: number): boolean {
  return /^[\s.,;:!?)"'\u2019\u201D]*$/.test(s.slice(at, at + 200)) && s.length - at <= 200;
}

type Value = { start: number; end: number; digitsToEnd: boolean };

/** The value a label introduces, "end" when the line ends first (the value is on the next line), or null when what follows is no secret. */
function readValue(s: string, at: number, kind: ValueKind, joined: boolean, plural: boolean): Value | "end" | null {
  const i = skipTalk(s, at);
  if (i >= s.length || restIsEmpty(s, i)) return "end";
  const start = i;
  const needsJoiner = kind === "codeword" || kind === "social";
  if (needsJoiner && !joined) return null;

  // Digits.
  DIGIT_RUN.lastIndex = i;
  const d = DIGIT_RUN.exec(s);
  if (d && !/\p{L}/u.test(s[DIGIT_RUN.lastIndex] ?? "")) {
    if (d[0].replace(/\D/g, "").length < minDigits(kind, plural)) return null;
    return { start, end: DIGIT_RUN.lastIndex, digitsToEnd: restIsEmpty(s, DIGIT_RUN.lastIndex) };
  }
  // Spoken digits, or letters in the phonetic alphabet ("echo romeo two").
  SPOKEN_RUN.lastIndex = i;
  const w = SPOKEN_RUN.exec(s);
  if (w) {
    const words = w[0].split(/[^a-z-]+/i).filter(Boolean);
    const digits = words.filter((x) => new RegExp(`^${SPOKEN_DIGIT}$`, "i").test(x)).length;
    const enough =
      kind === "password" || kind === "passphrase" || kind === "answer"
        ? words.length >= 2
        : kind === "code" || kind === "codeword"
          ? words.length >= 3
          : kind === "number" || kind === "account" || kind === "social"
            ? digits >= 5 && digits === words.length
            : false;
    if (enough) return { start, end: SPOKEN_RUN.lastIndex, digitsToEnd: false };
  }

  // A token, without the sentence's own punctuation.
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
    if (kind === "number" || kind === "account" || kind === "social") return null;
    if (kind === "token" && tok.length < 8) return null;
    if (kind === "pass" && tok.length < 4) return null;
    return { start, end, digitsToEnd: false };
  }
  if (kind !== "password" && kind !== "passphrase" && kind !== "answer") return null;
  // Plain words. A plural label ("passwords are ...") describes, it never gives one.
  if (plural && kind !== "answer") return null;
  const plainWord = (x: string) => /^[\p{L}\p{N}'\u2019-]+$/u.test(x);
  if (!plainWord(tok)) return null;
  const lower = tok.toLowerCase();
  const describes = COMMON.has(lower) || DESCRIPTIVE_ENDING.test(tok);
  if (kind === "password") {
    if (describes) return null;
    if (!joined) {
      // "password swordfish": only a word that ends the thought, never "password manager".
      if (PASSWORD_COMPOUNDS.has(lower)) return null;
      const after = s.slice(end, end + 40).match(/^[ \t]*([\p{L}]+)?/u)?.[1]?.toLowerCase();
      if (!restIsEmpty(s, end) && !(after && STOP.has(after)) && !/^[ \t]*[.,;:!?]/.test(s.slice(end, end + 5))) return null;
    }
  } else if (kind === "answer") {
    if (!joined || describes) return null;
  } else if (!joined) return null;
  // ... and the words after it: a passphrase read out loud ("blue falcon river", "the quick brown fox").
  const maxWords = kind === "passphrase" ? 6 : 4;
  let last = end;
  let words = 1;
  let stopped = !!trail;
  while (words < maxWords && !stopped) {
    const m = /^[ \t]{1,4}([\p{L}\p{N}'\u2019-]{1,40})([.,;:!?)"'\u2019\u201D]*)/u.exec(s.slice(last, last + 120));
    if (!m) break;
    const nxt = m[1].toLowerCase();
    if (STOP.has(nxt) || (COMMON.has(nxt) && !new RegExp(`^${SPOKEN_DIGIT}$`, "i").test(nxt))) break;
    last += m[0].length - m[2].length;
    words += 1;
    stopped = !!m[2];
  }
  return { start, end: last, digitsToEnd: false };
}

/** Shapes that are secrets whatever surrounds them. Every quantifier is bounded. */
const SHAPES: RegExp[] = [
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,200}\b/g, // Stripe
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,200}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,200}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,200}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,200}\b/g, // Google
  /\beyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{5,2000}\b/g, // JWT
  /\b(?:sk|key)-[A-Za-z0-9_-]{20,200}\b/g, // OpenAI-style and similar
  /\bSG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}/g, // SendGrid
  /\bshp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32}\b/g, // Shopify
  /\b(?:Bearer|Basic)[ \t]{1,4}[A-Za-z0-9._~+/=-]{16,2000}/g, // an Authorization header's value
  /\b[0-9a-fA-F]{32,}\b/g, // long hex: API keys, webhook secrets
  /\b\d{3}-\d{2}-\d{4}\b/g, // a US social security number
  new RegExp(`\\b${SPOKEN_DIGIT}(?:[ \\t,.-]{1,4}${SPOKEN_DIGIT}){11,30}\\b`, "gi"), // a card read out, digit by digit
];
/** A user name and password inside an address: https://admin:hunter2@router.local (the "admin:hunter2" part goes). */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s/@:]{1,64}:[^\s/@]{1,128})@/gi;
/** An IBAN, mod-97 checked: GB82 WEST 1234 5698 7654 32. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const BASE64_LINE = /^[A-Za-z0-9+/=]{20,}$/;
/** 13 to 19 digits, spaces, dashes or dots between them: a card when Luhn passes and it starts like one. */
const CARD = /\b(?:\d[ .-]?){12,18}\d\b/g;

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

/** Starts like a real card (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay), so "2023 2024 2025 2026" is a list of years. */
function cardPrefix(d: string): boolean {
  const n2 = Number(d.slice(0, 2));
  const n4 = Number(d.slice(0, 4));
  return d[0] === "4" || (n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720) || n2 === 34 || n2 === 37 || d.startsWith("6011") || d.startsWith("65") || (n4 >= 6440 && n4 <= 6499) || (n4 >= 3528 && n4 <= 3589) || n2 === 36 || n2 === 38 || n2 === 39 || (n4 >= 3000 && n4 <= 3059) || n2 === 62;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/**
 * A run of 32+ letters and digits that is a key, not a word or a file name:
 * upper and lower case and digits, and no long stretch of lower case
 * ("InvoiceAutomationWorkflow2024Final" has words in it; "MIIEvQIBADANBg..." does not).
 */
function mixedRuns(s: string, cuts: Array<[number, number]>): void {
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{32,2000}/g)) {
    const w = m[0];
    const digits = (w.match(/\d/g) ?? []).length;
    const upper = (w.match(/[A-Z]/g) ?? []).length;
    const lowerCount = (w.match(/[a-z]/g) ?? []).length;
    const longestLower = Math.max(0, ...(w.match(/[a-z]+/g) ?? []).map((x) => x.length));
    if (digits >= 2 && upper >= 3 && lowerCount >= 3 && longestLower <= 6) cuts.push([m.index ?? 0, (m.index ?? 0) + w.length]);
  }
}

/** A PEM private key on this line: where it starts, and whether it closes on the line too. Found with indexOf, never a pattern. */
function pemOn(s: string): { start: number; closed: number | null } | null {
  let from = 0;
  for (let n = 0; n < 50; n++) {
    const i = s.indexOf("-----BEGIN ", from);
    if (i === -1) return null;
    const head = s.indexOf("PRIVATE KEY-----", i);
    if (head !== -1 && head - i <= 40) {
      const end = s.indexOf("-----END ", head);
      const tail = end === -1 ? -1 : s.indexOf("PRIVATE KEY-----", end);
      return { start: i, closed: tail !== -1 && tail - end <= 40 ? tail + "PRIVATE KEY-----".length : null };
    }
    from = i + 1;
  }
  return null;
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

/**
 * A marker already in the text stays exactly as it is: it is swapped for a
 * character no rule reads before the scrub and put back after, so a second
 * scrub of scrubbed text changes nothing (review of phase 2: re-saving a note
 * kept appending to the marker).
 */
const INERT = "\u0001";

/** One line. `carry` is a label the previous line left open, still waiting for its value. */
function scrubLine(raw: string, carry: Carry | null): { text: string; hits: number; pending: Carry | null; pemOpen: boolean } {
  const s = raw.split(CREDENTIAL_MARKER).join(INERT);
  const cuts: Array<[number, number]> = [];
  let pending: Carry | null = null;

  if (carry) {
    // A speaker's name at the start of the next line ("Dana: hunter2" in raw notes) is not the value.
    const lead = /^([^\s:\[(][^:]{0,40}?)[ \t]{0,3}:[ \t]{1,8}/.exec(s);
    let at = lead && speakerLabel(lead[1], { repeated: true }) ? lead[0].length : 0;
    let joined = !carry.needJoiner;
    if (carry.needJoiner) {
      const j = afterLabel(s, skipTalk(s, at));
      joined = j.joined;
      if (j.joined) at = j.at;
    }
    if (carry.digitsOnly) {
      DIGIT_RUN.lastIndex = skipTalk(s, at);
      const d = DIGIT_RUN.exec(s);
      const next = d ? s.slice(DIGIT_RUN.lastIndex, DIGIT_RUN.lastIndex + 40).match(/^[ \t]*([\p{L}]+)?/u)?.[1]?.toLowerCase() : undefined;
      if (d && d[0].replace(/\D/g, "").length >= 4 && (restIsEmpty(s, DIGIT_RUN.lastIndex) || (next !== undefined && STOP.has(next)))) cuts.push([d.index, DIGIT_RUN.lastIndex]);
    } else {
      const v = readValue(s, at, carry.kind, joined, carry.plural);
      if (v && v !== "end") {
        cuts.push([v.start, v.end]);
        if (v.digitsToEnd) pending = { kind: carry.kind, plural: carry.plural, needJoiner: false, digitsOnly: true, lines: 0 };
      } else if (v === null && carry.lines < 1 && (s.split(/\s+/).length <= 10 || /\?\s*$/.test(s))) {
        // An interruption ("sorry, say again?"): the value may come on the line after.
        pending = { ...carry, lines: carry.lines + 1 };
      }
    }
  }

  LABEL.lastIndex = 0;
  for (let m = LABEL.exec(s); m; m = LABEL.exec(s)) {
    const group = m.slice(1).findIndex((g) => g !== undefined);
    const kind = KINDS[group] ?? "password";
    const plural = /s$/i.test(m[0]) && kind !== "pass" && kind !== "social" && !/\bpass$/i.test(m[0]);
    const labelEnd = m.index + m[0].length;
    const after = afterLabel(s, labelEnd);
    const v = readValue(s, after.at, kind, after.joined, plural);
    if (v === "end") {
      pending = { kind, plural, needJoiner: !after.joined, digitsOnly: false, lines: 0 };
      continue;
    }
    if (v) {
      cuts.push([v.start, v.end]);
      if (v.digitsToEnd && (kind === "number" || kind === "code" || kind === "account")) pending = { kind, plural, needJoiner: false, digitsOnly: true, lines: 0 };
      LABEL.lastIndex = Math.max(LABEL.lastIndex, v.end);
    }
  }
  for (const re of SHAPES) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of s.matchAll(URL_CREDENTIALS)) {
    const at = (m.index ?? 0) + m[0].indexOf(m[1]);
    cuts.push([at, at + m[1].length]);
  }
  for (const m of s.matchAll(IBAN)) if (ibanValid(m[0])) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of s.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && cardPrefix(digits) && luhn(digits)) cuts.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const pem = pemOn(s);
  if (pem) cuts.push([pem.start, pem.closed ?? s.length]);
  mixedRuns(s, cuts);
  const done = applyCuts(s, cuts);
  return { text: done.text.split(INERT).join(CREDENTIAL_MARKER), hits: done.hits, pending, pemOpen: !!pem && pem.closed === null };
}

/** A card number read across two lines ("4111 1111" / "1111 1111"): both halves go. */
function joinSplitCards(out: string[]): number {
  let hits = 0;
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const tailStart = Math.max(0, prev.length - 60);
    const tail = prev.slice(tailStart).match(/(\d[\d .-]{0,40}\d)\s*$/);
    const head = out[i].slice(0, 60).match(/^\s*(\d[\d .-]{0,40}\d)/);
    if (!tail || !head) continue;
    const digits = (tail[1] + head[1]).replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !cardPrefix(digits) || !luhn(digits)) continue;
    out[i - 1] = prev.slice(0, tailStart + (tail.index ?? 0)) + CREDENTIAL_MARKER;
    out[i] = CREDENTIAL_MARKER + out[i].slice((head.index ?? 0) + head[0].length);
    hits += 2;
  }
  return hits;
}

/**
 * Scrub consecutive lines (a transcript's, or a note's), carrying what one
 * line leaves open into the next: a label at a line's end (or its value after
 * a short interruption), digits that run on, a private key's body, a card
 * number cut in two.
 */
export function scrubTexts(texts: readonly string[]): { texts: string[]; hits: number } {
  const out: string[] = [];
  let hits = 0;
  let carry: Carry | null = null;
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

/** Remove credential-like text from one piece of text (lines kept). Returns the scrubbed text and how many pieces went. Scrubbing twice changes nothing. */
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
    "fyi http https www update summary agenda todo important warning tip question answer action item items reminder because if " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun weekdays weekends today tomorrow"
  ).split(" "),
);
/** Small words inside a name: "van der Berg", "Juan de la Cruz". */
const PARTICLES = new Set("van der den de la le du da di von bin ibn al el del dos das ter ten st".split(" "));
/** A label that introduces an account detail, never a speaker: "Password: ...", "Login: ...", "PIN: ...". */
const CREDENTIAL_LABEL = /\b(?:pass(?:word|code|phrase)?s?|passwd|pwd|pw|pins?|cv[vc]2?|csc|logins?|user ?names?|users?|e-?mails?|tokens?|secrets?|keys?|api|codes?|cards?|accounts?|acct|sin|ssn|social|otp|2fa|mfa)\b/i;
const ROLE = /^(?:speaker|interviewer|interviewee|host|guest|client|customer|caller|agent|rep|me|you|unknown)(?:\s+\d+)?$/i;

/**
 * A speaker's name before a colon: one to four capitalised words ("Dana Lee",
 * "Dr. Smith", "Speaker 1", "CC"), a name with particles ("van der Berg"),
 * "Q" or "A" in interview notes, or a role. Lower case ("dana", "cc") only
 * after a timestamp ("[0:32] dana: ..." as Oasis Meet copies it) or when the
 * same label comes back on other lines; "the first thing:" said once is a
 * sentence. Never anything with sentence punctuation in it ("Dana: Monday").
 */
export function speakerLabel(raw: string, opts: { afterTime?: boolean; repeated?: boolean } | boolean = {}): string | null {
  const o = typeof opts === "boolean" ? { afterTime: opts } : opts;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s.length > 40) return null;
  if (/[:;!?,"]/.test(s)) return null;
  if (/^[QA]$/.test(s)) return s;
  const words = s.split(" ");
  if (words.length > 4) return null;
  const bare = (w: string) => w.toLowerCase().replace(/[.']/g, "");
  if (NOT_SPEAKERS.has(bare(s)) || NOT_SPEAKERS.has(bare(words[0]))) return null;
  if (CREDENTIAL_LABEL.test(s)) return null;
  if (ROLE.test(s)) return s.slice(0, SPEAKER_MAX_CHARS);
  const capitalised = (w: string) => /^[\p{Lu}\d(]/u.test(w);
  const particle = (w: string) => PARTICLES.has(w.toLowerCase());
  if (words.some(capitalised) && words.every((w) => capitalised(w) || particle(w))) return s.slice(0, SPEAKER_MAX_CHARS);
  if ((o.afterTime || o.repeated) && words.length <= 3 && words.every((w) => /^[\p{L}][\p{L}.'-]*$/u.test(w))) return s.slice(0, SPEAKER_MAX_CHARS);
  return null;
}

/** "Speaker: words" at the start of a text line; speakerLabel decides whether it is a speaker. */
const SPEAKER_PREFIX = /^([^\s:\[(][^:]{0,40}?)[ \t]{0,3}:[ \t]{1,8}(\S.*)$/;
const AMPM = String.raw`([AaPp]\.?[Mm]\.?)`;
const TIME = String.raw`((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)`;
/** "[10:32 AM] ...", "(00:12:03) ...": a time in brackets. */
const BRACKET_TIME = new RegExp(String.raw`^[[(][ \t]{0,3}${TIME}[ \t]{0,3}${AMPM}?[ \t]{0,3}[\])][ \t]{0,3}(?:[-|${"\u2013"}][ \t]{0,3})?`);
/** "00:12:03 ...": three parts, so a time. */
const LONG_TIME = new RegExp(String.raw`^(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)[ \t]{0,3}${AMPM}?(?:[ \t]{1,3}[-|${"\u2013"}])?(?:[ \t]{1,3}|$)`);
/** "12:03 - ...": two parts, then a separator. */
const SHORT_TIME_SEP = new RegExp(String.raw`^(\d{1,2}:\d{2})[ \t]{0,3}${AMPM}?[ \t]{1,3}[-|${"\u2013"}][ \t]{1,3}`);
/** "12:03 Dana: ...": two parts, then a speaker (checked). "9:00 to 5:00 weekdays" stays text. */
const SHORT_TIME = new RegExp(String.raw`^(\d{1,2}:\d{2})[ \t]{0,3}${AMPM}?[ \t]{1,3}`);
/**
 * "Dana Lee  0:32" on its own line (Otter's export: two spaces or a tab before
 * the time): who speaks next, and when. One space is ordinary text ("Monday 9:00").
 */
const NAME_THEN_TIME = new RegExp(String.raw`^(.{1,40}?)(?:\t| {2})[ \t]{0,10}${TIME}$`);

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
    if (sp && speakerLabel(sp[1], { afterTime: true })) {
      const t = stamp(m[1], m[2], ref);
      if (t) return { t, rest };
    }
  }
  return null;
}

type RawLine = { t: string | null; speaker: string | null; text: string };

function parseTxt(text: string): RawLine[] {
  const rows = text.split(/\r\n|\r|\n/).map((r) => r.trim()).filter(Boolean);

  // "Dana Lee  0:32" lines are Otter's headers only when the file is laid out
  // that way: two or more, each followed by what was said, the times never
  // going back. A table of opening hours ("Monday  9:00") is just text.
  const heads = rows.map((r) => {
    const m = r.length <= 80 ? r.match(NAME_THEN_TIME) : null;
    const who = m ? speakerLabel(m[1]) : null;
    const at = m ? clock(m[2]) : null;
    return who && at ? { who, at } : null;
  });
  const headAt = heads.flatMap((h, i) => (h ? [i] : []));
  let otter = headAt.length >= 2 && headAt.every((i) => i + 1 < rows.length && !heads[i + 1]);
  for (let k = 1; otter && k < headAt.length; k++) if ((heads[headAt[k]] as { at: string }).at < (heads[headAt[k - 1]] as { at: string }).at) otter = false;

  // Labels that come back on other lines ("cc:" three times) may be lower case.
  const seen = new Map<string, number>();
  const countRef: ClockBase = { base: null };
  for (const r of rows) {
    const rest = timePrefix(r, countRef)?.rest ?? r;
    const sp = rest.match(SPEAKER_PREFIX);
    if (sp) seen.set(sp[1].trim().toLowerCase(), (seen.get(sp[1].trim().toLowerCase()) ?? 0) + 1);
  }

  const out: RawLine[] = [];
  const ref: ClockBase = { base: null };
  let speaker: string | null = null;
  let held: string | null = null;
  rows.forEach((raw, i) => {
    const head = otter ? heads[i] : null;
    if (head) {
      speaker = head.who;
      held = head.at;
      return;
    }
    let line = raw;
    let t: string | null = null;
    const time = timePrefix(line, ref);
    if (time) {
      t = time.t;
      line = time.rest;
      if (!line) {
        held = t;
        return;
      }
    }
    const sp = line.match(SPEAKER_PREFIX);
    const who = sp ? speakerLabel(sp[1], { afterTime: !!time, repeated: (seen.get(sp[1].trim().toLowerCase()) ?? 0) >= 2 }) : null;
    if (sp && who) {
      speaker = who;
      line = sp[2].trim();
    }
    out.push({ t: t ?? held, speaker, text: line });
    held = null;
  });
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
