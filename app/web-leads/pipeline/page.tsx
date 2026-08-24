/**
 * /web-leads/pipeline — a redirect, kept alive on purpose.
 *
 * The standalone pipeline page was retired on 2026-08-23, and the shared stage
 * board it linked to was deleted entirely (it showed every rep's leads mixed
 * together -- a manager's question on a screen only reps use). Deleting this
 * file too would 404 every link and bookmark anyone has already shared, which
 * is a worse outcome than one three-line file: retiring a UI does not require
 * breaking its URL. Codex flagged the removal (2026-08-23).
 *
 * Lands on My leads, which is the honest successor -- someone who bookmarked
 * "the pipeline" wanted to see leads at their stages, and that is now their own
 * book. `?rep=` is dropped rather than translated: a rep parameter selected
 * SOMEONE ELSE's slice of the old shared board, and there is deliberately no
 * longer a way to view another rep's book from this route.
 */

import { redirect } from "next/navigation";

export default function RetiredPipelinePage() {
  redirect("/web-leads?view=mine");
}
