/**
 * lib/skills/view.ts - the Skills tab's pure view logic (JARVIS Skills Training plan 3).
 * No I/O and no React: every number and phrase the screens show is computed here, so tests pin
 * it without a browser. Safe to import from client components (type-only imports from contract).
 */
import type { LabelRow, Op, TestRecord } from "./contract";

export type Rank = "use-first" | "also-helps";
export type LibrarySkill = {
  name: string; description: string; kind: "installed" | "library"; quarantined: boolean;
  capabilities: string[]; example_prompts: { prompt: string; adds: string }[];
  /** null = this computer never sent a record for it: "not tested, no evidence". */
  tests: TestRecord | null;
};
export type Library = {
  skills: LibrarySkill[];
  labels: LabelRow[];
  assignments: { skill: string; label: string; rank: Rank }[];
  kinds: Record<string, TestRecord>;
  /** The latest updated_at among this computer's skills_kind_score rows, or null when there are none. */
  records_at: string | null;
};
export type Computer = {
  id: string; display_name: string; primary: boolean; revoked: boolean; rebuild_requested: boolean;
  last_checkin_at: string | null; last_checkin_outcome: string | null; last_checkin_detail: string | null;
};
export type ChangeRow = {
  change_id: string; computer_id: string; status: string; reason: string; worse: number; better: number;
  totals: Record<string, { n: number; before: number; after: number }>;
  updated_at: string; description: string; author: string; scope: string; created_at: string; ops: Op[];
};
export type Tile = { id: string; title: string; long: string; skills: number; score: TestRecord | null; subs: { id: string; name: string; skills: number }[] };
export type Member = { skill: LibrarySkill; rank: Rank; labels: string[] };
export type Hit = { kind: "skill"; name: string; detail: string } | { kind: "group"; id: string; name: string; detail: string };
export type Action = { kind: "use-first" | "also-helps" | "remove"; skill: string; label: string };
export type NewChange = { description: string; scope: string; ops: Op[] };
export type TrainingLists = { held: ChangeRow[]; failed: ChangeRow[]; waiting: ChangeRow[]; applied: ChangeRow[] };
export type TotalsRow = { id: string; name: string; n: number; before: number; after: number; delta: number };

/** Plain-English tile names per kind of work (spec section 6: "Fix something broken", not "debug"). */
export const KIND_TITLES: Record<string, string> = {
  "ui-build": "Build a screen or page",
  "data-viz": "Charts and dashboards",
  "backend-api": "Servers, APIs and databases",
  "data-scrape": "Pull data from websites",
  research: "Research a question",
  "analysis-stats": "Analyse data and statistics",
  "docs-report-deck": "Write a doc, report or deck",
  "video-media": "Video, audio and images",
  "sales-offer": "Sell, price and pitch",
  "deploy-infra": "Ship and run it",
  debug: "Fix something broken",
  "new-feature-plan": "Plan a new feature",
  "feature-teardown": "Copy how another app does it",
  "repo-ingest": "Learn from a repo",
  "skill-agent-authoring": "Write skills and agents",
  "knowledge-recall": "Find what we already know",
};

export function kindTitle(l: LabelRow): string {
  return KIND_TITLES[l.id] ?? l.name;
}

export function labelNames(lib: Library): Map<string, string> {
  return new Map(lib.labels.map((l) => [l.id, l.level === "broad" ? kindTitle(l) : l.name]));
}

export function members(lib: Library, kindId: string, subId: string | null): Member[] {
  const subs = lib.labels.filter((l) => l.level === "sub" && l.parent === kindId).map((l) => l.id);
  const ids = new Set(subId ? [subId] : [kindId, ...subs]);
  const skills = new Map(lib.skills.map((s) => [s.name, s]));
  const bySkill = new Map<string, Member>();
  for (const a of lib.assignments) {
    if (!ids.has(a.label)) continue;
    const skill = skills.get(a.skill);
    if (!skill) continue;   // labelled but not on this computer: the next check-in prunes it
    const m = bySkill.get(a.skill) ?? { skill, rank: a.rank, labels: [] };
    if (a.rank === "use-first") m.rank = "use-first";
    m.labels.push(a.label);
    bySkill.set(a.skill, m);
  }
  const order = (r: Rank) => (r === "use-first" ? 0 : 1);
  return [...bySkill.values()].sort((x, y) => order(x.rank) - order(y.rank) || x.skill.name.localeCompare(y.skill.name));
}

