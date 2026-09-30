"use client";

/**
 * SlackChannelMap - Settings > Chat apps: which department speaks in each Slack
 * channel, and which client a channel is about.
 *
 * Reads /api/slack/channels (the connected workspace's public channels, with
 * the workspace's own bot token) after the page renders, so a slow Slack never
 * holds the page. Each row saves on its own. What a mapping does, in the
 * row's words:
 *   department   an @mention in the channel goes to that department unless the
 *                message names another; "General" means nobody answers unless
 *                @mentioned (Chief of Staff then).
 *   client       every message in the channel shows on that client's
 *                Conversations tab.
 * Channels shared with another company are listed, disabled: OASIS never reads
 * or answers there. A channel the app is not in cannot receive anything until
 * someone invites the app, and the row says so.
 */

import { useCallback, useEffect, useState } from "react";

type Department = { key: string; label: string };
type Channel = {
  id: string;
  name: string;
  is_member: boolean;
  is_ext_shared: boolean;
  route: { department: string | null; customer_id: string | null } | null;
};
type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      team: { id: string; name: string | null };
      channels: Channel[];
      orphaned: Orphan[];
      truncated: boolean;
      customers: Array<{ id: string; name: string }> | null;
    };

type Orphan = { channel_id: string; channel_name: string | null; department: string | null; customer_id: string | null };
type Draft = { department: string; customer: string };

const GENERAL = "";

function draftOf(c: Channel): Draft {
  return { department: c.route?.department ?? GENERAL, customer: c.route?.customer_id ?? "" };
}

