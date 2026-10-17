"use client";

/**
 * DeleteLeadButton - the owner's "Delete lead" on a lead's page (CC,
 * 2026-10-16: junk and test leads must be removable; "there needs to be a
 * section for deleting leads").
 *
 * Two steps, both through POST /api/pipeline/[id]/delete
 * (lib/pipeline/delete-lead.ts):
 *   1. "Delete lead..." asks for a dry run and shows what would happen: what is
 *      removed, what queued message is cancelled, what history is kept; or, when
 *      the lead has a booked call, a deal, a payment, documents or client work,
 *      the plain reasons it cannot be deleted. Nothing is written.
 *   2. Typing DELETE and pressing "Delete permanently" runs it, then returns to
 *      the pipeline.
 * Rendered only for an owner or admin by base role (page.tsx, session.isTrueAdmin);
 * the route refuses everyone else on its own.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

type Counts = Record<string, number>;
type Plan = { cancel?: Counts; unlink?: Counts; delete?: Counts };
type Answer = { ok?: boolean; code?: string; blockers?: string[]; message?: string; error?: string; plan?: Plan };

/** Owner-facing words for what the delete touches; an unknown table shows its own name. */
const WORDS: Record<string, string> = {
  form_submissions: "form answers",
  form_views: "form views",
  offer_funnel_visit_leads: "page-visit links",
  clair_reports: "background reports",
  phone_lookup_jobs: "phone lookups",
  leadgen_recheck_requests: "re-check requests",
  leadgen_presence_requests: "presence checks",
  daily_plan_items: "daily plan items",
  drip_runs: "scheduled drip emails",
  scheduled_sends: "scheduled messages",
  scheduled_calls: "scheduled call reminders",
  website_sales_meeting_notifications: "meeting reminders",
  lead_interactions: "queued emails",
  approvals: "pending approvals",
  sms_agent_jobs: "SMS replies waiting",
};

function describe(counts: Counts | undefined): string[] {
  return Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${n} ${WORDS[table] ?? table.replace(/_/g, " ")}`);
}

function failureLine(status: number, data: Answer): string {
  if (status === 403) return "Only an owner can delete leads.";
  if (status === 404) return "This lead no longer exists.";
  return data.message || "Couldn't delete this lead. Nothing was changed. Try again.";
}

export function DeleteLeadButton({ leadId, leadLabel }: { leadId: string; leadLabel: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "checking" | "review" | "deleting">("idle");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  async function call(body: Record<string, unknown>): Promise<{ status: number; data: Answer }> {
    const r = await fetch(`/api/pipeline/${encodeURIComponent(leadId)}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) as Answer };
  }

  function reset() {
    setStep("idle");
    setPlan(null);
    setBlockers([]);
    setTyped("");
  }

  async function review() {
    setStep("checking");
    setError(null);
    setBlockers([]);
    setPlan(null);
    try {
      const { status, data } = await call({ dry_run: true });
      if (data.ok) {
        setPlan(data.plan ?? {});
        setStep("review");
      } else if (data.code === "blocked") {
        setBlockers(data.blockers ?? []);
        setStep("review");
      } else {
        setError(failureLine(status, data));
        setStep("idle");
      }
    } catch {
      setError("Couldn't reach the server. Nothing was changed. Try again.");
      setStep("idle");
    }
  }

  async function remove() {
    if (typed.trim().toUpperCase() !== "DELETE") return;
    setStep("deleting");
    setError(null);
    try {
      const { status, data } = await call({ confirm: "delete" });
      if (data.ok) {
        router.push("/pipeline");
        router.refresh();
        return;
      }
      if (data.code === "blocked") {
        // Something changed since the check (a call was booked, a deal opened).
        setBlockers(data.blockers ?? []);
        setPlan(null);
        setStep("review");
        return;
      }
      setError(failureLine(status, data));
      setStep("review");
    } catch {
      setError("No answer came back. Reload the page: it shows whether the lead is still there.");
      setStep("review");
    }
  }

  const removed = describe(plan?.delete);
  const cancelled = describe(plan?.cancel);
  const busy = step === "checking" || step === "deleting";

  return (
    <section className="rounded-xl border border-red-500/25 bg-red-500/[0.04] p-5" aria-labelledby="delete-lead-title">
      <h2 id="delete-lead-title" className="text-sm font-semibold text-fg">
        Delete lead
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Removes {leadLabel} from the pipeline with its form answers, and cancels anything still queued to them.
        Consent records and the history of messages already sent are kept.
      </p>

      {step === "idle" || step === "checking" ? (
        <button
          type="button"
          onClick={review}
          disabled={busy}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-red-400/40 px-3 py-1.5 text-sm font-semibold text-red-200 hover:bg-red-500/10 disabled:opacity-60"
        >
          {step === "checking" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
          Delete lead...
        </button>
      ) : null}

      {step !== "idle" && step !== "checking" && blockers.length ? (
        <div className="mt-3 space-y-2" role="alert">
          <p className="text-sm font-semibold text-fg">This lead can&apos;t be deleted yet. Nothing was changed.</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <button type="button" onClick={reset} className="text-sm font-semibold text-accent hover:underline">
            Close
          </button>
        </div>
      ) : null}

      {step !== "idle" && step !== "checking" && !blockers.length && plan ? (
        <div className="mt-3 space-y-3">
          <ul className="space-y-1 text-sm text-fg-muted">
            <li>Removes: the lead{removed.length ? `, ${removed.join(", ")}` : ""}.</li>
            <li>Cancels: {cancelled.length ? cancelled.join(", ") : "nothing is queued"}.</li>
            <li>Keeps: consent records and messages already sent.</li>
          </ul>
          <label className="block text-sm text-fg">
            Type <span className="font-mono font-semibold">DELETE</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 block w-full max-w-xs rounded-md border border-bg-border bg-bg px-3 py-1.5 font-mono text-sm text-fg"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={remove}
              disabled={busy || typed.trim().toUpperCase() !== "DELETE"}
              className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {step === "deleting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
              Delete permanently
            </button>
            <button type="button" onClick={reset} disabled={busy} className="text-sm font-semibold text-fg-muted hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-red-200" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
