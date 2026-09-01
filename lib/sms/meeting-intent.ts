/**
 * Deterministic classification for replies to founder-meeting SMS messages.
 *
 * Pure by design: no provider, database, environment, or model access. The
 * caller owns appointment matching and policy; this module only labels text
 * and returns a proposed local time when the wording resolves to one unique,
 * future instant in the supplied IANA timezone.
 */

import { detectOptOut } from "./compliance";

export type MeetingIntent =
  | "confirm"
  | "reschedule"
  | "cancel"
  | "running_late"
  | "question"
  | "opt_out"
  | "unknown";

export type ProposedMeetingTime = {
  /** Minute-precision wall-clock time in the caller's supplied timezone. */
  isoLocal: string;
  source: "relative_datetime" | "explicit_datetime" | "slot_choice";
};

export type MeetingReplyContext = {
  state?: "idle" | "awaiting_slot_choice" | "awaiting_rep" | "closed";
  /** Local ISO minutes previously generated and persisted by trusted code. */
  proposedSlots?: readonly string[];
  nowIso?: string;
  timeZone?: string;
};

export type MeetingReplyClassification = {
  intent: MeetingIntent;
  confidence: "high" | "low";
  proposedTime: ProposedMeetingTime | null;
};

type LocalMinute = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const APPROXIMATE_TIME_RE = /\b(?:about|around|roughly|approximately|ish|morning|afternoon|evening|maybe|might|perhaps|possibly|probably)\b/iu;
const MULTIPLE_CHOICE_TIME_RE = /\b(?:or|either|between)\b/iu;
const NEGATED_OR_CONDITIONAL_TIME_RE =
  /\b(?:not|cannot|except|if|instead|rather|unless|unavailable)\b|\b(?:can|couldn|wouldn|shouldn|won|doesn|isn|aren|didn|don)['’]t\b|\bnever\s+mind\b/iu;
const UNPARSED_DATE_RE =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|next\s+(?:week|month)|this\s+week)\b|\b(?:in\s+may|may\s+\d{1,2}|\d{1,2}\s+may)\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/iu;
const EXPLICIT_TIME_ZONE_RE =
  /\b(?:UTC|GMT|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT)\b|(?:^|\s)[+-]\d{2}:?\d{2}\b/iu;
const MEETING_ACTION_RE =
  /\b(?:cancell?(?:ed|ing)?|call(?:ed|ing)?\s+off|reschedul(?:e|ed|ing)|mov(?:e|ed|ing)|chang(?:e|ed|ing))\b/iu;
const CANCEL_ACTION_RE = /\b(?:cancell?(?:ed|ing)?|call(?:ed|ing)?\s+off)\b/iu;
const RESCHEDULE_ACTION_RE = /\b(?:reschedul(?:e|ed|ing)|mov(?:e|ed|ing)|chang(?:e|ed|ing))\b/iu;

const MEETING_TARGET_SOURCE =
  `(?:(?:(?:my|our|the|this|that|today'?s|tomorrow'?s|upcoming|founder|sales)\\s+){0,3}` +
  `(?:meeting|appointment|audit|call)|it|this|that)`;
const CANCEL_REQUEST_SOURCE =
  `(?:cancel|call\\s+(?:it\\s+)?off)(?:\\s+${MEETING_TARGET_SOURCE})?`;
const LEADING_POLITENESS_SOURCE = `(?:sorry\\s*[,;:-]\\s*)?`;
const REQUEST_TRAILER_SOURCE =
  `(?:(?:\\s*[,;:-]\\s*|\\s+)(?:please|now|today|tomorrow|sorry|thanks|thank\\s+you))?[.!?]*`;
const RESCHEDULE_ACTION_SOURCE =
  `(?:reschedule(?:\\s+${MEETING_TARGET_SOURCE}\\b)?|` +
  `move\\s+${MEETING_TARGET_SOURCE}\\b|` +
  `change\\s+(?:(?:the\\s+)?(?:date|time|slot)\\b|` +
  `${MEETING_TARGET_SOURCE}\\b(?:\\s+(?:date|time|slot))?))`;
const TRUSTED_CLOCK_SOURCE =
  `\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?`;
const TRUSTED_RELATIVE_TIME_SOURCE =
  `(?:\\s+(?:to|for)\\s+|\\s+)(?:today|tomorrow)\\s+(?:at|@)\\s*${TRUSTED_CLOCK_SOURCE}`;
const RESCHEDULE_REQUEST_SOURCE =
  `(?:${RESCHEDULE_ACTION_SOURCE}(?:${TRUSTED_RELATIVE_TIME_SOURCE})?|` +
  `move${TRUSTED_RELATIVE_TIME_SOURCE})`;
