"use client";

/**
 * Founder controls for projects: create, edit in place, tasks, timeline.
 * Every change goes through /api/projects/**, which re-validates everything
 * (assignee against the live roster included); these controls only offer
 * choices the server will accept.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  PROJECT_PRIORITIES,
  PROJECT_STAGES,
  PROJECT_STAGE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type ProjectStage,
  type TaskStatus,
} from "@/lib/delivery/rules";
import { useDeliveryAction, type Option } from "@/components/delivery/useDeliveryAction";

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-status-hot" role="alert">{error}</p> : null;
}

function AssigneeSelect({
  value,
  roster,
  onChange,
  disabled,
  id,
}: {
  value: string;
  roster: Option[];
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const known = !value || roster.some((r) => r.value === value);
  return (
    <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Unassigned</option>
      {!known && <option value={value}>Former teammate (reassign)</option>}
      {roster.map((r) => (
        <option key={r.value} value={r.value}>{r.label}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function ProjectCreateForm({ roster, clientTenants }: { roster: Option[]; clientTenants: Option[] }) {
  const router = useRouter();
  const { run, busy, error } = useDeliveryAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    title: "",
    client_tenant_id: "",
    client_name: "",
    client_email: "",
    stage: "discovery",
    priority: "medium",
    assigned_to: "",
    due_date: "",
    lead_id: "",
    description: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New project
      </button>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const data = await run("/api/projects", "POST", {
      ...f,
      client_tenant_id: f.client_tenant_id || null,
      assigned_to: f.assigned_to || null,
      due_date: f.due_date || null,
      lead_id: f.lead_id.trim() || null,
    });
    if (data?.id) router.push(`/projects/${String(data.id)}`);
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
    >
    <form onSubmit={submit} className="w-full max-w-3xl rounded-xl border border-bg-border bg-bg-panel p-5 space-y-4 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.14em]">New project</h2>
        <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="label">Title</span>
          <input className="input" required maxLength={200} value={f.title} onChange={set("title")} placeholder="Acme Plumbing website" />
        </label>
        <label>
          <span className="label">Client portal workspace</span>
          <select className="select" value={f.client_tenant_id} onChange={set("client_tenant_id")}>
            <option value="">No portal (email only)</option>
            {clientTenants.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Client email</span>
          <input className="input" type="email" value={f.client_email} onChange={set("client_email")} placeholder="owner@client.com" />
        </label>
        <label>
          <span className="label">Client name</span>
          <input className="input" maxLength={160} value={f.client_name} onChange={set("client_name")} />
        </label>
        <label>
          <span className="label">Assignee</span>
          <AssigneeSelect value={f.assigned_to} roster={roster} onChange={(v) => setF({ ...f, assigned_to: v })} />
        </label>
        <label>
          <span className="label">Stage</span>
          <select className="select" value={f.stage} onChange={set("stage")}>
            {PROJECT_STAGES.map((s) => (
              <option key={s} value={s}>{PROJECT_STAGE_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Priority</span>
          <select className="select" value={f.priority} onChange={set("priority")}>
            {PROJECT_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Due date</span>
          <input className="input" type="date" value={f.due_date} onChange={set("due_date")} />
        </label>
        <label>
          <span className="label">Pipeline lead id (optional)</span>
          <input className="input font-mono text-xs" value={f.lead_id} onChange={set("lead_id")} placeholder="links the deal this came from" />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Description</span>
          <textarea className="textarea" maxLength={10000} value={f.description} onChange={set("description")} />
        </label>
      </div>
      <ErrorLine error={error} />
      <button type="submit" className="btn-primary" disabled={busy || !f.title.trim()}>
        {busy ? "Creating..." : "Create project"}
      </button>
    </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit in place
// ---------------------------------------------------------------------------

export type EditableProject = {
  id: string;
  title: string;
  description: string | null;
  stage: ProjectStage;
  priority: string;
  assigned_to: string | null;
  due_date: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  archived_at: string | null;
};

export function ProjectControls({
  project,
  roster,
  clientTenants,
}: {
  project: EditableProject;
  roster: Option[];
  clientTenants: Option[];
}) {
  const { run, busy, error } = useDeliveryAction();
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({
    title: project.title,
    description: project.description ?? "",
    client_tenant_id: project.client_tenant_id ?? "",
    client_name: project.client_name ?? "",
    client_email: project.client_email ?? "",
    lead_id: project.lead_id ?? "",
  });
  const patch = (body: Record<string, unknown>) => run(`/api/projects/${project.id}`, "PATCH", body);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label>
          <span className="label">Stage</span>
          <select className="select" value={project.stage} disabled={busy} onChange={(e) => patch({ stage: e.target.value })}>
            {PROJECT_STAGES.map((s) => (
              <option key={s} value={s}>{PROJECT_STAGE_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Priority</span>
          <select className="select" value={project.priority} disabled={busy} onChange={(e) => patch({ priority: e.target.value })}>
            {PROJECT_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Assignee</span>
          <AssigneeSelect value={project.assigned_to ?? ""} roster={roster} disabled={busy} onChange={(v) => patch({ assigned_to: v || null })} />
        </label>
        <label>
          <span className="label">Due date</span>
          <input
            className="input"
            type="date"
            defaultValue={project.due_date ?? ""}
            disabled={busy}
            onBlur={(e) => {
              if ((e.target.value || null) !== project.due_date) patch({ due_date: e.target.value || null });
            }}
          />
        </label>
      </div>

      {editing ? (
        <form
          className="space-y-3 rounded-lg border border-bg-border bg-bg-elev/40 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await patch({
              title: d.title,
              description: d.description || null,
              client_tenant_id: d.client_tenant_id || null,
              client_name: d.client_name || null,
              client_email: d.client_email || null,
              lead_id: d.lead_id.trim() || null,
            });
            if (ok) setEditing(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="label">Title</span>
              <input className="input" required maxLength={200} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
            </label>
            <label>
              <span className="label">Client portal workspace</span>
              <select className="select" value={d.client_tenant_id} onChange={(e) => setD({ ...d, client_tenant_id: e.target.value })}>
                <option value="">No portal (email only)</option>
                {clientTenants.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Client email</span>
              <input className="input" type="email" value={d.client_email} onChange={(e) => setD({ ...d, client_email: e.target.value })} />
            </label>
            <label>
              <span className="label">Client name</span>
              <input className="input" maxLength={160} value={d.client_name} onChange={(e) => setD({ ...d, client_name: e.target.value })} />
            </label>
            <label>
              <span className="label">Pipeline lead id</span>
              <input className="input font-mono text-xs" value={d.lead_id} onChange={(e) => setD({ ...d, lead_id: e.target.value })} />
            </label>
            <label className="sm:col-span-2">
              <span className="label">Description</span>
              <textarea className="textarea" maxLength={10000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving..." : "Save"}</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>Edit details</button>
          <button
            type="button"
            className={project.archived_at ? "btn-secondary" : "btn-danger"}
            disabled={busy}
            onClick={() => patch({ archived: !project.archived_at })}
          >
            {project.archived_at ? "Restore from archive" : "Archive project"}
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskItem = {
  id: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  due_date: string | null;
  notes: string | null;
};

export function TaskList({ projectId, tasks, roster }: { projectId: string; tasks: TaskItem[]; roster: Option[] }) {
  const { run, busy, error } = useDeliveryAction();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const patch = (taskId: string, body: Record<string, unknown>) =>
    run(`/api/projects/${projectId}/tasks/${taskId}`, "PATCH", body);

  return (
    <div className="space-y-3">
      {tasks.length === 0 ? (
        <p className="text-sm text-fg-muted">No tasks yet.</p>
      ) : (
        <ul className="divide-y divide-bg-border rounded-lg border border-bg-border">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
              <span className={`flex-1 text-sm ${t.status === "done" || t.status === "cancelled" ? "text-fg-dim line-through" : "text-fg"}`}>
                {t.title}
                {t.due_date && <span className="ml-2 text-xs text-fg-dim no-underline">due {t.due_date}</span>}
              </span>
              <div className="flex gap-2 sm:w-[22rem]">
                <select
                  aria-label={`Status of ${t.title}`}
                  className="select"
                  value={t.status}
                  disabled={busy}
                  onChange={(e) => patch(t.id, { status: e.target.value })}
                >
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>
                  ))}
                </select>
                <AssigneeSelect value={t.assigned_to ?? ""} roster={roster} disabled={busy} onChange={(v) => patch(t.id, { assigned_to: v || null })} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(`/api/projects/${projectId}/tasks`, "POST", {
            title,
            assigned_to: assignee || null,
            due_date: due || null,
          });
          if (ok) {
            setTitle("");
            setDue("");
          }
        }}
      >
        <input className="input sm:flex-1" placeholder="Add a task" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="sm:w-44">
          <AssigneeSelect value={assignee} roster={roster} onChange={setAssignee} />
        </div>
        <input className="input sm:w-40" type="date" aria-label="Task due date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit" className="btn-secondary" disabled={busy || !title.trim()}>Add</button>
      </form>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function UpdateComposer({ projectId }: { projectId: string }) {
  const { run, busy, error } = useDeliveryAction();
  const [body, setBody] = useState("");
  const [shared, setShared] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(`/api/projects/${projectId}/updates`, "POST", {
          body,
          visibility: shared ? "client" : "internal",
        });
        if (ok) {
          setBody("");
          setShared(false);
        }
      }}
    >
      <textarea className="textarea" maxLength={5000} placeholder="Post an update" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Visible to the client in their portal
        </label>
        <button type="submit" className="btn-secondary" disabled={busy || !body.trim()}>
          {shared ? "Post to client" : "Post internal update"}
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
