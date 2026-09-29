"use client";

/**
 * clients-actions — every control on the Clients pages and the Support desk
 * that writes: New client, Convert to client, the record's editor and
 * contacts, and turning a workspace's public support form on.
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
