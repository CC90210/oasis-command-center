/**
 * The research a rep needs before they dial, on the lead profile itself.
 *
 * Every one of these values was already stored on the lead and already
 * rendered on /web-leads — but /pipeline/[id] showed name, company, email
 * and phone and nothing else, so a rep opening the deal they were told to
 * call saw no site, no audit, no industry. The instruction directly below
 * this band reads "Review the website audit, then make the first call" and
 * pointed at a page that never displayed one. This is that audit.
 *
 * Renders nothing when a lead carries none of these keys, so SunBiz / MCA
 * leads (which use MCAProfilePanel) don't grow an empty card.
 */

import { ExternalLink } from "lucide-react";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { nonEmptyString } from "@/lib/format-helpers";

/**
 * The OSM importer writes `webdev_industry`; the manifest form writes
 * `industry`. lib/web-leads/data.ts already reads them as one field —
 * matching it here keeps the same lead from showing an industry on one
 * screen and a blank on the other.
 */
function readIndustry(data: Record<string, unknown>): string | null {
  return nonEmptyString(data.webdev_industry) || nonEmptyString(data.industry);
}

function readLocation(data: Record<string, unknown>): string | null {
  const city = nonEmptyString(data.business_city);
  const state = nonEmptyString(data.state);
  if (city && state) return `${city}, ${state}`;
  return city || state;
}

export function LeadWebsiteAuditBand({ data }: { data: Record<string, unknown> }) {
  const rawWebsite = nonEmptyString(data.website);
  const websiteHref = preferredSiteUrl(rawWebsite);
  const industry = readIndustry(data);
  const location = readLocation(data);
  const icpTrack = nonEmptyString(data.icp_track);

  // Defaults mirror lib/web-leads/data.ts: an un-researched lead says so
  // rather than rendering a blank the rep has to interpret.
  const condition = nonEmptyString(data.website_condition);
  const findings = nonEmptyString(data.audit_findings);

  // Nothing website-shaped on this lead — this band isn't for it.
  if (!rawWebsite && !condition && !findings && !industry && !icpTrack) return null;

  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] uppercase tracking-wider text-fg-dim">Website</span>
        {websiteHref ? (
          /* rel="noopener noreferrer": these are prospect sites we don't
             control, and without it the opened page can reach back through
             window.opener. */
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-panel px-2.5 py-1 text-xs font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            {rawWebsite}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs text-fg-muted">{rawWebsite || "No site on file"}</span>
        )}
        {icpTrack && (
          <span className="rounded-full border border-bg-border px-2 py-0.5 text-[11px] text-fg-muted">
            {icpTrack}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AuditCell label="Site condition" value={condition || "Not checked"} />
        <AuditCell label="Industry" value={industry || "—"} />
        <AuditCell label="Location" value={location || "—"} />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-fg-dim">Audit findings</div>
        <p className="mt-1 text-sm leading-relaxed text-fg">
          {findings || "Not audited yet - confirm on the call"}
        </p>
      </div>
    </div>
  );
}

function AuditCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-fg-dim">{label}</div>
      <div className="mt-0.5 truncate text-sm text-fg" title={value}>
        {value}
      </div>
    </div>
  );
}
