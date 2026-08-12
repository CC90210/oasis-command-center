/**
 * scripts/smoke-drips-render.ts — server-render the Drips views with REAL
 * production data and assert on the HTML.
 *
 * WHAT THIS COVERS THAT THE DATA SUITE DOES NOT. smoke-drips-suite.ts proves
 * the rules and the persistence. This proves the components survive contact
 * with the real data SHAPES — a null channel, a missing lead name, a sequence
 * with no volume, an unparseable timestamp. A render crash is a blank page, and
 * a blank page is indistinguishable from "nothing happened", which is the
 * failure this whole surface exists to end.
 *
 * It is not a substitute for clicking through the signed-in UI. It cannot see
 * layout, hydration, or the PATCH round trip.
 *
 * Run: npx tsx scripts/smoke-drips-render.ts
 */

import { execFileSync } from "node:child_process";
import Module from "node:module";

// next/navigation only exists inside a Next request. Stub it BEFORE the
// components are imported, so useRouter() resolves to an inert object.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: unknown })._load = function (request: string, ...rest: unknown[]) {
  if (request === "next/navigation") {
    return { useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/sequences" };
  }
  return (load as (...a: unknown[]) => unknown).call(this, request, ...rest);
};

const DB = "bravo-empire";
const TURSO = "C:/Users/echel/JARVIS/scripts/turso_sql.mjs";
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const TZ = process.env.OPERATOR_TIMEZONE || "America/Toronto";

let pass = 0;
const fails: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fails.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

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
      /* count line */
    }
  }
  return rows;
}
const q = (s: unknown) => `'${String(s).replace(/'/g, "''")}'`;
const jparse = <T,>(v: unknown, fb: T): T => {
  if (typeof v !== "string") return (v as T) ?? fb;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fb;
  }
};

