/**
 * lib/drips/sequence-volume-core.ts — how many emails one SEQUENCE may send
 * per day, and how many it actually sent.
 *
 * Adon, 2026-08-11: "we need to be able to have a feature that's visual on how
 * many email drips are being sent out per sequence daily. You're able to see
 * that and change that."
 *
 * Two halves of one thing. The chart is not a report that happens to sit near
 * the control; it is the control's OWN METER. Which forces the rule below.
 *
 * ═══ THE COUNTING SOURCE IS NOT NEGOTIABLE ═══
 *
 * Volume is counted from `lead_interactions` (agent_source 'sequence:%'), the
 * SAME table the existing daily and hourly caps enforce against — never from
 * `drip_runs`, which is what the Activity tab reads.
 *
 * They are different numbers on purpose. governor.ts counts anything not
 * EXPLICITLY dry_run, because a second sender writes rows for the same
 * sequences: over 30 days the VPS send_gateway sent 105 emails this engine
 * never wrote, against 320 of its own. `drip_runs` cannot see those.
 *
 * So a chart drawn from drip_runs beside a cap enforced on lead_interactions
 * would disagree by exactly the mail the operator most needs to know about. He
 * sets 20, watches the chart reach 14, and the engine has already stopped. The
 * cap looks broken and the number looks wrong, and neither is.
 *
 * ═══ WHY IT IS KEYED ON ID, NOT NAME ═══
 *
 * agent_source is `sequence:<name>`. A name is editable in the sequence editor,
 * so keying volume on it means renaming a sequence silently resets its day to
 * zero and orphans its history — a cap that quietly stops applying is worse
 * than no cap.
 *
 * The email send path already stamps `metadata.sequence_id` (executor.ts), so
 * the durable key is there without touching the sender. The name stays as the
 * fallback for older rows and for any writer that does not set the id — a row
 * attributable by name alone still counts, because a send this cap cannot see
 * is a send it cannot limit.
 *
 * Pure: no I/O, no "server-only". The reads live in sequence-volume.ts.
 */

/** One counted send, reduced to what volume cares about. */
export type VolumeInteraction = {
  /** metadata.sequence_id when present — the durable key. */
  sequenceId?: string | null;
  /** Parsed from agent_source `sequence:<name>`. The fallback for older rows. */
  sequenceName?: string | null;
  /** ISO timestamp of the send. */
  at: string;
  /** Explicitly true only for a dry run. */
  dryRun?: boolean;
};

export type DayBucket = {
  /** Calendar day in the operator's zone, as YYYY-MM-DD. */
  day: string;
  count: number;
};

export type SequenceVolume = {
  /** The durable key when known, else `name:<name>` so an unmatched historical
   *  row is still attributable to something rather than silently dropped. */
  key: string;
  sequenceId: string | null;
  sequenceName: string | null;
  days: DayBucket[];
  /** Sends in the CURRENT day bucket — the number the cap acts on. */
  today: number;
  /** Highest single day in the window. Sets the chart's scale. */
  peak: number;
  total: number;
};

/**
 * `sequence:<name>` -> name. Anything else is not a drip send.
 *
 * A colon is legal inside a sequence name, so split only on the FIRST one.
 */
export function sequenceNameFromSource(source: unknown): string | null {
  const s = String(source ?? "");
  if (!s.startsWith("sequence:")) return null;
  const name = s.slice("sequence:".length).trim();
  return name || null;
}

/**
 * The calendar day an ISO timestamp falls in, in a named zone.
 *
 * Rolling 24h is right for the GLOBAL reputation caps (governor.ts) because
 * that is how Gmail enforces. It is wrong here: an operator setting "40 a day
 * for this sequence" means a day they can point at on a calendar, and a chart
 * of rolling windows has no bars to draw. So this cap is a CALENDAR day in the
 * operator's zone, and the difference is deliberate.
 *
 * Returns null on an unparseable stamp rather than defaulting to today, which
 * would attribute unknown sends to the current bucket and make the live number
 * — the one the cap reads — the least trustworthy on the chart.
 */
