"use client";

/**
 * One engagement, end to end: where it stands (the brief's 13 CRM stages),
 * the discovery profile, the audit draft, the proposal, and what happened
 * after CC's approval (link, views, Stripe, onboarding), with the audit trail.
 *
 * The buttons here never send anything to the client. Delivery happens only
 * when the owner approves the "AI audit delivery" card in the approvals inbox.
 */
import { useState } from "react";
import Link from "next/link";
import { PageFrame } from "@/components/os/PageFrame";
import { useRouter } from "next/navigation";
import type { EngagementView } from "@/lib/ai-audit/view";
import {
  AI_AUDIT_STAGE_LABELS,
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  MANUAL_STAGE_TARGETS,
  PROFILE_EDIT_STAGES,
  STAGE_MOVES,
  WAITING_ON_CLIENT_STAGES,
  type AiAuditStage,
  type BusinessType,
} from "@/lib/ai-audit/rules";
import { formatMoney } from "@/lib/ai-audit/catalogue";
import { ProfileEditor } from "./ProfileEditor";
import { AuditEditor } from "./AuditEditor";
import { ProposalEditor } from "./ProposalEditor";
import { DiscoveryPanel } from "./DiscoveryPanel";
import { ResearchPanel } from "./ResearchPanel";
import { describeError, postAction } from "./api";