async function main(): Promise<void> {
  const React = (await import("react")).default;
  // Next compiles JSX with the automatic runtime; outside Next, tsx falls back
  // to the classic one, which expects `React` in lexical scope. Putting it on
  // globalThis BEFORE the components load is what makes them importable here.
  (globalThis as unknown as { React: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DripActivityView } = await import("../components/sequences/DripActivityView");
  const { SequenceVolumeView } = await import("../components/sequences/SequenceVolumeView");
  const { OutcomeChecksPanel } = await import("../components/health/OutcomeChecksPanel");
  const { classifyRunStatus, summarizeFailures, isHeldForPolicy } = await import("../lib/drips/activity-core");
  const { bucketBySequenceDay, joinVolumeToSequences, sequenceNameFromSource } = await import(
    "../lib/drips/sequence-volume-core"
  );
  const { toPanelRows } = await import("../lib/health/panel-core");

  const render = (el: React.ReactElement): string => renderToStaticMarkup(el);

  console.log("DRIPS RENDER SMOKE — real production data through the real components\n");

  // ── Activity view ────────────────────────────────────────────────────────
  console.log("=== Activity view ===");
  {
    const runs = sql<Record<string, unknown>>(
      `select id, lead_id, sequence_name, step_index, channel, status, from_identity, last_error, sent_at, scheduled_for
       from drip_runs where tenant_id = ${q(TENANT)}
       and (sent_at >= datetime('now','-7 days') or (sent_at is null and scheduled_for >= datetime('now','-7 days')))
       limit 300`,
    );
    const rows = runs.map((r) => ({
      id: String(r.id),
      leadId: String(r.lead_id),
      leadName: null,
      sequenceName: (r.sequence_name as string) ?? null,
      stepIndex: typeof r.step_index === "number" ? r.step_index : null,
      channel: (r.channel as string) ?? null,
      brand: "sunbiz",
      status: classifyRunStatus(r as never),
      rawStatus: (r.status as string) ?? null,
      fromIdentity: (r.from_identity as string) ?? null,
      error: (r.last_error as string) ?? null,
      heldForPolicy: isHeldForPolicy(r.last_error),
      sentAt: (r.sent_at as string) ?? null,
      scheduledFor: (r.scheduled_for as string) ?? null,
    }));
    const summary = { ...summarizeFailures(runs as never), heldForPolicy: 0, truncated: false };

    const html = render(React.createElement(DripActivityView, { rows, summary }) as React.ReactElement);
    check("Activity renders with real rows", html.length > 500, `${html.length} chars, ${rows.length} rows`);
    check("the tiles are labelled with their window", html.includes("Sent (24h)") && html.includes("Failure rate (24h)"));
    check("the table header renders", html.includes("Outcome") && html.includes("Sequence"));
    check("no React error boundary text", !/error|undefined is not/i.test(html.slice(0, 200)));

    // A read failure must look DIFFERENT from a quiet window.
    const failed = render(
      React.createElement(DripActivityView, {
        rows: [],
        summary: { realSends: 0, failed: 0, skipped: 0, dryRun: 0, failureRatePct: null, heldForPolicy: 0 },
        readError: "could not read drip activity",
      }) as React.ReactElement,
    );
    check("a failed read renders as UNKNOWN", /UNKNOWN, not empty|could not be read/i.test(failed));
    const quiet = render(
      React.createElement(DripActivityView, {
        rows: [],
        summary: { realSends: 0, failed: 0, skipped: 0, dryRun: 0, failureRatePct: null, heldForPolicy: 0 },
      }) as React.ReactElement,
    );
    check("a quiet window renders as a finding, not a blank", /No drip steps in this window/i.test(quiet));
    check("the two are visibly different", failed !== quiet);

    // Truncation must be visible.
    const trunc = render(
      React.createElement(DripActivityView, {
        rows,
        summary: { ...summary, truncated: true },
      }) as React.ReactElement,
    );
    check("a truncated summary says so", /partial sample|floor, not a total/i.test(trunc));
  }

  // ── Volume view ──────────────────────────────────────────────────────────
  console.log("\n=== Volume view ===");
  {
    const raw = sql<{ agent_source: string | null; created_at: string | null; metadata: string | null }>(
      `select agent_source, created_at, metadata from lead_interactions
       where tenant_id = ${q(TENANT)} and type='email_sent' and direction='outbound'
       and agent_source like 'sequence:%' and created_at >= datetime('now','-15 days') limit 5000`,
    );
    const vols = bucketBySequenceDay(
      raw.map((r) => {
        const md = jparse<Record<string, unknown>>(r.metadata, {});
        return {
          sequenceId: typeof md.sequence_id === "string" ? md.sequence_id : null,
          sequenceName: sequenceNameFromSource(r.agent_source),
          at: r.created_at || "",
          dryRun: String(md.dry_run) === "true",
        };
      }),
      { days: 14, timeZone: TZ, nowMs: Date.now() },
    );
    const seqs = sql<{ id: string; name: string; enabled: number; daily_email_cap: number | null }>(
      `select id, name, enabled, daily_email_cap from drip_sequences where tenant_id = ${q(TENANT)}`,
    ).map((s) => ({ id: s.id, name: s.name, enabled: Number(s.enabled) === 1, daily_email_cap: s.daily_email_cap }));
    const rows = joinVolumeToSequences(seqs, vols);

    const html = render(
      React.createElement(SequenceVolumeView, { rows, days: 14, timeZone: TZ }) as React.ReactElement,
    );
    check("Volume renders with real sequences", html.length > 500, `${html.length} chars, ${rows.length} rows`);
    check("every sequence name appears", seqs.every((s) => html.includes(s.name.replace(/&/g, "&amp;"))),
      seqs.filter((s) => !html.includes(s.name.replace(/&/g, "&amp;"))).map((s) => s.name).join(",") || "all");
    const rects = (html.match(/<rect/g) || []).length;
    check("bars are drawn for real volume", rects >= 14 * vols.length, `${rects} rects`);
    check("a cap input is rendered per live sequence", (html.match(/type="number"/g) || []).length >= seqs.length - 1);
    check("uncapped rows say uncapped", html.includes("uncapped"));

    // With a cap set, the line and the remaining count must appear.
    const capped = rows.map((r, i) => (i === 0 ? { ...r, cap: 5 } : r));
    const capHtml = render(
      React.createElement(SequenceVolumeView, { rows: capped, days: 14, timeZone: TZ }) as React.ReactElement,
    );
    check("a cap draws its line on the chart", (capHtml.match(/<line/g) || []).length > 0);
    check("a cap shows what is left today", /left|held until tomorrow/i.test(capHtml));

    // Zero cap = held.
    const zero = rows.map((r, i) => (i === 0 ? { ...r, cap: 0 } : r));
    check(
      "a cap of 0 reads as held, not as an error",
      /held until tomorrow/i.test(
        render(React.createElement(SequenceVolumeView, { rows: zero, days: 14, timeZone: TZ }) as React.ReactElement),
      ),
    );

    // A read failure must warn AGAINST setting a cap from a blank chart.
    const err = render(
      React.createElement(SequenceVolumeView, {
        rows: [],
        days: 14,
        timeZone: TZ,
        readError: "volume read failed: connection reset",
      }) as React.ReactElement,
    );
    check("a failed volume read says the bars are UNKNOWN", /UNKNOWN, not zero/i.test(err));
    check("and warns against setting a cap from it", /do not set a cap/i.test(err));
  }

  // ── Health panel ─────────────────────────────────────────────────────────
  console.log("\n=== Outcome checks panel ===");
  {
    const runs = sql<Record<string, unknown>>(
      `select check_id, verdict, observed, baseline, reason, ran_at from health_check_runs
       where tenant_id = ${q(TENANT)} order by ran_at desc limit 400`,
    );
    const latest = new Map<string, ReturnType<typeof Object>>();
    for (const r of runs) {
      const id = String(r.check_id);
      if (latest.has(id)) continue;
      latest.set(id, {
        checkId: id,
        verdict: String(r.verdict),
        observed: typeof r.observed === "number" ? r.observed : null,
        baseline: typeof r.baseline === "number" ? r.baseline : null,
        reason: (r.reason as string) ?? null,
        ranAt: (r.ran_at as string) ?? null,
      });
    }
    const panelRows = toPanelRows([...latest.values()] as never, Date.now());
    console.log(`  distinct checks with a result: ${panelRows.length}`);

    const alerts = sql<Record<string, unknown>>(
      `select alert_key, first_failed_at, last_alerted_at, repeat_n from health_alert_state
       where tenant_id = ${q(TENANT)} and first_failed_at is not null limit 50`,
    ).map((a) => ({
      alertKey: String(a.alert_key),
      firstFailedAt: (a.first_failed_at as string) ?? null,
      lastAlertedAt: (a.last_alerted_at as string) ?? null,
      repeatN: Number(a.repeat_n ?? 0),
    }));
    console.log(`  open alerts: ${alerts.length}`);

    const html = render(
      React.createElement(OutcomeChecksPanel, {
        rows: panelRows,
        openAlerts: alerts,
        readFailed: false,
        readError: null,
        now: Date.now(),
      }) as React.ReactElement,
    );
    check("the panel renders", html.includes("Outcome checks"));
    check(
      "it says something concrete, not an empty shell",
      panelRows.length === 0 ? /No check has ever recorded a result/i.test(html) : html.includes("Verdict"),
      `${panelRows.length} checks`,
    );

    const blind = render(
      React.createElement(OutcomeChecksPanel, {
        rows: [],
        openAlerts: [],
        readFailed: true,
        readError: "checks: connection reset",
        now: Date.now(),
      }) as React.ReactElement,
    );
    check("a blind panel says it is blind", /blind right now|treat it as unknown/i.test(blind));
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) console.log("failing:\n  - " + fails.join("\n  - "));
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("RENDER SMOKE ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
