"use client";

/**
 * CustomCredentialsVault - the Custom keys drawer on Settings > Connections:
 * add a key, see each key with the agents it is for, paste several at once.
 *
 * A custom key is any KEY=value secret an agent needs for an app with no
 * card: a client's API token, a webhook URL, an internal key. It is stored
 * encrypted (AES-256-GCM) and agents read it with the `get_credential` tool
 * (lib/cloud-tool-runner.ts), where the value goes to the request that uses
 * it and never into the chat. The API never returns a value, only that one is
 * saved; there is no "reveal": a forgotten value is pasted again.
 *
 * Dynamic (CC, 2026-10-26). As the owner types a name, lib/os/custom-keys.ts
 * recognises the app (HUBSPOT_PRIVATE_APP_TOKEN is HubSpot's; a value that
 * starts "sk-ant-" is Anthropic's) and the agents picker follows its
 * suggestion, by agent name, until the owner picks. A name already saved
 * replaces that key's value and keeps its agents unless they are changed. An
 * app with its own card says so and opens it. A paste lists every key with
 * its app and agents, each changeable before anything is saved. A saved key
 * still open to all agents shows its app's suggestion, one click to apply.
 *
 * Agents are sent only when chosen, or suggested for a new key
 * (custom-keys.ts agentsToSend): a new value must not widen or narrow a
 * choice the owner made earlier (review of OCC #743). The form is one column
 * so nothing is pushed out of the drawer: the viewport-wide `sm:` grid it had
 * put the Save button off the drawer's edge.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Trash2, Upload } from "lucide-react";
import { timeAgo } from "@/lib/devices/presence";
import { AgentPicker } from "@/components/os/connections/AgentPicker";
import {
  AGENT_ACCESS_CHANGED_EVENT,
  AGENT_CHOICES,
  agentNames,
  agentNamesSentence,
  sameAgentAccess,
  type AgentAccess,
  type AgentChoice,
} from "@/lib/os/agent-access";
import {
  agentsShown,
  agentsToSend,
  keyNameProblem,
  normalizeVaultKeyName,
  parseDotenvLines,
  recognizeCustomKey,
  unreadablePasteLines,
  VAULT_MAX_VALUE_LENGTH,
  draftApplies,
  looksLikeSecret,
  pastedNameProblem,
  type DraftScope,
  type KeyHint,
} from "@/lib/os/custom-keys";

type CustomCredentialRow = {
  key: string;
  has_value: boolean;
  updated_at: string | null;
  /** Which agents may use it (CC, 2026-10-26); null when the choices could not be read. */
  agents: AgentAccess | null;
  agents_saved: boolean;
  /** Its saved choice cannot be read: no agent may use it until it is saved again. */
  agents_unreadable?: boolean;
};

type UpsertResult = {
  key: string;
  ok: boolean;
  error?: string;
};

const INPUT =
  "w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none";
const PRIMARY = "btn-primary";
const LINK = "text-accent hover:underline";

function valueProblem(value: string): string | null {
  return value.length > VAULT_MAX_VALUE_LENGTH ? "Too long: 8 KB at most." : null;
}