export function dayKey(iso: unknown, timeZone: string, nowMs?: number): string | null {
  const raw = iso === undefined || iso === null ? nowMs : iso;
  if (raw === undefined || raw === null) return null;
  const d = new Date(raw as string | number);
  if (Number.isNaN(d.getTime())) return null;
  try {
    // en-CA formats as YYYY-MM-DD, which sorts lexically as it sorts
    // chronologically — so buckets need no date parsing to order.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Every day in the window, oldest first, so a day with NO sends is a visible
 *  zero rather than a missing bar. A gap the chart does not draw reads as "no
 *  data"; a zero reads as "nothing sent", and those are different findings. */
export function dayWindow(days: number, timeZone: string, nowMs: number): string[] {
  const out: string[] = [];
  const n = Math.max(1, Math.min(90, Math.floor(days)));
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(new Date(nowMs - i * 86_400_000).toISOString(), timeZone);
    if (k) out.push(k);
  }
  return out;
}

/**
 * Group counted sends into per-sequence daily buckets.
 *
 * Dry runs are excluded, and — matching governor.ts exactly — ONLY an explicit
 * dry run is. A row from an unknown writer counts, so an unrecognised sender
 * makes the number bigger and the cap bite sooner, rather than disappearing.
 */
export function bucketBySequenceDay(
  rows: VolumeInteraction[],
  opts: { days: number; timeZone: string; nowMs: number },
): SequenceVolume[] {
  const window = dayWindow(opts.days, opts.timeZone, opts.nowMs);
  const inWindow = new Set(window);
  const today = window[window.length - 1];

  // ── Resolve name -> id BEFORE bucketing ─────────────────────────────────
  //
  // Measured on production 2026-08-11: 119 of 183 rows carried
  // metadata.sequence_id and 64 did not, because id stamping started partway
  // through the retained history. Keying each row on whatever it happened to
  // carry split ONE sequence across two lines ("Signed application — bank
  // statements nag" appeared twice, at 67 and 39) — and the same split hits the
  // cap, which reads the id's counter and would have missed everything filed
  // under the name. A sequence capped at 40 could have sent 40 under each key.
  //
  // So a name is folded into its id when the mapping is UNAMBIGUOUS. When one
  // name has belonged to two different sequences, nothing is merged: guessing
  // would attribute one sequence's mail to another, which is worse than showing
  // an extra row a human can recognise.
  const idsForName = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.dryRun === true) continue;
    if (!r.sequenceId || !r.sequenceName) continue;
    const set = idsForName.get(String(r.sequenceName)) ?? new Set<string>();
    set.add(String(r.sequenceId));
    idsForName.set(String(r.sequenceName), set);
  }
  const nameToId = new Map<string, string>();
  for (const [name, ids] of idsForName) {
    if (ids.size === 1) nameToId.set(name, [...ids][0]);
  }

  const byKey = new Map<string, { id: string | null; name: string | null; counts: Map<string, number> }>();

  for (const r of rows) {
    if (r.dryRun === true) continue;
    const name = r.sequenceName ? String(r.sequenceName) : null;
    const id = r.sequenceId ? String(r.sequenceId) : (name ? nameToId.get(name) ?? null : null);
    if (!id && !name) continue; // not attributable to a sequence at all
    const key = id || `name:${name}`;
    const day = dayKey(r.at, opts.timeZone);
    if (!day || !inWindow.has(day)) continue;

    let e = byKey.get(key);
    if (!e) {
      e = { id, name, counts: new Map() };
      byKey.set(key, e);
    }
    // A later row may carry the name where an earlier one did not, and vice
    // versa. Keep whichever is known so a sequence never renders unlabelled.
    if (!e.id && id) e.id = id;
    if (!e.name && name) e.name = name;
    e.counts.set(day, (e.counts.get(day) || 0) + 1);
  }

  const out: SequenceVolume[] = [];
  for (const [key, e] of byKey) {
    const days = window.map((d) => ({ day: d, count: e.counts.get(d) || 0 }));
    out.push({
      key,
      sequenceId: e.id,
      sequenceName: e.name,
      days,
      today: e.counts.get(today) || 0,
      peak: days.reduce((m, d) => Math.max(m, d.count), 0),
      total: days.reduce((s, d) => s + d.count, 0),
    });
  }
  // Busiest first: the sequence sending the most is the one whose cap matters.
  return out.sort((a, b) => b.total - a.total || String(a.sequenceName).localeCompare(String(b.sequenceName)));
}

// ── The cap itself ──────────────────────────────────────────────────────────

/** Ceiling on a per-sequence daily cap an operator may set through the UI.
 *  Not a safety limit — the brand ceilings in governor.ts are that — but a
 *  typo guard: 4000 in this box would be a slip, and the brand cap would stop
 *  it anyway, so refusing is free. */
export const MAX_SEQUENCE_DAILY_CAP = 2000;