const RESCHEDULE_TRAILER_SOURCE =
  `(?:(?:\\s*[,;:-]\\s*|\\s+)(?:please|now|sorry|thanks|thank\\s+you))?[.!?]*`;

const AFFIRMATIVE_CANCEL_PATTERNS = [
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:please[\\s,:-]+)?` +
    `${CANCEL_REQUEST_SOURCE}${REQUEST_TRAILER_SOURCE}$`,
    "iu",
  ),
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:can|could|may|would|will)\\s+` +
    `(?:you|we|i)\\s+(?:please\\s+)?` +
    `${CANCEL_REQUEST_SOURCE}${REQUEST_TRAILER_SOURCE}$`,
    "iu",
  ),
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:i|we)\\s+` +
    `(?:(?:(?:need|want)(?:\\s+you)?|have)\\s+to|would\\s+like\\s+to)\\s+` +
    `${CANCEL_REQUEST_SOURCE}${REQUEST_TRAILER_SOURCE}$`,
    "iu",
  ),
] as const;

const AFFIRMATIVE_RESCHEDULE_PATTERNS = [
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:please[\\s,:-]+)?` +
    `${RESCHEDULE_REQUEST_SOURCE}${RESCHEDULE_TRAILER_SOURCE}$`,
    "iu",
  ),
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:can|could|may|would|will)\\s+` +
    `(?:you|we|i)\\s+(?:please\\s+)?` +
    `${RESCHEDULE_REQUEST_SOURCE}${RESCHEDULE_TRAILER_SOURCE}$`,
    "iu",
  ),
  new RegExp(
    `^${LEADING_POLITENESS_SOURCE}(?:i|we)\\s+` +
    `(?:(?:(?:need|want)(?:\\s+you)?|have)\\s+to|would\\s+like\\s+to)\\s+` +
    `${RESCHEDULE_REQUEST_SOURCE}${RESCHEDULE_TRAILER_SOURCE}$`,
    "iu",
  ),
] as const;

const MEETING_CANCEL_SCHEDULING_FOLLOW_UP_RE = new RegExp(
  `^${LEADING_POLITENESS_SOURCE}(?:(?:please[\\s,:-]+)?cancel\\s+` +
  `${MEETING_TARGET_SOURCE}\\b|(?:can|could|may|would|will)\\s+` +
  `(?:you|we|i)\\s+(?:please\\s+)?cancel\\s+${MEETING_TARGET_SOURCE}\\b)` +
  `(?:\\s*[,;:]\\s*|\\s+and\\s+)(?:please\\s+)?(?:message|text)\\s+me` +
  `(?:\\s+(?:(?:new|other)\\s+)?(?:times?|slots?|options?|alternatives?))?[.!?]*$`,
  "iu",
);
const MEETING_CANCEL_WITH_EXPLICIT_OPTOUT_RE = new RegExp(
  `\\bcancel\\s+${MEETING_TARGET_SOURCE}\\b[\\s\\S]*\\b(?:stop|unsubscribe)\\b`,
  "iu",
);

function affirmativeMeetingMutation(text: string): "cancel" | "reschedule" | null {
  const normalized = text.trim().replace(/\u2019/gu, "'").replace(/\s+/gu, " ");
  const hasCancel = CANCEL_ACTION_RE.test(normalized);
  const hasReschedule = RESCHEDULE_ACTION_RE.test(normalized);
  if (hasCancel && hasReschedule) return null;
  if (hasCancel && AFFIRMATIVE_CANCEL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "cancel";
  }
  if (hasReschedule && AFFIRMATIVE_RESCHEDULE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "reschedule";
  }
  return null;
}

function isHistoricalActionQuestion(text: string): boolean {
  if (!/\?/u.test(text) || !MEETING_ACTION_RE.test(text)) return false;
  return /^(?:please\s+)?(?:(?:did|have|has|had)\s+(?:you|we|i|they|he|she)\b|(?:is|are|was|were)\s+(?:it|this|that|the|our|my|your|you|we|i)\b|(?:can|could|would)\s+you\s+(?:please\s+)?(?:confirm|check|verify)\b|(?:why|when|where|who|what)\b)/iu.test(text.trim());
}

function isRetractedOrNearAction(text: string): boolean {
  if (!MEETING_ACTION_RE.test(text)) return false;
  return (
    /\b(?:almost|nearly)\s+(?:cancell?(?:ed|ing)?|reschedul(?:e|ed|ing)|mov(?:e|ed|ing)|chang(?:e|ed|ing))\b/iu.test(text) ||
    /\b(?:was|were)\s+(?:just\s+)?going\s+to\s+(?:cancel|call\s+off|reschedule|move|change)\b/iu.test(text) ||
    /\b(?:planned|intended|meant)\s+to\s+(?:cancel|call\s+off|reschedule|move|change)\b/iu.test(text) ||
    /\b(?:changed?\s+(?:my|our)\s+mind|never\s*mind|actually(?:\s*[,;:-]\s*|\s+)(?:no|don['’]t)|scratch\s+that|disregard\s+that|forget\s+that)\b/iu.test(text) ||
    /\b(?:keep|leave)\s+(?:the\s+)?(?:original|current)\s+(?:time|date|slot|meeting)\b/iu.test(text) ||
    /\?\s*(?:no|nope|nah)\b/iu.test(text)
  );
}

const AFFIRMATIVE_RUNNING_LATE_PATTERNS = [
  /^(?:i(?:'m| am)|we(?:'re| are))\s+running\s+(?:(?:about|roughly)\s+)?(?:(?:a\s+)?(?:little|bit)\s+)?(?:\d{1,3}\s*(?:minutes?|mins?)\s+)?late\b/iu,
  /^(?:i(?:'ll| will)|we(?:'ll| will))\s+(?:be|join|arrive|show\s+up|get\s+there)\s+(?:(?:about|roughly)\s+)?(?:\d{1,3}\s*(?:minutes?|mins?)\s+)?late\b/iu,
  /^(?:i(?:'m| am)|we(?:'re| are))\s+(?:(?:about|roughly)\s+)?\d{1,3}\s*(?:minutes?|mins?)\s+late\b/iu,
  /^(?:i(?:'m| am)|we(?:'re| are))\s+going\s+to\s+be\s+(?:(?:about|roughly)\s+)?(?:\d{1,3}\s*(?:minutes?|mins?)\s+)?late\b/iu,
  /^running\s+(?:(?:about|roughly)\s+)?(?:\d{1,3}\s*(?:minutes?|mins?)\s+)?late\b/iu,
  /^\d{1,3}\s*(?:minutes?|mins?)\s+(?:behind|late)\b/iu,
] as const;

function isAffirmativeRunningLate(text: string): boolean {
  const normalized = text.trim().replace(/\u2019/gu, "'").replace(/\s+/gu, " ");
  if (/\b(?:on\s+time\s+now|not\s+late\s+(?:now|anymore)|caught\s+up)\b/iu.test(normalized)) {
    return false;
  }
  return AFFIRMATIVE_RUNNING_LATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isDeliberativeOrConditionalAction(text: string): boolean {
  if (!MEETING_ACTION_RE.test(text)) return false;
  const normalized = text.trim();
  return (
    /\b(?:if|maybe|might|perhaps|possibly|probably)\b/iu.test(normalized) ||
    /\b(?:think|thinking|consider|considering|wonder|wondering|guess|suppose)\b/iu.test(normalized) ||
    /\b(?:should\s+(?:i|we|you)|do\s+(?:i|we|you))\b/iu.test(normalized) ||
    /\b(?:could|would)\s+i\b/iu.test(normalized) ||
    /\b(?:i|we)\s+(?:may|might|could|would(?!\s+like\s+to)|should)\b/iu.test(normalized) ||
    /\b(?:(?:need|want)\s+to\s+know|need\s+(?:information|details|help)(?:\s+on)?)\s+how\s+to\b/iu.test(normalized) ||
    /\bdo\s+you\s+want\s+me\s+to\b/iu.test(normalized)
  );
}

function parseLocalIso(value: string): LocalMinute | null {
  const match = LOCAL_ISO_RE.exec(value.trim());
  if (!match) return null;
  const local = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  if (
    local.month < 1 || local.month > 12 ||
    local.day < 1 || local.day > 31 ||
    local.hour < 0 || local.hour > 23 ||
    local.minute < 0 || local.minute > 59
  ) return null;
  const roundTrip = new Date(Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  ));
  if (
    roundTrip.getUTCFullYear() !== local.year ||
    roundTrip.getUTCMonth() + 1 !== local.month ||
    roundTrip.getUTCDate() !== local.day ||
    roundTrip.getUTCHours() !== local.hour ||
    roundTrip.getUTCMinutes() !== local.minute
  ) return null;
  return local;
}

function localIso(local: LocalMinute): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(local.year).padStart(4, "0")}-${pad(local.month)}-${pad(local.day)}` +
    `T${pad(local.hour)}:${pad(local.minute)}`;
}