export function CustomCredentialsVault({
  onOpenApp,
  active = true,
}: {
  /** Opens a recognised app's own card (the Connections page passes it). */
  onOpenApp?: (slug: string) => void;
  /** The drawer is open: the keys are read again each time it opens, so the list is never an old one. */
  active?: boolean;
} = {}) {
  const [rows, setRows] = useState<CustomCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  // The saved keys have been read. Until then the page cannot say which names
  // are saved or who uses them, so nothing is saved.
  const [listed, setListed] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  // The workspace's agents by name ("Maven (Marketing)"), from the route.
  const [choices, setChoices] = useState<ReadonlyArray<AgentChoice>>(AGENT_CHOICES);

  // Add a key. The owner's pick, and the name it was made for: a pick made for
  // a saved key never carries to another name (custom-keys.ts draftApplies).
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [draft, setDraft] = useState<AgentAccess>("all");
  const [draftScope, setDraftScope] = useState<DraftScope | null>(null);
  const [busy, setBusy] = useState(false);

  // Paste several: the agents the owner chose per key, by its saved name.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteAgents, setPasteAgents] = useState<Record<string, AgentAccess>>({});
  const [pasteEditing, setPasteEditing] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteResults, setPasteResults] = useState<UpsertResult[] | null>(null);

  // Change a saved key's agents, one key at a time.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editAgents, setEditAgents] = useState<AgentAccess>("all");
  const [editBusy, setEditBusy] = useState(false);

  /** Read the saved keys; the rows, or null when they could not be read. */
  const fetchRows = useCallback(async (): Promise<CustomCredentialRow[] | null> => {
    setLoading(true);
    try {
      const r = await fetch("/api/credentials/custom", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        entries?: CustomCredentialRow[];
        agents_error?: string;
        choices?: AgentChoice[];
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setListError(j.error || `http_${r.status}`);
        setRows([]);
        setListed(false);
        return null;
      }
      const entries = j.entries || [];
      setRows(entries);
      setListed(true);
      setListError(null);
      setAgentsError(j.agents_error || null);
      if (Array.isArray(j.choices) && j.choices.length > 0) setChoices(j.choices);
      return entries;
    } catch (e) {
      setListError(e instanceof Error ? e.message : "fetch_failed");
      setRows([]);
      setListed(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Read on every opening: the drawer stays mounted while closed, and another
  // admin, tab or agent may have changed the keys since (review of OCC #748).
  useEffect(() => {
    if (active) void fetchRows();
  }, [active, fetchRows]);

  // The Connections page's cards read their agents again (ConnectionsHub).
  const announce = () => window.dispatchEvent(new CustomEvent(AGENT_ACCESS_CHANGED_EVENT));
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const sentence = (access: AgentAccess) => agentNamesSentence(access, choices);

  // The key being added, as it will be saved.
  const keyName = normalizeVaultKeyName(name);
  const nameProblem = keyNameProblem(name);
  const existing = keyName ? byKey.get(keyName) : undefined;
  const touched = draftApplies(draftScope, keyName, !!existing);
  const hint = recognizeCustomKey(name, value);
  const shown = touched ? draft : agentsShown({ saved: !!existing, existing: existing?.agents ?? null, hint });
  const toSend = agentsToSend({ touched, draft, hint });
  const tooLong = valueProblem(value);
  // Why nothing can be saved yet, or null. Agents that cannot be read would make
  // every line about them a guess (review of OCC #748).
  const blockedBy = !listed
    ? loading
      ? "Reading your saved keys first."
      : "Your saved keys could not be read, so nothing can be saved yet."
    : agentsError
      ? "Which agents may use these keys could not be read, so nothing can be saved yet."
      : null;
  const canSave = !blockedBy && !!keyName && !nameProblem && !!value.trim() && !tooLong && !busy;
  const pick = (next: AgentAccess) => {
    setDraft(next);
    setDraftScope({ key: keyName, saved: !!existing });
  };

  // The keys in a paste, each once (a key pasted twice keeps its last value).
  // A paste is saved as written: its names are never reshaped (pastedNameProblem).
  const pasted = useMemo(() => {
    const lines = parseDotenvLines(pasteText);
    const lastAt = new Map<string, number>();
    lines.forEach((l, i) => lastAt.set(l.key.trim().toUpperCase() || `#${i}`, i));
    return lines.flatMap((l, i) => {
      const key = l.key.trim().toUpperCase();
      if (lastAt.get(key || `#${i}`) !== i) return [];
      const problem = pastedNameProblem(l.key, l.value) ?? (!l.value.trim() ? "No value." : valueProblem(l.value));
      // A secret pasted without a name is never shown as one.
      const secret = looksLikeSecret(l.key) || /^=+$/.test(l.value.trim());
      const row = byKey.get(key);
      const lineHint = problem ? null : recognizeCustomKey(l.key, l.value);
      const chosen = pasteAgents[key];
      const agents = chosen ?? agentsShown({ saved: !!row, existing: row?.agents ?? null, hint: lineHint });
      const send = agentsToSend({ touched: chosen !== undefined, draft: chosen ?? "all", hint: lineHint });
      return [{ id: `${i}`, key: secret ? "(a secret without a name)" : key, sendKey: l.key.trim(), value: l.value, problem, exists: !!row, hint: lineHint, agents, send }];
    });
  }, [pasteText, pasteAgents, byKey]);
  const pasteReady = pasted.filter((p) => !p.problem);
  const pasteSkipped = unreadablePasteLines(pasteText);
  const pasteRepeats = parseDotenvLines(pasteText).length - pasted.length;

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyName, value, ...toSend }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; results?: UpsertResult[]; error?: string };
      if (!j.ok) {
        setErr(j.results?.[0]?.error || j.error || `http_${r.status}`);
        return;
      }
      const saved = keyName;
      setName("");
      setValue("");
      setDraft("all");
      setDraftScope(null);
      // Say who uses it as the server now holds it: the route decides whether a suggestion applied.
      const row = (await fetchRows())?.find((x) => x.key === saved);
      setMsg(
        !row
          ? `Saved ${saved}.`
          : row.agents === null
            ? `Saved ${saved}. Its agents could not be read, so no agent may use it until they are saved again.`
            : `Saved ${saved} for ${sentence(row.agents)}.`,
      );
      announce();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save_failed");
    } finally {
      setBusy(false);
    }
  }

  async function onPaste(e: React.FormEvent) {
    e.preventDefault();
    if (pasteReady.length === 0) return;
    setPasteBusy(true);
    setErr(null);
    setMsg(null);
    setPasteResults(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: pasteReady.map((p) => ({ key: p.sendKey, value: p.value, ...p.send })),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; saved?: number; failed?: number; results?: UpsertResult[]; error?: string };
      if (j.error) {
        setErr(j.error);
        return;
      }
      setPasteResults(j.results || []);
      const saved = j.saved || 0;
      const failed = j.failed || 0;
      if (failed === 0 && saved > 0) {
        setMsg(`Saved ${saved} key${saved === 1 ? "" : "s"}.`);
        setPasteText("");
        setPasteAgents({});
        setPasteEditing(null);
      } else if (saved > 0) {
        setMsg(`Saved ${saved}; ${failed} not saved (below).`);
      } else {
        setErr("Nothing saved (below).");
      }
      await fetchRows();
      announce();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save_failed");
    } finally {
      setPasteBusy(false);
    }
  }

  async function onDelete(key: string) {
    if (!confirm(`Remove ${key}? Agents will lose access to this value immediately.`)) return;
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string };
      if (!j.ok) {
        setErr(j.error || `http_${r.status}`);
        return;
      }
      setMsg(j.warning ? `Removed ${key}. ${j.warning}` : `Removed ${key}.`);
      await fetchRows();
      announce();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete_failed");
    }
  }

  function startEditingAgents(row: CustomCredentialRow) {
    setEditingKey(row.key);
    // An unreadable choice starts from No agents: saving "All agents" unchanged would
    // widen a key that may have been narrow (review of OCC #743).
    setEditAgents(row.agents_unreadable ? [] : row.agents ?? "all");
    setErr(null);
    setMsg(null);
  }

  async function saveAgents(key: string, agents: AgentAccess): Promise<boolean> {
    const r = await fetch("/api/connections/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "custom", id: key, agents }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) {
      setErr(j.error || `http_${r.status}`);
      return false;
    }
    setMsg(`${key} is now for ${sentence(agents)}.`);
    await fetchRows();
    announce();
    return true;
  }

  async function onSaveAgents(key: string) {
    setEditBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (await saveAgents(key, editAgents)) setEditingKey(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save_failed");
    } finally {
      setEditBusy(false);
    }
  }

  async function applySuggestion(key: string, suggestion: KeyHint) {
    setErr(null);
    setMsg(null);
    try {
      await saveAgents(key, suggestion.access);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save_failed");
    }
  }

  return (
    <div className="space-y-5">
      {agentsError && (
        <div className="rounded-md border border-status-hot/30 bg-status-hot/10 px-3 py-2 text-xs text-status-hot">
          {agentsError} Agents are refused these keys until it can be read.
        </div>
      )}

      {/* Add a key */}
      <form onSubmit={onAdd} aria-labelledby="custom-key-add" className="space-y-3 rounded-lg border border-bg-border bg-bg-elev/20 p-3">
        <h3 id="custom-key-add" className="text-[13px] font-medium text-fg">
          Add a key
        </h3>

        <div className="space-y-1.5">
          <label htmlFor="custom-key-name" className="block text-[12px] text-fg-muted">
            Name
          </label>
          <input
            id="custom-key-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. PIPEDRIVE_API_TOKEN"
            className={`${INPUT} uppercase placeholder:normal-case`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!nameProblem}
            aria-describedby="custom-key-name-note"
          />
          <p id="custom-key-name-note" className="text-[12px] leading-5 text-fg-dim" data-testid="custom-key-name-note">
            {nameProblem ? (
              <span className="text-status-hot">{nameProblem}</span>
            ) : existing ? (
              touched ? (
                "Already saved: a new value replaces it, for the agents you picked below."
              ) : existing.agents === null ? (
                "Already saved, and its agents could not be read: no agent may use it. Pick them below to fix it."
              ) : (
                <>
                  Already saved: a new value replaces it, and it stays with {sentence(existing.agents)} unless you change them below.
                </>
              )
            ) : hint?.from === "name" ? (
              <>
                <span className="font-medium text-fg">{hint.app}</span> key, suggested for {sentence(hint.access)}.
                {keyName !== name.trim().toUpperCase() && <> Saved as <span className="font-mono text-fg-muted">{keyName}</span>.</>}
              </>
            ) : keyName ? (
              <>
                {keyName !== name.trim().toUpperCase() && <>Saved as <span className="font-mono text-fg-muted">{keyName}</span>. </>}
                No app recognised from the name, so it is for all agents unless you pick.
              </>
            ) : (
              "The name an app's docs give it, like ZAPIER_WEBHOOK_URL. The agents it is for are picked from the name."
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="custom-key-value" className="block text-[12px] text-fg-muted">
            Value
          </label>
          <input
            id="custom-key-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the secret"
            className={INPUT}
            autoComplete="off"
            spellCheck={false}
          />
          {tooLong ? (
            <p className="text-[12px] text-status-hot">{tooLong}</p>
          ) : (
            hint?.from === "value" && (
              <p className="text-[12px] leading-5 text-fg-dim" data-testid="custom-key-value-note">
                This looks like a key for <span className="font-medium text-fg">{hint.app}</span>, suggested for {sentence(hint.access)}.
                {!keyName && hint.usualName && (
                  <>
                    {" "}
                    <button type="button" onClick={() => setName(hint.usualName ?? "")} className={LINK}>
                      Name it {hint.usualName}
                    </button>
                  </>
                )}
              </p>
            )
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[12px] text-fg-muted">Agents that may use it</span>
            {hint && !sameAgentAccess(shown, hint.access) && (
              <button
                type="button"
                onClick={() => pick(hint.access)}
                className={`text-[12px] ${LINK}`}
              >
                Use the {hint.app} suggestion
              </button>
            )}
          </div>
          <AgentPicker
            value={shown}
            onChange={pick}
            disabled={busy}
            label="Agents that may use the new key"
            choices={choices}
          />
        </div>

        {hint?.card && (
          <p className="rounded-md border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12px] leading-5 text-fg-muted">
            {hint.app} has its own card, with a connection test and the agents&apos; built-in tools for it.{" "}
            {onOpenApp ? (
              <button type="button" onClick={() => onOpenApp(hint.card ?? "")} className={LINK}>
                Open {hint.app}
              </button>
            ) : (
              <a href={`/settings/connections?app=${encodeURIComponent(hint.card)}`} className={LINK}>
                Open {hint.app}
              </a>
            )}
            . A key saved here is used only when an agent calls {hint.app} itself.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="min-w-0 text-[12px] text-fg-dim" data-testid="custom-key-summary">
            {blockedBy ? (
              blockedBy
            ) : keyName && !nameProblem ? (
              <>
                Saves <span className="font-mono text-fg-muted">{keyName}</span> for {sentence(shown)}.
              </>
            ) : (
              "Stored encrypted. Never shown again, never in the chat."
            )}
          </p>
          <button type="submit" disabled={!canSave} className={PRIMARY}>
            {busy ? "Saving…" : existing ? "Replace value" : "Save key"}
          </button>
        </div>
      </form>

      {err && (
        <div className="flex items-start gap-2 rounded-md border border-status-hot/30 bg-status-hot/10 px-3 py-2 text-sm text-status-hot">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="font-mono text-xs">{err}</span>
        </div>
      )}
      {msg && (
        <div className="flex items-start gap-2 rounded-md border border-status-engaged/30 bg-status-engaged/10 px-3 py-2 text-sm text-status-engaged" role="status">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {/* Saved keys */}
      <section aria-labelledby="custom-key-saved" className="rounded-lg border border-bg-border bg-bg-elev/30">
        <div className="flex items-center justify-between border-b border-bg-border px-3 py-2">
          <h3 id="custom-key-saved" className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <KeyRound className="h-3.5 w-3.5 text-fg-dim" />
            Saved keys
            <span className="font-normal text-fg-dim">({rows.length})</span>
          </h3>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-dim" />}
        </div>
        {!loading && listError && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-6 text-center text-xs text-status-hot" role="alert">
            <span>
              Couldn&apos;t read your saved keys (<span className="font-mono">{listError}</span>).
            </span>
            <button type="button" onClick={() => void fetchRows()} className={LINK}>
              Try again
            </button>
          </div>
        )}
        {!loading && !listError && rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">No keys yet. Add one above, or paste several below.</div>
        )}
        {rows.length > 0 && (
          <ul className="divide-y divide-bg-border">
            {rows.map((row) => {
              const rowHint = recognizeCustomKey(row.key);
              const nudge = !row.agents_saved && row.agents === "all" && rowHint && rowHint.access !== "all" ? rowHint : null;
              return (
                <li key={row.key} className="space-y-2 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm text-fg">{row.key}</div>
                      <div className="mt-0.5 text-[11px] text-fg-dim">
                        {rowHint ? `${rowHint.app} · ` : ""}updated {timeAgo(row.updated_at)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => (editingKey === row.key ? setEditingKey(null) : startEditingAgents(row))}
                        disabled={row.agents === null && !row.agents_unreadable}
                        className="rounded-md border border-bg-border px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
                        aria-expanded={editingKey === row.key}
                      >
                        Agents
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(row.key)}
                        className="rounded-md p-1.5 text-fg-dim transition-colors hover:bg-status-hot/10 hover:text-status-hot"
                        title="Remove this key"
                        aria-label={`Remove ${row.key}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5" data-testid={`custom-key-agents-${row.key}`}>
                    <span className="text-[11px] text-fg-dim">Used by</span>
                    {row.agents_unreadable ? (
                      <span className="text-[11px] text-status-hot">no agent: its saved choice could not be read. Pick agents and save to fix it.</span>
                    ) : row.agents === null ? (
                      <span className="text-[11px] text-fg-dim">couldn&apos;t read</span>
                    ) : (
                      <AgentChips access={row.agents} choices={choices} />
                    )}
                  </div>
                  {nudge && editingKey !== row.key && (
                    <p className="text-[11.5px] leading-5 text-fg-muted" data-testid={`custom-key-suggestion-${row.key}`}>
                      Suggested for {nudge.app}: {sentence(nudge.access)}.{" "}
                      <button type="button" onClick={() => void applySuggestion(row.key, nudge)} className={LINK}>
                        Apply
                      </button>
                    </p>
                  )}
                  {editingKey === row.key && (
                    <div className="space-y-2 rounded-md border border-bg-border bg-bg-elev/40 p-2.5">
                      <AgentPicker value={editAgents} onChange={setEditAgents} disabled={editBusy} label={`Agents that may use ${row.key}`} choices={choices} />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onSaveAgents(row.key)}
                          disabled={editBusy}
                          className="rounded-md bg-accent-muted px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent disabled:opacity-50"
                        >
                          {editBusy ? "Saving…" : "Save agents"}
                        </button>
                        <button type="button" onClick={() => setEditingKey(null)} className="text-xs text-fg-muted hover:text-fg">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Paste several */}
      <section className="rounded-lg border border-bg-border bg-bg-elev/20">
        <button
          type="button"
          onClick={() => setPasteOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg"
          aria-expanded={pasteOpen}
        >
          <span className="flex items-center gap-2">
            <Upload className="h-3.5 w-3.5" />
            Paste several
          </span>
          <span className="text-[11px] font-normal text-fg-dim">{pasteOpen ? "Close" : "KEY=value lines, as in a .env file"}</span>
        </button>
        {pasteOpen && (
          <form onSubmit={onPaste} className="space-y-2.5 px-3 pb-3">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={6}
              aria-label="KEY=value lines to save"
              placeholder={"HUBSPOT_PRIVATE_APP_TOKEN=...\nZAPIER_WEBHOOK_URL=https://hooks.zapier.com/...\n# comments, export and quotes are fine"}
              className="w-full resize-y rounded-md border border-bg-border bg-bg-elev px-3 py-2.5 font-mono text-xs text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
              spellCheck={false}
            />
            {pasted.length > 0 && (
              <ul aria-label="Keys in the paste" className="divide-y divide-bg-border rounded-md border border-bg-border" data-testid="custom-key-paste-preview">
                {pasted.map((p) => (
                  <li key={p.id} className="space-y-1.5 px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className={`truncate font-mono text-[12.5px] ${p.problem ? "text-status-hot" : "text-fg"}`}>{p.key}</div>
                        <div className="text-[11px] leading-4 text-fg-dim">
                          {p.problem ? (
                            <span className="text-status-hot">{p.problem} Not saved.</span>
                          ) : (
                            <>
                              {p.hint ? `${p.hint.app} · ` : ""}
                              {p.exists
                                ? p.send.agents === undefined
                                  ? `replaces its value, stays with ${sentence(p.agents)}`
                                  : `replaces its value, for ${sentence(p.agents)}`
                                : `for ${sentence(p.agents)}`}
                            </>
                          )}
                        </div>
                      </div>
                      {!p.problem && (
                        <button
                          type="button"
                          onClick={() => setPasteEditing(pasteEditing === p.key ? null : p.key)}
                          className="shrink-0 rounded-md border border-bg-border px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
                          aria-expanded={pasteEditing === p.key}
                        >
                          Agents
                        </button>
                      )}
                    </div>
                    {pasteEditing === p.key && (
                      <AgentPicker
                        value={p.agents}
                        onChange={(next) => setPasteAgents((m) => ({ ...m, [p.key]: next }))}
                        disabled={pasteBusy}
                        label={`Agents that may use ${p.key}`}
                        choices={choices}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(pasteSkipped > 0 || pasteRepeats > 0) && (
              <p className="text-[11px] text-fg-dim">
                {pasteSkipped > 0 && `${pasteSkipped} line${pasteSkipped === 1 ? " is" : "s are"} not KEY=value and will be skipped. `}
                {pasteRepeats > 0 && `${pasteRepeats} repeated key${pasteRepeats === 1 ? "" : "s"}: the last value is kept.`}
              </p>
            )}
            {blockedBy && <p className="text-[11px] text-fg-dim">{blockedBy}</p>}
            <button type="submit" disabled={!!blockedBy || pasteBusy || pasteReady.length === 0} className={PRIMARY}>
              {pasteBusy ? "Saving…" : pasteReady.length > 1 ? `Save ${pasteReady.length} keys` : "Save key"}
            </button>
            {pasteResults && pasteResults.length > 0 && (
              <div className="max-h-48 divide-y divide-bg-border overflow-y-auto rounded-md border border-bg-border">
                {pasteResults.map((res, i) => (
                  <div
                    key={`${res.key}-${i}`}
                    className={`flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-[11px] ${res.ok ? "text-status-engaged" : "text-status-hot"}`}
                  >
                    <span className="truncate">
                      {res.ok ? "✓" : "✗"} {res.key}
                    </span>
                    {!res.ok && <span className="truncate text-[10px] text-fg-dim">{res.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </form>
        )}
      </section>
    </div>
  );
}

/** A choice as chips, one per agent by name ("All agents", "No agents" as such). */
function AgentChips({ access, choices }: { access: AgentAccess; choices: ReadonlyArray<AgentChoice> }) {
  const chip = "rounded border border-bg-border bg-bg-raised px-1.5 py-px text-[11px] text-fg";
  if (access === "all") return <span className={chip}>All agents</span>;
  if (access.length === 0) return <span className="rounded border border-dashed border-bg-border px-1.5 py-px text-[11px] text-fg-dim">No agents</span>;
  return (
    <>
      {agentNames(access, choices).map((n) => (
        <span key={n} className={chip}>
          {n}
        </span>
      ))}
    </>
  );
}
