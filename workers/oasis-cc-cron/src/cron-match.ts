/**
 * Minimal cron-expression matcher for the oasis-cc-cron companion worker.
 * Five UTC fields: minute hour dom month dow. Supports "*", "*\/n", lists,
 * ranges, and plain values — the full grammar used by vercel.json's 28
 * entries, verbatim. Standard cron rule: when BOTH dom and dow are
 * restricted, the date matches if EITHER does.
 */

function partMatches(part: string, value: number): boolean {
  if (part === "*") return true;
  const step = part.match(/^\*\/(\d+)$/);
  if (step) return value % Number(step[1]) === 0;
  const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
  if (range) {
    const [lo, hi, st] = [Number(range[1]), Number(range[2]), Number(range[3] || 1)];
    return value >= lo && value <= hi && (value - lo) % st === 0;
  }
  return Number(part) === value;
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((p) => partMatches(p, value));
}

export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`bad cron expression: ${expr}`);
  const [min, hour, dom, mon, dow] = fields;
  const m = fieldMatches(min, at.getUTCMinutes());
  const h = fieldMatches(hour, at.getUTCHours());
  const mo = fieldMatches(mon, at.getUTCMonth() + 1);
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const d = fieldMatches(dom, at.getUTCDate());
  const w = fieldMatches(dow, at.getUTCDay());
  const dateOk = domRestricted && dowRestricted ? d || w : d && w;
  return m && h && mo && dateOk;
}
