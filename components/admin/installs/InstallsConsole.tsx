"use client";

/**
 * The install console's interactive half: the workspace table, the set-up
 * panel and the owner-invite panel. Every write asks for confirmation first
 * and shows what the server did (the provisioning steps, the invite result).
 * Data comes from the server page; this component only posts to the
 * operator-only /api/admin/installs routes and refreshes.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InstallRow } from "@/lib/provisioning/installs";

export type ConsoleOptions = {
  departments: Array<{ key: string; label: string; purpose: string; teammate: string | null; locked: boolean }>;
  defaultDepartments: string[];
  modules: Array<{ key: string; label: string; description: string }>;
  chatApps: Array<{ key: string; label: string }>;
};

type Step = { title: string; time: string };
type Outcome = { ok: boolean; message: string; steps?: Step[]; link?: string | null };

type Choices = { departments: string[]; modules: string[]; chatApps: string[]; jev: "off" | "shadow" };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "No activity recorded";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function outcomeFrom(json: Record<string, unknown>, fallback: string): Outcome {
  const steps = Array.isArray(json.steps) ? (json.steps as Step[]) : undefined;
  if (json.ok === true) {
    const invite = json.invite as { invite_url?: string | null } | undefined;
    return {
      ok: true,
      message: typeof json.message === "string" ? json.message : "Done.",
      steps,
      link: invite?.invite_url ?? null,
    };
  }
  return { ok: false, message: typeof json.message === "string" ? json.message : fallback, steps };
}

export function InstallsConsole({ installs, options }: { installs: InstallRow[]; options: ConsoleOptions }) {
  const clients = installs.filter((i) => i.kind === "client");
  const others = installs.filter((i) => i.kind !== "client");
  return (
    <div className="space-y-8">
      <NewWorkspace options={options} />
      <section aria-label="Client workspaces">
        <h2 className="text-sm font-semibold text-fg">Client workspaces ({clients.length})</h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          Last activity is the newest profile change, setup save, audit event or setup step in that workspace.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-hairline">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-bg-panel text-[12px] text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Members</th>
                <th className="px-3 py-2 font-medium">Set up</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-fg-muted">
                    No client workspaces yet. Create one above.
                  </td>
                </tr>
              ) : (
                clients.map((row) => <InstallRowView key={row.tenantId} row={row} options={options} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
      {others.length > 0 && (
        <section aria-label="Other workspaces">
          <h2 className="text-sm font-semibold text-fg">OASIS and retired workspaces</h2>
          <p className="mt-1 text-[13px] text-fg-muted">Listed for reference. They are not set up from here.</p>
          <ul className="mt-2 space-y-1 text-sm text-fg-muted">
            {others.map((o) => (
              <li key={o.tenantId}>
                <span className="text-fg">{o.name}</span> /{o.slug} · {o.kind === "oasis" ? "OASIS" : "Retired"} ·{" "}
                {o.members} member{o.members === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ChoicesEditor({ options, value, onChange }: { options: ConsoleOptions; value: Choices; onChange: (c: Choices) => void }) {
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <fieldset>
        <legend className="text-[13px] font-medium text-fg">Departments</legend>
        <div className="mt-2 space-y-1.5">
          {options.departments.map((d) => (
            <label key={d.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-accent"
                checked={value.departments.includes(d.key)}
                disabled={d.locked}
                onChange={() => onChange({ ...value, departments: toggle(value.departments, d.key) })}
              />
              <span>
                <span className="text-fg">{d.label}</span>
                <span className="block text-[12px] text-fg-muted">
                  {d.purpose} {d.teammate ? `Teammate: ${d.teammate}.` : "No AI teammate for this department yet."}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-4">
        <fieldset>
          <legend className="text-[13px] font-medium text-fg">Add-ons requested</legend>
          <p className="text-[12px] text-fg-muted">Recorded on the workspace. They turn on in the rail when billing includes them.</p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {options.modules.map((m) => (
              <label key={m.key} className="flex items-start gap-2 text-sm" title={m.description}>
                <input
                  type="checkbox"
                  className="mt-1 accent-accent"
                  checked={value.modules.includes(m.key)}
                  onChange={() => onChange({ ...value, modules: toggle(value.modules, m.key) })}
                />
                <span className="text-fg">{m.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-medium text-fg">Where does their team talk?</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {options.chatApps.map((a) => (
              <label key={a.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={value.chatApps.includes(a.key)}
                  onChange={() => {
                    // "Email only" cannot sit beside a chat app, in either direction.
                    const chatApps =
                      a.key === "email"
                        ? value.chatApps.includes("email") ? [] : ["email"]
                        : toggle(value.chatApps.filter((k) => k !== "email"), a.key);
                    onChange({ ...value, chatApps });
                  }}
                />
                <span className="text-fg">{a.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-[12px] text-fg-muted">Slack connects in Settings &gt; Chat apps once their owner signs in.</p>
        </fieldset>
        <label className="block text-sm">
          <span className="text-[13px] font-medium text-fg">Fast classifier (Jev)</span>
          <select
            className="mt-1 block w-full rounded-md border border-hairline bg-bg-panel px-2 py-1.5 text-sm text-fg"
            value={value.jev}
            onChange={(e) => onChange({ ...value, jev: e.target.value === "shadow" ? "shadow" : "off" })}
          >
            <option value="off">Off (default for clients)</option>
            <option value="shadow">Shadow: runs beside the normal path, acts on nothing</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function StepsList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[13px] text-fg-muted">
      {steps.map((s, i) => (
        <li key={`${s.time}-${i}`}>{s.title}</li>
      ))}
    </ol>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <div
      role="status"
      className={`mt-3 rounded-lg border px-3 py-2 text-sm ${outcome.ok ? "border-status-engaged/40 text-fg" : "border-status-hot/40 text-fg"}`}
    >
      {outcome.message}
      {outcome.link && (
        <input
          readOnly
          aria-label="Invite link"
          value={outcome.link}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-2 block w-full rounded-md border border-hairline bg-bg-panel px-2 py-1 font-mono text-[12px] text-fg"
        />
      )}
      <StepsList steps={outcome.steps ?? []} />
    </div>
  );
}

function NewWorkspace({ options }: { options: ConsoleOptions }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [choices, setChoices] = useState<Choices>({ departments: options.defaultDepartments, modules: [], chatApps: [], jev: "off" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const address = slugEdited ? slug : slugify(name);

  async function create() {
    setBusy(true);
    setOutcome(null);
    try {
      const { json } = await postJson("/api/admin/installs", {
        name,
        slug: address,
        departments: choices.departments,
        modules: choices.modules,
        chat_apps: choices.chatApps,
        jev: choices.jev,
      });
      const o = outcomeFrom(json, "The workspace was not created.");
      setOutcome(o.ok ? { ...o, message: `Created and set up ${name}.` } : o);
      if (o.ok) {
        setName("");
        setSlug("");
        setSlugEdited(false);
        router.refresh();
      }
    } catch {
      setOutcome({ ok: false, message: "Could not reach the server. Nothing was created." });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section aria-label="New client workspace" className="rounded-xl border border-hairline bg-bg-panel p-4">
      <h2 className="text-sm font-semibold text-fg">New client workspace</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-[13px] font-medium text-fg">Business name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The client's business name"
            className="mt-1 block w-full rounded-md border border-hairline bg-bg-panel px-2 py-1.5 text-sm text-fg"
          />
        </label>
        <label className="block text-sm">
          <span className="text-[13px] font-medium text-fg">Address</span>
          <input
            value={address}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            placeholder="business-name"
            className="mt-1 block w-full rounded-md border border-hairline bg-bg-panel px-2 py-1.5 font-mono text-sm text-fg"
          />
        </label>
      </div>
      <div className="mt-4">
        <ChoicesEditor options={options} value={choices} onChange={setChoices} />
      </div>
      {!confirming ? (
        <button
          type="button"
          className="btn-primary mt-4"
          disabled={!name.trim() || !address || busy}
          onClick={() => setConfirming(true)}
        >
          Create and set up
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-hairline p-3 text-sm text-fg">
          Create <strong>{name.trim()}</strong> at /{address} with{" "}
          {options.departments.filter((d) => choices.departments.includes(d.key)).map((d) => d.label).join(", ")}? This adds a
          real workspace.
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={create}>
              {busy ? "Setting up…" : "Yes, create it"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <OutcomeView outcome={outcome} />
    </section>
  );
}

function InstallRowView({ row, options }: { row: InstallRow; options: ConsoleOptions }) {
  const router = useRouter();
  const [panel, setPanel] = useState<"none" | "setup" | "invite">("none");
  const [choices, setChoices] = useState<Choices>({ departments: options.defaultDepartments, modules: [], chatApps: [], jev: "off" });
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const setupLabel = useMemo(() => {
    if (!row.manifestSlug) return row.runStatus === "failed" ? "Not set up (last attempt failed)" : "Not set up";
    return row.manifestSlug === row.slug ? "Set up" : `Set up under /${row.manifestSlug}`;
  }, [row]);

  async function run() {
    setBusy(true);
    setOutcome(null);
    try {
      const { json } =
        panel === "setup"
          ? await postJson(`/api/admin/installs/${row.tenantId}/provision`, {
              departments: choices.departments,
              modules: choices.modules,
              chat_apps: choices.chatApps,
              jev: choices.jev,
            })
          : await postJson(`/api/admin/installs/${row.tenantId}/owner-invite`, { email });
      const o = outcomeFrom(json, panel === "setup" ? "Setup did not finish." : "The invite was not created.");
      setOutcome(o.ok && panel === "setup" ? { ...o, message: `Set up ${row.name}.` } : o);
      if (o.ok) router.refresh();
    } catch {
      setOutcome({ ok: false, message: "Could not reach the server. Nothing was changed." });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <>
      <tr className="border-t border-hairline align-top">
        <td className="px-3 py-2">
          <div className="text-fg">{row.name}</div>
          <div className="font-mono text-[12px] text-fg-muted">/{row.slug}</div>
        </td>
        <td className="px-3 py-2 text-fg-muted">
          {row.ownerEmail ? (
            <span className="text-fg">{row.ownerName ? `${row.ownerName} · ` : ""}{row.ownerEmail}</span>
          ) : row.pendingOwnerInvite ? (
            `Invite sent to ${row.pendingOwnerInvite}`
          ) : (
            "No owner yet"
          )}
        </td>
        <td className="px-3 py-2 text-fg">{row.members}</td>
        <td className="px-3 py-2 text-fg">{setupLabel}</td>
        <td className="px-3 py-2 text-fg-muted">{formatWhen(row.lastActivity)}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => { setPanel(panel === "setup" ? "none" : "setup"); setConfirming(false); setOutcome(null); }}>
              {row.manifestSlug ? "Set up again" : "Provision"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!!row.ownerEmail}
              title={row.ownerEmail ? "This workspace already has an owner" : undefined}
              onClick={() => { setPanel(panel === "invite" ? "none" : "invite"); setConfirming(false); setOutcome(null); }}
            >
              Send owner invite
            </button>
          </div>
        </td>
      </tr>
      {panel !== "none" && (
        <tr className="bg-bg-panel">
          <td colSpan={6} className="px-3 py-3">
            {panel === "setup" ? (
              <ChoicesEditor options={options} value={choices} onChange={setChoices} />
            ) : (
              <label className="block max-w-md text-sm">
                <span className="text-[13px] font-medium text-fg">Founder&apos;s email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="The address the founder will sign up with"
                  className="mt-1 block w-full rounded-md border border-hairline bg-bg-panel px-2 py-1.5 text-sm text-fg"
                />
                <span className="mt-1 block text-[12px] text-fg-muted">
                  The invite works only for this address and makes them the workspace owner.
                </span>
              </label>
            )}
            {!confirming ? (
              <button
                type="button"
                className="btn-primary mt-3"
                disabled={busy || (panel === "invite" && !email.includes("@"))}
                onClick={() => setConfirming(true)}
              >
                {panel === "setup" ? "Set up this workspace" : "Send the owner invite"}
              </button>
            ) : (
              <div className="mt-3 text-sm text-fg">
                {panel === "setup"
                  ? `Save this setup to ${row.name}? Members see the new departments on their next page load.`
                  : `Email an owner invite for ${row.name} to ${email.trim()}?`}
                <div className="mt-2 flex gap-2">
                  <button type="button" className="btn-primary" disabled={busy} onClick={run}>
                    {busy ? "Working…" : "Yes, do it"}
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <OutcomeView outcome={outcome} />
          </td>
        </tr>
      )}
    </>
  );
}