export function tiles(lib: Library): Tile[] {
  return lib.labels.filter((l) => l.level === "broad").map((b) => {
    const subs = lib.labels.filter((l) => l.level === "sub" && l.parent === b.id);
    const score = lib.kinds[b.id] && lib.kinds[b.id].n > 0 ? lib.kinds[b.id] : null;
    return {
      id: b.id, title: kindTitle(b), long: b.name, skills: members(lib, b.id, null).length, score,
      subs: subs.map((s) => ({ id: s.id, name: s.name, skills: members(lib, b.id, s.id).length })),
    };
  });
}

export function sortTiles(list: Tile[], by: "biggest" | "weakest"): Tile[] {
  const rate = (t: Tile) => (t.score ? t.score.ok / t.score.n : Number.POSITIVE_INFINITY);
  return [...list].sort((a, b) => (by === "biggest" ? b.skills - a.skills : rate(a) - rate(b)) || a.title.localeCompare(b.title));
}

/**
 * Task 7 fix round 1: a sub-label chip selected under one kind of work must not keep filtering
 * once the screen jumps to a different kind (a skill-sheet group link, a Ctrl K group hit) without
 * going through the back button that used to be the only thing clearing it. `chip` only means
 * something when it names one of `tile`'s own sub-labels; otherwise it is stale and ignored.
 */
export function activeChip(tile: Tile | null, chip: string | null): string | null {
  if (!tile || !chip) return null;
  return tile.subs.some((s) => s.id === chip) ? chip : null;
}

export function groupsOf(lib: Library, skill: string): { id: string; name: string; rank: Rank; level: "broad" | "sub" }[] {
  const names = labelNames(lib);
  const levels = new Map(lib.labels.map((l) => [l.id, l.level]));
  return lib.assignments
    .filter((a) => a.skill === skill && levels.has(a.label))
    .map((a) => ({ id: a.label, name: names.get(a.label) ?? a.label, rank: a.rank, level: levels.get(a.label) === "sub" ? "sub" : "broad" }));
}

/**
 * Task 8 fix round 1: the skill sheet's "Add to a group" select keeps its chosen id in React
 * state (`addTo`), set once from `addable[0]` on first render. If the SAME mounted SkillSheetBody
 * is later shown a different skill or library (name/lib change without a remount - e.g. the sheet
 * stays open while a different row is opened from underneath it), the stored id can point at a
 * label that is no longer one of THIS skill's addable options. A plain controlled `<select
 * value={addTo}>` with no matching `<option>` silently falls back to showing the first option
 * while `addTo` itself still holds the stale id - so Add would send the OLD id even though the
 * screen shows the new first option selected. This derives the one value both the select and the
 * Add button must use: the stored choice when it is still a real option, otherwise the first
 * addable option (or "" when there are none), exactly matching what the select itself visibly
 * shows.
 */
export function addToValue(addable: { id: string }[], addTo: string): string {
  return addable.some((l) => l.id === addTo) ? addTo : (addable[0]?.id ?? "");
}

export function testLine(t: TestRecord | null): { text: string; tested: boolean } {
  if (!t || t.n === 0) return { text: "Not tested, no evidence", tested: false };
  return { text: `${t.ok} of ${t.n} test prompts routed here`, tested: true };
}

/**
 * One square per test prompt, up to `max`. When the count is scaled down, the ok share is
 * FLOORED, never rounded (D5) - rounding up can turn a real miss (ok=99 of n=100) into a row of
 * solid green squares, which reads as a perfect score that never happened. Flooring a share that
 * is strictly less than 1 always lands below the scaled length, so a real miss always draws at
 * least one miss square without a separate clamp. Below the cap, `ok` is used as-is rather than
 * re-derived through a ratio: `(t.ok / t.n) * n` divides BEFORE it multiplies, and plain
 * floating-point division can land a hair under the true integer (15/22 * 22 computes to
 * 14.999999999999998, not 15), silently under-counting a pass that actually happened. Scaled
 * down (t.n > max), the multiply happens before the divide for the same reason.
 */
export function squares(t: TestRecord | null, max = 40): ("ok" | "miss")[] {
  if (!t || t.n === 0) return [];
  const n = Math.min(t.n, max);
  const ok = t.n <= max ? t.ok : Math.floor((t.ok * max) / t.n);
  return Array.from({ length: n }, (_, i) => (i < ok ? "ok" : "miss"));
}

