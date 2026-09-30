"use client";

/**
 * clients-actions — every control on the Clients pages and the Support desk
 * that writes: New client, Convert to client, the record's editor and
 * contacts, Mark engagement ended, Link workspace (operator), Import Stripe
 * customers (OASIS founders), and turning a workspace's public support form
 * on. (The record's email composer lives in client-conversations.tsx.)
 *
 * Each one calls its API through useDeliveryAction (JSON in, the route's own
 * sentence out on failure, a server refresh on success), so the page re-reads
 * through the tenant-scoped store instead of trusting local state. Nothing
 * here names a workspace: every route takes the tenant from the session.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CUSTOMER_LIFECYCLES, CUSTOMER_LIFECYCLE_LABELS, type CustomerLifecycle } from "@/lib/os/customers/rules";
import { useDeliveryAction, type Option } from "@/components/delivery/useDeliveryAction";

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-status-hot" role="alert">{error}</p> : null;
}

/** "A client with that email already exists." plus a link to it, when the API named it. */
function ConflictLine({ existingId }: { existingId: string | null }) {
  return existingId ? (
    <Link href={`/clients/${existingId}`} prefetch={false} className="text-sm text-accent hover:underline">
      Open the existing client
    </Link>
  ) : null;
}

// ---------------------------------------------------------------------------
// Support desk: turn the public form on
// ---------------------------------------------------------------------------

