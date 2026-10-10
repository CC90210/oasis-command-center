"use client";

/**
 * AgentEnginePanel - "What powers your agents": ONE choice for every
 * department, Slack mention and the coding harness (lib/ai/agent-engine.ts).
 *
 *   An AI account   a cloud provider's key (Anthropic, OpenAI, Google,
 *                   OpenRouter). Switch between providers whose key is saved
 *                   without pasting again; pick the model and Test below.
 *                   Spends API credits.
 *   An app on your paired computer   Claude Code, Codex or Gemini CLI, on its
 *                   own sign-in there, through the OASIS bridge. No API credits.
 *   A local model on your paired computer   Ollama or LM Studio, through the
 *                   same bridge. No API credits.
 *
 * Every change is tested with one short department answer before it is saved,
 * and nothing changes when the test fails (the routes do it, not this panel).
 * The status of each app comes from the paired computer's own report (the card
 * below); it is a hint, never a lock: any app can be chosen, and its Test says
 * plainly whether it answers.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Cloud, Cpu, HardDrive, Loader2 } from "lucide-react";
import { CLI_STATE_LABEL, cliUnsupportedDetail } from "@/lib/bridge-cli-status";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
import {
  CLI_ENGINES,
  CLI_ENGINE_LABEL,
  agentsEngineLine,
  isLocalModelName,
  spendFor,
  spendSentence,
  type AgentEngineChoice,
  type CliEngine,
} from "@/lib/ai/agent-engine";
import { readEngine, readUnsupportedApps, removeSavedKey, saveEngine, switchProvider, testEngine, type EngineState } from "@/components/settings/agent-engine-client";

const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

type Kind = AgentEngineChoice["kind"];

function engineName(c: AgentEngineChoice): string {
  return c.kind === "cli" ? CLI_ENGINE_LABEL[c.cli] : c.kind === "local" ? c.model : "Your AI account";
}
type Note = { ok: boolean; text: string } | null;

/**
 * The AI account (connect, replace or remove a key, the model, Test), inside the
 * panel where the engine is chosen. The card it wraps carries id="providers"
 * (SettingsContent), the anchor every "Connect an AI account" link lands on
 * (lib/setup-links.ts ai_account).
 */
function AccountSection({ heading, blurb, children }: { heading: string; blurb?: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="space-y-2 border-t border-hairline pt-3" data-testid="engine-ai-account">
      <div className="text-sm font-semibold text-fg">{heading}</div>
      <p className="text-[11px] leading-relaxed text-fg-dim">
        Connect, replace or remove the API key, pick its model and test it here. {blurb}
      </p>
      {children}
    </div>
  );
}

