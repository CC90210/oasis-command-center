/**
 * scripts/verify-sequence-volume.ts
 *
 * Run the REAL bucketing rules over REAL production rows and check that the
 * chart's numbers reconcile with a hand count.
 *
 * Why not just trust the unit tests: they run on fixtures I wrote, and a
 * fixture encodes the same assumption the code does. That is precisely how the
 * TextTorrent timezone bug survived twelve review rounds on 2026-08-09 — every
 * fixture agreed with the wrong belief. So this pulls actual rows from Turso
 * (bravo-empire, the live plane) and reconciles.
 *
 * Read-only. Uses scripts/turso_sql.mjs, so it needs no app runtime.
 *
 * Run:
 *   npx tsx scripts/verify-sequence-volume.ts
 */

import { execFileSync } from "node:child_process";
import {
  bucketBySequenceDay,
  sequenceNameFromSource,
  dayKey,
  type VolumeInteraction,
} from "../lib/drips/sequence-volume-core";

const DB = "bravo-empire";
const TURSO = "C:/Users/echel/JARVIS/scripts/turso_sql.mjs";
const TZ = process.env.OPERATOR_TIMEZONE || "America/Toronto";
const DAYS = 14;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** argv array, never a shell string: this interpolates nothing, but the rule
 *  holds regardless of today's inputs. */
function sql<T = Record<string, unknown>>(query: string): T[] {
  const out = execFileSync("node", [TURSO, "--db", DB, "--sql", query], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows: T[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(t) as T);
    } catch {
      /* the trailing "(n row(s))" line */
    }
  }
  return rows;
}

