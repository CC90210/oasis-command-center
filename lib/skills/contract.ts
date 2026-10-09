/**
 * lib/skills/contract.ts - the Skills Training check-in contract (JARVIS plan 2).
 *
 * The PC (JARVIS scripts/skills_training/checkin.mjs) and the /api/skills routes agree on these
 * shapes. Every field is allowlisted: an unknown key is refused, so a PC bug can never smuggle a
 * raw prompt or a file path in under a new name. The PC refuses first (skill_payload.mjs); this
 * is the second fence. Enum values live here, not in CHECK constraints (SQLite cannot ALTER one).
 */
export const CHANGE_STATUSES = ["waiting", "applied", "held", "failed", "accepted-anyway", "rejected"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export const PULLABLE = ["waiting", "accepted-anyway"] as const;
export type Pullable = (typeof PULLABLE)[number];
/** The moves the PC may make from a status it pulled. */
export const PC_TRANSITIONS: Record<Pullable, readonly ChangeStatus[]> = {
  waiting: ["applied", "held", "failed"],
  "accepted-anyway": ["applied", "failed"],
};
export const RUN_OUTCOMES = ["applied", "held", "failed", "nothing-to-do"] as const;
export const RANKS = ["use-first", "also-helps"] as const;
export const DECISIONS = ["accept-anyway", "reject"] as const;
export const PRUNE_WHY = ["not installed on this computer", "quarantined"] as const;
export const MAX_BODY_BYTES = 2_000_000;
export const KEY_RE = /^skc_([a-z0-9-]{3,40})_([A-Za-z0-9_-]{43})$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** Absolute-path shapes: drive letter, home, UNC, unix roots. A URL's "https://" is not one. */
export const PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.])~[\\/]|\\\\[A-Za-z0-9]|(?<![\w:])\/(?:Users|home|srv|etc|var|tmp|opt|mnt)\//;

export class ContractError extends Error {}
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ContractError(`${where} must be an object`);
  return v as Record<string, unknown>;
}
function only(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ContractError(`${where}: unexpected field "${k}"`);
}
function text(v: unknown, max: number, where: string, nonEmpty = false): string {
  if (typeof v !== "string" || v.length > max || (nonEmpty && !v.trim())) throw new ContractError(`${where} must be text of at most ${max} characters`);
  if (PATH_RE.test(v)) throw new ContractError(`${where} contains a file path`);
  return v;
}
function id(v: unknown, where: string): string {
  const s = text(v, 80, where, true);
  if (!ID_RE.test(s)) throw new ContractError(`${where} must be a kebab-case id`);
  return s;
}
function list(v: unknown, max: number, where: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new ContractError(`${where} must be a list of at most ${max}`);
  return v;
}
function count(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100_000) throw new ContractError(`${where} must be a whole number`);
  return v;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ContractError(`${where} must be one of: ${allowed.join(", ")}`);
  return v as T;
}
function iso(v: unknown, where: string): string {
  if (typeof v !== "string" || !ISO_RE.test(v)) throw new ContractError(`${where} must be an ISO UTC time`);
  return v;
}
function parsed<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof ContractError) return { ok: false, error: e.message };
    throw e;
  }
}

export type SkillRow = {
  name: string; description: string; kind: "installed" | "library"; quarantined: boolean;
  capabilities: string[]; example_prompts: { prompt: string; adds: string }[];
};