function localParts(instant: Date, timeZone: string): LocalMinute | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return parseLocalIso(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
    );
  } catch {
    return null;
  }
}

/**
 * Resolve a local wall-clock minute to an instant only when the mapping is
 * unique. Searching the finite UTC-offset range catches both sides of a DST
 * fold; zero matches catches a spring-forward gap.
 */
function uniqueInstantForLocal(local: LocalMinute, timeZone: string): number | null {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  const matches = new Set<number>();
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const instant = target - offsetMinutes * 60_000;
    const observed = localParts(new Date(instant), timeZone);
    if (observed && localIso(observed) === localIso(local)) matches.add(instant);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function shiftedLocalDate(local: LocalMinute, days: number): Pick<LocalMinute, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseClock(hourToken: string, minuteToken: string | undefined, meridiem: string | undefined): {
  hour: number;
  minute: number;
} | null {
  const rawHour = Number(hourToken);
  const minute = minuteToken === undefined ? 0 : Number(minuteToken);
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  const normalizedMeridiem = (meridiem || "").toLowerCase().replaceAll(".", "");
  if (normalizedMeridiem) {
    if (rawHour < 1 || rawHour > 12) return null;
    const hour = normalizedMeridiem === "pm"
      ? rawHour % 12 + 12
      : rawHour % 12;
    return { hour, minute };
  }
  // A bare "2" or "2:30" is AM/PM ambiguous. A zero-padded HH:mm or an
  // hour that only exists on a 24-hour clock is an explicit 24-hour time.
  if (minuteToken === undefined || (hourToken.length < 2 && rawHour <= 12)) return null;
  if (rawHour < 0 || rawHour > 23) return null;
  return { hour: rawHour, minute };
}

/**
 * Parse only datetime shapes that identify one future instant. The returned
 * value is local wall-clock ISO (`YYYY-MM-DDTHH:mm`); calendar policy converts
 * it to UTC after applying business-hour and collision guards.
 */
export function parseProposedTime(body: string, nowIso: string, tz: string): string | null {
  const text = String(body ?? "").trim();
  const nowEpoch = Date.parse(nowIso);
  if (!text || !Number.isFinite(nowEpoch) || !tz.trim()) return null;
  const nowLocal = localParts(new Date(nowEpoch), tz);
  if (!nowLocal) return null;

  const explicit = parseLocalIso(text);
  if (explicit) {
    const instant = uniqueInstantForLocal(explicit, tz);
    return instant !== null && instant > nowEpoch ? localIso(explicit) : null;
  }

  if (MEETING_ACTION_RE.test(text) && !affirmativeMeetingMutation(text)) return null;
  if (
    APPROXIMATE_TIME_RE.test(text) ||
    MULTIPLE_CHOICE_TIME_RE.test(text) ||
    NEGATED_OR_CONDITIONAL_TIME_RE.test(text) ||
    UNPARSED_DATE_RE.test(text) ||
    EXPLICIT_TIME_ZONE_RE.test(text) ||
    isHistoricalActionQuestion(text) ||
    isRetractedOrNearAction(text) ||
    isDeliberativeOrConditionalAction(text)
  ) return null;
  const explicitClockTokens = [...text.matchAll(
    /\b(?:\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)(?![\p{L}\p{N}])/giu,
  )];
  if (explicitClockTokens.length !== 1) return null;
  const dateTokens = [...text.matchAll(/\b(today|tomorrow)\b/giu)];
  if (dateTokens.length !== 1) return null;
  const timeTokens = [...text.matchAll(
    /(?:\bat\b|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/giu,
  )];
  if (timeTokens.length !== 1) return null;
  const clock = parseClock(timeTokens[0][1], timeTokens[0][2], timeTokens[0][3]);
  if (!clock) return null;

  const date = shiftedLocalDate(nowLocal, dateTokens[0][1].toLowerCase() === "tomorrow" ? 1 : 0);
  const candidate: LocalMinute = { ...date, ...clock };
  const instant = uniqueInstantForLocal(candidate, tz);
  return instant !== null && instant > nowEpoch ? localIso(candidate) : null;
}

function result(
  intent: MeetingIntent,
  confidence: "high" | "low",
  proposedTime: ProposedMeetingTime | null = null,
): MeetingReplyClassification {
  return { intent, confidence, proposedTime };
}

function slotChoice(body: string, context: MeetingReplyContext): ProposedMeetingTime | null {
  if (context.state !== "awaiting_slot_choice") return null;
  const match = /^(\d{1,2})[.)]?$/u.exec(body.trim());
  if (!match) return null;
  const slot = context.proposedSlots?.[Number(match[1]) - 1];
  if (!slot || !parseLocalIso(slot)) return null;
  return { isoLocal: slot, source: "slot_choice" };
}

/** Label an inbound meeting reply without performing any action. */
export function classifyMeetingReply(
  body: string,
  context: MeetingReplyContext = {},
): MeetingReplyClassification {
  const text = String(body ?? "").trim();
  if (!text) return result("unknown", "low");
  const normalized = text.toLowerCase().replace(/\u2019/gu, "'");

  const selectedSlot = slotChoice(text, context);
  if (selectedSlot) return result("reschedule", "high", selectedSlot);
  if (/^\d{1,2}[.)]?$/u.test(text)) return result("unknown", "low");

  const stopBy = /\bstop\s+by\b/iu.test(normalized);
  const negatedMeetingAction =
    /\b(?:(?:do|did|have|has|had|is|was|were|can|could|would|should|will)\s+not|cannot|\p{L}+n['’]t|never|not)\b[^.!?\n]{0,80}\b(?:cancell?(?:ed|ing)?|call(?:ed|ing)?\s+off|reschedul(?:e|ed|ing)|mov(?:e|ed|ing)|chang(?:e|ed|ing)|(?:different|another|new)\s+(?:the\s+)?(?:date|time|slot))\b/iu.test(normalized);
  const historicalActionQuestion = isHistoricalActionQuestion(normalized);
  const retractedOrNearAction = isRetractedOrNearAction(normalized);
  const deliberativeOrConditionalAction = isDeliberativeOrConditionalAction(normalized);
  const contactSignalText = stopBy
    ? normalized.replace(/\bstop\s+by\b/giu, "visit")
    : normalized;
  if (MEETING_CANCEL_WITH_EXPLICIT_OPTOUT_RE.test(contactSignalText)) {
    return result("opt_out", "high");
  }
  if (MEETING_CANCEL_SCHEDULING_FOLLOW_UP_RE.test(normalized)) {
    return result("cancel", "high");
  }
  const contactRevocation =
    /\b(?:stop|cancel|remove|unsubscribe|opt\s*-?\s*out)\b[\s\S]{0,30}\b(?:texts?|texting|messages?|messaging|contact|list)\b/iu.test(normalized) ||
    /\b(?:do\s+not|don't|never)\s+(?:text|message|contact|call)\s+me\b/iu.test(normalized);

  if (contactRevocation) return result("opt_out", "high");
  const optOutText = stopBy ? text.replace(/\bstop\s+by\b/giu, "visit") : text;
  const optOut = detectOptOut(optOutText);
  const bareCancelCommand = /^(?:please\s+)?cancel(?:\s+please)?[.!?]*$/iu.test(normalized);
  if (optOut.optOut && (optOut.matched !== "cancel" || bareCancelCommand)) {
    return result("opt_out", "high");
  }
  if (
    negatedMeetingAction ||
    historicalActionQuestion ||
    retractedOrNearAction ||
    deliberativeOrConditionalAction
  ) {
    const asksForVerification = !retractedOrNearAction && (
      /\?/u.test(text) ||
      /\b(?:confirm|check|verify)\b/iu.test(normalized) ||
      /\b(?:(?:need|want)\s+to\s+know|need\s+(?:information|details|help)(?:\s+on)?)\s+how\s+to\b/iu.test(normalized)
    );
    return result(asksForVerification ? "question" : "unknown", asksForVerification ? "high" : "low");
  }

  const affirmativeMutation = affirmativeMeetingMutation(normalized);
  if (affirmativeMutation === "reschedule") {
    const isoLocal = context.nowIso && context.timeZone
      ? parseProposedTime(text, context.nowIso, context.timeZone)
      : null;
    const source: ProposedMeetingTime["source"] = LOCAL_ISO_RE.test(text)
      ? "explicit_datetime"
      : "relative_datetime";
    return result(
      "reschedule",
      "high",
      isoLocal ? { isoLocal, source } : null,
    );
  }

  if (affirmativeMutation === "cancel") return result("cancel", "high");

  if (isAffirmativeRunningLate(normalized)) return result("running_late", "high");

  if (
    /\?/u.test(text) ||
    /^(?:who|what|when|where|why|how|can|could|would|do|does|is|are)\b/iu.test(normalized) ||
    /\b(?:send|share|need)\b[\s\S]{0,30}\b(?:meet|meeting|link|details|address)\b/iu.test(normalized)
  ) return result("question", "high");

  if (
    /^(?:yes|yep|yeah|confirmed?|sounds good|see you(?: then)?|looking forward(?: to it)?|(?:that|it) works(?: for me)?|works for me)(?:[\s!.]|$)/iu.test(normalized)
  ) return result("confirm", "high");

  return result("unknown", "low");
}