export type CapVerdict = { ok: true; value: number | null } | { ok: false; reason: string };

/**
 * Validate a cap coming from the UI or the API.
 *
 * null means NO per-sequence cap: the brand ceilings still apply. That is the
 * default and today's behaviour exactly, so this ships inert.
 *
 * ZERO IS A REAL VALUE, and it is not null. It means "send nothing from this
 * sequence", which is a pause an operator may genuinely want without disabling
 * the sequence and losing its enrolments. Coercing 0 to null would turn "stop"
 * into "unlimited" — the single worst misreading available here.
 */
export function parseSequenceDailyCap(input: unknown): CapVerdict {
  if (input === null || input === undefined || input === "") return { ok: true, value: null };
  const n = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isFinite(n)) return { ok: false, reason: "daily cap must be a number, or empty for no cap" };
  if (!Number.isInteger(n)) return { ok: false, reason: "daily cap must be a whole number of emails" };
  if (n < 0) return { ok: false, reason: "daily cap cannot be negative (use 0 to send nothing)" };
  if (n > MAX_SEQUENCE_DAILY_CAP) {
    return { ok: false, reason: `daily cap above ${MAX_SEQUENCE_DAILY_CAP} is almost certainly a typo` };
  }
  return { ok: true, value: n };
}

/** How much of its own daily allowance a sequence has left. */
export function sequenceRemaining(sentToday: number, cap: number | null | undefined): number | null {
  if (cap === null || cap === undefined) return null; // uncapped
  return Math.max(0, cap - Math.max(0, sentToday));
}

/**
 * Join measured volume to the configured sequences, for the table.
 *
 * BOTH DIRECTIONS, and that is the point:
 *
 *   - A sequence with no sends still appears, at zero. "This sequence sent
 *     nothing today" is a finding — the four-day dispatcher outage in August
 *     looked exactly like this and no surface said so.
 *   - Volume with NO matching sequence still appears too, with a null id. Those
 *     are emails that reached real merchants under a sequence that has since
 *     been deleted or renamed. Hiding them would make the chart disagree with
 *     the brand ceiling for reasons nobody could see, and mail that went out is
 *     mail that went out.
 */
export function joinVolumeToSequences(
  sequences: Array<{ id: string; name: string; enabled?: boolean; daily_email_cap?: number | null }>,
  volumes: SequenceVolume[],
): Array<{
  sequenceId: string | null;
  name: string;
  cap: number | null;
  enabled: boolean;
  volume: SequenceVolume | null;
}> {
  const byId = new Map<string, SequenceVolume>();
  const byName = new Map<string, SequenceVolume>();
  for (const v of volumes) {
    if (v.sequenceId) byId.set(v.sequenceId, v);
    if (v.sequenceName) byName.set(v.sequenceName, v);
  }

  // TWO PASSES, and one is not enough. Resolving each sequence with
  // `byId ?? byName` in a single pass lets a sequence that merely INHERITED a
  // name pick up the renamed sequence's history — both would match the same
  // volume, and which one won would depend on array order. Every id match is
  // settled first, then names compete only for what is left.
  const claimed = new Set<SequenceVolume>();
  const matched = new Map<string, SequenceVolume>();
  for (const s of sequences) {
    const v = byId.get(s.id);
    if (v) {
      matched.set(s.id, v);
      claimed.add(v);
    }
  }
  for (const s of sequences) {
    if (matched.has(s.id)) continue;
    const v = byName.get(s.name);
    if (v && !claimed.has(v)) {
      matched.set(s.id, v);
      claimed.add(v);
    }
  }

  const rows = sequences.map((s) => ({
    sequenceId: s.id as string | null,
    name: s.name,
    cap: s.daily_email_cap ?? null,
    enabled: s.enabled !== false,
    volume: matched.get(s.id) ?? null,
  }));

  for (const v of volumes) {
    if (claimed.has(v)) continue;
    rows.push({
      sequenceId: null,
      name: v.sequenceName || v.sequenceId || "(unattributed)",
      cap: null,
      enabled: false,
      volume: v,
    });
  }

  // Busiest first, then by name. The sequence sending the most is the one whose
  // cap an operator came here to set.
  return rows.sort((a, b) => (b.volume?.total ?? 0) - (a.volume?.total ?? 0) || a.name.localeCompare(b.name));
}

/** Has this sequence used up its day? `null`/absent cap never blocks. */
export function sequenceCapReached(sentToday: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return false;
  return Math.max(0, sentToday) >= cap;
}
