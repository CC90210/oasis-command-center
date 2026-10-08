"use client";

/**
 * ProviderAccountsCard — top-level "Connect your AI provider" surface.
 *
 * Lives at the top of /settings so the first thing the operator sees is
 * which provider accounts they've connected. Each provider that powers
 * dashboard chat shows:
 *   - Connection status: Connected means the workspace's AI account is on
 *     this provider (lib/ai/workspace-account.ts), the key every department
 *     chat and Slack mention uses. A key the viewer saved for their own chats
 *     only reads "Your personal key": department chats don't use it.
 *   - Tagline + which models it unlocks
 *   - "Connect" button → inline dialog with single API-key paste
 *   - "Get API key ↗" deep-link to the provider's console (new tab)
 *
 * Single-click connect: paste the key once. The dialog first sends ONE real
 * message with it (/api/agent-config/test-connection) and saves only when the
 * provider answers (connectProviderKey); then /api/agent-config/bulk-provider
 * saves the workspace's AI account and stamps (provider, model, key) across
 * every enabled chat agent in the tenant. No per-agent paste dance, no
 * navigating to /settings#agents to do it five times.
 *
 * For the verified operator only, Anthropic gets the "tool_use" badge: an
 * Anthropic key flips the operator's own cloud chat to the native tool_use
 * protocol. A client's department chats have no tools, so a client never sees
 * that badge or any vendor tool name on this card.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ExternalLink,
  Check,
  AlertCircle,
  KeyRound,
  Cpu,
  Cloud,
  Loader2,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import { PROVIDER_REGISTRY, PROVIDER_TO_SERVICE, type Provider } from "@/lib/providers";
import { BridgeInstallLink } from "@/components/settings/BridgeInstallLink";

type Props = {
  /** Set of services-with-key resolved server-side via aiServicesWithKey():
   *  the workspace's AI account, the key every department chat uses.
   *  null = that read failed: a card with no key known says "Couldn't check",
   *  never "Not connected". */
  connectedServices: Set<string> | null;
  /** Services the viewer saved a key for, for their own chats only
   *  (personalAiServicesWithKey). Shown apart from Connected because
   *  department chats don't use them. Omitted or null: none shown. */
  personalServices?: Set<string> | null;
  /** null = the bridge heartbeat could not be read. */
  bridgeOnline: boolean | null;
  canManageTeam: boolean;
  /** The server's verified platform-operator verdict. Only the operator is offered the bridge install. */
  canInstallBridge: boolean;
};

// Providers that get a card on this surface. Ollama is intentionally hidden
// — it has no "account" to connect; the local-model path is wired through
// the bridge + AgentConfigEditor and shouldn't pretend it's an account.
const CARD_PROVIDERS: Provider[] = ["anthropic", "openrouter", "openai", "google"];

/** This page's own connects and removals, and the server answer they were made on. */
type Overlay = { on: Set<string> | null | undefined; changes: ReadonlyMap<string, boolean> };
const NO_CHANGES: ReadonlyMap<string, boolean> = new Map();

/**
 * The server's answer with this page's changes laid over it, while that answer
 * is still the one they were made on. A newer answer (a new prop object: every
 * router.refresh() hands one back) is the truth, and the changes are dropped.
 */
export function laidOver(answer: Set<string> | null | undefined, overlay: Overlay): Set<string> {
  const out = new Set(answer ?? []);
  if (overlay.on !== answer) return out;
  for (const [svc, on] of overlay.changes) {
    if (on) out.add(svc);
    else out.delete(svc);
  }
  return out;
}

