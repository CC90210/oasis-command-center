"use client";

/**
 * Ticket controls. Founders: create, triage (status / severity / category /
 * assignee / project / client), resolution, and the reply composer with two
 * explicit actions — "Send reply to client" (emails them) and "Add internal
 * note" (does not). Clients: the composer only, always public.
 *
 * Status offers only the moves TICKET_TRANSITIONS allows from the current
 * status; the API enforces the same table.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_SEVERITIES,
  TICKET_SEVERITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TRANSITIONS,
  type TicketStatus,
} from "@/lib/delivery/rules";
import { useDeliveryAction, type Option } from "@/components/delivery/useDeliveryAction";

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-status-hot" role="alert">{error}</p> : null;
}

export type ProjectOption = Option & { clientTenantId: string | null };

// ---------------------------------------------------------------------------
// Create (founders)
// ---------------------------------------------------------------------------

export function TicketCreateForm({
  roster,
  projects,
  clientTenants,
}: {
  roster: Option[];
  projects: ProjectOption[];
  clientTenants: Option[];
}) {
  const router = useRouter();
  const { run, busy, error } = useDeliveryAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    title: "",
    description: "",
    category: "bug",
    severity: "medium",
    project_id: "",
    client_tenant_id: "",
    client_name: "",
    client_email: "",
    client_company: "",
    assigned_to: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New ticket
      </button>
    );
  }
  return (
    <form
      className="w-full max-w-3xl rounded-xl border border-bg-border bg-bg-panel p-5 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = await run("/api/tickets", "POST", {
          ...f,
          project_id: f.project_id || null,
          client_tenant_id: f.client_tenant_id || null,
          assigned_to: f.assigned_to || null,
        });
        if (data?.id) router.push(`/tickets/${String(data.id)}`);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.14em]">New internal ticket</h2>
        <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-fg-muted">
        Logged by the team (a call, a text). Nobody is emailed. Clients file their own through the support form.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="label">Title</span>
          <input className="input" required maxLength={200} value={f.title} onChange={set("title")} />
        </label>
        <label>
          <span className="label">Category</span>
          <select className="select" value={f.category} onChange={set("category")}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>{TICKET_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Severity</span>
          <select className="select" value={f.severity} onChange={set("severity")}>
            {TICKET_SEVERITIES.map((s) => (
              <option key={s} value={s}>{TICKET_SEVERITY_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Project</span>
          <select className="select" value={f.project_id} onChange={set("project_id")}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Client portal workspace</span>
          <select className="select" value={f.client_tenant_id} onChange={set("client_tenant_id")}>
            <option value="">From the project / none</option>
            {clientTenants.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Client name</span>
          <input className="input" maxLength={160} value={f.client_name} onChange={set("client_name")} />
        </label>
        <label>
          <span className="label">Client email</span>
          <input className="input" type="email" value={f.client_email} onChange={set("client_email")} />
        </label>
        <label>
          <span className="label">Company</span>
          <input className="input" maxLength={160} value={f.client_company} onChange={set("client_company")} />
        </label>
        <label>
          <span className="label">Assignee</span>
          <select className="select" value={f.assigned_to} onChange={set("assigned_to")}>
            <option value="">Unassigned</option>
            {roster.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="sm:col-span-2">
          <span className="label">Description</span>
          <textarea className="textarea" maxLength={10000} value={f.description} onChange={set("description")} />
        </label>
      </div>
      <ErrorLine error={error} />
      <button type="submit" className="btn-primary" disabled={busy || !f.title.trim()}>
        {busy ? "Creating..." : "Create ticket"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Triage (founders)
// ---------------------------------------------------------------------------

export type EditableTicket = {
  id: string;
  status: TicketStatus;
  severity: string;
  category: string;
  assigned_to: string | null;
  project_id: string | null;
  client_tenant_id: string | null;
  resolution: string | null;
};

export function TicketControls({
  ticket,
  roster,
  projects,
  clientTenants,
}: {
  ticket: EditableTicket;
  roster: Option[];
  projects: ProjectOption[];
  clientTenants: Option[];
}) {
  const { run, busy, error } = useDeliveryAction();
  const [resolution, setResolution] = useState(ticket.resolution ?? "");
  const patch = (body: Record<string, unknown>) => run(`/api/tickets/${ticket.id}`, "PATCH", body);
  const nextStatuses = TICKET_TRANSITIONS[ticket.status] ?? [];
  // A ticket that belongs to a client may only move to that client's projects
  // (or projects with no portal). The API refuses the rest; this hides them.
  const linkable = projects.filter(
    (p) => !ticket.client_tenant_id || !p.clientTenantId || p.clientTenantId === ticket.client_tenant_id,
  );
  const assigneeKnown = !ticket.assigned_to || roster.some((r) => r.value === ticket.assigned_to);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">Status</span>
          <select className="select" value={ticket.status} disabled={busy} onChange={(e) => patch({ status: e.target.value })}>
            <option value={ticket.status}>{TICKET_STATUS_LABELS[ticket.status]}</option>
            {nextStatuses.map((s) => (
              <option key={s} value={s}>
                {s === "open" && (ticket.status === "resolved" || ticket.status === "closed") ? "Reopen" : TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Assignee</span>
          <select className="select" value={ticket.assigned_to ?? ""} disabled={busy} onChange={(e) => patch({ assigned_to: e.target.value || null })}>
            <option value="">Unassigned</option>
            {!assigneeKnown && <option value={ticket.assigned_to ?? ""}>Former teammate (reassign)</option>}
            {roster.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Severity</span>
          <select className="select" value={ticket.severity} disabled={busy} onChange={(e) => patch({ severity: e.target.value })}>
            {TICKET_SEVERITIES.map((s) => (
              <option key={s} value={s}>{TICKET_SEVERITY_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Category</span>
          <select className="select" value={ticket.category} disabled={busy} onChange={(e) => patch({ category: e.target.value })}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>{TICKET_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Project</span>
          <select className="select" value={ticket.project_id ?? ""} disabled={busy} onChange={(e) => patch({ project_id: e.target.value || null })}>
            <option value="">No project</option>
            {linkable.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Client portal workspace</span>
          <select className="select" value={ticket.client_tenant_id ?? ""} disabled={busy} onChange={(e) => patch({ client_tenant_id: e.target.value || null })}>
            <option value="">None</option>
            {clientTenants.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await patch({ resolution: resolution.trim() || null });
        }}
      >
        <label className="block">
          <span className="label">Resolution (visible to the client)</span>
          <textarea className="textarea" maxLength={5000} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy || (resolution.trim() || null) === (ticket.resolution ?? null)}>
          Save resolution
        </button>
      </form>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread composer
// ---------------------------------------------------------------------------

export function TicketComposer({ ticketId, mode, closed }: { ticketId: string; mode: "founder" | "client"; closed: boolean }) {
  const { run, busy, error } = useDeliveryAction();
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  if (mode === "client" && closed) {
    return <p className="text-sm text-fg-muted">This ticket is closed. Open a new ticket for anything new.</p>;
  }
  async function send(isInternal: boolean) {
    setNotice(null);
    const data = await run(`/api/tickets/${ticketId}/comments`, "POST", { body, is_internal: isInternal });
    if (!data) return;
    setBody("");
    const comment = data.comment as { email_status?: string | null } | undefined;
    if (mode === "founder" && !isInternal) {
      const status = comment?.email_status ?? "";
      setNotice(status.includes("sent") && !status.includes("FAILED") && !status.includes("not sent")
        ? "Reply saved and emailed to the client."
        : `Reply saved on the ticket, but the email did not go out: ${status || "unknown"}`);
    } else {
      setNotice(isInternal ? "Internal note saved." : "Sent.");
    }
  }
  return (
    <div className="space-y-2">
      <textarea
        className="textarea"
        maxLength={10000}
        placeholder={mode === "founder" ? "Write a reply or an internal note" : "Add a reply"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        {mode === "founder" ? (
          <>
            <button type="button" className="btn-primary" disabled={busy || !body.trim()} onClick={() => send(false)}>
              {busy ? "Sending..." : "Send reply to client"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy || !body.trim()} onClick={() => send(true)}>
              Add internal note
            </button>
            <span className="text-xs text-fg-dim">A reply is emailed to the client. A note is never shown to them.</span>
          </>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !body.trim()} onClick={() => send(false)}>
            {busy ? "Sending..." : "Send"}
          </button>
        )}
      </div>
      {notice && <p className={`text-sm ${notice.includes("did not go out") ? "text-status-warm" : "text-status-engaged"}`}>{notice}</p>}
      <ErrorLine error={error} />
    </div>
  );
}
