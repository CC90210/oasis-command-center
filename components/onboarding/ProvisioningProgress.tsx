/**
 * ProvisioningProgress - what OASIS has actually done to set up the viewer's
 * workspace, read from the newest provisioning_runs row for THAT workspace.
 *
 * WHY IT WAS REWRITTEN (2026-09-30). The old component was a client screen
 * that always said "Payment verified", showed a spinner labelled "Configuring
 * environment..." and refreshed every 3 seconds, fed by an unsigned webhook
 * that anyone could call (deleted 2026-09-28, P0-2). This one claims nothing it
 * did not read: the steps lib/provisioning/provision-tenant.ts recorded, the
 * run's status, or "not started yet". A failed read says so; it is never shown
 * as "nothing has happened".
 *
 * Server component. The workspace comes from the SESSION (lib/team.ts
 * getSessionContext), never from a prop or the URL, so it can only ever show
 * the viewer's own workspace. The contact line imports CONTACT_EMAIL, OASIS's
 * support inbox; no other address is written here.
 */

import { getSessionContext } from "@/lib/team";
import { CONTACT_EMAIL } from "@/lib/marketing/routes";
import { latestProvisioningRun, type ProvisioningRunView } from "@/lib/provisioning/provision-tenant";

type Loaded =
  | { kind: "no_session" }
  | { kind: "unreadable" }
  | { kind: "run"; run: ProvisioningRunView | null };

async function load(): Promise<Loaded> {
  let ctx: Awaited<ReturnType<typeof getSessionContext>>;
  try {
    ctx = await getSessionContext();
  } catch (err) {
    console.error("[provisioning-progress.session]", err);
    return { kind: "unreadable" };
  }
  if (!ctx) return { kind: "no_session" };
  try {
    return { kind: "run", run: await latestProvisioningRun(ctx.tenantId) };
  } catch (err) {
    console.error("[provisioning-progress.run]", err);
    return { kind: "unreadable" };
  }
}

function when(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" });
}

function Status({ loaded }: { loaded: Loaded }) {
  if (loaded.kind === "unreadable") {
    return <p className="text-sm text-fg">We could not read your setup progress just now. Reload the page to try again.</p>;
  }
  if (loaded.kind === "no_session" || !loaded.run) {
    return <p className="text-sm text-fg">OASIS has not started setting up this workspace yet.</p>;
  }
  const { run } = loaded;
  const finished = when(run.completedAt);
  return (
    <div>
      <p className="text-sm text-fg">
        {run.status === "complete"
          ? `Setup finished${finished ? ` on ${finished}` : ""}. Reload the page to open your workspace.`
          : run.status === "failed"
            ? // No alert fires on a failed run, so this promises nothing: the
              // contact line below is the next step (2026-09-30 fix pass).
              "Setup stopped before it finished."
            : "OASIS is setting up this workspace now."}
      </p>
      {run.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-fg-muted">
          {run.steps.map((s, i) => (
            <li key={`${s.time}-${i}`}>{s.title}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export async function ProvisioningProgress() {
  const loaded = await load();
  return (
    <section aria-label="Setup progress" className="max-w-2xl rounded-xl border border-hairline bg-bg-panel p-4">
      <h2 className="text-sm font-semibold text-fg">Setup progress</h2>
      <div className="mt-2">
        <Status loaded={loaded} />
      </div>
      <p className="mt-4 text-sm text-fg-muted">
        Questions?{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-accent hover:underline">
          {CONTACT_EMAIL}
        </a>
      </p>
    </section>
  );
}