export function ProviderAccountsCard({
  connectedServices: initialServices,
  personalServices,
  bridgeOnline,
  canManageTeam,
  canInstallBridge,
}: Props) {
  const router = useRouter();
  // What the cards draw is the server's latest answer (the prop, which every
  // router.refresh() hands back fresh) with this page's own connects and
  // disconnects laid over it, so a click flips its card at once instead of
  // waiting for the refresh round-trip. It is derived on every render, never
  // copied into state: after a failed read the copy stayed empty, so the
  // refresh that followed a connect showed the providers already on file as
  // "Not connected". When the server read failed, `keysKnown` is false and a
  // provider this page has not just connected reads "Couldn't check".
  //
  // THE OVERLAY IS ONLY UNTIL THE SERVER ANSWERS (PR #535 review, R5-M2). Each
  // change is laid over the server answer it was made on (the prop object,
  // which is new on every refresh), and the next answer replaces it. It used
  // to stay for the page's life: connect Anthropic, then OpenRouter, and both
  // read Connected; a stale "disconnected" drew Not connected over a live key.
  const keysKnown = initialServices !== null;
  const [changedHere, setChangedHere] = useState<Overlay>(() => ({ on: initialServices, changes: NO_CHANGES }));
  const latestServices = useRef(initialServices);
  latestServices.current = initialServices;
  const services = laidOver(initialServices, changedHere);
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  // The viewer's own keys (department chats never use them), with this page's
  // own personal connects and removals laid over the server's answer, until
  // the next one.
  const [personalHere, setPersonalHere] = useState<Overlay>(() => ({ on: personalServices, changes: NO_CHANGES }));
  const latestPersonal = useRef(personalServices);
  latestPersonal.current = personalServices;
  const personal = laidOver(personalServices, personalHere);
  const change = (scope: "tenant" | "user", svc: string, now: boolean | null) => {
    const latest = scope === "user" ? latestPersonal.current : latestServices.current;
    const apply = (prev: Overlay): Overlay => {
      const changes = new Map(prev.on === latest ? prev.changes : NO_CHANGES);
      if (now === null) changes.delete(svc);
      else changes.set(svc, now);
      return { on: latest, changes };
    };
    if (scope === "user") setPersonalHere(apply);
    else setChangedHere(apply);
  };

  function markConnected(p: Provider, scope: "tenant" | "user" = "tenant") {
    const svc = PROVIDER_TO_SERVICE[p];
    if (!svc) return;
    // A key saved "Just me" is the viewer's own: it never reads Connected.
    change(scope, svc, true);
    // Cross-component refresh: AgentConfigEditor on this same page caches
    // its config list in client state from a fetch() on mount. Without a
    // poke, the per-agent rows below would still show "no key on file"
    // after a bulk-connect until the user manually reloaded. The custom
    // event lets the editor re-fetch on receipt; router.refresh() re-runs
    // server components so the page's own connectedServices prop is
    // up-to-date next render. Belt + suspenders intentional.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("oasis:agent-configs-changed"));
    }
    router.refresh();
  }

  // A disconnect that failed may still have changed something (it retires
  // first, then a later step failed): this page's own overlay for that card is
  // dropped and the server is read again, so the card shows the server's
  // answer and is never left on Connected by mistake.
  function rereadAfterFailure(p: Provider, scope: "tenant" | "user") {
    change(scope, PROVIDER_TO_SERVICE[p], null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("oasis:agent-configs-changed"));
    }
    router.refresh();
  }

  const totalConnected = CARD_PROVIDERS.filter((p) =>
    services.has(PROVIDER_TO_SERVICE[p])
  ).length;
  const anyConnected = totalConnected > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-4 space-y-2">
        <div className="flex items-start gap-3">
          <KeyRound className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-fg">
              Connect an AI provider account
            </div>
            {/* What the account does, in the product's words: no vendor tool
                names (it used to promise "Claude-Code-class capability" to
                client owners whose chats have no tools). */}
            <p className="text-xs text-fg-muted mt-1 leading-relaxed">
              Paste a key once. Your teammates answer every department chat
              and Slack mention with the team-wide account.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] pt-1">
          <span
            className={`inline-flex items-center gap-1 ${
              anyConnected ? "text-status-engaged" : "text-fg-dim"
            }`}
          >
            <Cloud className="w-3 h-3" />
            Cloud:{" "}
            {/* After a failed read, a count can only come from this page's own
                connects: it is a floor, not the total. */}
            {!keysKnown && !anyConnected
              ? "couldn't check"
              : anyConnected
                ? `${totalConnected} provider${totalConnected === 1 ? "" : "s"} connected${keysKnown ? "" : ", couldn't check the rest"}`
                : "no provider connected"}
          </span>
          <span className="text-fg-dim">·</span>
          <span
            className={`inline-flex items-center gap-1 ${
              bridgeOnline ? "text-accent" : "text-fg-dim"
            }`}
          >
            <Cpu className="w-3 h-3" />
            Local bridge: {bridgeOnline === null ? "couldn't check" : bridgeOnline ? "online" : "offline"}
          </span>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        {CARD_PROVIDERS.map((p) => {
          const reg = PROVIDER_REGISTRY.find((r) => r.value === p);
          if (!reg) return null;
          const connected = services.has(PROVIDER_TO_SERVICE[p]);
          // Only the viewer's own key is on this provider: department chats
          // and Slack mentions don't use it, so it is never "Connected".
          const personalOnly = !connected && personal.has(PROVIDER_TO_SERVICE[p]);
          const isAnthropic = p === "anthropic";
          return (
            <div
              key={p}
              className={`rounded-lg border p-4 ${
                connected
                  ? "border-status-engaged/30 bg-status-engaged/5"
                  : "border-bg-border bg-bg-elev/30"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-fg flex items-center gap-2">
                    {reg.label}
                    {/* Only the operator's own chat runs the native tool loop
                        on an Anthropic key; a client's department chats have
                        no tools, so the badge would promise what they lack. */}
                    {isAnthropic && canInstallBridge && (
                      <span className="text-[9px] uppercase tracking-wider text-accent border border-accent/40 rounded-full px-1.5 py-0.5">
                        tool_use
                      </span>
                    )}
                    {reg.recommended && (
                      <span className="text-[9px] uppercase tracking-wider text-status-engaged border border-status-engaged/40 rounded-full px-1.5 py-0.5">
                        recommended
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-fg-muted mt-0.5">
                    {reg.tagline}
                  </div>
                </div>
                {connected ? (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-status-engaged shrink-0">
                    <Check className="w-3 h-3" /> Connected
                  </span>
                ) : personalOnly ? (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-accent shrink-0">
                    <KeyRound className="w-3 h-3" /> Your personal key
                  </span>
                ) : !keysKnown ? (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-fg-muted shrink-0">
                    <AlertCircle className="w-3 h-3" /> Couldn&apos;t check
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-fg-dim shrink-0">
                    <AlertCircle className="w-3 h-3" /> Not connected
                  </span>
                )}
              </div>
              <div className="text-[11px] text-fg-dim leading-relaxed mb-3 line-clamp-3">
                {reg.hint}
              </div>
              {connected && (
                <p className="text-[11px] text-fg-muted leading-relaxed mb-3">
                  Every department chat and Slack mention uses this key.
                </p>
              )}
              {personalOnly && (
                <p className="text-[11px] text-fg-muted leading-relaxed mb-3">
                  This key is saved for you only. Department chats and Slack mentions don&apos;t use it:{" "}
                  {canManageTeam
                    ? "connect it for the whole team so they can."
                    : "an owner or admin can connect one for the whole team."}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveProvider(p)}
                  className={`text-[11px] font-bold inline-flex items-center gap-1 ${
                    connected
                      ? "text-fg-muted hover:text-fg"
                      : "text-accent hover:text-accent-bright"
                  }`}
                >
                  {connected ? "Replace key" : keysKnown ? "Connect" : "Set key"} →
                </button>
                <span className="text-fg-dim text-[10px]">·</span>
                <a
                  href={reg.apiKey}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-fg-muted hover:text-fg inline-flex items-center gap-1"
                >
                  Get a key <ExternalLink className="w-3 h-3" />
                </a>
                {connected && (
                  <>
                    <span className="text-fg-dim text-[10px]">·</span>
                    <TestConnectionButton provider={p} />
                    <span className="text-fg-dim text-[10px]">·</span>
                    <Link
                      href="#agents"
                      className="text-[11px] text-fg-muted hover:text-fg inline-flex items-center gap-1"
                    >
                      Per-agent ↓
                    </Link>
                    {canManageTeam && (
                      <>
                        <span className="text-fg-dim text-[10px]">·</span>
                        <DisconnectButton
                          provider={p}
                          onDisconnected={() => {
                            // Optimistically clear it on this page, until the
                            // server's next answer (the refresh below).
                            change("tenant", PROVIDER_TO_SERVICE[p], false);
                            if (typeof window !== "undefined") {
                              window.dispatchEvent(
                                new CustomEvent("oasis:agent-configs-changed"),
                              );
                            }
                            router.refresh();
                          }}
                          onFailed={() => rereadAfterFailure(p, "tenant")}
                        />
                      </>
                    )}
                  </>
                )}
                {personalOnly && (
                  <>
                    <span className="text-fg-dim text-[10px]">·</span>
                    <DisconnectButton
                      provider={p}
                      scope="user"
                      onDisconnected={() => {
                        change("user", PROVIDER_TO_SERVICE[p], false);
                        if (typeof window !== "undefined") {
                          window.dispatchEvent(new CustomEvent("oasis:agent-configs-changed"));
                        }
                        router.refresh();
                      }}
                      onFailed={() => rereadAfterFailure(p, "user")}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Only a KNOWN "no key and no bridge" earns this warning; a read that
          failed is not evidence that nothing is wired. */}
      {keysKnown && !anyConnected && bridgeOnline === false && <NoProviderNotice canInstallBridge={canInstallBridge} />}

      {activeProvider && (
        <ConnectProviderDialog
          provider={activeProvider}
          canManageTeam={canManageTeam}
          onClose={() => {
            setActiveProvider(null);
            // A save whose answer never came may have landed after all: the
            // cards are drawn again from the server once the dialog closes.
            router.refresh();
          }}
          onConnected={(p, scope) => {
            markConnected(p, scope);
            setActiveProvider(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Connect: test the pasted key with one real message, then save it
// ============================================================================

/** How a connect attempt ended. Every message is one plain sentence. */
export type ConnectResult =
  | { kind: "saved" }
  /**
   * The test refused the key (nothing was saved). `proof` is the test's
   * signed verdict when the provider was down or slow: "Save anyway" sends it
   * back, so the save route does not test the key again (R5-L3).
   */
  | { kind: "refused"; message: string; canSaveAnyway: boolean; proof?: string | null }
  /** The key passed (or was saved anyway) but the save did not go through. */
  | { kind: "failed"; message: string }
  /** The form moved on before the save (stillWanted): nothing was saved. */
  | { kind: "dropped" };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A route's answer: its status, and its JSON body when it was the route's JSON (`json`). */
type Answer = { status: number; json: boolean; body: Record<string, unknown> };

/**
 * A refusal that says nothing about the key: the provider was down or slow.
 * Only these may be saved anyway.
 */
const SAVE_ANYWAY_CODES: ReadonlySet<string> = new Set(["provider_5xx", "timeout"]);
const COULD_NOT_TEST = "The key couldn't be tested just now, so it was not saved. Try again in a moment.";
const COULD_NOT_SAVE = "The key couldn't be saved just now. Try again in a moment.";
const COULD_NOT_TELL = "We couldn't check whether the key was saved. Close this and look at the card in a moment.";
const NOT_SAVED_WHEN_CHECKED = "The key wasn't saved when we checked. Close this, look at the card in a moment, and connect again if it doesn't show it.";
/** Longer than the test's own 15-second provider call, plus the trip here. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The save route's refusal, as one sentence: never an agent name or an error code. */
function saveFailureSentence(body: Record<string, unknown>): string {
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (body.error === "invalid_key_length") return "That doesn't look like a valid API key. Check what you pasted and try again.";
  if (body.error === "admin_required") return "Only an owner or admin can connect an AI account for the whole team.";
  if (body.error === "unauthorized") return "Your session ended. Sign in again, then connect the key.";
  return COULD_NOT_SAVE;
}

/**
 * Connect a pasted key: first ONE real message with it, on the model it will
 * be saved with (/api/agent-config/test-connection), and only when the
 * provider answers, save it (/api/agent-config/bulk-provider). A refused key
 * saves nothing and says why in the test's own plain sentence, so a wrong or
 * empty-balance key is caught on the spot instead of reading "Connected"
 * (AIP-05, AIP-07). `skipTest` is "Save anyway", offered only when the
 * provider was down or slow. `stillWanted` is asked once more just before the
 * save: false (the dialog's form moved on, or closed, while the test ran)
 * saves nothing. Each request gives up after `timeoutMs`, so one that hangs
 * can never keep the dialog locked (it cannot be closed while a run is out).
 * A save whose answer never came, or came back as a server failure (a 5xx, or
 * a page that is not the route's JSON), is then checked with a read
 * (`verify`), so the dialog says what is actually saved: the save is one step
 * on the server, so it landed whole or not at all, and an answer lost after
 * the commit must not read "not saved" over a key that is (R5-M1).
 *
 * The test's signed proof (lib/ai/connect-test-proof.ts) goes with the save,
 * so the save route, which now tests every key itself (R5-L3), does not test
 * this one twice. "Save anyway" (`skipTest`) sends the proof of the test that
 * found the provider down or slow (`proof`), with save_anyway.
 */
export async function connectProviderKey(
  input: {
    provider: Provider;
    apiKey: string;
    model: string;
    scope: "tenant" | "user";
    skipTest?: boolean;
    /** With skipTest: the proof the timed-out test returned. */
    proof?: string | null;
    stillWanted?: () => boolean;
    timeoutMs?: number;
  },
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<ConnectResult> {
  const post = async (url: string, body: Record<string, unknown>): Promise<Answer> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("request timed out"));
      }, input.timeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        }),
        gaveUp,
      ]);
      const parsed = await Promise.race([res.json().then((b: unknown) => ({ b, json: true }), () => ({ b: null, json: false })), gaveUp]);
      const json = parsed.json && !!parsed.b && typeof parsed.b === "object";
      return { status: res.status, json, body: json ? (parsed.b as Record<string, unknown>) : {} };
    } finally {
      clearTimeout(timer);
    }
  };
  let proof = input.skipTest ? (input.proof ?? null) : null;
  if (!input.skipTest) {
    let tested: Record<string, unknown>;
    try {
      tested = (await post("/api/agent-config/test-connection", {
        provider: input.provider,
        api_key: input.apiKey,
        model: input.model,
      })).body;
    } catch {
      return { kind: "refused", message: COULD_NOT_TEST, canSaveAnyway: false };
    }
    if (tested.ok !== true) {
      const code = typeof tested.code === "string" ? tested.code : "";
      const message = typeof tested.message === "string" && tested.message.trim() ? tested.message : COULD_NOT_TEST;
      const canSaveAnyway = SAVE_ANYWAY_CODES.has(code);
      return { kind: "refused", message, canSaveAnyway, proof: canSaveAnyway && typeof tested.tested === "string" ? tested.tested : null };
    }
    proof = typeof tested.tested === "string" ? tested.tested : null;
  }
  if (input.stillWanted && !input.stillWanted()) return { kind: "dropped" };
  const theKey = {
    provider: input.provider,
    api_key: input.apiKey,
    model: input.model,
    scope: input.scope,
    ...(proof ? { tested: proof } : {}),
    ...(input.skipTest ? { save_anyway: true } : {}),
  };
  // Ask the route what is saved now (a read) and say exactly that, instead of
  // reporting a failure that may be false. The save is one step on the
  // server, so the answer is all of it or none of it.
  const readBack = async (): Promise<ConnectResult> => {
    let check: Answer;
    try {
      check = await post("/api/agent-config/bulk-provider", { ...theKey, verify: true });
    } catch {
      return { kind: "failed", message: COULD_NOT_TELL };
    }
    if (check.body.ok === true && check.body.saved === true) return { kind: "saved" };
    // Not saved YET: the abandoned save may still be running on the server
    // and land a moment later, so this is never told as a failure.
    if (check.body.ok === true && check.body.saved === false) return { kind: "failed", message: NOT_SAVED_WHEN_CHECKED };
    return { kind: "failed", message: COULD_NOT_TELL };
  };
  let answer: Answer;
  try {
    answer = await post("/api/agent-config/bulk-provider", theKey);
  } catch {
    // No answer (it timed out, or never arrived): the save may still have landed.
    return readBack();
  }
  const saved = answer.body;
  // A server failure, or a page that is not the route's answer (the Worker
  // stopped, or the platform answered for it): the batch may have committed
  // before it, so the dialog reads what is saved instead of saying "not saved".
  if (saved.ok !== true && (answer.status >= 500 || !answer.json)) return readBack();
  if (saved.ok !== true && saved.error === "key_refused") {
    const message = typeof saved.message === "string" && saved.message.trim() ? saved.message : COULD_NOT_TEST;
    return { kind: "refused", message, canSaveAnyway: saved.can_save_anyway === true, proof: typeof saved.tested === "string" ? saved.tested : null };
  }
  if (saved.ok !== true) return { kind: "failed", message: saveFailureSentence(saved) };
  // A teammate row that did not update is logged, not shown: the chats run on
  // the workspace's AI account, which saved.
  if (Array.isArray(saved.failed) && saved.failed.length > 0) {
    console.warn("[bulk-provider] some teammate rows were not updated", saved.failed);
  }
  return { kind: "saved" };
}

// ============================================================================
// Inline connect dialog — single API key input + Save
// ============================================================================

/**
 * What a run sent: exactly this provider, trimmed key, model and scope. A key
 * kept for "Save anyway" also carries the proof its timed-out test returned.
 */
type TestedKey = { provider: Provider; apiKey: string; model: string; scope: "tenant" | "user"; proof?: string | null };

function sameKey(a: TestedKey | null, b: TestedKey): boolean {
  return a !== null && a.provider === b.provider && a.apiKey === b.apiKey && a.model === b.model && a.scope === b.scope;
}

export function ConnectProviderDialog({
  provider,
  canManageTeam,
  onClose,
  onConnected,
}: {
  provider: Provider;
  canManageTeam: boolean;
  onClose: () => void;
  onConnected: (p: Provider, scope: "tenant" | "user") => void;
}) {
  const reg = PROVIDER_REGISTRY.find((r) => r.value === provider);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The exact key the provider was down or slow on. "Save anyway" saves THAT,
  // and any edit to the form takes the offer away: a key or model nobody
  // tested is never saved untested (Codex review, PR #535).
  const [untested, setUntested] = useState<TestedKey | null>(null);
  const [model, setModel] = useState(reg?.models[0]?.id || "");
  const [scope, setScope] = useState<"tenant" | "user">(canManageTeam ? "tenant" : "user");
  // An answer that lands late must not speak for a form that moved on: it
  // brought "Save anyway" back for a key no longer on screen (Codex review,
  // PR #535). So every run (a test, or Save anyway) takes the next number,
  // and its answer is applied only while it is the newest run AND the form,
  // as last drawn, still shows exactly what it sent. The form is also locked
  // while a run is out (`saving`), so in the browser it cannot move on.
  const newestRun = useRef(0);
  const drawn = useRef<TestedKey | null>(null);
  useLayoutEffect(() => {
    drawn.current = { provider, apiKey: apiKey.trim(), model, scope };
  });
  // A closed dialog wants nothing: a test that passes after it closed saves
  // nothing, and no answer is applied (PR #535 review). It cannot be closed
  // while a run is out, but it can still go away with the page.
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!reg) return null;

  async function connect(target: TestedKey, skipTest: boolean) {
    if (!target.apiKey || saving) return;
    const run = ++newestRun.current;
    const isNewest = () => run === newestRun.current;
    const formUnchanged = () => sameKey(drawn.current, target);
    setSaving(true);
    setError(null);
    setUntested(null);
    const result = await connectProviderKey({
      ...target,
      skipTest,
      stillWanted: () => mounted.current && isNewest() && formUnchanged(),
    });
    // Closed meanwhile: nothing is applied. A newer run holds the lock and
    // speaks for the form: this one says nothing.
    if (!mounted.current || !isNewest()) return;
    setSaving(false);
    if (result.kind === "dropped" || !formUnchanged()) return;
    if (result.kind === "saved") {
      onConnected(target.provider, target.scope);
      return;
    }
    setError(result.message);
    if (result.kind === "refused" && result.canSaveAnyway) setUntested({ ...target, proof: result.proof ?? null });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await connect({ provider, apiKey: apiKey.trim(), model, scope }, false);
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/80 backdrop-blur-sm p-4"
      onClick={() => {
        // Like Cancel and the close button: not while a key is being tried.
        if (!saving) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-bg-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-bg-border">
          <div>
            <h2 className="text-base font-bold text-fg">Connect {reg.label}</h2>
            <p className="text-xs text-fg-muted mt-0.5">
              {scope === "tenant"
                ? "Every department chat and Slack mention will use this key. We test it with one short message before saving."
                : "Saved for you only: department chats and Slack mentions won't use it. We test it with one short message before saving."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg-muted p-1"
            title="Close"
            disabled={saving}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Two-step guided flow:
                Step 1 — open the provider's account console (where their
                Claude.ai / ChatGPT subscription already lives) in a popup
                so signing in feels like an OAuth handshake.
                Step 2 — back here, paste the key from that console.

              Why we don't do real OAuth pass-through: neither Anthropic nor
              OpenAI exposes a public flow that lets a third party app use
              a user's Claude.ai Pro or ChatGPT Plus subscription. The
              "connectors" both vendors advertise work the OTHER direction
              (their chat apps calling MCP servers). API key paste against
              the developer console is the real path. We surface the trip
              to the console so it feels less like manual data entry. */}
          <div className="rounded-md border border-bg-border bg-bg-deep/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim font-bold mb-1">
              Step 1 · Sign in to {reg.label}
            </div>
            <p className="text-xs text-fg-muted leading-relaxed mb-2">
              Opens {new URL(reg.apiKey).host} in a new tab. Log in with
              your existing account, then copy your API key from there.
            </p>
            <a
              href={reg.apiKey}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary inline-flex items-center gap-1.5 text-xs"
            >
              Sign in &amp; get key{" "}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-fg-muted block mb-1.5">
              Step 2 · Paste your API key
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setUntested(null);
                }}
                placeholder={reg.placeholder}
                autoFocus
                className="input w-full font-mono text-sm pr-10"
                autoComplete="off"
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg-muted p-1"
                title={showKey ? "Hide" : "Show"}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-fg-dim mt-2 leading-relaxed">
              We encrypt the key at rest (AES-256-GCM) and never return it
              to the browser after save. The selected scope controls who can
              use it.
            </p>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-fg-muted block mb-1.5">
              Default model
            </label>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setUntested(null);
              }}
              className="input w-full text-sm"
              disabled={saving}
            >
              {reg.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-fg-dim mt-1.5">
              Applied to every agent. Override per-agent under{" "}
              <span className="font-mono">/settings#agents</span> if a specific
              agent should use a different model on the same provider.
            </div>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-fg-muted block mb-1.5">
              Save scope
            </label>
            {canManageTeam ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setScope("tenant");
                    setUntested(null);
                  }}
                  disabled={saving}
                  className={`rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                    scope === "tenant"
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-bg-border bg-bg-elev text-fg-muted hover:text-fg"
                  }`}
                >
                  Whole team
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScope("user");
                    setUntested(null);
                  }}
                  disabled={saving}
                  className={`rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                    scope === "user"
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-bg-border bg-bg-elev text-fg-muted hover:text-fg"
                  }`}
                >
                  Just me
                </button>
              </div>
            ) : (
              <div className="rounded-md border border-bg-border bg-bg-deep/40 px-3 py-2 text-xs text-fg-muted">
                Saves just for you. Team defaults are managed by an owner or admin.
              </div>
            )}
          </div>

          {/* One plain sentence: the test's own words for a refused key, or
              why the save did not go through (connectProviderKey). */}
          {error && (
            <div role="alert" className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-xs text-status-warm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
              disabled={saving}
            >
              Cancel
            </button>
            {/* The provider was down or slow on exactly this key, model and
                scope, which says nothing about the key: it may be saved as
                tested. */}
            {untested && (
              <button
                type="button"
                onClick={() => void connect(untested, true)}
                className="btn-secondary"
                disabled={saving}
              >
                Save anyway
              </button>
            )}
            <button
              type="submit"
              className="btn-primary inline-flex items-center gap-2"
              disabled={!apiKey.trim() || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Connect {reg.label}
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body
  );
}

/**
 * Disconnect a provider across the whole tenant. Confirms before firing —
 * disconnect can't be undone (the encrypted key is wiped from the DB; the
 * operator has to paste it again from the provider's console). Soft-fails
 * are surfaced inline. scope="user" is "Remove my key": only the viewer's
 * own key for that provider, which department chats never used.
 *
 * A failure shows the route's one plain sentence and never its code or the
 * database's own words (PR #535 review), and `onFailed` has the card read the
 * server again: a disconnect can fail after it already changed something.
 */
const DISCONNECT_FALLBACK = "The AI account couldn't be disconnected just now. Try again in a moment.";

function DisconnectButton({
  provider,
  scope = "tenant",
  onDisconnected,
  onFailed,
}: {
  provider: Provider;
  scope?: "tenant" | "user";
  onDisconnected: () => void;
  onFailed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    const question =
      scope === "user"
        ? `Remove your personal ${provider} key?\n\nIt was saved for you only. Department chats and Slack mentions are not affected.`
        : `Disconnect ${provider}?\n\n` +
          `• The encrypted API key is wiped from every agent that uses ${provider}.\n` +
          `• Any per-agent custom system prompts on those agents are also wiped (the row is removed).\n` +
          `• You'll need to paste the key again to reconnect.\n\n` +
          `If you only want to swap keys, use "Replace key" instead — that preserves custom prompts.`;
    if (!confirm(question)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agent-config/bulk-provider?provider=${encodeURIComponent(provider)}&scope=${scope}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: unknown;
      };
      if (!res.ok || !data.ok) {
        setError(typeof data.message === "string" && data.message.trim() ? data.message : DISCONNECT_FALLBACK);
        onFailed();
        return;
      }
      onDisconnected();
    } catch {
      setError(DISCONNECT_FALLBACK);
      onFailed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="text-[11px] text-rose-400 hover:text-rose-300 inline-flex items-center gap-1 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <X className="w-3 h-3" />
        )}
        {scope === "user" ? "Remove my key" : "Disconnect"}
      </button>
      {error && (
        <span role="alert" className="text-[10px] text-rose-400">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * TestConnectionButton — sends a one-token message with the key on file
 * (/api/agent-config/test-connection) and reports latency, or why the
 * provider refused, inline. A model-list call would pass a drained or bad
 * key; a real completion fails exactly when a chat would. Operator-facing
 * health check for already-saved keys; complements validate-on-save at the
 * connect step.
 */
const TEST_FALLBACK = "The key couldn't be tested just now. Try again in a moment.";

function TestConnectionButton({ provider }: { provider: Provider }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | null
    | { kind: "ok"; latency: number; at: number }
    | { kind: "err"; message: string; at: number }
  >(null);

  async function go() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/agent-config/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        latency_ms?: number;
        message?: string;
        error?: string;
      };
      if (body.ok && typeof body.latency_ms === "number") {
        setResult({ kind: "ok", latency: body.latency_ms, at: Date.now() });
      } else {
        // The route's own sentence, never its code or a status number.
        setResult({
          kind: "err",
          message: typeof body.message === "string" && body.message.trim() ? body.message : TEST_FALLBACK,
          at: Date.now(),
        });
      }
    } catch {
      setResult({ kind: "err", message: TEST_FALLBACK, at: Date.now() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="text-[11px] text-fg-muted hover:text-fg inline-flex items-center gap-1 disabled:opacity-50"
        title="Sends a one-word test message with the saved key. Costs a fraction of a cent."
      >
        {busy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : result?.kind === "ok" ? (
          <Check className="w-3 h-3 text-status-engaged" />
        ) : result?.kind === "err" ? (
          <AlertCircle className="w-3 h-3 text-rose-400" />
        ) : null}
        Test
      </button>
      {result?.kind === "ok" && (
        <span className="text-[10px] text-status-engaged" title={`Ping succeeded at ${new Date(result.at).toLocaleTimeString()}`}>
          ({result.latency}ms)
        </span>
      )}
      {result?.kind === "err" && (
        <span className="text-[10px] text-rose-400" title={result.message}>
          (failed — hover for detail)
        </span>
      )}
    </>
  );
}

/**
 * Shown when no provider is connected and no bridge is online. The bridge
 * route installs for the verified platform operator only (F0 containment,
 * 2026-09-29), so only the operator is offered it as the alternative; for
 * everyone else the one way forward is a cloud provider above. No hooks, so
 * tests/f0-containment.test.ts renders both versions.
 */
export function NoProviderNotice({ canInstallBridge }: { canInstallBridge: boolean }) {
  return (
    <div className="rounded-lg border border-status-warm/30 bg-status-warm/5 p-3 text-xs text-fg flex items-start gap-2">
      <AlertCircle className="w-4 h-4 text-status-warm shrink-0 mt-0.5" />
      <div className="flex-1">
        <span className="font-bold">No provider wired yet.</span> Your
        agents can&apos;t think until you connect at least one
        {canInstallBridge === true ? (
          <>
            {" "}— connect a cloud provider above (recommended for client tenants) OR{" "}
            <BridgeInstallLink canInstallBridge className="text-accent hover:text-accent-bright underline">
              install the local bridge
            </BridgeInstallLink>{" "}
            to use your own Claude Code subscription.
          </>
        ) : (
          <> — connect a cloud provider above.</>
        )}
      </div>
    </div>
  );
}