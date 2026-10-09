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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cloud, Cpu, HardDrive, Loader2 } from "lucide-react";
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
import { readEngine, removeSavedKey, saveEngine, switchProvider, testEngine, type EngineState } from "@/components/settings/agent-engine-client";

const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

type Kind = AgentEngineChoice["kind"];
type Note = { ok: boolean; text: string } | null;

export function AgentEnginePanel() {
  const router = useRouter();
  const [state, setState] = useState<EngineState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("api");
  const [cli, setCli] = useState<CliEngine>("claude");
  const [localModel, setLocalModel] = useState("");
  const [provider, setProvider] = useState<Provider | "">("");
  const [busy, setBusy] = useState<null | "save" | "test" | "provider">(null);
  const [note, setNote] = useState<Note>(null);

  async function load() {
    const r = await readEngine();
    if (!r.ok) {
      setReadError(r.message);
      return;
    }
    setReadError(null);
    setState(r.state);
    setKind(r.state.engine.kind);
    if (r.state.engine.kind === "cli") setCli(r.state.engine.cli);
    if (r.state.engine.kind === "local") setLocalModel(r.state.engine.model);
    setProvider(r.state.account?.provider ?? "");
  }

  useEffect(() => {
    void load();
  }, []);

  if (readError) {
    return <p className="text-sm text-fg-muted">{readError}</p>;
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

  async function save() {
    if (!draft) return;
    setBusy("save");
    setNote(null);
    const r = await saveEngine(draft);
    setBusy(null);
    if (!r.ok) {
      setNote({ ok: false, text: r.message });
      return;
    }
    // The coding harness reads this same setting (lib/ai/agent-engine.ts harnessRouteFor).
    setNote({
      ok: true,
      text: `Your agents now use ${agentsEngineLine(draft)}.${r.latencyMs !== null ? ` A test answer came back in ${(r.latencyMs / 1000).toFixed(1)} s.` : ""}`,
    });
    await load();
    router.refresh();
  }

  async function test() {
    if (!draft || draft.kind === "api") return;
    setBusy("test");
    setNote(null);
    const r = await testEngine(draft);
    setBusy(null);
    setNote(r.ok ? { ok: true, text: `It answered in ${(r.latencyMs / 1000).toFixed(1)} s: "${r.reply.slice(0, 160)}"` } : { ok: false, text: r.message });
  }

  async function moveProvider(next: Provider) {
    setBusy("provider");
    setNote(null);
    const r = await switchProvider(next);
    setBusy(null);
    if (!r.ok) {
      setNote({ ok: false, text: r.message });
      setProvider(state?.account?.provider ?? "");
      return;
    }
    setNote({ ok: true, text: `Your AI account is now ${PROVIDER_LABEL[next]}, ${r.label}.` });
    await load();
    router.refresh();
  }

  async function forget(p: Provider) {
    if (typeof window !== "undefined" && !window.confirm(`Remove the saved ${PROVIDER_LABEL[p]} key from this workspace?`)) return;
    setBusy("provider");
    setNote(null);
    const r = await removeSavedKey(p);
    setBusy(null);
    setNote(r.ok ? { ok: true, text: `The saved ${PROVIDER_LABEL[p]} key was removed.` } : { ok: false, text: r.message });
    await load();
    router.refresh();
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
        disabled={!canManage || busy !== null}
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
              disabled={!canManage || busy !== null}
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
            {busy === "provider" && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                <Loader2 className="h-3 w-3 animate-spin" /> Testing a short answer...
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
                    disabled={busy !== null}
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
                disabled={!canManage || busy !== null}
                onClick={() => {
                  setCli(c);
                  setNote(null);
                }}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  cli === c ? "border-accent bg-accent/15 text-accent" : "border-bg-border bg-bg-deep/60 text-fg-muted hover:text-fg"
                }`}
              >
                {CLI_ENGINE_LABEL[c]}
              </button>
            ))}
          </div>
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
              disabled={!canManage || busy !== null}
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
        <div className="flex flex-wrap items-center gap-2">
          {kind !== "api" && (
            <button
              type="button"
              onClick={() => void test()}
              disabled={!draft || busy !== null}
              className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 !text-xs disabled:opacity-50"
            >
              {busy === "test" && <Loader2 className="h-3 w-3 animate-spin" />}
              Test
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft || unchanged || busy !== null}
            className="btn-primary inline-flex items-center gap-1.5 !py-1.5 !text-xs disabled:opacity-50"
          >
            {busy === "save" && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy === "save" ? "Testing a short answer..." : unchanged ? "In use" : "Use this for my agents"}
          </button>
          {kind !== "api" && <span className="text-[11px] text-fg-dim">An app&apos;s first answer can take up to a minute.</span>}
        </div>
      ) : (
        <p className="text-[11px] text-fg-dim">An owner or admin changes what powers your agents.</p>
      )}

      {note && (
        <p role={note.ok ? "status" : "alert"} className={`text-xs leading-relaxed ${note.ok ? "text-status-engaged" : "text-status-warm"}`}>
          {note.text}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-fg-dim">
        The coding harness uses this same setting: there is no second picker. On an app, it runs that app on your paired
        computer; on an AI account, it uses that account; with a local model, it runs on Claude Code (it edits files).
      </p>
    </div>
  );
}