export function scoreText(s: TestRecord | null): string {
  return s && s.n > 0 ? `${s.ok} of ${s.n}` : "Not tested yet";
}

const TZ = "America/Toronto";
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNum = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
// Node's ICU puts U+202F (narrow no-break space) before AM/PM, not a plain space; the Worker
// bundle check (tests/worker-source-one-byte.test.ts) refuses any regex literal with a
// character above U+00FF, so it is written as an escape here rather than typed literally.
const timeOf = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\u202f/g, " ").toLowerCase();

/**
 * D4: "today" and "yesterday" are Toronto CALENDAR dates, not a raw hour count. A pure hour
 * threshold mis-reads a check-in that crosses two midnights in under 26 hours (e.g. 11:30 pm two
 * nights ago, read at 12:30 am) as "today" or "yesterday" when it is really two calendar days
 * back. Anything that is neither today's nor yesterday's Toronto date reads "N day(s) ago" and is
 * always stale; the hour cap still guards the rare case where the SAME calendar date is more than
 * 26 hours old (practically never, but never allowed to print a false "Checked in at <time>").
 *
 * `diff` is computed ONCE from the two calendar-date strings via `dayNum` (the same pattern
 * `recordsAgeLine` uses), never from subtracting a literal 24 hours of wall-clock milliseconds.
 * Toronto observes DST: the day of a spring-forward is 23 hours and the day of a fall-back is 25,
 * so "now minus 24h" can land on the WRONG calendar date on either transition day, making a real
 * "yesterday" check-in miss the comparison and fall through to a wrong "N days ago".
 */
export function statusLine(lastIso: string | null, now: Date): { text: string; stale: boolean } {
  if (!lastIso) return { text: "Not checked in yet", stale: true };
  const at = new Date(lastIso);
  const hours = (now.getTime() - at.getTime()) / 3600e3;
  const todayDay = dayOf(now);
  const atDay = dayOf(at);
  const diff = Math.round(dayNum(todayDay) - dayNum(atDay));
  if (diff === 0 && hours <= 26) return { text: `Checked in at ${timeOf(at)}`, stale: false };
  if (diff === 1 && hours <= 26) return { text: `Checked in yesterday at ${timeOf(at)}`, stale: false };
  const days = Math.max(1, diff);
  return { text: `Last checked in ${days} day${days === 1 ? "" : "s"} ago`, stale: true };
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * Task 4 ruling: when this computer's test records are older than its latest check-in (Toronto
 * calendar date), say so in plain English so a stale "3 of 4" never reads as current evidence.
 * Null when there is nothing to compare (no records yet, or no check-in yet) and null on the same
 * day, because "not tested yet" is already said elsewhere and a same-day record needs no caveat.
 */
export function recordsAgeLine(recordsAt: string | null, lastCheckinAt: string | null): string | null {
  if (!recordsAt || !lastCheckinAt) return null;
  const recordsDay = dayOf(new Date(recordsAt));
  const checkinDay = dayOf(new Date(lastCheckinAt));
  if (dayNum(recordsDay) >= dayNum(checkinDay)) return null;
  return `Test record from ${shortDate(recordsAt)}`;
}

export function training(changes: ChangeRow[], computerId: string, now: Date): TrainingLists {
  const mine = changes.filter((c) => c.computer_id === computerId);
  const week = now.getTime() - 7 * 24 * 3600e3;
  const recent = (c: ChangeRow) => Date.parse(c.updated_at) >= week;
  const newest = (a: ChangeRow, b: ChangeRow) => b.updated_at.localeCompare(a.updated_at);
  return {
    held: mine.filter((c) => c.status === "held").sort(newest),
    failed: mine.filter((c) => c.status === "failed" && recent(c)).sort(newest),
    waiting: mine.filter((c) => c.status === "waiting" || c.status === "accepted-anyway").sort(newest),
    applied: mine.filter((c) => c.status === "applied" && recent(c)).sort(newest).slice(0, 10),
  };
}

export function totalsRows(c: ChangeRow, lib: Library): TotalsRow[] {
  const names = labelNames(lib);
  return Object.entries(c.totals)
    .map(([id, t]) => ({ id, name: names.get(id) ?? KIND_TITLES[id] ?? id, n: t.n, before: t.before, after: t.after, delta: t.after - t.before }))
    .sort((a, b) => a.delta - b.delta || a.name.localeCompare(b.name));
}