type Tab = "overview" | "call" | "profile" | "research" | "audit" | "proposal" | "delivery" | "history";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "call", label: "Call and transcripts" },
  { key: "profile", label: "Discovery profile" },
  { key: "research", label: "Research" },
  { key: "audit", label: "Audit" },
  { key: "proposal", label: "Proposal" },
  { key: "delivery", label: "Delivery and payment" },
  { key: "history", label: "History" },
];

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function EngagementWorkspace({ view, isOwner }: { view: EngagementView; isOwner: boolean }) {
  const router = useRouter();
  const e = view.engagement;
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [details, setDetails] = useState<{ business_name: string; business_type: BusinessType | ""; contact_name: string; contact_email: string }>({
    business_name: e.business_name ?? "",
    // Empty until someone chooses one. Sending a type nobody picked would change
    // what Gate 1 binds, and after Gate 1 the save would be refused (CodeRabbit on #733).
    business_type: e.business_type ?? "",
    contact_name: e.contact_name ?? "",
    contact_email: e.contact_email ?? "",
  });

  async function act(action: string, body: Record<string, unknown> = {}, done?: string) {
    setBusy(true);
    setMessage(null);
    setProblems([]);
    const r = await postAction(e.id, action, { expected_row_version: e.row_version, ...body });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      if (Array.isArray(r.problems)) setProblems(r.problems);
      return;
    }
    setMessage(done ?? "Done.");
    router.refresh();
  }

  const manualMoves = STAGE_MOVES[e.stage].filter((s) => MANUAL_STAGE_TARGETS.includes(s));
  const auditEditable = !view.audit || view.audit.status === "draft";
  const proposalEditable = !view.proposal || view.proposal.status === "draft";
  const submitted = view.audit?.status === "awaiting_approval";
  // Submission comes after Gate 1: only an authorized engagement reaches generating.
  const canSubmit = ["generating", "final_review"].includes(e.stage) && view.audit?.status === "draft" && view.proposal?.status === "draft";
  const cur = view.proposal?.currency ?? view.settings.default_currency;

  return (
    <PageFrame
      title={e.business_name || "Unnamed business"}
      subtitle={
        <>
          <Link href="/ai-audit" className="hover:underline">
            AI audits
          </Link>
          {" / "}
          {view.row.stage_number ? `${view.row.stage_number}. ` : ""}
          {view.row.stage_label}. Next: <span className="text-fg">{view.row.next_action}</span>
          {e.health !== "ok" ? <span className="ml-2 text-status-warm">{e.health_reason}</span> : null}
        </>
      }
      actions={
        <>
          <Link href={`/pipeline/${e.lead_id}`} className="btn-secondary">
            Lead record
          </Link>
          {manualMoves.map((s) => (
            <button
              key={s}
              type="button"
              className={s === "declined" || s === "cancelled" ? "btn-danger" : "btn-secondary"}
              disabled={busy}
              onClick={() => {
                // Declining or cancelling ends the engagement for good and stops any open payment link.
                if ((s === "declined" || s === "cancelled") && !window.confirm(s === "declined" ? "Mark this engagement declined? It cannot be reopened, and any open payment link stops working." : "Cancel this engagement? It cannot be reopened, and any open payment link stops working.")) return;
                void act("set_stage", { to: s }, `Moved to ${AI_AUDIT_STAGE_LABELS[s]}.`);
              }}
            >
              {s === "declined" ? "Mark declined" : s === "cancelled" ? "Cancel engagement" : `Move to ${AI_AUDIT_STAGE_LABELS[s as AiAuditStage]}`}
            </button>
          ))}
        </>
      }
    >
    <div className="grid gap-5">

      {message ? (
        <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">
          {message}
          {problems.length ? (
            <ul className="mt-1 grid gap-0.5 text-[13px] text-status-hot">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <nav className="flex flex-wrap gap-1 border-b border-hairline" aria-label="Engagement sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
            <h2 className="text-sm font-semibold text-fg">Business and contact</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="label">Business name</div>
                <input className="input" value={details.business_name} onChange={(ev) => setDetails({ ...details, business_name: ev.target.value })} />
              </div>
              <div>
                <div className="label">Business type</div>
                <select className="select" value={details.business_type} onChange={(ev) => setDetails({ ...details, business_type: ev.target.value as BusinessType | "" })}>
                  {details.business_type === "" ? <option value="">Not chosen yet</option> : null}
                  {BUSINESS_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {BUSINESS_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Contact name</div>
                <input className="input" value={details.contact_name} onChange={(ev) => setDetails({ ...details, contact_name: ev.target.value })} />
              </div>
              <div>
                <div className="label">Contact email</div>
                <input className="input" value={details.contact_email} onChange={(ev) => setDetails({ ...details, contact_email: ev.target.value })} />
              </div>
            </div>
            <button type="button" className="btn-primary justify-self-start" disabled={busy} onClick={() => {
                const { business_type, ...rest } = details;
                void act("save_details", business_type ? { ...rest, business_type } : rest, "Details saved.");
              }}>
              Save details
            </button>
          </section>
          <section className="grid content-start gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
            <h2 className="text-sm font-semibold text-fg">Where it stands</h2>
            <div className="text-fg-muted">
              Stage: <span className="text-fg">{view.row.stage_label}</span>
            </div>
            <div className="text-fg-muted">
              Profile: <span className="text-fg">{view.profile ? `version ${view.profile.version.version_no}, ${view.profile.fields.length} facts, ${view.profile.version.status}` : "not started"}</span>
            </div>
            <div className="text-fg-muted">
              Audit: <span className="text-fg">{view.audit ? `version ${view.audit.version_no}, ${view.audit.status.replace(/_/g, " ")}` : "not started"}</span>
            </div>
            <div className="text-fg-muted">
              Proposal: <span className="text-fg">{view.proposal ? `version ${view.proposal.version_no}, ${view.proposal.status.replace(/_/g, " ")}, ${formatMoney(view.proposal.total_cents, cur)}` : "not started"}</span>
            </div>
            <div className="text-fg-muted">
              Payment: <span className="text-fg">{e.payment_status.replace(/_/g, " ")}</span>
            </div>
            <div className="text-fg-muted">
              Onboarding: <span className="text-fg">{e.onboarding_status.replace(/_/g, " ")}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {canSubmit ? (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => act("submit", {}, "Submitted. The PDF is being printed on the Mac; the final approval card appears when it is ready.")}>
                  Submit for final approval
                </button>
              ) : null}
              {submitted && e.stage === "final_review" ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("reopen", {}, "Reopened for edits.")}>
                  Reopen for edits
                </button>
              ) : null}
              {isOwner && WAITING_ON_CLIENT_STAGES.includes(e.stage) && (e.payment_status === "none" || e.payment_status === "pending") ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Revise this audit? Any payment page the client has open stops working now. The client keeps reading the version they have until you approve and send the new one, which replaces their link.")) return;
                    void act("revise_after_delivery", {}, "Revising: edit the drafts, then submit again for final approval.");
                  }}
                >
                  Revise and send again
                </button>
              ) : null}
              {submitted && view.deliveryApproval?.status === "failed" && view.deliveryApproval.reason === "delivery_unknown" && isOwner ? (
                <>
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => act("confirm_delivery_sent", {}, "Recorded as delivered.")}>
                    It was sent
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm("Only if the email is NOT in the Sent folder. Its link stops working and a new final approval card is filed. Continue?")) return;
                      void act("retry_delivery", { confirm_not_sent: true }, "A new final approval card is waiting in Needs you.");
                    }}
                  >
                    It was not sent: send again
                  </button>
                </>
              ) : null}
              {submitted &&
              view.deliveryApproval &&
              view.deliveryApproval.reason !== "delivery_unknown" &&
              (["failed", "expired", "sent_back", "cancelled"].includes(view.deliveryApproval.status) || (view.deliveryApproval.status === "executed" && view.deliveryApproval.outcome === "dry_run")) &&
              isOwner ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("retry_delivery", {}, "A new final approval card is waiting in Needs you.")}>
                  Retry delivery
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {/* Kept mounted, hidden, so pasted text and the consent answers survive a switch of tab. */}
      <div hidden={tab !== "call"}>
        <DiscoveryPanel view={view} isOwner={isOwner} />
      </div>

      {/* The three editors stay mounted, hidden, so a draft survives a switch of tab.
          Each re-seeds from the server when its saved content changes (the key). */}
      <div hidden={tab !== "profile"}>
        {/* Editable until Gate 1; an edit after a frozen version opens a new draft (versions.ts). */}
        <ProfileEditor engagementId={e.id} fields={view.profile?.fields ?? []} frozen={!PROFILE_EDIT_STAGES.includes(e.stage)} />
      </div>

      {/* Kept mounted, hidden, so a half-typed assumption survives a switch of tab. */}
      <div hidden={tab !== "research"}>
        <ResearchPanel view={view} isOwner={isOwner} />
      </div>

      <div hidden={tab !== "audit"}>
        <AuditEditor
          key={`audit:${view.audit?.id ?? "new"}:${view.audit?.content_sha256 ?? ""}`}
          engagementId={e.id}
          initialDoc={view.audit?.doc ?? null}
          rowVersion={e.row_version}
          editable={auditEditable}
          defaults={{
            businessName: e.business_name ?? "",
            businessType: (e.business_type ?? "other") as BusinessType,
            contactName: e.contact_name ?? "",
            website: view.lead?.website ?? "",
            location: view.lead?.city ?? "",
          }}
        />
      </div>

      <div hidden={tab !== "proposal"}>
        <ProposalEditor
          key={`proposal:${view.proposal?.id ?? "new"}:${view.proposal?.content_sha256 ?? ""}`}
          engagementId={e.id}
          initial={view.proposal?.content ?? null}
          rowVersion={e.row_version}
          editable={proposalEditable}
          catalogue={view.catalogue}
          settings={{ tax: view.settings.tax, default_currency: view.settings.default_currency, deposit_bps: view.settings.deposit_bps }}
          defaults={{ to: e.contact_email ?? "", businessName: e.business_name ?? "", contactName: e.contact_name ?? "" }}
          isOwner={isOwner}
        />
      </div>

      {tab === "delivery" ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="grid content-start gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
            <h2 className="text-sm font-semibold text-fg">Final approval and PDF</h2>
            <div className="text-fg-muted">
              PDF:{" "}
              <span className="text-fg">
                {view.audit?.pdf_sha256 ? `ready (${view.audit.pdf_pages ?? "?"} pages)` : submitted ? "waiting for the Mac to print it" : "made when you submit"}
              </span>
              {view.audit?.pdf_sha256 ? (
                <a className="ml-2 underline" href={`/api/ai-audit/${e.id}/pdf`}>
                  Download
                </a>
              ) : null}
            </div>
            {submitted && !view.audit?.pdf_sha256 && e.health === "attention" ? (
              <button type="button" className="btn-secondary justify-self-start" disabled={busy} onClick={() => act("retry_pdf", {}, "Printing again. The Mac picks it up within a minute.")}>
                Retry PDF
              </button>
            ) : null}
            <div className="text-fg-muted">
              Final approval: <span className="text-fg">{view.deliveryApproval ? view.deliveryApproval.status.replace(/_/g, " ") : "not filed yet"}</span>
              {view.deliveryApproval?.message ? <div className="text-[13px] text-status-warm">{view.deliveryApproval.message}</div> : null}
            </div>
            {view.deliveryApproval?.status === "pending" ? (
              <Link href="/feed" className="btn-primary justify-self-start">
                Open it in Needs you
              </Link>
            ) : null}
            <div className="mt-2 text-fg-muted">
              Client link:{" "}
              <span className="text-fg">
                {view.link
                  ? view.link.revoked_at
                    ? `revoked (${view.link.revoked_reason ?? "by you"})`
                    : `live until ${when(view.link.expires_at)}, opened ${view.link.view_count} time${view.link.view_count === 1 ? "" : "s"}${view.link.first_viewed_at ? `, first ${when(view.link.first_viewed_at)}` : ""}`
                  : "not sent"}
              </span>
            </div>
            {view.link && !view.link.revoked_at ? (
              <button type="button" className="btn-danger justify-self-start" disabled={busy} onClick={() => act("revoke_link", {}, "Link revoked.")}>
                Revoke the link
              </button>
            ) : null}
          </section>
          <section className="grid content-start gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
            <h2 className="text-sm font-semibold text-fg">Payment and onboarding</h2>
            {view.checkouts.length === 0 ? <div className="text-fg-muted">No checkout opened yet.</div> : null}
            {view.checkouts.map((c) => (
              <div key={c.id} className="text-fg-muted">
                Checkout {formatMoney(c.amount_cents, c.currency)} ({c.installment_kind}): <span className="text-fg">{c.status}</span>
                {c.last_error ? <span className="ml-1 text-status-warm">{c.last_error}</span> : null}
              </div>
            ))}
            {view.receipts.map((r) => (
              <div key={r.id} className="text-fg">
                Stripe confirmed {formatMoney(r.amount_cents, r.currency)} on {when(r.verified_at)} ({r.status})
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-2">
              {view.checkouts.some((c) => c.stripe_session_id) ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("recheck_payment", {}, "Checked with Stripe.")}>
                  Re-check payment with Stripe
                </button>
              ) : null}
              {["payment_confirmed", "onboarding"].includes(e.stage) ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("retry_onboarding", {}, "Onboarding steps ran.")}>
                  Run onboarding again
                </button>
              ) : null}
            </div>
            <div className="mt-2 text-fg-muted">
              Client record: <span className="text-fg">{e.customer_id ? "created" : "not yet"}</span>. Project: <span className="text-fg">{e.delivery_project_id ? "created" : "not yet"}</span>.
            </div>
          </section>
        </div>
      ) : null}

      {tab === "history" ? (
        <section className="rounded-xl border border-hairline bg-bg-panel">
          <ol className="divide-y divide-hairline text-sm">
            {view.events.map((ev) => (
              <li key={ev.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2">
                <span className="text-fg">
                  {ev.event.replace(/_/g, " ")}
                  {ev.to_stage ? <span className="text-fg-muted"> to {AI_AUDIT_STAGE_LABELS[ev.to_stage as AiAuditStage] ?? ev.to_stage}</span> : null}
                </span>
                <span className="text-[12px] tabular-nums text-fg-dim">
                  {ev.actor_type} {when(ev.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
    </PageFrame>
  );
}