export function SlackChannelMap({
  departments,
  savedRoutes = [],
}: {
  departments: readonly Department[];
  /** The workspace's saved mappings (server-read), shown even when Slack cannot be reached. */
  savedRoutes?: readonly Orphan[];
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoaded({ state: "loading" });
    try {
      const res = await fetch("/api/slack/channels", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body || body.ok !== true) {
        setLoaded({ state: "error", message: String(body?.message ?? `Could not load the channels (HTTP ${res.status}).`) });
        return;
      }
      const channels = body.channels as Channel[];
      setLoaded({
        state: "ready",
        team: body.team as { id: string; name: string | null },
        channels,
        orphaned: Array.isArray(body.orphaned) ? (body.orphaned as Orphan[]) : [],
        truncated: body.truncated === true,
        customers: (body.customers as Array<{ id: string; name: string }> | null) ?? null,
      });
      setDrafts(Object.fromEntries(channels.map((c) => [c.id, draftOf(c)])));
    } catch (err) {
      setLoaded({ state: "error", message: err instanceof Error ? `Could not load the channels: ${err.message}` : "Could not load the channels." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(c: Channel) {
    const d = drafts[c.id] ?? draftOf(c);
    setBusy(c.id);
    try {
      const res = await fetch("/api/slack/channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel_id: c.id, department: d.department || null, customer_id: d.customer || null }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || body?.ok !== true) {
        setRowNote((n) => ({ ...n, [c.id]: { ok: false, text: String(body?.message ?? `Not saved (HTTP ${res.status}).`) } }));
        return;
      }
      const route = body.route as { department: string | null; customer_id: string | null };
      setLoaded((l) =>
        l.state === "ready"
          ? { ...l, channels: l.channels.map((x) => (x.id === c.id ? { ...x, route: { department: route.department, customer_id: route.customer_id } } : x)) }
          : l,
      );
      setRowNote((n) => ({ ...n, [c.id]: { ok: true, text: "Saved" } }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(channelId: string) {
    setBusy(channelId);
    try {
      const res = await fetch(`/api/slack/channels?channel_id=${encodeURIComponent(channelId)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || body?.ok !== true) {
        setRowNote((n) => ({ ...n, [channelId]: { ok: false, text: String(body?.message ?? `Not removed (HTTP ${res.status}).`) } }));
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loaded.state === "loading") return <p className="text-[13px] leading-5 text-fg-muted">Loading your Slack channels…</p>;
  if (loaded.state === "error") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-[13px] leading-5">
          <span className="text-status-warm">{loaded.message}</span>
          <button type="button" onClick={() => void load()} className="btn-secondary">
            Try again
          </button>
        </div>
        {/* What is mapped is OASIS's own record, so it stays visible while Slack is not answering. */}
        {savedRoutes.length > 0 && (
          <div>
            <p className="text-[12px] font-medium text-fg-dim">Mapped now</p>
            <ul className="mt-1 space-y-0.5 text-[13px] leading-5 text-fg-muted">
              {savedRoutes.map((m) => (
                <li key={m.channel_id}>
                  <span className="font-medium text-fg">#{m.channel_name ?? m.channel_id}</span>{" "}
                  {m.department ? departments.find((d) => d.key === m.department)?.label ?? m.department : "General"}
                  {m.customer_id ? ", linked to a client" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const q = filter.trim().toLowerCase();
  const rows = loaded.channels.filter((c) => !q || c.name.toLowerCase().includes(q));
  const mapped = loaded.channels.filter((c) => c.route).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-[13px] leading-5 text-fg-muted">
          {mapped === 0 ? "No channel is mapped yet." : `${mapped} of ${loaded.channels.length} public channels mapped.`} Invite the app to a
          channel in Slack (type /invite and pick the app) before mapping it.
        </p>
        <label className="sr-only" htmlFor="slack-channel-filter">
          Find a channel
        </label>
        <input
          id="slack-channel-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a channel"
          className="input w-48 text-sm"
        />
      </div>
      {loaded.customers === null && (
        <p className="text-[12px] leading-4 text-status-warm">Your client records could not be read, so channels cannot be linked to a client right now.</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-hairline text-[12px] text-fg-dim">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Channel</th>
              <th scope="col" className="px-3 py-2 font-medium">Department</th>
              <th scope="col" className="px-3 py-2 font-medium">Client</th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((c) => {
              const d = drafts[c.id] ?? draftOf(c);
              const changed = d.department !== (c.route?.department ?? GENERAL) || d.customer !== (c.route?.customer_id ?? "") || !c.route;
              const note = rowNote[c.id];
              const disabled = c.is_ext_shared || busy === c.id;
              return (
                <tr key={c.id} className={c.is_ext_shared ? "opacity-60" : ""}>
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium text-fg">#{c.name}</div>
                    {c.is_ext_shared ? (
                      <div className="text-[12px] leading-4 text-fg-dim">Shared with another company. OASIS stays out.</div>
                    ) : !c.is_member ? (
                      <div className="text-[12px] leading-4 text-fg-dim">The app is not in this channel yet.</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <label className="sr-only" htmlFor={`dept-${c.id}`}>
                      Department for #{c.name}
                    </label>
                    <select
                      id={`dept-${c.id}`}
                      value={d.department}
                      disabled={disabled}
                      onChange={(e) => setDrafts((all) => ({ ...all, [c.id]: { ...d, department: e.target.value } }))}
                      className="input w-44 text-sm"
                    >
                      <option value={GENERAL}>General</option>
                      {departments.map((dep) => (
                        <option key={dep.key} value={dep.key}>
                          {dep.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <label className="sr-only" htmlFor={`client-${c.id}`}>
                      Client for #{c.name}
                    </label>
                    <select
                      id={`client-${c.id}`}
                      value={d.customer}
                      disabled={disabled || loaded.customers === null}
                      onChange={(e) => setDrafts((all) => ({ ...all, [c.id]: { ...d, customer: e.target.value } }))}
                      className="input w-48 text-sm"
                    >
                      <option value="">No client</option>
                      {(loaded.customers ?? []).map((cu) => (
                        <option key={cu.id} value={cu.id}>
                          {cu.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right align-top">
                    <div className="flex items-center justify-end gap-2">
                      {note && <span className={`text-[12px] ${note.ok ? "text-fg-muted" : "text-status-warm"}`}>{note.text}</span>}
                      {!c.is_ext_shared && changed && (
                        <button type="button" onClick={() => void save(c)} disabled={busy !== null} className="btn-primary">
                          {busy === c.id ? "Saving…" : c.route ? "Save" : "Map"}
                        </button>
                      )}
                      {c.route && (
                        <button type="button" onClick={() => void remove(c.id)} disabled={busy !== null} className="btn-secondary">
                          Unmap
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-fg-muted">
                  {loaded.channels.length === 0 ? "Slack listed no public channels for this workspace." : "No channel matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loaded.truncated && <p className="text-[12px] leading-4 text-fg-dim">Only the first 500 channels are listed.</p>}
      {loaded.orphaned.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[12px] font-medium text-fg-dim">Mapped, but Slack no longer lists them (archived or made private)</p>
          <ul className="space-y-1">
            {loaded.orphaned.map((o) => (
              <li key={o.channel_id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="text-fg-muted">#{o.channel_name ?? o.channel_id}</span>
                <button type="button" onClick={() => void remove(o.channel_id)} disabled={busy !== null} className="btn-secondary">
                  Unmap
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