export function opText(op: Op, names: Map<string, string>): string {
  const n = (v: unknown) => names.get(String(v)) ?? KIND_TITLES[String(v)] ?? String(v);
  switch (op.op) {
    case "assign": return `Put ${op.skill} in ${n(op.label)} as ${op.rank === "use-first" ? "use first" : "also helps"}`;
    case "unassign": return `Take ${op.skill} out of ${n(op.label)}`;
    case "add-sub": return `New sub-label "${op.name}" under ${n(op.parent)}`;
    case "edit-sub": return `Edit the sub-label ${n(op.id)}`;
    case "remove-sub": return `Remove the sub-label ${n(op.id)}`;
    case "rename": return `Rename ${n(op.id)} to "${op.name}"`;
    default: return `Change: ${op.op}`;
  }
}

/**
 * Flip one op. D3 cascades BOTH ways: unticking an add-sub also unticks every op that places a
 * skill into that new sub-label (you cannot keep assigning a skill to a label that will not
 * exist); ticking an op whose label names an unticked add-sub re-ticks that add-sub (you cannot
 * assign into a label without also creating it).
 */
export function toggleOp(ops: Op[], keep: boolean[], i: number): boolean[] {
  const next = [...keep];
  next[i] = !next[i];
  const op = ops[i];
  if (op.op === "add-sub" && !next[i]) {
    ops.forEach((o, j) => { if (o.label === op.id) next[j] = false; });
  }
  if (next[i] && typeof op.label === "string") {
    ops.forEach((o, j) => { if (o.op === "add-sub" && o.id === op.label) next[j] = true; });
  }
  return next;
}

/**
 * D10: editing a held change appends "(edited)" so Training can tell a revised change from the
 * original at a glance. Strips an exact trailing marker first, so editing an already-edited
 * change never grows "(edited) (edited)" - a mid-string lookalike (not at the end) is left alone,
 * since that is part of the description itself, not a marker this function added.
 *
 * Fix round 1 (task 9) #3: the base is sliced to `300 - suffix.length` BEFORE the suffix is
 * appended, not the other way around. Slicing the already-concatenated string to 300 can cut
 * partway through the suffix itself on a long description (a 295-character base plus the 9-
 * character suffix is 304 characters, and a plain `.slice(0, 300)` on that keeps only the first
 * 5 of the suffix's 9 characters - `"...x (edi"` - a visibly broken marker, not a truncated one).
 * Slicing the base first guarantees the full suffix always survives and the total never exceeds 300.
 */
export function markEdited(description: string): string {
  const suffix = " (edited)";
  const base = description.endsWith(suffix) ? description.slice(0, -suffix.length) : description;
  return `${base.slice(0, 300 - suffix.length)}${suffix}`;
}

/**
 * Fix round 1 (task 9) #1/#2: what a failed `/api/skills` call should say, in plain English, never
 * a raw HTTP status, a snake_case error code, or contract/validation developer text - all of which
 * the server legitimately returns (`not_found`, `storage_not_ready`, `rate_limited`, "ops[0].label
 * must be a kebab-case id") but none of which are fit for Adon to read. `status === undefined`
 * means `fetch` itself never got a response (a thrown network error, not a server answer) - that
 * reads differently from a server that DID answer, just not with success. The one status Training
 * tells apart is 409/"not_held": a Reject or Edit landing on a change that already moved on
 * (accepted, rejected or edited by someone else, or by this same computer's own check-in) - every
 * other failure collapses to one generic sentence.
 */
export function actionErrorMessage(e: { status?: number; code?: string; message?: string } | null | undefined): string {
  if (!e || e.status === undefined) return "Could not reach the command center.";
  if (e.status === 409 || e.code === "not_held") return "This change is no longer held.";
  return "Something went wrong on the server.";
}

