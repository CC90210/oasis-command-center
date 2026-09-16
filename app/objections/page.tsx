/**
 * `/objections` — the library, and the door new objections come in through.
 *
 * WHY THIS PAGE EXISTS. The objection engine's whole design rests on one rule:
 * no AI-drafted or newly typed sentence reaches a rep's screen until a human
 * approves it. Until this page there was nowhere to do that, so approval
 * happened out of band, by somebody reading a list somewhere else and saying
 * yes. That is not a gate, it is a habit. This makes it a gate.
 *
 * READ/WRITE SPLIT is enforced server-side in the API routes, not here. This
 * page passes `canApprove` to the client purely so the UI does not offer a
 * button that would 403; every one of those actions is checked again on the
 * server, because a hidden button is not a permission.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/Card";
import { ObjectionLibrary } from "@/components/objections/ObjectionLibrary";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  mayApproveObjections,
  mayViewObjectionLibrary,
} from "@/lib/web-leads/objections/admin-access";
import { fetchAdminCatalog, type AdminObjection } from "@/lib/web-leads/objections/admin";

export const dynamic = "force-dynamic";

export default async function ObjectionsPage() {
  const session = await resolveSessionContext();
  if (!session.ok) redirect("/auth/login?next=/objections");
  if (!mayViewObjectionLibrary(session)) redirect("/");

  const canApprove = mayApproveObjections(session);

  // A read failure renders the page with an explicit message rather than a
  // crash: somebody arriving here to approve something needs to be told the
  // library could not be read, not shown a blank screen that looks like an
  // empty library. Those two states are indistinguishable otherwise, and one
  // of them is a lie.
  let objections: AdminObjection[];
  let readError: string | null = null;
  try {
    objections = await fetchAdminCatalog();
  } catch (err) {
    objections = [];
    readError = err instanceof Error ? err.message : "unknown";
    console.error("[objections] library read failed", readError);
  }

  const approved = objections.filter((o) => o.status === "approved").length;
  const drafts = objections.filter((o) => o.status === "draft").length;
  const draftAnswers = objections.reduce(
    (n, o) => n + o.responses.filter((r) => r.status === "draft").length,
    0,
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Objections"
        subtitle={
          readError
            ? "The library could not be read. Nothing below is the real state."
            : `${approved} live, ${drafts} waiting to be approved, ${draftAnswers} draft answers. Nothing reaches a rep until it is approved here.`
        }
        action={
          <Link
            href="/objections/practice"
            className="inline-block rounded-md border border-bg-border px-3 py-1.5 text-sm font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg"
          >
            Practise these
          </Link>
        }
      />
      <ObjectionLibrary
        initial={objections}
        canApprove={canApprove}
        readError={readError}
      />
    </div>
  );
}