export function AgentEnginePanel({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<EngineState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("api");
  const [cli, setCli] = useState<CliEngine>("claude");
  const [localModel, setLocalModel] = useState("");
  const [provider, setProvider] = useState<Provider | "">("");
  // Two independent busy states, and neither locks the page. A Test or Save
  // check only disables the Test and Save buttons; switching a provider or
  // removing a key only disables the provider controls. Radios, the app
  // picker, the model box and everything else outside this panel stay live
  // (CC, 2026-10-10: "I couldn't click anything else on the page").
  const [check, setCheck] = useState<null | "save" | "test">(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<Note>(null);
  const [unsupported, setUnsupported] = useState<CliEngine[]>([]);
  const stopCheck = useRef<AbortController | null>(null);

  async function load(opts: { keepDraft?: boolean } = {}) {
    const [r, refused] = await Promise.all([readEngine(), readUnsupportedApps()]);
    setUnsupported(refused);
    if (!r.ok) {
      // A failed refresh after a failed save keeps what is on screen.
      if (!opts.keepDraft) setReadError(r.message);
      return;
    }
    setReadError(null);
    setState(r.state);
    if (opts.keepDraft) return;
    setKind(r.state.engine.kind);
    if (r.state.engine.kind === "cli") setCli(r.state.engine.cli);
    if (r.state.engine.kind === "local") setLocalModel(r.state.engine.model);
    setProvider(r.state.account?.provider ?? "");
  }

  useEffect(() => {
    void load();
    // Leaving the page stops a check that is still waiting.
    return () => stopCheck.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The seconds a check has been waiting, so a slow app never looks frozen.
  useEffect(() => {
    if (check === null) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [check]);

  // The AI account stays reachable when the engine choice could not be read:
  // a key is never locked away behind a failed read.
  if (readError) {
    return (
      <div className="space-y-3" data-testid="agent-engine">
        <p className="text-sm text-fg-muted">{readError}</p>
        <AccountSection heading="Your AI account">{children}</AccountSection>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading what powers your agents...
      </div>
    );
  }

  const draft: AgentEngineChoice | null =
    kind === "api" ? { kind: "api" } : kind === "cli" ? { kind: "cli", cli } : isLocalModelName(localModel.trim()) ? { kind: "local", model: localModel.trim() } : null;
  const current = state.engine;
  const unchanged = draft !== null && JSON.stringify(draft) === JSON.stringify(current);
  const canManage = state.canManage;
  // An app the vendor refuses on this sign-in: selectable only to show why, never offered a Test or Save.
  const refused = kind === "cli" && unsupported.includes(cli);

  /** Runs one Test or Save to an end: the result, or a plain sentence. The busy state always clears. */
  async function runCheck(which: "save" | "test", work: (signal: AbortSignal) => Promise<void>) {
    const ctl = new AbortController();
    stopCheck.current = ctl;
    setCheck(which);
    setNote(null);
    try {
      await work(ctl.signal);
    } catch {
      setNote({ ok: false, text: "That couldn't be finished just now. Nothing was changed. Try again in a moment." });
    } finally {
      if (stopCheck.current === ctl) stopCheck.current = null;
      setCheck(null);
    }
  }

  async function save() {
    if (!draft) return;
    const chosen = draft;
    await runCheck("save", async (signal) => {
      const r = await saveEngine(chosen, undefined, { signal });
      if (!r.ok) {
        setNote({ ok: false, text: r.message });
        // A save whose answer never came may have landed: read what is in use, keeping the pick on screen.
        await load({ keepDraft: true });
        return;
      }
      // The coding harness reads this same setting (lib/ai/agent-engine.ts harnessRouteFor).
      setNote({
        ok: true,
        text: `Your agents now use ${agentsEngineLine(chosen)}.${r.latencyMs !== null ? ` A test answer came back in ${(r.latencyMs / 1000).toFixed(1)} s.` : ""}`,
      });
      await load();
      router.refresh();
    });
  }

  async function test() {
    if (!draft || draft.kind === "api") return;
    const chosen = draft;
    await runCheck("test", async (signal) => {
      const r = await testEngine(chosen, undefined, { signal });
      // Named, because the pick can change while the test waits.
      const name = engineName(chosen);
      setNote(
        r.ok
          ? { ok: true, text: `${name} answered in ${(r.latencyMs / 1000).toFixed(1)} s: "${r.reply.slice(0, 160)}"` }
          : { ok: false, text: `${name}: ${r.message}` },
      );
    });
  }

  function cancelCheck() {
    stopCheck.current?.abort();
  }

  async function moveProvider(next: Provider) {
    setProviderBusy(true);
    setNote(null);
    try {
      const r = await switchProvider(next);
      if (!r.ok) {
        setNote({ ok: false, text: r.message });
        setProvider(state?.account?.provider ?? "");
        return;
      }
      setNote({ ok: true, text: `Your AI account is now ${PROVIDER_LABEL[next]}, ${r.label}.` });
      await load();
      router.refresh();
    } finally {
      setProviderBusy(false);
    }
  }

  async function forget(p: Provider) {
    if (typeof window !== "undefined" && !window.confirm(`Remove the saved ${PROVIDER_LABEL[p]} key from this workspace?`)) return;
    setProviderBusy(true);
    setNote(null);
    try {
      const r = await removeSavedKey(p);
      setNote(r.ok ? { ok: true, text: `The saved ${PROVIDER_LABEL[p]} key was removed.` } : { ok: false, text: r.message });
      await load();
      router.refresh();
    } finally {
      setProviderBusy(false);
    }
  }

  const option = (value: Kind, icon: React.ReactNode, title: string, sub: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        kind === value ? "border-accent/60 bg-accent-soft" : "border-hairline bg-bg-panel hover:border-bg-border-strong"
      } ${!canManage ? "cursor-default" : ""}`}
    >
      <input
        type="radio"
        name="agent-engine"
        value={value}
        checked={kind === value}
        disabled={!canManage}
        onChange={() => {
          setKind(value);
          setNote(null);
        }}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          {icon}
          {title}
          {current.kind === value && <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-status-engaged">In use</span>}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{sub}</span>
      </span>
    </label>
  );

  const apiOption = option(
    "api",
    <Cloud className="h-3.5 w-3.5" />,
    state.oasis ? "An AI account (fallback)" : "An AI account",
    "An API key from Anthropic, OpenAI, Google or OpenRouter. Each reply spends API credits.",
  );
  const cliOption = option(
    "cli",
    <Cpu className="h-3.5 w-3.5" />,
    "An app on your paired computer",
    state.oasis
      ? "Claude Code, Codex or Gemini CLI, running each department's own harness through the bridge. No API credits."
      : "Claude Code, Codex or Gemini CLI, on its own sign-in there. No API credits.",
  );
  const localOption = option("local", <HardDrive className="h-3.5 w-3.5" />, "A local model", "Ollama or LM Studio on your paired computer. No API credits.");

  return (
    <div className="space-y-3" data-testid="agent-engine">
      <p className="text-sm text-fg">
        Your agents and the coding harness run on <span className="font-bold">{agentsEngineLine(current)}</span>
        {current.kind === "api" && state.account ? (
          <>
            : <span className="font-bold">{state.account.providerLabel}, {state.account.modelLabel}</span>
          </>
        ) : null}
        {current.kind === "cli" ? ", through the bridge" : ""}. <span className="text-fg-muted">{spendSentence(spendFor(current))}</span>
      </p>
      {state.oasis && (
        <p className="text-xs leading-relaxed text-fg-muted">
          This workspace runs each department in its own agent harness on your paired computer: Chief of Staff, Sales, Client
          Success and Operations in the Chief of Staff&apos;s, Marketing and Finance in their own. Each harness&apos;s own
          instructions and skills route the work. An AI account below is only the fallback when the computer can&apos;t be reached.
        </p>
      )}
      {current.kind !== "api" && !state.bridgeReachable && (
        <p className="text-xs leading-relaxed text-status-warm">
          Your paired computer can&apos;t be reached from this account right now, so{" "}
          {state.account ? "your AI account answers in its place until it is back." : "your agents can't answer until it is back, or until an AI account is connected below."}
        </p>
      )}

      {/* OASIS's own workflow first (CC, 2026-10-09: "for mine you should know
          our workflow and show it that way"); a client sees its API key first. */}
      <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="What powers your agents">
        {state.oasis ? (
          <>
            {cliOption}
            {apiOption}
            {localOption}
          </>
        ) : (
          <>
            {apiOption}
            {cliOption}
            {localOption}
          </>
        )}
      </div>

      {kind === "api" && (
        <div className="space-y-2 rounded-lg border border-hairline bg-bg-panel p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="engine-provider" className="text-xs text-fg-muted">
              Provider
            </label>
            <select
              id="engine-provider"
              value={provider}
              disabled={!canManage || providerBusy}
              onChange={(e) => {
                const next = e.target.value as Provider;
                setProvider(next);
                if (next && next !== state.account?.provider) void moveProvider(next);
              }}
              className="select !py-1 !text-xs"
            >
              {!state.account && <option value="">None connected</option>}
              {PROVIDERS.map((p) => {
                const saved = state.savedProviders.includes(p) || state.account?.provider === p;
                return (
                  <option key={p} value={p} disabled={!saved}>
                    {PROVIDER_LABEL[p]}
                    {saved ? "" : " (connect its key below)"}
                  </option>
                );
              })}
            </select>
            {providerBusy && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                <Loader2 className="h-3 w-3 animate-spin" /> Switching...
              </span>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-fg-dim">
            A provider whose key is saved switches at once, after one short test answer, and the key you switch away from stays
            saved so you can switch back. To add a provider, connect its key on its card below. Pick the model and Test it just below.
          </p>
          {canManage &&
            state.savedProviders
              .filter((p) => p !== state.account?.provider)
              .map((p) => (
                <div key={p} className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
                  <span>{PROVIDER_LABEL[p]}: key saved, not in use.</span>
                  <button
                    type="button"
                    disabled={providerBusy}
                    onClick={() => void forget(p)}
                    className="text-fg-dim underline underline-offset-2 hover:text-status-warm disabled:opacity-50"
                  >
                    Remove saved key
                  </button>
                </div>
              ))}
        </div>
      )}

      {kind === "cli" && (
        <div className="space-y-2 rounded-lg border border-hairline bg-bg-panel p-3">
          <div role="radiogroup" aria-label="App on your paired computer" className="flex flex-wrap gap-1.5">
            {CLI_ENGINES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cli === c}
                disabled={!canManage}
                onClick={() => {
                  setCli(c);
                  setNote(null);
                }}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  cli === c ? "border-accent bg-accent/15 text-accent" : "border-bg-border bg-bg-deep/60 text-fg-muted hover:text-fg"
                }`}
              >
                {CLI_ENGINE_LABEL[c]}{" "}
                {unsupported.includes(c) && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider text-status-warm">Not supported</span>}
              </button>
            ))}
          </div>
          {refused && (
            <p role="status" className="text-xs leading-relaxed text-status-warm" data-testid="engine-cli-unsupported">
              <span className="font-semibold">{CLI_STATE_LABEL.unsupported}.</span> {cliUnsupportedDetail(cli)}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-fg-dim">
            Your agents answer through the app&apos;s own sign-in on your paired computer, reached by the OASIS bridge. It answers in
            plan mode: it reads and replies, and is told not to change files for a department reply. When the computer can&apos;t be
            reached, your AI account answers instead, and the reply says so.
          </p>
        </div>
      )}

      {kind === "local" && (
        <div className="space-y-2 rounded-lg border border-hairline bg-bg-panel p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="engine-local-model" className="text-xs text-fg-muted">
              Model name
            </label>
            <input
              id="engine-local-model"
              value={localModel}
              onChange={(e) => {
                setLocalModel(e.target.value);
                setNote(null);
              }}
              disabled={!canManage}
              placeholder="llama3.3"
              className="input !py-1 !text-xs w-48"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-fg-dim">
            The name Ollama or LM Studio uses for the model on your paired computer. The bridge there calls it; OASIS never does.
          </p>
        </div>
      )}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="engine-actions">
          {!refused && kind !== "api" && (
            <button
              type="button"
              onClick={() => void test()}
              disabled={!draft || check !== null}
              className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 !text-xs disabled:opacity-50"
            >
              {check === "test" && <Loader2 className="h-3 w-3 animate-spin" />}
              {check === "test" ? "Testing..." : "Test"}
            </button>
          )}
          {!refused && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={!draft || unchanged || check !== null || providerBusy}
              className="btn-primary inline-flex items-center gap-1.5 !py-1.5 !text-xs disabled:opacity-50"
            >
              {check === "save" && <Loader2 className="h-3 w-3 animate-spin" />}
              {check === "save" ? "Testing a short answer..." : unchanged ? "In use" : "Use this for my agents"}
            </button>
          )}
          {check !== null && (
            <>
              <span role="status" className="text-[11px] text-fg-muted" data-testid="engine-elapsed">
                Testing... {elapsed} s. An app&apos;s first answer can take up to a minute.
              </span>
              <button
                type="button"
                onClick={cancelCheck}
                className="btn-secondary !py-1.5 !text-xs"
                data-testid="engine-cancel"
              >
                Cancel
              </button>
            </>
          )}
          {check === null && !refused && kind !== "api" && <span className="text-[11px] text-fg-dim">An app&apos;s first answer can take up to a minute.</span>}
        </div>
      ) : (
        <p className="text-[11px] text-fg-dim">An owner or admin changes what powers your agents.</p>
      )}

      {note && (
        <p role={note.ok ? "status" : "alert"} className={`text-xs leading-relaxed ${note.ok ? "text-status-engaged" : "text-status-warm"}`}>
          {note.text}
        </p>
      )}

      <AccountSection
        heading={kind === "api" ? "Your AI account" : "Your AI account (the fallback)"}
        blurb={
          current.kind === "api"
            ? "Your agents answer with it."
            : "Your agents answer with it only when the paired computer can't be reached, and Slack mentions always do."
        }
      >
        {children}
      </AccountSection>

      <p className="text-[11px] leading-relaxed text-fg-dim">
        The coding harness uses this same setting: there is no second picker. On an app, it runs that app on your paired
        computer; on an AI account, it uses that account; with a local model, it runs on Claude Code (it edits files).
      </p>
    </div>
  );
}