export function EnableSupportFormButton() {
  const { run, busy, error } = useDeliveryAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-primary" disabled={busy} onClick={() => void run("/api/support-desk", "POST", {})}>
        {busy ? "Turning on..." : "Turn on support form"}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// New client
// ---------------------------------------------------------------------------

export function NewClientButton({ owners, defaultOwner }: { owners: Option[]; defaultOwner: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null);
  const blank = {
    display_name: "",
    company_name: "",
    primary_email: "",
    primary_phone: "",
    lifecycle: "active" as CustomerLifecycle,
    owner_user_id: defaultOwner ?? "",
    tags: "",
  };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New client
      </button>
    );
  }
  const canSave = Boolean(f.display_name.trim() || f.company_name.trim() || f.primary_email.trim());
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
      role="dialog"
      aria-modal="true"
      aria-label="New client"
    >
      <form
        className="w-full max-w-2xl space-y-4 rounded-xl border border-hairline bg-bg-panel p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setExistingId(null);
          try {
            const res = await fetch("/api/customers", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...f, owner_user_id: f.owner_user_id || null }),
            });
            const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (!res.ok || !data || data.ok !== true) {
              setError((data && typeof data.message === "string" && data.message) || `The request failed (HTTP ${res.status}). Nothing was saved.`);
              setExistingId(data && typeof data.existing_id === "string" ? data.existing_id : null);
              return;
            }
            router.push(`/clients/${String(data.id)}`);
          } catch {
            setError("Network error. Nothing was saved.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">New client</h2>
          <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        <p className="text-[13px] text-fg-muted">
          A customer your business already serves. A deal won in Pipeline can become a client from the deal itself.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className="label">Name</span>
            <input className="input" maxLength={160} value={f.display_name} onChange={set("display_name")} placeholder="Who the client is" />
          </label>
          <label>
            <span className="label">Company</span>
            <input className="input" maxLength={160} value={f.company_name} onChange={set("company_name")} />
          </label>
          <label>
            <span className="label">Email</span>
            <input className="input" type="email" maxLength={254} value={f.primary_email} onChange={set("primary_email")} />
          </label>
          <label>
            <span className="label">Phone</span>
            <input className="input" type="tel" maxLength={40} value={f.primary_phone} onChange={set("primary_phone")} />
          </label>
          <label>
            <span className="label">Status</span>
            <select className="select" value={f.lifecycle} onChange={set("lifecycle")}>
              {CUSTOMER_LIFECYCLES.map((l) => (
                <option key={l} value={l}>{CUSTOMER_LIFECYCLE_LABELS[l]}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Owner</span>
            <select className="select" value={f.owner_user_id} onChange={set("owner_user_id")}>
              <option value="">No owner</option>
              {owners.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="label">Tags</span>
            <input className="input" value={f.tags} onChange={set("tags")} placeholder="Comma separated, e.g. retainer, priority" />
          </label>
        </div>
        <ErrorLine error={error} />
        <ConflictLine existingId={existingId} />
        <button type="submit" className="btn-primary" disabled={busy || !canSave}>
          {busy ? "Saving..." : "Create client"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convert a won deal
// ---------------------------------------------------------------------------

export function ConvertToClientButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setExistingId(null);
          try {
            const res = await fetch("/api/customers/convert", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ lead_id: leadId }),
            });
            const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (!res.ok || !data || data.ok !== true) {
              setError((data && typeof data.message === "string" && data.message) || `The request failed (HTTP ${res.status}). Nothing was saved.`);
              setExistingId(data && typeof data.existing_id === "string" ? data.existing_id : null);
              return;
            }
            router.push(`/clients/${String(data.id)}`);
          } catch {
            setError("Network error. Nothing was saved.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Converting..." : "Convert to client"}
      </button>
      <ErrorLine error={error} />
      <ConflictLine existingId={existingId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past engagements
// ---------------------------------------------------------------------------

/**
 * "Mark engagement ended" on a record: asks first, then moves the client to
 * Past (POST /api/clients/[id]/end-engagement; the ledger records it). The
 * record and its history stay; the Status select undoes it.
 */
export function EndEngagementButton({ customerId, clientName }: { customerId: string; clientName: string }) {
  const { run, busy, error } = useDeliveryAction();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>
        Mark engagement ended
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label="Confirm engagement ended" className="space-y-2 rounded-xl border border-hairline bg-bg-panel p-3">
      <p className="text-sm text-fg">
        Move {clientName} to Past? Their tickets, projects, files and history stay, and you can change the status back later.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            const data = await run(`/api/clients/${encodeURIComponent(customerId)}/end-engagement`, "POST", {});
            if (data) setConfirming(false);
          }}
        >
          {busy ? "Saving..." : "Yes, the engagement ended"}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
          Keep as a current client
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * The same, for a won deal that never became a record ("Not yet client
 * records"): converts it (POST /api/customers/convert), then marks it ended,
 * so it moves to Past instead of sitting among current clients. Two calls;
 * when the second fails the record exists and the error says so.
 */
export function EndDealEngagementButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok && !!data && data.ok === true, data, status: res.status };
  };
  if (!confirming) {
    return (
      <button type="button" className="text-[13px] text-fg-muted hover:text-fg hover:underline" onClick={() => setConfirming(true)}>
        Mark engagement ended
      </button>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-[13px] text-fg">Record this deal as a Past client?</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const conv = await call("/api/customers/convert", { lead_id: leadId });
              if (!conv.ok || typeof conv.data?.id !== "string") {
                setError((conv.data && typeof conv.data.message === "string" && conv.data.message) || `The request failed (HTTP ${conv.status}). Nothing was saved.`);
                return;
              }
              const id = conv.data.id;
              const ended = await call(`/api/clients/${encodeURIComponent(id)}/end-engagement`, {});
              if (!ended.ok) {
                setError(
                  `The client record was created, but it could not be marked ended: ${
                    (ended.data && typeof ended.data.message === "string" && ended.data.message) || `HTTP ${ended.status}`
                  }. Open the record to finish.`,
                );
                return;
              }
              router.refresh();
            } catch {
              setError("Network error. Check the client list before trying again.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving..." : "Yes, move to Past"}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The client's own workspace (operator only)
// ---------------------------------------------------------------------------

export function LinkWorkspaceControl({
  customerId,
  current,
  options,
}: {
  customerId: string;
  current: { id: string; label: string } | null;
  options: Option[];
}) {
  const { run, busy, error } = useDeliveryAction();
  const [choice, setChoice] = useState(current?.id ?? "");
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmLink, setConfirmLink] = useState(false);
  const url = `/api/clients/${encodeURIComponent(customerId)}/link-workspace`;
  const chosenLabel = options.find((o) => o.value === choice)?.label ?? "this workspace";
  if (confirmLink) {
    // A cross-workspace read grant: asked first, in words, like unlinking.
    return (
      <div role="alertdialog" aria-label="Confirm link workspace" className="space-y-2 rounded-xl border border-hairline bg-bg-panel p-3">
        <p className="text-sm text-fg">
          Link {chosenLabel} to this client? This record will then read that workspace&rsquo;s usage: its AI numbers, agent runs,
          approvals and tickets.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              const data = await run(url, "POST", { client_tenant_id: choice, confirmed: true });
              if (data) setConfirmLink(false);
            }}
          >
            {busy ? "Saving..." : "Yes, link it"}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirmLink(false)}>
            Cancel
          </button>
        </div>
        <ErrorLine error={error} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1">
          <span className="label">Client&rsquo;s workspace (operator only)</span>
          <select className="select" value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a workspace</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !choice || choice === current?.id}
          onClick={() => setConfirmLink(true)}
        >
          {current ? "Change workspace" : "Link workspace"}
        </button>
        {current &&
          (confirmUnlink ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void run(url, "POST", { client_tenant_id: null, confirmed: true })}
              >
                Confirm unlink
              </button>
              <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setConfirmUnlink(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setConfirmUnlink(true)}>
              Unlink
            </button>
          ))}
      </div>
      <p className="text-xs text-fg-dim">Linking lets this record read that workspace&rsquo;s usage. Only the platform operator can change it.</p>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import Stripe customers (OASIS, founders)
// ---------------------------------------------------------------------------

type PlanItem = { action: string; stripe_customer_id: string; name: string | null; email: string | null; lifecycle: string; reason?: string };

/**
 * Shows what an import WOULD do (GET), asks the privacy question, and only
 * then imports exactly the listed people (POST { confirm_privacy: true,
 * confirmed: [...] }). Records get a name, an email and the Stripe customer
 * id; nothing else.
 */
export function ImportStripeButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ summary: Record<string, number>; items: PlanItem[] } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    setOpen(true);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/clients/import-stripe", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok !== true) {
        setError((data && typeof data.message === "string" && data.message) || `Couldn't read the books (HTTP ${res.status}).`);
        return;
      }
      setPlan({ summary: data.summary as Record<string, number>, items: data.items as PlanItem[] });
    } catch {
      setError("Network error. Nothing was imported.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => void load()}>
        Import Stripe customers
      </button>
    );
  }
  const actionable = plan ? (plan.summary.create ?? 0) + (plan.summary.link ?? 0) : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16" role="dialog" aria-modal="true" aria-label="Import Stripe customers">
      <div className="w-full max-w-2xl space-y-4 rounded-xl border border-hairline bg-bg-panel p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Import Stripe customers</h2>
          <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        {busy && !plan && <p className="text-[13px] text-fg-muted">Reading the books...</p>}
        {plan && (
          <>
            <p className="text-[13px] text-fg-muted">
              From the Stripe customers in OASIS&rsquo;s books: {plan.summary.create ?? 0} new record(s), {plan.summary.link ?? 0} existing
              record(s) to link by email, {plan.summary.skip ?? 0} skipped, {plan.summary.conflict ?? 0} conflict(s) left for you.
            </p>
            <ul className="max-h-64 divide-y divide-hairline overflow-y-auto rounded-lg border border-hairline">
              {plan.items.map((i) => (
                <li key={i.stripe_customer_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                  <span className="min-w-0 truncate text-fg">{i.name ?? i.email ?? "No name or email"}</span>
                  <span className="text-xs text-fg-dim">
                    {i.action === "create"
                      ? `new record, ${i.lifecycle === "active" ? "Active" : "Past"}`
                      : i.action === "link"
                        ? "link to the record with this email"
                        : i.action === "conflict"
                          ? "conflict: the email's record has another Stripe customer"
                          : i.reason === "already_a_client"
                            ? "already a client"
                            : "skipped: no name or email"}
                  </span>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-[13px] text-fg">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
              <span>
                Some Stripe subscribers are private individuals (Quebec Law 25). I confirm OASIS may keep them as client
                records with their name and email only.
              </span>
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !agreed || actionable === 0}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  // Exactly the people listed above, with the action each was
                  // shown with: the privacy answer covers them and no one else.
                  const confirmed = plan.items
                    .filter((i) => i.action === "create" || i.action === "link")
                    .map((i) => ({ stripe_customer_id: i.stripe_customer_id, action: i.action }));
                  const res = await fetch("/api/clients/import-stripe", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ confirm_privacy: true, confirmed }),
                  });
                  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
                  if (!res.ok || !data || data.ok !== true) {
                    setError((data && typeof data.message === "string" && data.message) || `The import failed (HTTP ${res.status}).`);
                    return;
                  }
                  const held = Number(data.unreviewed ?? 0) + Number(data.changed ?? 0);
                  setDone(
                    `Created ${String(data.created)}, linked ${String(data.linked)}, skipped ${String(data.skipped)}.` +
                      (held > 0
                        ? ` ${held} not imported: they reached the books or changed after this list was opened. Open the import again to review them.`
                        : ""),
                  );
                  setPlan(null);
                  router.refresh();
                } catch {
                  setError("Network error. Check the client list before trying again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Importing..." : actionable === 0 ? "Nothing to import" : `Import ${actionable}`}
            </button>
          </>
        )}
        {done && <p className="text-sm text-fg" role="status">{done}</p>}
        <ErrorLine error={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The record's editor
// ---------------------------------------------------------------------------

export type EditableClient = {
  id: string;
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  owner_user_id: string | null;
  stripe_customer_id: string | null;
  tags: string[];
  archived_at: string | null;
};

export function ClientEditor({ client, owners }: { client: EditableClient; owners: Option[] }) {
  const { run, busy, error } = useDeliveryAction();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    display_name: client.display_name,
    company_name: client.company_name ?? "",
    primary_email: client.primary_email ?? "",
    primary_phone: client.primary_phone ?? "",
    stripe_customer_id: client.stripe_customer_id ?? "",
    tags: client.tags.join(", "),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const patch = (body: Record<string, unknown>) => run(`/api/customers/${client.id}`, "PATCH", body);
  const ownerKnown = !client.owner_user_id || owners.some((o) => o.value === client.owner_user_id);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">Status</span>
          <select className="select" value={client.lifecycle} disabled={busy} onChange={(e) => patch({ lifecycle: e.target.value })}>
            {CUSTOMER_LIFECYCLES.map((l) => (
              <option key={l} value={l}>{CUSTOMER_LIFECYCLE_LABELS[l]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Owner</span>
          <select className="select" value={client.owner_user_id ?? ""} disabled={busy} onChange={(e) => patch({ owner_user_id: e.target.value || null })}>
            <option value="">No owner</option>
            {!ownerKnown && <option value={client.owner_user_id ?? ""}>Former teammate (reassign)</option>}
            {owners.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = await patch({
              display_name: f.display_name,
              company_name: f.company_name || null,
              primary_email: f.primary_email || null,
              primary_phone: f.primary_phone || null,
              stripe_customer_id: f.stripe_customer_id || null,
              tags: f.tags,
            });
            if (data) setEditing(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">Name</span>
              <input className="input" required maxLength={160} value={f.display_name} onChange={set("display_name")} />
            </label>
            <label>
              <span className="label">Company</span>
              <input className="input" maxLength={160} value={f.company_name} onChange={set("company_name")} />
            </label>
            <label>
              <span className="label">Email</span>
              <input className="input" type="email" maxLength={254} value={f.primary_email} onChange={set("primary_email")} />
            </label>
            <label>
              <span className="label">Phone</span>
              <input className="input" type="tel" maxLength={40} value={f.primary_phone} onChange={set("primary_phone")} />
            </label>
            <label>
              <span className="label">Stripe customer id</span>
              <input className="input font-mono" maxLength={64} value={f.stripe_customer_id} onChange={set("stripe_customer_id")} placeholder="cus_..." />
            </label>
            <label>
              <span className="label">Tags</span>
              <input className="input" value={f.tags} onChange={set("tags")} placeholder="Comma separated" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !f.display_name.trim()}>
              {busy ? "Saving..." : "Save"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
            Edit details
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => patch({ archived: !client.archived_at })}>
            {client.archived_at ? "Restore from archive" : "Archive"}
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function AddContactForm({ customerId }: { customerId: string }) {
  const { run, busy, error } = useDeliveryAction();
  const [open, setOpen] = useState(false);
  const blank = { name: "", email: "", phone: "", role: "" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  if (!open) {
    return (
      <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => setOpen(true)}>
        Add a contact
      </button>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = await run(`/api/customers/${customerId}/contacts`, "POST", {
          name: f.name || null,
          email: f.email || null,
          phone: f.phone || null,
          role: f.role || null,
        });
        if (data) {
          setF(blank);
          setOpen(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">Name</span>
          <input className="input" maxLength={160} value={f.name} onChange={set("name")} />
        </label>
        <label>
          <span className="label">Role</span>
          <input className="input" maxLength={80} value={f.role} onChange={set("role")} placeholder="e.g. Office manager" />
        </label>
        <label>
          <span className="label">Email</span>
          <input className="input" type="email" maxLength={254} value={f.email} onChange={set("email")} />
        </label>
        <label>
          <span className="label">Phone</span>
          <input className="input" type="tel" maxLength={40} value={f.phone} onChange={set("phone")} />
        </label>
      </div>
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy || !(f.name.trim() || f.email.trim() || f.phone.trim())}>
          {busy ? "Saving..." : "Add contact"}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RemoveContactButton({ customerId, contactId }: { customerId: string; contactId: string }) {
  const { run, busy, error } = useDeliveryAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      {confirming ? (
        <>
          <button
            type="button"
            className="text-xs text-status-hot hover:underline"
            disabled={busy}
            onClick={() => void run(`/api/customers/${customerId}/contacts?contact_id=${encodeURIComponent(contactId)}`, "DELETE", {})}
          >
            {busy ? "Removing..." : "Confirm remove"}
          </button>
          <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {error && <span className="text-xs text-status-hot" role="alert">{error}</span>}
    </span>
  );
}
