/**
 * lib/health/deploy-checks.ts — is production serving what GitHub says it
 * should be?
 *
 * WHY. On 2026-08-18 21:08Z a LOCAL branch (fix/automations-turnkey, never
 * pushed to GitHub) was CLI-deployed straight to production. It was built from
 * a base before PRs #224/#225, so the freshly-shipped blocked-application
 * alarm silently vanished from prod for 4.7 hours — discovered only because a
 * smoke test 401'd. GitHub main and production had diverged and nothing
 * noticed.
 *
 * HOW. This check runs ON the serving deployment, so it can simply read its
 * own birth certificate: Vercel stamps every git-built deployment with
 * VERCEL_GIT_COMMIT_REF (the rogue deploy identified itself this way). No
 * GitHub or Vercel credential enters the runtime — deliberately: an admin
 * token in the web app to "verify git" would be a far worse risk than the gap
 * it closes. The one case this cannot see — an OLD main commit redeployed —
 * is reviewed, merged, main-lineage code: a rollback, not a hijack.
 */

import "server-only";
import type { DripCheck } from "./drip-checks";
import {
  deploymentGitRef,
  deploymentGitSha,
  deploymentIsDirty,
  isProductionRuntime,
} from "./runtime-environment";

/** How far back the alerting check looks for undelivered pages. */
const DELIVERY_WINDOW_MS = 6 * 3_600_000;

export const DEPLOY_CHECKS: DripCheck[] = [
  {
    /**
     * Somebody has to read the rows that say the alert channel is broken.
     *
     * `runner.ts` writes an `alerting.telegram_delivery` row every time a lane
     * refuses a page, on the DATABASE path, precisely so a dead channel cannot
     * hide behind itself. Three separate comments in that file describe this as
     * the backstop that turns a dead lane into an alert of its own.
     *
     * It was not. Nothing read those rows. `alerting.telegram_delivery`
     * appeared in no check list, so the rows accumulated in a table nobody
     * graded — a guarantee asserted in a comment and enforced by nothing,
     * which is worse than no guarantee, because it was believed.
     *
     * This is the reader. It is not circular: one lane dying is caught by the
     * other, and the run summary is in the database either way.
     */
    id: "alerting.delivery_failures",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    // Both lanes. A delivery failure is about the alerting system itself, and
    // whichever audience CAN still be reached is the one that must hear it.
    lane: ["operator", "sunbiz-ops"],
    observe: async (db, tenantId, endMs) => {
      try {
        const r = await db
          .from("health_check_runs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("check_id", "alerting.telegram_delivery")
          .gte("ran_at", new Date(endMs - DELIVERY_WINDOW_MS).toISOString())
          .lt("ran_at", new Date(endMs).toISOString());
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} page(s) in the last 6h could not be delivered to at least one lane. ` +
      `Read the \`reason\` column of health_check_runs where check_id = ` +
      `'alerting.telegram_delivery': it names the lanes that refused and says whether ` +
      `ANY lane took the message. A lane that keeps refusing is usually the bot removed ` +
      `from that chat — Telegram gives a bot no way to re-add itself, so a human must. ` +
      `Until then every alert for that audience is being written to a table and to nobody.`,
  },
  {
    id: "deploy.prod_serves_main",
    severity: "critical",
    // Estate-wide: production serving the wrong commit affects every company
    // on the platform, not the one whose tenant happened to be graded. It had
    // been inheriting the runner's sunbiz-ops default, so an OASIS-only
    // regression would have paged the client's ops channel and nobody else.
    lane: ["operator", "sunbiz-ops"],
    rule: { kind: "must_be_zero" },
    // Env is read at OBSERVE time, not module load, so tests can vary it and
    // a long-lived process cannot capture a stale value.
    observe: async () => {
      // Only the PRODUCTION deployment is doctrine-bound to main. Previews
      // serve branches by design, and local dev has no Vercel identity —
      // grading those would be a standing false alarm.
      if (!isProductionRuntime()) return 0;
      const ref = deploymentGitRef();
      // No git identity at all is the WORST case, not a pass: it means a
      // local working tree was CLI-deployed with no repo metadata.
      if (!ref) return 1;
      // A CLI deploy of a checkout WITH uncommitted changes claims its
      // branch's name while serving contents that exist nowhere in git
      // (Codex P1): Vercel stamps that case VERCEL_GIT_DIRTY=true. Only the
      // literal "true" fails — the var is absent on GitHub-triggered builds.
      if (deploymentIsDirty()) return 1;
      return ref === "main" ? 0 : 1;
    },
    describe: (r) => {
      const ref = deploymentGitRef();
      const sha = (deploymentGitSha() || "").slice(0, 8);
      if (r.observed === 0) return `production is serving main (${sha || "sha unknown"}).`;
      const dirty = deploymentIsDirty();
      return (
        `PRODUCTION IS NOT SERVING MAIN — this deployment was built from ` +
        (ref
          ? dirty
            ? `a DIRTY checkout of "${ref}" (uncommitted changes — these contents exist nowhere in git)`
            : `branch "${ref}"`
          : `a tree with NO git identity (CLI deploy of a local working tree)`) +
        (sha ? ` at ${sha}` : "") +
        `. Whatever main shipped after that base is silently OFF prod right now ` +
        `(this exact condition removed the blocked-application alarm for 4.7h on 2026-08-18). ` +
        `Find who deployed it, land their change via PR, and redeploy main.`
      );
    },
  },
];
