/**
 * tenant.ts — the constants every web-leads read pins itself to.
 *
 * These lived in data.ts until 2026-08-23. They moved here for one structural
 * reason: lib/web-leads/scores.ts needs the tenant id and the read cap, and
 * data.ts needs scores.ts's resolveScore() to attach a score to each row. Left
 * in data.ts that is an import cycle (data -> scores -> data). The cycle would
 * probably have worked -- nothing reads across it at module-init time -- but
 * "probably works under this bundler" is not a property worth depending on for
 * the module that carries the authorization boundary. A leaf module with no
 * imports of its own cannot participate in a cycle at all.
 *
 * data.ts and audit.ts re-export these, so every existing import site keeps
 * working unchanged.
 */

/**
 * OASIS AI command-center tenant (slug `oasis-ai-cc`) — where the web-design
 * leads AND the operators who work them both live. NOT SunBiz (aa04fa1f...),
 * which this feature never reads.
 *
 * Was 42423fde-be8b-454f-932a-750e8c9b743d ("Oasis Web Studio", slug
 * `oasis-webdev`) until 2026-08-20: that tenant had ZERO users, so nobody
 * could ever log in and see this feature. Repointed once the underlying
 * leadgen_territories / leadgen_businesses / tenant_records rows were
 * migrated to carry this tenant_id instead.
 */
export const WEBDEV_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export const PAGE_SIZE = 50;

/**
 * Hard cap on rows read per bulk call (leads, audits, unreachable attempts).
 * The tenant holds ~31K leads and ~23K audits today, so 50,000 is headroom,
 * not a working limit -- this is not meant to ever bind in normal operation.
 *
 * WHY THIS EXISTS: two independent reviewers flagged the missing `.limit()` on
 * the leads read. The fix is not that the cap is generous -- it's that hitting
 * it can never pass unnoticed. getServiceSupabase() (lib/supabase-server.ts)
 * falls back to a REAL supabase-js client whenever EMPIRE_DATA_BACKEND is not
 * "turso_cloud", and PostgREST enforces its own server-side max-rows cap on
 * every request regardless of what this code asks for. If that fallback path
 * is ever taken, an unbounded select comes back SILENTLY TRUNCATED -- no
 * error, just fewer rows than exist. The filter rail would confidently show
 * 10,872 while the table quietly showed whatever PostgREST's cap allowed, and
 * nothing would say the number was wrong. A plausible-looking wrong number is
 * the exact failure this feature exists to avoid. So every reader treats
 * "returned row count >= LEAD_READ_CAP" as proof the read may be incomplete
 * and throws instead of returning a partial list.
 */
export const LEAD_READ_CAP = 50000;

/**
 * Mirrors JARVIS services/leadgen/lib/scoring-run.js's MODEL_VERSION.
 *
 * Both score readers (audit.ts for one lead, scores.ts for the whole list) pin
 * it, so a list scored under one model version can never sit beside a panel
 * scored under another. Keep in sync by hand if that constant ever bumps --
 * oasis and JARVIS are separate deployments with no shared module graph.
 */
export const MODEL_VERSION = 1;
