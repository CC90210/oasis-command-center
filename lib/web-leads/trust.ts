/**
 * trust.ts — can this battle card's score be stood behind, and if not, why.
 *
 * ═══ THE MANDATE (Adon, 2026-09-01) ═════════════════════════════════════════
 *
 * "Right now they're going to trust whatever they see on the battle card...
 * If you can't scrape certain data, or you can't really score the website,
 * or if you're uncertain, then you don't generate information. You just say
 * it." Per his explicit decision: a score we cannot stand behind is HIDDEN
 * and the card says why in plain words, with the re-check action beside the
 * explanation -- never a number wearing a warning label.
 *
 * ═══ WHAT THIS MODULE JUDGES, AND FROM WHAT ═════════════════════════════════
 *
 * Everything here derives from STORED data the crawler actually recorded --
 * the same discipline as check-evidence.ts. Nothing fetches, nothing guesses
 * beyond the one documented heuristic:
 *
 *   hide `shell_suspect` — the raw source had almost no readable text but
 *     plenty of machinery (wordCount < 40 AND (blockingScripts >= 3 OR page
 *     over 150 KB)). That is the fingerprint of a browser-built site
 *     (Wix/Squarespace/React) that our raw-HTTP crawler cannot read: the
 *     score is arithmetic over an empty shell, and the 2026-09-01 sweep
 *     counted 549 of these (2.4% of the corpus). HEURISTIC, stated as such,
 *     until the crawler stores real shell markers; a truly-thin site (low
 *     words, little machinery) keeps its score -- that thinness IS the pitch.
 *
 *   hide `rejected_url` — verification concluded this website is NOT this
 *     business's site. Every number on the card would be about a stranger.
 *
 *   warn `unverified_url` — verification has not confirmed ownership
 *     (verdict `review` or `unknown`). This is the DEFAULT state for ~99% of
 *     the corpus today (202 verified of ~27k), so the wording is calm and
 *     factual, not an alarm.
 *
 *   warn `stale` — measured more than 90 days ago; the site may have changed.
 *     (Corpus is currently all fresh; this is the trap for next quarter.)
 *
 * Rule 1 unchanged: trust states carry no verdict colours. The hidden-score
 * panel is a sentence, the warnings are words.
 */

import type { AuditResult } from "./audit";
import type { UrlVerification } from "./audit";

export const STALE_AFTER_DAYS = 90;

export type TrustAssessment = {
  /** null = the score (or non-scored sentence) may render as-is. */
  hide: null | {
    reason: "shell_suspect" | "rejected_url";
    /** Hand-written, rep-facing. */
    headline: string;
    detail: string;
  };
  /** Rendered as lines on the measurement-honesty strip, worst first. */
  warnings: { code: "stale" | "unverified_url"; line: string }[];
};

const num = (s: Record<string, unknown> | null, key: string): number | null => {
  const v = s ? s[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** The shell fingerprint, from stored signals only. Exported for tests. */
export function isShellSuspect(signals: Record<string, unknown> | null): boolean {
  const words = num(signals, "wordCount");
  if (words === null || words >= 40) return false;
  const scripts = num(signals, "blockingScripts");
  const bytes = num(signals, "bytes");
  return (scripts !== null && scripts >= 3) || (bytes !== null && bytes > 150_000);
}

export function assessTrust(input: {
  audit: AuditResult;
  signals: Record<string, unknown> | null;
  urlVerification: UrlVerification;
  /** Injected clock so tests never depend on the wall. */
  now?: Date;
}): TrustAssessment {
  const { audit, signals, urlVerification } = input;
  const warnings: TrustAssessment["warnings"] = [];

  // Rejected ownership hides EVERYTHING scored or measured about the site --
  // wrong site beats every other consideration.
  if (urlVerification.verdict === "rejected") {
    return {
      hide: {
        reason: "rejected_url",
        headline: "The website we measured has been flagged as NOT this business's site.",
        detail:
          "Ownership verification rejected this link, so every measurement on file is about someone else's website. " +
          "Nothing is shown because nothing on file is about this business. If you know their real website, paste it below and re-check.",
      },
      warnings,
    };
  }

  if (audit.state === "scored") {
    if (isShellSuspect(signals)) {
      return {
        hide: {
          reason: "shell_suspect",
          headline: "We could not measure this site honestly, so no score is shown.",
          detail:
            "This site builds its page in the browser, and our crawler reads only the raw page source, " +
            "so it saw an almost empty shell. Scoring that would punish the business for how the site is built, " +
            "not for what a visitor sees. Re-check below, or verify the site by eye before saying anything about it.",
        },
        warnings,
      };
    }

    const measured = Date.parse(audit.measuredAt);
    const now = (input.now ?? new Date()).getTime();
    if (Number.isFinite(measured)) {
      const days = Math.floor((now - measured) / 86_400_000);
      if (days > STALE_AFTER_DAYS) {
        const months = Math.max(1, Math.round(days / 30));
        warnings.push({
          code: "stale",
          line: `Measured ${months} ${months === 1 ? "month" : "months"} ago. The site may have changed since; re-check before quoting anything from this card.`,
        });
      }
    }
  }

  if (urlVerification.verdict === "review" || urlVerification.verdict === "unknown") {
    warnings.push({
      code: "unverified_url",
      line:
        urlVerification.verdict === "review"
          ? "This website's ownership is queued for human review and has not been confirmed as this business's site."
          : "Nobody has confirmed this website actually belongs to this business. The link came from a public directory anyone can edit.",
    });
  }

  return { hide: null, warnings };
}

const trustModule = { assessTrust, isShellSuspect, STALE_AFTER_DAYS };
export default trustModule;