export function parseSkillsPush(body: unknown): Parsed<{ skills_sha: string; skills: SkillRow[] }> {
  return parsed(() => {
    const b = obj(body, "body");
    only(b, ["skills_sha", "skills"], "body");
    const skillsSha = text(b.skills_sha, 64, "skills_sha", true);
    const seen = new Set<string>();
    const skills = list(b.skills, 2000, "skills").map((raw, i): SkillRow => {
      const w = `skills[${i}]`;
      const s = obj(raw, w);
      only(s, ["name", "description", "kind", "quarantined", "capabilities", "example_prompts"], w);
      const name = text(s.name, 120, `${w}.name`, true);
      if (seen.has(name)) throw new ContractError(`${w}.name ${name} appears twice`);
      seen.add(name);
      if (typeof s.quarantined !== "boolean") throw new ContractError(`${w}.quarantined must be true or false`);
      return {
        name,
        description: text(s.description, 1200, `${w}.description`),
        kind: oneOf(s.kind, ["installed", "library"] as const, `${w}.kind`),
        quarantined: s.quarantined,
        capabilities: list(s.capabilities, 3, `${w}.capabilities`).map((c, j) => text(c, 200, `${w}.capabilities[${j}]`, true)),
        example_prompts: list(s.example_prompts, 5, `${w}.example_prompts`).map((raw2, j) => {
          const e = obj(raw2, `${w}.example_prompts[${j}]`);
          only(e, ["prompt", "adds"], `${w}.example_prompts[${j}]`);
          return { prompt: text(e.prompt, 300, `${w}.example_prompts[${j}].prompt`, true), adds: text(e.adds, 300, `${w}.example_prompts[${j}].adds`, true) };
        }),
      };
    });
    return { skills_sha: skillsSha, skills };
  });
}

export type Op = { op: string; [field: string]: string | string[] };
const OP_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  assign: { required: ["skill", "label", "rank"], optional: [] },
  unassign: { required: ["skill", "label"], optional: [] },
  "add-sub": { required: ["id", "parent", "name", "meaning", "phrasings", "keywords", "examples"], optional: [] },
  "edit-sub": { required: ["id"], optional: ["name", "meaning", "phrasings", "keywords", "examples"] },
  "remove-sub": { required: ["id"], optional: [] },
  rename: { required: ["id", "name"], optional: [] },
};
const LIST_FIELDS = new Set(["phrasings", "keywords", "examples"]);
const ID_FIELDS = new Set(["id", "parent", "label"]);

function op(raw: unknown, i: number): Op {
  const w = `ops[${i}]`;
  const o = obj(raw, w);
  const kind = oneOf(o.op, Object.keys(OP_FIELDS), `${w}.op`);
  const spec = OP_FIELDS[kind];
  only(o, ["op", ...spec.required, ...spec.optional], w);
  const out: Op = { op: kind };
  for (const f of [...spec.required, ...spec.optional]) {
    if (!(f in o)) {
      if (spec.required.includes(f)) throw new ContractError(`${w} needs ${f}`);
      continue;
    }
    if (f === "rank") out[f] = oneOf(o[f], RANKS, `${w}.rank`);
    else if (LIST_FIELDS.has(f)) out[f] = list(o[f], 20, `${w}.${f}`).map((x, j) => text(x, 200, `${w}.${f}[${j}]`, true));
    else if (ID_FIELDS.has(f)) out[f] = id(o[f], `${w}.${f}`);
    else out[f] = text(o[f], f === "meaning" ? 300 : 120, `${w}.${f}`, true);
  }
  return out;
}

export function parseOps(v: unknown): Parsed<Op[]> {
  return parsed(() => list(v, 50, "ops").map(op));
}

export function parseNewChange(body: unknown): Parsed<{ description: string; scope: string; ops: Op[] }> {
  return parsed(() => {
    const b = obj(body, "body");
    only(b, ["description", "scope", "ops"], "body");
    const description = text(b.description, 300, "description", true);
    const scope = b.scope === "shared" ? "shared" : id(b.scope, "scope");
    const ops = list(b.ops, 50, "ops").map(op);
    if (!ops.length) throw new ContractError("a change needs at least one op");
    return { description, scope, ops };
  });
}

export type ReportResult = {
  change_id: string; pulled_status: Pullable; status: ChangeStatus; reason: string; worse: number; better: number;
  totals: Record<string, { n: number; before: number; after: number }>;
};
export type LabelRow = { id: string; level: "broad" | "sub"; parent: string | null; name: string; meaning: string; examples: string[] };
export type Report = {
  run: { started_at: string; finished_at: string; outcome: (typeof RUN_OUTCOMES)[number]; detail: string };
  results: ReportResult[];
  pruned: { skill: string; label: string; why: (typeof PRUNE_WHY)[number] }[];
  /** null = the PC withheld the snapshot (its guard refused a label text): leave the mirror as it is. */
  labels: { labels: LabelRow[]; assignments: { skill: string; label: string; rank: (typeof RANKS)[number] }[] } | null;
};