/**
 * `key` identifies WHICH announcement this is, not WHEN it happened: two "pending" states for the
 * SAME queued edit (description) always carry the same key, so the toast element SkillsTab
 * renders never remounts on a re-announce. A re-announce happens on Ruling C4 - when an older
 * edit's in-flight send settles while a newer edit is still queued, the queue (actions.ts) re-
 * announces the newer edit's own "pending" state so its Undo toast stays the last word, not the
 * older edit's "sent"/"error". If the toast element remounted on that re-announce, any mount-tied
 * countdown or entrance motion would restart for an edit that was never actually re-queued - a
 * cosmetic lie about how much time is left before it sends. Keying on (kind, description) instead
 * of a counter means the SAME edit's toast is reused in place; a genuinely different announcement
 * (a different edit, or the same edit moving to a different kind of state) gets a different key
 * and legitimately swaps. Lives here (not in the "use client" SkillsTab.tsx) so it stays testable
 * with no React import chain, the same reason actions.ts carries no React import either.
 *
 * Fix round 1 (review, IMPORTANT - wrong data): a "pending" state can carry `message`, the text
 * of an OLDER edit's send that just failed (actions.ts's `fire()` re-announces the newer edit's
 * own pending state when a stale in-flight send settles while it is still queued, and for a
 * REJECTED settle it attaches that stale failure as `message` so it is not lost). Showing only
 * "Queued: <newer edit>" with the older failure silently dropped reads as "the older edit must
 * have saved fine" when it did not - the user believes something was saved that was not. Said
 * plainly, in the SAME toast (never a separate one, which could be missed), with the SAME key
 * (the older edit's failure is not itself a new announcement of THIS edit, so it must not restart
 * this edit's own countdown).
 */
export type Toast = { key: string; tone: "ok" | "error"; text: string; undo: boolean } | null;

export function toastFor(s: { kind: "pending" | "sending" | "sent" | "undone" | "error"; description: string; message?: string }): Toast {
  switch (s.kind) {
    case "pending": {
      const queued = `Queued: ${s.description}. Goes live after tonight's check.`;
      const text = s.message ? `The earlier edit did not save: ${s.message}. Nothing changed for it. ${queued}` : queued;
      return { key: `pending:${s.description}`, tone: "ok", text, undo: true };
    }
    case "sending": return { key: `sending:${s.description}`, tone: "ok", text: `Sending: ${s.description}.`, undo: false };
    case "sent": return { key: `sent:${s.description}`, tone: "ok", text: `Waiting for tonight's check: ${s.description}.`, undo: false };
    case "undone": return { key: "undone", tone: "ok", text: "Undone. Nothing was sent.", undo: false };
    case "error": return { key: `error:${s.description}`, tone: "error", text: `Could not queue "${s.description}": ${s.message ?? "unknown error"}. Nothing changed.`, undo: false };
  }
}

export function changeFor(a: Action, names: Map<string, string>, scope: string): NewChange {
  const where = names.get(a.label) ?? a.label;
  if (a.kind === "remove") {
    return { description: `Take ${a.skill} out of ${where}`.slice(0, 300), scope, ops: [{ op: "unassign", skill: a.skill, label: a.label }] };
  }
  return {
    description: `Put ${a.skill} in ${where} as ${a.kind === "use-first" ? "use first" : "also helps"}`.slice(0, 300),
    scope, ops: [{ op: "assign", skill: a.skill, label: a.label, rank: a.kind }],
  };
}

/** Only the primary computer's owner edits the shared map (spec decision 5); anyone else edits their own computer. */
export function scopeFor(c: Computer): string {
  return c.primary ? "shared" : c.id;
}

export function search(lib: Library, tileList: Tile[], q: string, limit = 8): Hit[] {
  const s = q.trim().toLowerCase();
  if (!s) return tileList.slice(0, limit).map((t) => ({ kind: "group", id: t.id, name: t.title, detail: `${t.skills} skills` }));
  const weight = (text: string) => {
    const t = text.toLowerCase();
    if (t.startsWith(s)) return 3;
    if (t.includes(` ${s}`) || t.includes(`-${s}`) || t.includes(`:${s}`)) return 2;
    return t.includes(s) ? 1 : 0;
  };
  const hits: { hit: Hit; w: number }[] = [];
  for (const t of tileList) {
    const w = Math.max(weight(t.title), weight(t.long) ? 1 : 0);
    if (w) hits.push({ hit: { kind: "group", id: t.id, name: t.title, detail: `${t.skills} skills` }, w: w + 0.5 });
  }
  for (const k of lib.skills) {
    const w = Math.max(weight(k.name) * 2, weight(k.description) ? 1 : 0);
    if (w) hits.push({ hit: { kind: "skill", name: k.name, detail: k.description.slice(0, 90) }, w });
  }
  return hits.sort((a, b) => b.w - a.w || a.hit.name.localeCompare(b.hit.name)).slice(0, limit).map((h) => h.hit);
}
