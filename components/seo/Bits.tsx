import type { SiteStatus } from "@/lib/seo/types";
import { MISSING, STATUS_LABEL, type Change } from "@/lib/seo/format";

/** An unknown value. Screen readers hear "no data", never a dash. */
export function Missing({ label = "no data" }: { label?: string }) {
  return (
    <span className="text-fg-dim">
      <span aria-hidden>{MISSING}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A change with its sign; colour is never the only signal. */
export function ChangeCell({ change, none = "no prior data" }: { change: Change | null; none?: string }) {
  if (!change) return <Missing label={none} />;
  const tone = change.tone === "good" ? "text-status-engaged" : change.tone === "bad" ? "text-status-hot" : "text-fg-muted";
  return (
    <span className={`tabular-nums ${tone}`}>
      <span aria-hidden>{change.text}</span>
      <span className="sr-only">{change.sr}</span>
    </span>
  );
}

const STATUS_STYLE: Record<SiteStatus, { glyph: string; tone: string }> = {
  current: { glyph: "●", tone: "text-status-engaged" },
  collecting: { glyph: "◐", tone: "text-status-info" },
  waiting: { glyph: "○", tone: "text-fg-muted" },
  behind: { glyph: "▲", tone: "text-status-warm" },
  access_removed: { glyph: "■", tone: "text-status-hot" },
};

/** Glyph carries the colour, the word carries the meaning. */
export function StatusBadge({ status }: { status: SiteStatus }) {
  const s = STATUS_STYLE[status] ?? { glyph: "?", tone: "text-fg-muted" };
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-fg">
      <span aria-hidden className={s.tone}>{s.glyph}</span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * Why the measurement service could not be read, in words with the one action that fixes it.
 * The reason codes are lib/seo/client.ts's (SeoUnavailable) and lib/seo/occ.ts's. Before this
 * the banner said the same sentence for every cause and claimed a monitor that did not exist.
 */
export function unavailableWords(reason: string | undefined): { what: string; action: string } {
  if (!reason) return { what: "The measurement service did not answer.", action: "Try again in a minute." };
  if (reason === "no_worker_context") return { what: "This page is running outside the Cloudflare Worker (local dev), where the SEO service binding does not exist.", action: "Open it on oasisai.work." };
  if (reason === "binding_missing") return { what: "The Worker has no SEO_MEASURE service binding.", action: "Check wrangler.jsonc's services entry and redeploy." };
  if (reason === "read_key_missing") return { what: "The Worker has no SEO_READ_TOKEN secret (or it is shorter than 32 characters).", action: "Set SEO_READ_TOKEN on the Worker; the measurement service's read key." };
  if (reason === "manage_key_missing") return { what: "The Worker has no SEO_MANAGE_TOKEN secret, so sites cannot be added or checked.", action: "Set SEO_MANAGE_TOKEN on the Worker; reads still work." };
  if (reason === "timeout") return { what: "The measurement service took longer than allowed.", action: "Try again; if it repeats, the service is overloaded or down." };
  if (reason === "unreachable") return { what: "The measurement service could not be reached through the binding.", action: "Check that the oasis-seo-measure Worker is deployed." };
  if (/^40[13]_/.test(reason)) return { what: `The measurement service refused the key (${reason}).`, action: "The read or manage token on this Worker does not match the service's. Rotate one to match the other." };
  if (/^404_/.test(reason)) return { what: "The measurement service has no such site.", action: "Add the site again, or pick it from the list." };
  if (/^5\d\d_|^bad_response_5/.test(reason)) return { what: `The measurement service answered with an error (${reason}).`, action: "Its logs name the cause; try again in a few minutes." };
  if (reason === "bad_shape" || /^bad_response_/.test(reason)) return { what: `The measurement service answered in a shape this page does not read (${reason}).`, action: "The two deployments disagree; update the older one." };
  return { what: `The measurement service did not answer (${reason}).`, action: "Try again in a minute." };
}

export function UnavailableBanner({ reason }: { reason?: string }) {
  const words = unavailableWords(reason);
  return (
    <div role="alert" className="mt-6 rounded-lg border border-status-warm/40 bg-bg-panel px-4 py-3 text-sm">
      <strong className="font-semibold text-fg">SEO data unavailable.</strong>{" "}
      <span className="text-fg-muted">{words.what} Nothing here is a zero: it is unknown.</span>{" "}
      <span className="text-fg">{words.action}</span>
    </div>
  );
}
