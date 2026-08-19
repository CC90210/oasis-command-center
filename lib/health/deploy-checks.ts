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

export const DEPLOY_CHECKS: DripCheck[] = [
  {
    id: "deploy.prod_serves_main",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    // Env is read at OBSERVE time, not module load, so tests can vary it and
    // a long-lived process cannot capture a stale value.
    observe: async () => {
      // Only the PRODUCTION deployment is doctrine-bound to main. Previews
      // serve branches by design, and local dev has no Vercel identity —
      // grading those would be a standing false alarm.
      if (process.env.VERCEL_ENV !== "production") return 0;
      const ref = process.env.VERCEL_GIT_COMMIT_REF;
      // No git identity at all is the WORST case, not a pass: it means a
      // local working tree was CLI-deployed with no repo metadata.
      if (!ref) return 1;
      return ref === "main" ? 0 : 1;
    },
    describe: (r) => {
      const ref = process.env.VERCEL_GIT_COMMIT_REF;
      const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 8);
      if (r.observed === 0) return `production is serving main (${sha || "sha unknown"}).`;
      return (
        `PRODUCTION IS NOT SERVING MAIN — this deployment was built from ` +
        (ref ? `branch "${ref}"` : `a tree with NO git identity (CLI deploy of a local working tree)`) +
        (sha ? ` at ${sha}` : "") +
        `. Whatever main shipped after that base is silently OFF prod right now ` +
        `(this exact condition removed the blocked-application alarm for 4.7h on 2026-08-18). ` +
        `Find who deployed it, land their change via PR, and redeploy main.`
      );
    },
  },
];
