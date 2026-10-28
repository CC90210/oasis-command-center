/**
 * System health's Platform vitals strip (2026-10-28): the Command Center's own numbers over the last
 * 24 hours, one KpiTile each (lib/admin/platform-vitals.ts). A tile that cannot read its source says
 * so; it is never a zero. Server component.
 */
import { KpiTile, type KpiStatus } from "@/components/os/KpiTile";
import type { PlatformVitals, Vital } from "@/lib/admin/platform-vitals";

/** KpiTile's status for a vital: the same four states, by name. */
function statusOf(v: Vital<unknown>): KpiStatus {
  return v.state === "live" ? "live" : v.state;
}

/** The Command Center's own numbers, over the last 24 hours (lib/admin/platform-vitals.ts). */
export function VitalsStrip({ vitals }: { vitals: PlatformVitals }) {
  const { databaseMs, ai24h, browserErrors24h, checks24h, worker24h } = vitals;
  return (
    <section aria-label="Platform vitals" className="space-y-3">
      <h2 className="text-sm font-semibold text-fg">Platform vitals</h2>
      <p className="text-[13px] leading-5 text-fg-muted">
        The Command Center itself, over the last 24 hours. A tile that cannot read its source says so; it is never a zero.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          label="Database"
          value={databaseMs.state === "live" ? `${databaseMs.value} ms` : null}
          status={statusOf(databaseMs)}
          hint={databaseMs.state === "not_connected" ? databaseMs.reason : "One round trip to Turso, just now"}
        />
        <KpiTile
          label="AI calls"
          value={ai24h.state === "live" ? ai24h.value.calls.toLocaleString("en-US") : null}
          status={statusOf(ai24h)}
          emptyText="No AI calls"
          hint={
            ai24h.state === "live"
              ? `${ai24h.value.failed} failed${ai24h.value.p50Ms !== null ? ` · median ${ai24h.value.p50Ms.toLocaleString("en-US")} ms` : ""}`
              : "Every metered call your agents made"
          }
        />
        <KpiTile
          label="Browser errors"
          value={browserErrors24h.state === "live" ? browserErrors24h.value.toLocaleString("en-US") : null}
          status={statusOf(browserErrors24h)}
          hint="Crashes a browser reported from a Command Center page"
        />
        <KpiTile
          label="Health checks"
          value={checks24h.state === "live" ? `${checks24h.value.failing.toLocaleString("en-US")} failing` : null}
          status={statusOf(checks24h)}
          emptyText="No checks ran"
          hint={checks24h.state === "live" ? `${checks24h.value.ok.toLocaleString("en-US")} ok · ${checks24h.value.degraded.toLocaleString("en-US")} degraded` : "The automated checks' runs"}
        />
        <KpiTile
          label="Worker requests"
          value={worker24h.state === "live" ? worker24h.value.requests.toLocaleString("en-US") : null}
          status={statusOf(worker24h)}
          hint={
            worker24h.state === "live"
              ? `${worker24h.value.errors.toLocaleString("en-US")} errors · CPU ${worker24h.value.cpuP50Ms} ms median, ${worker24h.value.cpuP99Ms} ms p99`
              : worker24h.state === "not_connected"
                ? worker24h.reason
                : "Cloudflare's own count for this Worker"
          }
        />
      </div>
    </section>
  );
}