async function main(): Promise<void> {
  console.log(`per-sequence email volume — last ${DAYS} days, ${TZ}\n`);

  const raw = sql<{ agent_source: string | null; created_at: string | null; metadata: string | null }>(
    "select agent_source, created_at, metadata from lead_interactions " +
      "where type='email_sent' and direction='outbound' and agent_source LIKE 'sequence:%' " +
      `and created_at >= datetime('now','-${DAYS + 1} days') order by created_at desc limit 5000`,
  );
  console.log(`raw drip email rows pulled: ${raw.length}\n`);

  // Decode exactly as lib/turso-postgrest.ts fromSql does, so this harness sees
  // what the app sees. metadata is TEXT in libSQL; reading it as an object
  // without parsing would make every sequence_id undefined and silently push
  // attribution onto the editable NAME.
  const rows: VolumeInteraction[] = raw.map((r) => {
    let md: Record<string, unknown> = {};
    if (typeof r.metadata === "string") {
      try {
        md = JSON.parse(r.metadata) as Record<string, unknown>;
      } catch {
        md = {};
      }
    } else if (r.metadata && typeof r.metadata === "object") {
      md = r.metadata as Record<string, unknown>;
    }
    return {
      sequenceId: typeof md.sequence_id === "string" && md.sequence_id ? md.sequence_id : null,
      sequenceName: sequenceNameFromSource(r.agent_source),
      at: r.created_at || "",
      dryRun: String(md.dry_run) === "true",
    };
  });

  const withId = rows.filter((r) => r.sequenceId).length;
  console.log(`rows carrying metadata.sequence_id: ${withId}/${rows.length}`);
  // Not a failure if some lack it — the name fallback exists for exactly that —
  // but if NONE carry it, attribution rests entirely on an editable field and a
  // rename would silently reset a sequence's day.
  check("the durable key is present on at least some rows", rows.length === 0 || withId > 0);

  const nowMs = Date.now();
  const vols = bucketBySequenceDay(rows, { days: DAYS, timeZone: TZ, nowMs });

  console.log("\nper sequence:");
  for (const v of vols) {
    const spark = v.days.map((d) => (d.count === 0 ? "." : d.count > 9 ? "#" : String(d.count))).join("");
    console.log(
      `  ${String(v.total).padStart(4)}  today ${String(v.today).padStart(3)}  peak ${String(v.peak).padStart(3)}  ${spark}  ${v.sequenceName ?? v.key}`,
    );
  }

  // ── Reconciliation ───────────────────────────────────────────────────────
  // The bucketed total must equal a hand count of the same rows over the same
  // window. Counting the window here rather than trusting `raw.length`: the
  // query pulls DAYS+1 to avoid clipping the oldest calendar day for a
  // west-of-UTC operator, so the two differ legitimately.
  const inWindow = new Set(
    Array.from({ length: DAYS }, (_, i) => dayKey(new Date(nowMs - i * 86_400_000).toISOString(), TZ)),
  );
  const handCount = rows.filter((r) => !r.dryRun && (r.sequenceId || r.sequenceName) && inWindow.has(dayKey(r.at, TZ))).length;
  const bucketed = vols.reduce((s, v) => s + v.total, 0);
  check("bucketed total matches a hand count", bucketed === handCount, `${bucketed} vs ${handCount}`);

  // Today's number is the one the CAP reads, so it gets its own check.
  const todayKey = dayKey(new Date(nowMs).toISOString(), TZ);
  const handToday = rows.filter((r) => !r.dryRun && (r.sequenceId || r.sequenceName) && dayKey(r.at, TZ) === todayKey).length;
  const bucketedToday = vols.reduce((s, v) => s + v.today, 0);
  check("today matches a hand count", bucketedToday === handToday, `${bucketedToday} vs ${handToday}`);

  // Every sequence must expose exactly DAYS buckets, or the chart draws a
  // ragged axis and two sequences become impossible to compare by eye.
  check("every sequence has one bucket per day", vols.every((v) => v.days.length === DAYS));

  // Dry runs must not be counted: a rehearsal moves no bytes and must not
  // consume a real allowance.
  //
  // Asserted by DIFFERENCE, not by an inequality. The previous check was
  // `bucketed + dry <= rows.length`, which holds whether or not dry runs are
  // counted — `bucketed` already excludes every out-of-window row, and the
  // query deliberately pulls DAYS+1, so those rows supply all the slack the
  // inequality needs. It passed regardless of the property it named, which is
  // the same worthless reassurance this whole feature exists to remove.
  const dryInWindow = rows.filter((r) => r.dryRun && (r.sequenceId || r.sequenceName) && inWindow.has(dayKey(r.at, TZ)));
  console.log(`\ndry-run rows in window: ${dryInWindow.length} (of ${rows.filter((r) => r.dryRun).length} pulled)`);
  const withDry = bucketBySequenceDay(
    rows.map((r) => ({ ...r, dryRun: false })),
    { days: DAYS, timeZone: TZ, nowMs },
  ).reduce((s, v) => s + v.total, 0);
  check(
    "counting dry runs would change the total (so excluding them is doing work)",
    dryInWindow.length === 0 || withDry === bucketed + dryInWindow.length,
    `${withDry} with vs ${bucketed} without, ${dryInWindow.length} dry`,
  );
  check("no dry run reached a bucket", withDry - bucketed === dryInWindow.length);

  // ── The configured caps, and whether any sequence is over one ────────────
  const caps = sql<{ id: string; name: string; daily_email_cap: number | null }>(
    "select id, name, daily_email_cap from drip_sequences where NOT (daily_email_cap IS NULL)",
  );
  console.log(`\nsequences with a daily cap set: ${caps.length}`);
  for (const c of caps) {
    const v = vols.find((x) => x.sequenceId === c.id || x.sequenceName === c.name);
    const today = v?.today ?? 0;
    const cap = Number(c.daily_email_cap);
    console.log(`  ${c.name}: ${today}/${cap} today`);
    // Over the cap is not necessarily a bug — a cap lowered mid-day is honoured
    // going forward, not retroactively — but it should be visible, not silent.
    if (today > cap) console.log(`     (over cap; the engine holds further sends until tomorrow)`);
  }

  console.log(failures === 0 ? "\nVOLUME VERIFIED AGAINST PRODUCTION" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