export function parseReport(body: unknown): Parsed<Report> {
  return parsed(() => {
    const b = obj(body, "body");
    only(b, ["run", "results", "pruned", "labels"], "body");
    const r = obj(b.run, "run");
    only(r, ["started_at", "finished_at", "outcome", "detail"], "run");
    const run = { started_at: iso(r.started_at, "run.started_at"), finished_at: iso(r.finished_at, "run.finished_at"),
      outcome: oneOf(r.outcome, RUN_OUTCOMES, "run.outcome"), detail: text(r.detail, 500, "run.detail") };
    const results = list(b.results, 500, "results").map((raw, i): ReportResult => {
      const w = `results[${i}]`;
      const x = obj(raw, w);
      only(x, ["change_id", "pulled_status", "status", "reason", "worse", "better", "totals"], w);
      const pulled = oneOf(x.pulled_status, PULLABLE, `${w}.pulled_status`);
      const status = oneOf(x.status, PC_TRANSITIONS[pulled], `${w}.status`);
      const totalsIn = obj(x.totals, `${w}.totals`);
      if (Object.keys(totalsIn).length > 40) throw new ContractError(`${w}.totals has too many kinds of work`);
      const totals: ReportResult["totals"] = {};
      for (const [k, v] of Object.entries(totalsIn)) {
        text(k, 80, `${w}.totals key`, true);
        const t = obj(v, `${w}.totals.${k}`);
        only(t, ["n", "before", "after"], `${w}.totals.${k}`);
        totals[k] = { n: count(t.n, `${w}.totals.${k}.n`), before: count(t.before, `${w}.totals.${k}.before`), after: count(t.after, `${w}.totals.${k}.after`) };
      }
      return { change_id: id(x.change_id, `${w}.change_id`), pulled_status: pulled, status, reason: text(x.reason, 500, `${w}.reason`),
        worse: count(x.worse, `${w}.worse`), better: count(x.better, `${w}.better`), totals };
    });
    const pruned = list(b.pruned, 500, "pruned").map((raw, i) => {
      const p = obj(raw, `pruned[${i}]`);
      only(p, ["skill", "label", "why"], `pruned[${i}]`);
      return { skill: text(p.skill, 120, `pruned[${i}].skill`, true), label: id(p.label, `pruned[${i}].label`), why: oneOf(p.why, PRUNE_WHY, `pruned[${i}].why`) };
    });
    if (b.labels === null) return { run, results, pruned, labels: null };
    const l = obj(b.labels, "labels");
    only(l, ["labels", "assignments"], "labels");
    const labelRows = list(l.labels, 400, "labels.labels").map((raw, i): LabelRow => {
      const w = `labels.labels[${i}]`;
      const x = obj(raw, w);
      only(x, ["id", "level", "parent", "name", "meaning", "examples"], w);
      return { id: id(x.id, `${w}.id`), level: oneOf(x.level, ["broad", "sub"] as const, `${w}.level`),
        parent: x.parent === null ? null : id(x.parent, `${w}.parent`), name: text(x.name, 120, `${w}.name`, true),
        meaning: text(x.meaning, 300, `${w}.meaning`), examples: list(x.examples, 10, `${w}.examples`).map((e, j) => text(e, 200, `${w}.examples[${j}]`, true)) };
    });
    const assignments = list(l.assignments, 5000, "labels.assignments").map((raw, i) => {
      const w = `labels.assignments[${i}]`;
      const x = obj(raw, w);
      only(x, ["skill", "label", "rank"], w);
      return { skill: text(x.skill, 120, `${w}.skill`, true), label: id(x.label, `${w}.label`), rank: oneOf(x.rank, RANKS, `${w}.rank`) };
    });
    return { run, results, pruned, labels: { labels: labelRows, assignments } };
  });
}
