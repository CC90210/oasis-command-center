"use client";

/**
 * ChatWidget — in-dashboard chat with the agent family.
 *
 * Phase 1: cloud-only. The user picks an agent (Bravo/Maven/Atlas/Aura/Hermes)
 * and the widget streams from /api/chat using whatever provider/model/api_key
 * they've configured for that agent in Settings — OR a platform-default key
 * if the authed user is the operator (CC).
 *
 * Phase 2: paired local bridge unlocks file tree + actual Claude Code spawning.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolTimelineList } from "@/components/chat/ToolTimelineList";
import { MessageDownloadMenu } from "@/components/chat/MessageDownloadMenu";
import { mdToHtml } from "@/lib/markdown";
import { useSynthCalls, type SynthCliRuntime } from "@/lib/use-synth-calls";
import {
  Send,
  Square,
  AlertCircle,
  Settings as Cog,
  Loader2,
  Sparkles,
  RefreshCw,
  Cpu,
  ArrowDown,
  Check,
  ChevronRight,
  Clipboard,
  FileText,
  // FileText / Pencil / Terminal / Search / Globe / X / Brain moved to
  // components/chat/ToolTimelineList.tsx along with the timeline that
  // used them. Database stays — used by the cloud-tool result pill below.
  Database,
  Maximize2,
  Minimize2,
  Paperclip,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { getAgentInfo } from "@/lib/agents";
import { useAgentDisplayNames } from "@/lib/use-agent-display-names";
import { BRIDGE_CHAT_BASE } from "@/lib/agent-roots";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { parseInput, renderHelp, type SlashCommandName } from "@/lib/chat-modes/slash-parser";
import { usePlanMode } from "@/lib/chat-modes/use-plan-mode";
import {
  SlashCommandMenu,
  SlashArgMenu,
  filterCommands,
  filterArgCandidates,
  type ArgCandidate,
} from "@/components/chat/SlashCommandMenu";
import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import { providerForModel, PROVIDER_MODELS } from "@/lib/providers";

type Role = "user" | "assistant" | "system";
type ChatAttachmentSummary = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  parser: string;
  text_excerpt?: string | null;
};
type Msg = {
  role: Role;
  content: string;
  at: number;
  attachments?: ChatAttachmentSummary[];
  /** Which runtime actually serviced this assistant turn — surfaced as a
   *  small "via gemini" pill under the message so operators can verify
   *  the picker selection landed on the wire. Only set for assistant
   *  messages; user/system messages leave this undefined. */
  runtime?: {
    label: string;  // e.g. "gemini", "claude", "anthropic / claude-opus-4-7"
    detail?: string; // e.g. "local bridge" or "cloud · 3.4s"
  };
};

// Legacy localStorage keys from the FIRST Auto/Cloud/Desktop picker (removed
// 2026-05-13). The one-shot cleanup effect below clears them. Nothing else
// reads them.
const ACCESS_MODE_STORAGE_KEY = "oasis.chat.accessMode";
const LEGACY_RUNTIME_MODE_STORAGE_KEY = "oasis.chat.runtimeMode";

/**
 * Chat-mode picker — Phase 3 of giggly-reef, 2026-05-15.
 *
 * Four real combinations of (who-owns-the-LLM, who-owns-the-tools):
 *
 *   "auto"               — bridge if reachable, else cloud_bridge_tools.
 *                          The fall-through default.
 *   "cli"                — pin to the local Claude Code bridge. Operator's
 *                          Claude.ai Pro subscription owns the LLM AND the
 *                          tools. Cheapest path; errors loud if the bridge
 *                          isn't running.
 *   "cloud_only"         — /api/chat with the operator's API key. ONLY the
 *                          11 cloud tools (records, http, integrations). No
 *                          bridge tools even when the bridge is online —
 *                          some operators prefer this when they don't
 *                          trust an LLM with bash/edit_file on real prod
 *                          machines.
 *   "cloud_bridge_tools" — /api/chat with the operator's API key for the
 *                          LLM, AND the bridge for tool execution. Browser
 *                          proxies tool_use to localhost:9100/exec-tool,
 *                          posts the result to /api/chat/resume. The best
 *                          of both worlds — paid LLM, free local tools —
 *                          and what auto upgrades to when the bridge is
 *                          paired.
 *
 * The mode survives reloads via localStorage so the operator's choice sticks.
 * The previous union ("auto" | "bridge" | "cloud") used the v2 key and has
 * no notion of "cloud only without bridge tools"; the migration below
 * translates v2 → v3 once, transparently. CC's framing on 2026-05-15:
 * "It's literally the same as the Telegram bridge. The API key should be
 * connected to my running server just like the Telegram bridge is."
 */
type ChatMode = "auto" | "cli" | "cloud_only" | "cloud_bridge_tools";
const CHAT_MODE_STORAGE_KEY = "oasis.chat.mode.v3";
const LEGACY_CHAT_MODE_STORAGE_KEY = "oasis.chat.mode.v2";
const isChatMode = (s: unknown): s is ChatMode =>
  s === "auto" || s === "cli" || s === "cloud_only" || s === "cloud_bridge_tools";

type CliRuntime = "claude" | "codex" | "gemini";
const CLI_RUNTIME_STORAGE_KEY = "oasis.chat.cliRuntime.v1";
/**
 * Compute the human-readable runtime label for an outbound turn given the
 * current picker state. Stamped on the assistant message at send time so
 * operators can verify which runtime actually serviced the turn (e.g.
 * "did Gemini really run, or did the bridge fall back to cloud?").
 *
 * Note: this is the EXPECTED runtime based on client-side picker state.
 * If the bridge falls back to cloud mid-turn (e.g. claude CLI crashed)
 * the SSE event handlers may overwrite this with the actual runtime
 * the server dispatched to. The default-correct case is "what the
 * picker said, what the bridge ran".
 */
function computeExpectedRuntime(args: {
  chatMode: ChatMode;
  modeOverride?: ChatMode;
  bridgeOnline: boolean | null;
  cliRuntime: CliRuntime;
  cfgProvider?: string;
  cfgModel?: string;
}): { label: string; detail?: string } {
  const mode = args.modeOverride ?? args.chatMode;
  const usingBridge = mode === "cli" || (mode === "auto" && args.bridgeOnline === true);
  if (usingBridge) {
    return {
      label: args.cliRuntime,
      detail: "local bridge",
    };
  }
  const provider = args.cfgProvider?.trim();
  const model = args.cfgModel?.trim();
  if (provider && model) return { label: `${provider} · ${model}`, detail: "cloud" };
  if (provider) return { label: provider, detail: "cloud" };
  return { label: "cloud", detail: undefined };
}

// Plan mode persists in sessionStorage (per tab) — operators who run /plan,
// reload the page mid-investigation, then send another message expect their
// mode to survive. Distinct from CHAT_MODE_STORAGE_KEY (localStorage, per
// origin) because plan mode is a within-conversation state, not a long-lived
// operator preference.
const PLAN_MODE_STORAGE_KEY = "oasis.chat.planMode.v1";
const isCliRuntime = (s: unknown): s is CliRuntime =>
  s === "claude" || s === "codex" || s === "gemini";

/** Single-source-of-truth label suffix for the three CLI options in
 *  the advanced picker. Keeps the three nearly-identical <option>
 *  blocks in the dropdown tight + makes adding a fourth CLI a one-line
 *  change instead of a 12-line ternary copy.
 *
 *  - bridgeOnline=true: just the runtime name, no suffix
 *  - bridgeOnline=null (probe in flight): "(checking…)"
 *  - bridgeOnline=false + serverBridgeOnline=true: heartbeating but
 *    this browser can't reach it — usually CORS, different machine,
 *    or a Firefox/Safari HTTPS→HTTP localhost block
 *  - bridgeOnline=false + serverBridgeOnline=false: daemon actually down
 */
const UNREACHABLE_TOOLTIP =
  "Your bridge IS heartbeating — this browser just can't reach it directly (CORS, different machine, or HTTPS→HTTP localhost block). Run `pm2 restart claude-bridge` to pick up the latest allowed-origins, or open the dashboard on the machine the bridge runs on.";

function renderCliOption(args: {
  value: string;
  displayName: string;
  onlineTooltip: string;
  offlineTooltip: string;
  bridgeOnline: boolean | null;
  serverBridgeOnline?: boolean;
}) {
  const { value, displayName, onlineTooltip, offlineTooltip, bridgeOnline, serverBridgeOnline } = args;
  // 2026-06-08 fix: when proxy mode is active AND the server confirms the
  // bridge is heartbeating, the browser's failed localhost probe is
  // IRRELEVANT — all bridge traffic routes through /api/bridge/* anyway.
  // Treat as effectively online so the operator can actually select the CLI.
  //
  // Bug this fixes: CC (Ezra session) saw all CLI options showing
  // "(bridge offline)" and disabled, even though srv1723601 was pinging
  // every few seconds and the footer correctly showed BRIDGE ONLINE. The
  // dropdown gated on bridgeOnline (browser probe of localhost:9100)
  // which can NEVER succeed when the bridge is on a remote VPS — but
  // since proxy mode is on, the chat works just fine.
  const usingProxy = isProxyMode && serverBridgeOnline === true;
  const effectivelyOnline = bridgeOnline === true || usingProxy;
  const suffix =
    effectivelyOnline
      ? ""
      : bridgeOnline === null
        ? " (checking…)"
        : serverBridgeOnline === true
          ? " (unreachable from this browser)"
          : " (bridge offline)";
  const title =
    effectivelyOnline
      ? onlineTooltip
      : serverBridgeOnline === true
        ? UNREACHABLE_TOOLTIP
        : offlineTooltip;
  return (
    <option key={value} value={value} disabled={!effectivelyOnline} title={title}>
      {displayName}
      {suffix}
    </option>
  );
}
const CLI_RUNTIME_LABELS: Record<CliRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};
// Proxy mode — when NEXT_PUBLIC_BRIDGE_CHAT_BASE is set to anything other than
// the operator's localhost default, the bridge is a remote (private) VPS that
// the browser must NOT touch directly. In that case all bridge traffic routes
// through same-origin /api/bridge/* proxies (Supabase-cookie-authed; the
// server attaches the VPS bearer). When false (CC's localhost), every bridge
// call hits ${BRIDGE_CHAT_BASE} directly, byte-for-byte as before.
const isProxyMode = BRIDGE_CHAT_BASE !== "http://127.0.0.1:9100";

const MAX_ATTACHMENTS_PER_TURN = 5;
const TEXT_ATTACHMENT_READ_BYTES = 512 * 1024;
const MAX_ATTACHMENT_EXCERPT_CHARS = 120_000;
const CHAT_FETCH_TIMEOUT_MS = 90_000;
// ============================================================================
// BRIDGE TIMEOUT CONSTANTS — paired with server-side caps in
// CEO-Agent/bravo_cli/bridge_chat_server.py. Both sides MUST move together.
// Mismatches mean either (a) the client cuts off a working bridge run,
// or (b) the bridge keeps running after the client has given up.
//
// Client side (this file):
//   BRIDGE_TOOL_TIMEOUT_MS      ←→ bridge_chat_server._run_cli_command timeout_s
//   SSE_INACTIVITY_TIMEOUT_MS   ←→ bridge_chat_server.WATCHDOG_TIMEOUT_SEC
//
// History: 2026-05-28 — bumped both pairs after CC hit the 120s cap on a
// Gemini run that legitimately needed >2 minutes (deep research workload).
// ============================================================================
// BRIDGE_TOOL_TIMEOUT_MS: bumped 2026-05-28 from 120s to 6 hours.
// The bridge endpoint here is http://127.0.0.1:9100 — direct browser
// → localhost. There's no Vercel function on this path, so no
// infrastructure-side budget. The prior 120s was a defensive client-
// side cap that fired on every multi-minute Gemini / Codex CLI run
// (operator tasks legitimately taking hours, per CC 2026-05-28). 6
// hours covers any realistic CLI workload while still bounding a
// truly stuck request so the browser eventually reclaims its slot.
const BRIDGE_TOOL_TIMEOUT_MS = 21_600_000;
const RESUME_FETCH_TIMEOUT_MS = 90_000;
// SSE inactivity watchdog — bumped 2026-05-28 from 240s to 600s.
// Codex / Gemini CLI subprocesses can run silently for 60-180s while
// they do their internal tool-use loop (file reads, command execution,
// HTTP fetches), then emit one big delta with the final response. The
// bridge ticks `agent_status: thinking` every 25s during long waits
// (heartbeat in _run_chat_via_local_cli) which keeps the watchdog
// from firing — but 600s is the safety margin if that ticker ever
// fails. The previous 240s tripped on the longest daily-briefing
// runs when the bridge heartbeat momentarily stalled.
const SSE_INACTIVITY_TIMEOUT_MS = 600_000;

/**
 * One-shot migration from the v2 vocabulary to the v3 vocabulary.
 *
 *   bridge → cli                 (bridge owned LLM + tools — that's CLI mode)
 *   cloud  → cloud_bridge_tools  (the prior "cloud" path automatically used
 *                                 bridge tools when the bridge was online;
 *                                 the new name makes that opt-in explicit
 *                                 and adds the cloud_only escape hatch
 *                                 alongside it)
 *   auto   → auto                (semantics unchanged)
 *
 * Returns the migrated ChatMode if a v2 value was present and translated,
 * or null otherwise. Caller writes it to v3 and deletes v2 on success.
 */
function migrateLegacyChatMode(): ChatMode | null {
  try {
    const legacy = localStorage.getItem(LEGACY_CHAT_MODE_STORAGE_KEY);
    if (!legacy) return null;
    let mapped: ChatMode;
    if (legacy === "bridge") mapped = "cli";
    else if (legacy === "cloud") mapped = "cloud_bridge_tools";
    else if (legacy === "auto") mapped = "auto";
    else return null;
    localStorage.setItem(CHAT_MODE_STORAGE_KEY, mapped);
    localStorage.removeItem(LEGACY_CHAT_MODE_STORAGE_KEY);
    return mapped;
  } catch {
    return null;
  }
}

const AGENT_SUGGESTIONS: Record<string, string[]> = {
  bravo: [
    "Run the daily briefing",
    "Show me my MRR + this week's revenue movement",
    "Which leads are qualified and ready to close?",
    "Draft a follow-up for my top stalled lead",
  ],
  atlas: [
    "Summarize this week's net worth + cash position",
    "Show me what's owing on tax this quarter",
    "Run a FIRE projection with current inputs",
    "Any red-flag transactions in the last 7 days?",
  ],
  maven: [
    "Draft 3 hooks for tomorrow's content drop",
    "What's working in our latest ads?",
    "Build a funnel audit on the booking page",
    "Plan this week's content calendar",
  ],
  aura: [
    "Run the morning briefing",
    "Summarize last night's sleep + recovery",
    "Draft this week's habit audit",
    "What's on the calendar today?",
  ],
  hermes: [
    "Status of open POs + chargebacks",
    "Draft the EDI 856 for the latest shipment",
    "Show me yesterday's A2000 sync log",
    "Any commerce alerts I need to handle?",
  ],
  solara: [
    "What funding leads need action today?",
    "Which renewals should we chase first?",
    "Pipeline this week — who's stuck?",
    "Which deals need lender assignment?",
  ],
  helios: [
    "Draft a first-touch SMS for a freshly qualified lead",
    "Revival sequence for leads that ghosted after the application step",
    "Close-the-loop SMS for an offer that just expired",
    "What's the best follow-up cadence for this stage?",
  ],
  "life-preservation": [
    "Help me plan an interview session with Grandma",
    "What questions surface the small details, not the obvious ones?",
    "Show me what we've captured so far",
    "What's missing from her story?",
  ],
};

function _suggestionsFor(agent: string): string[] {
  return AGENT_SUGGESTIONS[agent] || [
    "What can you do?",
    "Run the daily briefing",
    "Show me what changed in the last 24 hours",
    "Read brain/STATE.md",
  ];
}

/**
 * Map a tool SSE event to a display label + detail. Handles every Claude
 * Code tool kind plus the legacy bridge tools. Keep this small — the pill
 * UI just needs a 1-2 word verb + a one-line detail.
 */
function _toolLabel(parsed: Record<string, unknown>): string {
  const n = String(parsed.name || "tool");
  switch (n) {
    case "read_file": return "read";
    case "edit_file": return "edit";
    case "write_file": return "write";
    case "run_script": return "bash";
    case "glob": return "glob";
    case "grep": return "grep";
    case "web_fetch": return "fetch";
    case "mcp_call":
      return `${parsed.server ?? "mcp"}`;
    default:
      return String(parsed.raw_name ?? n);
  }
}

/**
 * Pretty-prints a tool's input object as a single-line detail string. Used by
 * the cloud_tool_call event handler (the runner gives us the model's input
 * blob; we want to show "list_records: entity=lead, limit=10" not the full
 * JSON in the chip). Falls back to a JSON.stringify slice if no meaningful
 * keys are present.
 */
function truncateJson(obj: Record<string, unknown>, maxLen = 80): string {
  try {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string") {
        parts.push(`${k}="${v.length > 24 ? v.slice(0, 24) + "…" : v}"`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      } else {
        // object/array — just signal its shape so the chip stays one line
        parts.push(`${k}=${Array.isArray(v) ? "[…]" : "{…}"}`);
      }
      if (parts.join(", ").length > maxLen) break;
    }
    const out = parts.join(", ");
    return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
  } catch {
    return "";
  }
}

function _toolDetail(parsed: Record<string, unknown>): string {
  const n = String(parsed.name || "tool");
  switch (n) {
    case "read_file":
    case "edit_file":
    case "write_file":
      return String(parsed.path || "");
    case "run_script": {
      const args = Array.isArray(parsed.args) ? (parsed.args as unknown[]).join(" ") : "";
      return String(parsed.script || "") + (args ? ` ${args}` : "");
    }
    case "glob": return String(parsed.pattern || "");
    case "grep": return String(parsed.pattern || "");
    case "web_fetch": return String(parsed.url || "");
    case "mcp_call":
      return String(parsed.tool || parsed.summary || "");
    default:
      return String(parsed.summary || "");
  }
}
type AgentConfig = {
  agent_key: string;
  provider: string;
  model: string;
  enabled: boolean;
  has_key: boolean;
};

type Props = {
  agentKeys: string[];
  defaultAgent?: string;
  /** When true (operator/admin), the widget never blocks on missing config — chat is allowed via platform fallback. */
  isAdmin?: boolean;
  welcomeMessages?: Partial<Record<string, string>>;
  /**
   * Per-tenant manifest flag — when true, the 4-mode chat picker dropdown
   * renders. When false (default for end-user tenants), the picker is
   * hidden and Auto-mode routes silently. Sourced from
   * TenantManifest.ui.advanced_picker. Phase 1 of SunBiz CRM build
   * (2026-05-15) — CC's framing: end users don't care about CLI vs API,
   * "if one of them just works correctly."
   */
  advancedPicker?: boolean;
  /**
   * Server-resolved tenant bridge owner (ADR-0006). Used to surface
   * "Bridge runs on <owner>'s machine" when this browser can't reach
   * localhost:9100 but the tenant DOES have a bridge online elsewhere
   * (typical multi-employee scenario: admin's always-on machine).
   * Null fields when there's no pairing anywhere in the tenant.
   */
  tenantBridgeOwner?: {
    online: boolean;
    machine_label: string | null;
    owner_display_name: string | null;
  };
  /**
   * Authoritative server-side bridge-up signal (bridge_pairings.last_seen_at
   * within 5 min). Distinguishes three CLI dropdown states:
   *   - bridgeOnline=true   → "Codex CLI" (works)
   *   - bridgeOnline=false + serverBridgeOnline=true →
   *       "Codex CLI (unreachable from this browser)" — daemon IS heartbeating;
   *       this browser just can't get to localhost (CORS, different machine,
   *       Firefox mixed-content block, etc).
   *   - bridgeOnline=false + serverBridgeOnline=false →
   *       "Codex CLI (bridge offline)" — daemon is genuinely down.
   * Without this distinction CC saw "(bridge offline)" on oasisai.work while
   * the sidebar simultaneously said BRIDGE ONLINE — confusing and incorrect.
   */
  serverBridgeOnline?: boolean;
};

function seedMessagesForAgent(
  agent: string,
  welcomeMessages?: Partial<Record<string, string>>
): Msg[] {
  const content = welcomeMessages?.[agent]?.trim();
  if (!content) return [];
  return [{ role: "assistant", content, at: Date.now() }];
}

export default function ChatWidget({ agentKeys, defaultAgent, isAdmin, welcomeMessages, advancedPicker, tenantBridgeOwner, serverBridgeOnline }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // URL params let /reasoning Quick Actions deep-link a prompt + agent
  // straight into the composer. Read once on mount, then strip from URL
  // so a refresh doesn't re-fire the prompt.
  const urlAgent = searchParams?.get("agent");
  const urlPrompt = searchParams?.get("prompt");
  const urlAutosend = searchParams?.get("autosend") === "1";

  const initialAgent = urlAgent && agentKeys.includes(urlAgent)
    ? urlAgent
    : (defaultAgent || agentKeys[0] || "bravo");
  const [agent, setAgent] = useState<string>(initialAgent);
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [configsLoaded, setConfigsLoaded] = useState(false);
  // Per-user display names (Solara → "Ada" etc). The hook fetches
  // /api/agent-config?scope=user once at mount and returns labelFor()
  // which falls back to the canonical agent label when the operator
  // hasn't set an override. Used wherever an agent name surfaces in
  // the chat chrome.
  const { labelFor: agentDisplayName } = useAgentDisplayNames();
  const [messages, setMessages] = useState<Msg[]>(() => seedMessagesForAgent(initialAgent, welcomeMessages));
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Slash-command autocomplete. The menu opens whenever the input matches
  // `^/[a-z]*$` (a single slash followed by zero or more lowercase letters,
  // no whitespace yet). The operator can dismiss it manually with Escape
  // (sets slashMenuDismissed) — that flag clears the moment the input
  // changes back to something that wouldn't trigger the menu (e.g., they
  // start a regular message), so a single Escape dismisses for ONE attempt
  // without permanently disabling the affordance.
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const slashMenuTrigger = /^\/[a-z]*$/i.exec(input.trim());
  // Derive a stable boolean for the dismissal effect's dep array. The
  // raw RegExpExecArray is a fresh object every render, so depending on
  // it directly fires the effect every keystroke — harmless (setState
  // is a no-op on same value) but wasteful. The boolean only changes
  // when the trigger pattern transitions, which is what we actually
  // want.
  const hasSlashMenuTrigger = !!slashMenuTrigger;
  const slashMenuOpen = hasSlashMenuTrigger && !slashMenuDismissed && !streaming;
  const slashQuery = slashMenuTrigger ? slashMenuTrigger[0].slice(1).toLowerCase() : "";
  // Reset selection + dismissal whenever the trigger string changes so the
  // operator never sees a stale highlighted row (e.g., index 2 carried
  // over after the filter narrowed to one match).
  useEffect(() => {
    setSlashSelectedIdx(0);
  }, [slashQuery]);
  useEffect(() => {
    // Auto-undismiss when the input leaves slash-trigger shape — so the
    // operator gets the menu back on the next attempt without having
    // to clear and retype.
    if (!hasSlashMenuTrigger) setSlashMenuDismissed(false);
  }, [hasSlashMenuTrigger]);

  // Arg-completion menu — fires when the input is `/agent <query>` or
  // `/model <query>`. The arg menu and the command menu are mutually
  // exclusive (the command menu only matches the no-whitespace pattern;
  // the arg menu only matches after a space). Two different state shapes
  // because the candidate sets are different.
  const slashArgTrigger = /^\/(agent|model)\s+(\S.*)?$/i.exec(input);
  const slashArgCommand = slashArgTrigger
    ? (slashArgTrigger[1]!.toLowerCase() as "agent" | "model")
    : null;
  const slashArgQuery = slashArgTrigger ? (slashArgTrigger[2] || "").trim() : "";
  // Stable boolean — see slashMenuTrigger above for the rationale.
  const hasSlashArgTrigger = !!slashArgTrigger;
  const [slashArgSelectedIdx, setSlashArgSelectedIdx] = useState(0);
  const [slashArgDismissed, setSlashArgDismissed] = useState(false);
  useEffect(() => {
    setSlashArgSelectedIdx(0);
  }, [slashArgQuery, slashArgCommand]);
  useEffect(() => {
    if (!hasSlashArgTrigger) setSlashArgDismissed(false);
  }, [hasSlashArgTrigger]);

  // Candidate list per arg command. Memo so we don't rebuild on every
  // keystroke; the inputs (agentKeys, configs) only change rarely.
  const argCandidates: ArgCandidate[] = useMemo(() => {
    if (slashArgCommand === "agent") {
      return agentKeys.map((k) => ({
        value: k,
        label: agentDisplayName(k),
        hint: getAgentInfo(k).tagline,
      }));
    }
    if (slashArgCommand === "model") {
      // Surface models the operator actually has providers configured
      // for first — those are the only ones /model can successfully
      // switch to. If no configs are loaded yet, show the full registry
      // as a fallback (better than an empty menu mid-onboarding).
      const configuredProviders = new Set(configs.map((c) => c.provider));
      const flat: ArgCandidate[] = [];
      for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
        const isConfigured = configuredProviders.has(provider) || configs.length === 0;
        if (!isConfigured) continue;
        for (const m of models) {
          flat.push({ value: m, label: m, hint: provider });
        }
      }
      return flat;
    }
    return [];
  }, [slashArgCommand, agentKeys, configs, agentDisplayName]);

  const slashArgOpen =
    hasSlashArgTrigger &&
    !slashArgDismissed &&
    !streaming &&
    argCandidates.length > 0;
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Refresh ticker for the chat-history sidebar — bumped after every
  // successful turn so the sidebar re-fetches and the just-completed
  // session appears in the list without a page reload.
  const [historyRefresh, setHistoryRefresh] = useState<number>(0);
  // Tab-stable identifier for the warm-process pool. Minted ONCE per
  // ChatWidget mount; persists across agent switches and turns. The
  // bridge keys its warm pool by `agent:tab_id` so even turn 1 (before
  // claude has minted a session_id) lands in the pool. See
  // bravo_cli/warm_claude_pool.py for the architecture.
  const [tabId] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
  const [error, setError] = useState<string | null>(null);
  // Structured error code surfaced by /api/chat (lib/chat-auth.ts).
  // When set, the error render branch picks the matching friendly UI
  // copy instead of dumping the raw `error` string. Currently used for
  // "key_decrypt_failed" → Replace-key deep link.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [actions, setActions] = useState<
    Array<{
      ok: boolean;
      type: string;
      summary?: string;
      error?: string;
      // A4: verification UI — uid for dismiss target, dismissed flips to
      // true once CC clicks "got it" so the pill collapses.
      uid: string;
      dismissed?: boolean;
    }>
  >([]);
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);
  // Chat-mode picker — see the type docs at the top of this file. SSR-safe
  // initializer (always returns the same value on the server, then
  // localStorage hydration runs in the mount effect below).
  //
  // Phase 4.1 (2026-06-06): default is "cli" so the 4-option picker
  // renders "Claude Code CLI" on first paint instead of flashing "API"
  // for the frame between SSR and useEffect hydration. The mount effect
  // still normalizes any legacy "auto" / "cloud_bridge_tools" stored
  // values to "cli" so behavior is consistent.
  const [chatMode, setChatModeState] = useState<ChatMode>("cli");
  const [cliRuntime, setCliRuntimeState] = useState<CliRuntime>("claude");
  // Plan vs Build mode (2026-05-22 OpenCode-style). Build = default, full
  // tool registry. Plan = read-only tools + plan-mode prompt overlay.
  // Toggled by `/plan` and `/build` slash commands, the composer
  // Plan/Execute toggle, and the chat header badge — all four converge
  // on the same state. Sent as `chat_mode` on every /api/chat POST so
  // the server can filter tools + adjust the system prompt accordingly.
  // Separate from chatMode (CLI vs Cloud) — orthogonal axis.
  //
  // Hook owns sessionStorage hydration + persistence so AgentChat
  // (tenant-preview surface) and this widget share the contract without
  // duplicating the code. Per-surface storage key keeps the two
  // surfaces' plan-mode state isolated.
  const [planMode, setPlanMode] = usePlanMode(PLAN_MODE_STORAGE_KEY);
  // Tracks which routing mode the most recent FAILED message used. Powers
  // the "Retry on the other mode" affordance on the error banner. Null
  // while everything is healthy or after a successful turn.
  // Tracks which transport bucket failed on the previous turn so the
  // Retry button can pick the most-likely-working alternate. Collapsed
  // to two buckets — cli-vs-cloud — because the API surface for the
  // retry is the same regardless of which cloud variant failed.
  const [lastFailedMode, setLastFailedMode] = useState<"cli" | "cloud" | null>(null);
  function setChatMode(next: ChatMode) {
    setChatModeState(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, next);
      } catch {
        // localStorage quota / privacy mode — fine, mode is in-memory.
      }
    }
  }
  function setCliRuntime(next: CliRuntime) {
    setCliRuntimeState(next);
    setSessionId(null);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CLI_RUNTIME_STORAGE_KEY, next);
      } catch {
        // localStorage quota / privacy mode - fine, runtime is in-memory.
      }
    }
  }
  const [usage, setUsage] = useState<{ usage: number; limit: number | null } | null>(null);
  // Cloud-tool results — only fire on the cloud /api/chat path. Each
  // entry is one execution of a <cloud-tool> marker the agent emitted
  // (e.g., lookup_lead_by_name → matched leads). Rendered as inline
  // pills so the operator sees what the cloud agent looked up.
  const [cloudResults, setCloudResults] = useState<
    Array<{ uid: string; ok: boolean; name: string; summary?: string; error?: string; data?: unknown }>
  >([]);
  // Generic tool-call pills — covers every Claude Code tool (Read, Edit,
  // Write, Bash, Glob, Grep, WebFetch, MCP servers) plus the legacy
  // bridge tools (read_file, run_script). Correlated by tool_use_id.
  const [toolCalls, setToolCalls] = useState<
    Array<{
      id: string;
      kind: string;
      label: string;
      detail?: string;
      output?: string;
      error?: boolean;
      elapsed_s?: number;
      createdAt: number;
      completedAt?: number;
    }>
  >([]);
  // [DEPRECATED — REMOVE AFTER 2026-05-14] toolReads + toolRuns + their
  // ToolReadList / ToolRunList renderers below are only used when the
  // bridge runs in OASIS_CHAT_LEGACY=1 mode (raw_name absent on tool
  // events). Default Claude Code subprocess path uses the unified
  // toolCalls list above. Cut both pieces of state + their renderers
  // after the new path proves stable for one week.
  const [toolReads, setToolReads] = useState<Array<{ path: string; body?: string }>>([]);
  const [toolRuns, setToolRuns] = useState<
    Array<{
      script: string;
      args: string[];
      confirm: boolean;
      output?: string;
      elapsed_s?: number;
    }>
  >([]);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [expandedReads, setExpandedReads] = useState<Set<number>>(new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [thinking, setThinking] = useState(false);
  // Fullscreen mode — uses the browser Fullscreen API on the chat
  // element itself (same pattern as Claude / ChatGPT). The chat fills
  // the screen, Esc exits, no portal magic, no parent stacking-context
  // wrestling. We only track an `isFullscreen` flag so the maximize/
  // minimize icon swaps correctly.
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  function toggleFullscreen() {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => null);
    } else if (chatContainerRef.current?.requestFullscreen) {
      chatContainerRef.current.requestFullscreen().catch(() => null);
    }
  }

  // Track the browser's fullscreen state so our icon stays in sync
  // when the user hits Esc (the browser exits fullscreen on its own).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === chatContainerRef.current);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  // A0c: status phase + elapsed-time counter so CC sees "starting Atlas in
  // CFO-Agent…" → "thinking… (0:12)" instead of a static "thinking…" during
  // the first 30s of a Claude Code subprocess cold start.
  const [statusPhase, setStatusPhase] = useState<"spawning" | "thinking" | "tool" | "warm_resume" | null>(null);
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [elapsedTick, setElapsedTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Holds the AbortController for the currently-streaming POST. The Stop
  // button calls .abort() on this; the stream consumer catches the
  // AbortError and tears down state. Ref (not state) because aborting
  // shouldn't re-render — the resulting state change happens via the
  // streaming/setStreaming setters in the finally block.
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const activeWelcomeMessage = welcomeMessages?.[agent]?.trim() || "";
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // Tick elapsed time every second while a request is mid-flight.
  useEffect(() => {
    if (!streamStartedAt) return;
    const id = setInterval(() => setElapsedTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streamStartedAt]);

  // Synthetic activity feed via the extracted useSynthCalls hook. Shows
  // motion (terminal opening, cd, CLI spawn, file scans) during the
  // 0-30s cold-start window when no real tool events fire yet. Real
  // tool events always win — the hook bails the moment toolCalls is
  // non-empty. See lib/use-synth-calls.ts.
  // 2026-05-22: pass the actual runtime so the trace doesn't hardcode
  // "spawn claude" when the operator picked gemini/codex/cloud. CLI mode
  // (pinned or auto+bridge) maps to the operator's cliRuntime; everything
  // else is the cloud API-key path. Defaults to "cloud" pre-classification
  // so a stale frame doesn't lie either.
  const synthRuntime: SynthCliRuntime =
    chatMode === "cli" || (chatMode === "auto" && bridgeOnline === true)
      ? cliRuntime
      : "cloud";
  const synthCalls = useSynthCalls({
    streaming,
    streamStartedAt,
    hasRealTools: toolCalls.length > 0,
    agent,
    cliRuntime: synthRuntime,
  });

  const elapsedLabel = useMemo(() => {
    if (!streamStartedAt) return "";
    // elapsedTick is referenced so this memo recomputes every second.
    void elapsedTick;
    const s = Math.max(0, Math.floor((Date.now() - streamStartedAt) / 1000));
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [streamStartedAt, elapsedTick]);

  useEffect(() => {
    fetch("/api/agent-config")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          // Log so a stuck "not configured" state in the chat composer is
          // searchable in Vercel logs / browser console. The composer still
          // renders — just with whatever configs were last hydrated (none on
          // first mount) — so the operator can retry the page.
          console.error("[chat_widget.agent_config]", j?.error || `status ${r.status}`);
          return;
        }
        setConfigs(j.configs as AgentConfig[]);
      })
      .catch((err) => {
        console.error("[chat_widget.agent_config]", err);
      })
      .finally(() => setConfigsLoaded(true));
  }, []);

  // Hydrate composer from /reasoning Quick Action deep-links. Once.
  // Then strip params so a refresh doesn't re-trigger.
  const [hydratedFromUrl, setHydratedFromUrl] = useState(false);
  useEffect(() => {
    if (hydratedFromUrl || !urlPrompt) return;
    setInput(urlPrompt);
    setHydratedFromUrl(true);
    // Remove the params from the URL without a full nav so the composer
    // text remains visible to the operator.
    if (pathname) {
      const fresh = new URLSearchParams(searchParams?.toString() || "");
      fresh.delete("prompt");
      fresh.delete("agent");
      fresh.delete("autosend");
      const qs = fresh.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    // Auto-send only if explicitly requested — default is to let the
    // operator review + edit before firing.
    if (urlAutosend) {
      setTimeout(() => {
        // send() is defined later — trigger via the form submit affordance
        const f = document.querySelector("form[data-chat-composer]") as HTMLFormElement | null;
        f?.requestSubmit();
      }, 200);
    } else {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [hydratedFromUrl, urlPrompt, urlAutosend, pathname, searchParams, router]);

  // OpenRouter usage pill — only fetches when the agent's provider is
  // openrouter (or unknown but admin-fallback is openrouter). Anthropic /
  // OpenAI / Google don't expose this cleanly, so the pill stays hidden.
  useEffect(() => {
    if (!configsLoaded) return;
    const cfg = configs.find((c) => c.agent_key === agent);
    const isOpenRouter = !cfg || cfg.provider === "openrouter";
    if (!isOpenRouter) {
      setUsage(null);
      return;
    }
    fetch(`/api/usage?agent=${encodeURIComponent(agent)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.ok || !j.supported) {
          setUsage(null);
          return;
        }
        setUsage({ usage: Number(j.usage) || 0, limit: j.limit === null ? null : Number(j.limit) });
      })
      .catch(() => setUsage(null));
  }, [agent, configs, configsLoaded]);

  // Clean up legacy localStorage keys from the removed Auto/Cloud/Desktop
  // picker. One-shot on mount — the keys are no longer written to or read.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(ACCESS_MODE_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_RUNTIME_MODE_STORAGE_KEY);
  }, []);

  // Hydrate chat-mode picker from localStorage on mount. Initial render is
  // always "auto" (matches SSR); this effect upgrades to the persisted value.
  // Phase 3 migration: if the operator's machine still has the v2 vocabulary
  // ("bridge" / "cloud"), translate it into v3 once and drop the legacy
  // entry. Subsequent reads always come from v3.
  //
  // Phase 4.1 follow-up (2026-06-06): the new advanced picker only renders
  // 4 routes — Codex/Gemini/Claude CLI + API. Legacy "auto" and
  // "cloud_bridge_tools" don't have a dedicated picker slot, so the value
  // derivation collapses them to "api" visually. To prevent the picker
  // from showing API while internal routing keeps using the bridge,
  // auto-normalize those legacy values to "cli" on load. The picker
  // then matches what's actually running.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CHAT_MODE_STORAGE_KEY);
      if (isChatMode(stored)) {
        if (stored === "auto" || stored === "cloud_bridge_tools") {
          setChatModeState("cli");
          try {
            window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "cli");
          } catch {
            // localStorage may be disabled — the in-memory state is enough.
          }
          return;
        }
        setChatModeState(stored);
        return;
      }
      const migrated = migrateLegacyChatMode();
      if (migrated) {
        if (migrated === "auto" || migrated === "cloud_bridge_tools") {
          setChatModeState("cli");
          try {
            window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "cli");
          } catch {
            // localStorage may be disabled — the in-memory state is enough.
          }
          return;
        }
        setChatModeState(migrated);
      }
    } catch {
      // Privacy mode / disabled storage — leave default "auto".
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CLI_RUNTIME_STORAGE_KEY);
      if (isCliRuntime(stored)) setCliRuntimeState(stored);
    } catch {
      // Privacy mode / disabled storage - leave default "claude".
    }
  }, []);

  // Probe the local bridge on mount + every 30s. When the operator runs
  // `pm2 restart claude-bridge`, this flips true and desktop-enabled runtimes can
  // target their machine instead of /api/chat.
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        // Proxy mode: probe the same-origin proxy (which forwards the bearer
        // to the VPS server-side) so the browser never touches the VPS and
        // never needs the bearer. Operator localhost: probe the bridge directly.
        const r = await fetch(
          isProxyMode ? "/api/bridge/health" : `${BRIDGE_CHAT_BASE}/health`,
          { signal: ctl.signal },
        );
        clearTimeout(t);
        if (alive) setBridgeOnline(r.ok);
      } catch {
        if (alive) setBridgeOnline(false);
      }
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Pre-warm the bridge's claude process for the active agent as soon
  // as we know the bridge is online. The operator's first turn skips
  // cold-start (5-30s) entirely — claude is already booted, MCP servers
  // already loaded, brain files already parsed by the time they hit
  // Send. Re-fires on:
  //   - agent switch — each agent gets its own warm process
  //   - reset (🔄)   — bumping `prewarmEpoch` re-triggers the effect
  // Fire-and-forget; if the bridge is offline or pre-warm fails the
  // chat falls back to cold-spawn naturally.
  const [prewarmEpoch, setPrewarmEpoch] = useState(0);
  useEffect(() => {
    if (bridgeOnline !== true) return;
    if (cliRuntime !== "claude") return;
    // Proxy mode routes through the same-origin proxy so the prewarm POST
    // isn't a cross-origin (CORS-blocked, bearer-less) hit on the VPS.
    void fetch(isProxyMode ? "/api/bridge/prewarm" : `${BRIDGE_CHAT_BASE}/prewarm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, tab_id: tabId }),
    }).catch(() => null);
  }, [bridgeOnline, agent, tabId, prewarmEpoch, cliRuntime]);

  useEffect(() => {
    if (awayFromBottom) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming, awayFromBottom]);

  useEffect(() => {
    setMessages(seedMessagesForAgent(agent, welcomeMessages));
    setSessionId(null);
    setError(null);
    setErrorCode(null);
    setActions([]);
    setCloudResults([]);
    setToolReads([]);
    setToolRuns([]);
    setToolCalls([]);
    setExpandedReads(new Set());
    setExpandedRuns(new Set());
    setThinking(false);
    setAwayFromBottom(false);
    setPendingAttachments([]);
    setAttachmentError(null);
    // Conversation-boundary reset — drop the "last failed mode" tracker
    // so the Retry button doesn't carry over from a previous chat or a
    // previous agent. The button hides anyway when error=null, but
    // leaving the state populated is a foot-gun for any future code
    // path that surfaces the value.
    setLastFailedMode(null);
  }, [agent, activeWelcomeMessage, welcomeMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAwayFromBottom(distanceFromBottom > 80);
  }, []);

  function jumpToLatest() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setAwayFromBottom(false);
  }

  const cfg = useMemo(() => configs.find((c) => c.agent_key === agent) || null, [configs, agent]);
  const hasOwnKey = cfg?.has_key && cfg?.enabled;
  const cloudProviderReachable = cfg?.provider !== "ollama";
  const cloudReady = configsLoaded && (hasOwnKey || isAdmin) && cloudProviderReachable;
  const bridgeReady = bridgeOnline === true;
  const effectiveMode: "cli" | "cloud_only" | "cloud_bridge_tools" =
    chatMode === "cli"
      ? "cli"
      : chatMode === "cloud_only"
        ? "cloud_only"
        : chatMode === "cloud_bridge_tools"
          ? "cloud_bridge_tools"
          : bridgeReady
            ? "cli"
            : "cloud_bridge_tools";
  // Routing self-selects now: desktop bridge when paired + online, else the
  // per-agent API key. The Auto/Cloud/Desktop picker is gone — see the
  // header render block + commit 150a124.
  const desktopBridgeActive = effectiveMode === "cli" && bridgeReady;
  const ready = bridgeReady || cloudReady;
  const providerStatus = (() => {
    if (desktopBridgeActive && cfg?.provider === "ollama" && cliRuntime === "claude") {
      return `Provider: ${cfg.provider} · ${cfg.model} · local desktop`;
    }
    if (desktopBridgeActive) {
      return `Provider: ${CLI_RUNTIME_LABELS[cliRuntime]} subscription (desktop bridge)`;
    }
    if (cfg?.provider === "ollama") return "Provider: local model (Desktop required)";
    if (cfg) return `Provider: ${cfg.provider} · ${cfg.model} · saved key`;
    if (isAdmin) return "Provider: OASIS platform default";
    return configsLoaded ? "Provider: not connected" : "Provider: loading...";
  })();
  // Resolve the actual route the next /send will take, given the picker.
  // Honest copy on scope: the cloud-only path is curated tools (records,
  // http, integrations) — NOT a full coding agent. We surface that
  // distinction here so operators don't expect bash / edit_file / shell
  // execution from a path that doesn't have them. Codex Finding #1.B.
  const accessStatus =
    effectiveMode === "cli"
      ? `On this computer · ${CLI_RUNTIME_LABELS[cliRuntime]}`
      : effectiveMode === "cloud_only"
        ? "Cloud · chat only (no files)"
        : bridgeReady
          ? "Cloud + my files (bridge runs tools)"
          : "Cloud · bridge offline";
  const accessTitle =
    chatMode === "auto"
      ? "Best path: use your computer's CLI when the bridge is running, otherwise fall back to your saved API key. Install the bridge to unlock file edits + shell access."
      : chatMode === "cli"
        ? `On my computer: pinned to the ${CLI_RUNTIME_LABELS[cliRuntime]} CLI running on this machine. Uses your subscription, full file/script access. Errors loud if the bridge isn't running.`
        : chatMode === "cloud_only"
          ? "Cloud — chat only: uses your saved API key. Agent can chat, look up records, hit the dashboard, and check integrations — but CANNOT touch files on your machine, run scripts, or shell out. Pick this when you don't want the agent on your computer."
          : "Cloud + my files: your API key drives the LLM, but the agent still has access to files + scripts on your machine through the bridge. Read, write, bash, send email/SMS all work. Best of both worlds — your paid LLM, your free local tools.";
  const activeStatus = `${providerStatus} · ${accessStatus}`;
  const composerPlaceholder = !ready
    ? cfg?.provider === "ollama"
      ? "Install the desktop bridge to use local Ollama models"
      : "Configure this agent's provider + API key in Settings → Agents"
    : `Message ${agentDisplayName(agent).toUpperCase()}…  (Shift+Enter for newline)`;

  function reset() {
    // Best-effort: tell the bridge to kill the warm claude subprocess
    // for the session we're abandoning. Without this, the orphaned
    // process pins ~50-200MB of RAM until the 15-min idle reaper
    // catches up. Fire-and-forget; bridge offline / 404 is fine since
    // the reaper is the safety net.
    if (bridgeOnline === true) {
      // Proxy mode routes through the same-origin proxy so reset (which kills
      // the warm VPS process) isn't a cross-origin (CORS-blocked) hit.
      void fetch(isProxyMode ? "/api/bridge/chat-reset" : `${BRIDGE_CHAT_BASE}/chat-reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // tab_id is the canonical pool key; session_id sent for legacy
        // fallback path on older bridge builds.
        body: JSON.stringify({ agent, tab_id: tabId, session_id: sessionId, cli_provider: cliRuntime }),
      }).catch(() => null);
      // Bump the prewarm epoch so the prewarm effect re-fires and
      // spawns a fresh warm process for the next chat. Without this,
      // the first message after reset would cold-spawn (~5-30s).
      setPrewarmEpoch((e) => e + 1);
    }
    setMessages(seedMessagesForAgent(agent, welcomeMessages));
    setSessionId(null);
    setError(null);
    setErrorCode(null);
    setActions([]);
    setCloudResults([]);
    setToolReads([]);
    setToolRuns([]);
    setToolCalls([]);
    setExpandedReads(new Set());
    setExpandedRuns(new Set());
    setThinking(false);
    setAwayFromBottom(false);
    setPendingAttachments([]);
    setAttachmentError(null);
    // Conversation-boundary reset — drop the "last failed mode" tracker
    // so the Retry button doesn't carry over from a previous chat or a
    // previous agent. The button hides anyway when error=null, but
    // leaving the state populated is a foot-gun for any future code
    // path that surfaces the value.
    setLastFailedMode(null);
  }

  /**
   * Load a previously-saved chat session into the live composer.
   * Called from the ChatHistorySidebar. Calls GET /api/chat/sessions/[id]
   * which returns the agent_key + ordered messages, then resets state to
   * the loaded session so the next /api/chat POST resumes against the
   * same session_id (server keeps the chat_sessions row and appends new
   * messages onto the existing thread).
   *
   * Side effects:
   *   - If the loaded session is for a different agent, switch the agent
   *     picker too (operator clicked a session in Atlas's folder while
   *     looking at Bravo).
   *   - Reset all tool-call / synth-call / cloud-result UI state since
   *     those are per-turn, not per-session.
   *   - Clear errors and the failed-mode tracker so the loaded session
   *     starts clean.
   */
  async function loadPastSession(id: string) {
    setError(null);
    setErrorCode(null);
    setLastFailedMode(null);
    setActions([]);
    setCloudResults([]);
    setToolReads([]);
    setToolRuns([]);
    setToolCalls([]);
    setExpandedReads(new Set());
    setExpandedRuns(new Set());
    setPendingAttachments([]);
    setAttachmentError(null);
    try {
      const r = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        session?: { id: string; agent_key: string; title: string | null };
        messages?: Array<{ role: string; content: string; created_at: string }>;
        error?: string;
      };
      if (!r.ok || !j.ok || !j.session || !Array.isArray(j.messages)) {
        setError(j.error || `http_${r.status}`);
        return;
      }
      // Switch agent if the loaded session belongs to a different one.
      if (j.session.agent_key && j.session.agent_key !== agent) {
        setAgent(j.session.agent_key);
      }
      // Map server-shape -> client Msg shape. created_at strings -> ms
      // timestamps; "system" rows from earlier persistence get filtered
      // (they're client-only chrome). assistant/user rows are kept.
      const restored: Msg[] = j.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as Role,
          content: m.content,
          at: new Date(m.created_at).getTime() || Date.now(),
        }));
      setMessages(restored);
      setSessionId(j.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "session_load_failed");
    }
  }

  function applySuggestion(text: string) {
    setInput(text);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function attachFiles(fileList: FileList | null) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAttachmentError(null);
    const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_TURN - pendingAttachments.length);
    if (remainingSlots <= 0) {
      setAttachmentError("Maximum 5 files per turn.");
      return;
    }
    const selected = files.slice(0, remainingSlots);
    const uploaded: ChatAttachmentSummary[] = [];

    setUploadingAttachments(true);
    try {
      const signRes = await fetchWithTimeout("/api/chat/attachments/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_key: agent,
          session_id: sessionId,
          files: selected.map((file) => ({
            filename: file.name,
            mime_type: file.type || null,
            size_bytes: file.size,
          })),
        }),
        timeoutMs: CHAT_FETCH_TIMEOUT_MS,
      });
      const signBody = asRecord(await safeReadJson(signRes));
      if (!signRes.ok || signBody?.ok !== true) {
        throw new Error(getString(signBody?.error) || `upload_sign_failed_${signRes.status}`);
      }
      const uploads = Array.isArray(signBody.uploads) ? signBody.uploads : [];
      if (uploads.length !== selected.length) throw new Error("upload_sign_count_mismatch");

      const supabase = getBrowserSupabase();
      for (let i = 0; i < selected.length; i += 1) {
        const file = selected[i];
        const upload = asRecord(uploads[i]);
        const storagePath = getString(upload?.storage_path);
        const uploadToken = getString(upload?.upload_token);
        const completionToken = getString(upload?.completion_token);
        const mimeType = getString(upload?.mime_type) || file.type || "application/octet-stream";
        if (!storagePath || !uploadToken || !completionToken) {
          throw new Error("upload_sign_payload_invalid");
        }

        const storage = await supabase.storage
          .from("chat-attachments")
          .uploadToSignedUrl(storagePath, uploadToken, file, {
            contentType: mimeType,
            upsert: false,
          });
        if (storage.error) throw new Error(`upload_failed: ${storage.error.message}`);

        const excerpt = await readAttachmentExcerpt(file, mimeType);
        const completeRes = await fetchWithTimeout("/api/chat/attachments/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            completion_token: completionToken,
            parser: excerpt.parser,
            text_excerpt: excerpt.text,
            truncated: excerpt.truncated,
          }),
          timeoutMs: CHAT_FETCH_TIMEOUT_MS,
        });
        const completeBody = asRecord(await safeReadJson(completeRes));
        if (!completeRes.ok || completeBody?.ok !== true) {
          throw new Error(getString(completeBody?.error) || `upload_complete_failed_${completeRes.status}`);
        }
        const summary = normalizeAttachmentSummary(completeBody.attachment);
        if (!summary) throw new Error("upload_complete_payload_invalid");
        uploaded.push(summary);
      }
      if (uploaded.length > 0) {
        setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, MAX_ATTACHMENTS_PER_TURN));
      }
      if (files.length > selected.length) {
        setAttachmentError(`Attached ${selected.length}; maximum 5 files per turn.`);
      }
    } catch (err) {
      if (uploaded.length > 0) {
        setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, MAX_ATTACHMENTS_PER_TURN));
      }
      setAttachmentError(err instanceof Error ? err.message : "upload_failed");
    } finally {
      setUploadingAttachments(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((att) => att.id !== id));
  }

  async function send() {
    const attachmentsForTurn = pendingAttachments;
    const text =
      input.trim() ||
      (attachmentsForTurn.length > 0
        ? "Please review the attached file(s) and update the CRM if appropriate."
        : "");
    if ((!text && attachmentsForTurn.length === 0) || streaming || uploadingAttachments) return;

    // Slash command interception — runs entirely client-side, no API call.
    // Only fires when there are no attachments + the raw input parses as a
    // known slash command. Anything else falls through to the regular send.
    if (text && attachmentsForTurn.length === 0) {
      const parsed = parseInput(text);
      if (parsed.kind === "command") {
        setInput("");
        runSlashCommand(parsed.name, parsed.args);
        return;
      }
    }

    setInput("");
    setPendingAttachments([]);
    setAttachmentError(null);
    return submitText(text, undefined, attachmentsForTurn);
  }

  /**
   * Slash command dispatcher. Runs entirely client-side — each command
   * either mutates local widget state (planMode, agent, messages) or
   * appends a system note to the conversation so the operator sees what
   * happened. None of these hit the model.
   *
   * /compact is the exception — it'd need a server summarization call
   * which we punt on for v1; the slash is parsed but renders a "coming
   * soon" note so the operator knows the command was recognised.
   */
  function runSlashCommand(name: SlashCommandName, args: string) {
    const now = Date.now();
    const appendSystem = (content: string) => {
      setMessages((m) => [...m, { role: "system", content, at: now }]);
    };
    switch (name) {
      case "help":
        appendSystem(renderHelp());
        return;
      case "clear":
        setMessages([]);
        return;
      case "plan":
        setPlanMode("plan");
        if (effectiveMode === "cli" && cliRuntime !== "claude") {
          appendSystem(
            `Plan mode set — but you're routed through the ${cliRuntime} CLI which has no native plan-mode gate. The bridge will prepend an advisory overlay, but write tools are NOT hard-blocked. Switch to claude CLI or API mode for a hard gate.`,
          );
        } else {
          appendSystem(
            "Plan mode active — agent is restricted to read-only tools. Hit Execute (or run /build) when you're ready to run.",
          );
        }
        return;
      case "build":
        setPlanMode("build");
        appendSystem("Execute mode active — full agent capabilities restored.");
        return;
      case "agent": {
        const target = args.trim().toLowerCase();
        if (!target) {
          appendSystem("Usage: /agent <slug>. Try /agent bravo or /agent atlas.");
          return;
        }
        if (!agentKeys.includes(target)) {
          appendSystem(
            `Unknown agent "${target}". Available: ${agentKeys.join(", ")}.`,
          );
          return;
        }
        setAgent(target);
        setMessages([]);
        appendSystem(`Switched to agent: ${target}. History cleared.`);
        return;
      }
      case "model": {
        const requested = args.trim();
        if (!requested) {
          // No args — list the models available across the operator's
          // configured providers so they don't have to guess. Falls back
          // to the full registry when no configs are loaded.
          const known = configs.length
            ? Array.from(
                new Set(
                  configs.flatMap((c) => PROVIDER_MODELS[c.provider as keyof typeof PROVIDER_MODELS] || []),
                ),
              )
            : Object.values(PROVIDER_MODELS).flat();
          appendSystem(
            `Usage: /model <id>. Examples: ${known.slice(0, 6).join(", ")}${known.length > 6 ? ", ..." : ""}.`,
          );
          return;
        }
        const provider = providerForModel(requested);
        if (!provider) {
          appendSystem(
            `Unknown model "${requested}". Use a model id from one of: ${Object.keys(PROVIDER_MODELS).join(", ")}. Tip: /model with no arg lists examples.`,
          );
          return;
        }
        // Fire-and-forget — runSlashCommand is sync, but the API call is
        // async. We surface progress + result via system notes; refetching
        // /api/agent-config refreshes the visible "Provider: x · model: y"
        // header line. Try tenant scope first (operator/admin path), fall
        // back to user scope on 403 (employees on a shared tenant).
        void (async () => {
          const tryScope = async (scope: "tenant" | "user") => {
            const res = await fetch("/api/agent-config", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agent_key: agent, provider, model: requested, scope }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
              message?: string;
            };
            return { res, body };
          };
          let attempt = await tryScope("tenant");
          if (!attempt.res.ok && attempt.body.error === "admin_required") {
            attempt = await tryScope("user");
          }
          if (!attempt.res.ok || !attempt.body.ok) {
            const msg = attempt.body.message || attempt.body.error || `http_${attempt.res.status}`;
            appendSystem(
              `Couldn't switch model to ${requested}: ${msg}. The current model stays active.`,
            );
            return;
          }
          // Refetch configs so the chat header + provider pill reflect the
          // new model on the very next render — no page reload needed.
          try {
            const r = await fetch("/api/agent-config");
            const j = (await r.json().catch(() => ({}))) as { ok?: boolean; configs?: AgentConfig[] };
            if (j?.ok && Array.isArray(j.configs)) setConfigs(j.configs);
          } catch {
            // non-fatal — header may stay stale until next reload.
          }
          appendSystem(
            `Model switched to ${requested} (${provider}). Next turn uses the new model.`,
          );
        })();
        return;
      }
      case "compact": {
        const focusHint = args.trim();
        // Need at least an assistant + user pair to compact. Anything less
        // and there's nothing to summarize — bail with a friendly note.
        const hasAssistant = messages.some((m) => m.role === "assistant");
        const userCount = messages.filter((m) => m.role === "user").length;
        if (!hasAssistant || userCount < 1) {
          appendSystem("Nothing to compact yet — send a few turns first.");
          return;
        }
        void (async () => {
          appendSystem("Compacting conversation…");
          try {
            const res = await fetch("/api/chat/compact", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent_key: agent,
                messages: messages.filter((m) => m.role === "user" || m.role === "assistant"),
                focus: focusHint || null,
              }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              summary?: string;
              error?: string;
              message?: string;
            };
            if (!res.ok || !body.ok || !body.summary) {
              const detail = body.message || body.error || `http_${res.status}`;
              appendSystem(`Compact failed: ${detail}. History unchanged.`);
              return;
            }
            // Replace the live history with one assistant message holding
            // the summary, prefixed with a "context summary" marker so
            // operators can see what got folded. The compacted summary
            // becomes the new starting context for whatever the operator
            // types next.
            setMessages([
              {
                role: "assistant",
                content: `--- Context summary ---\n\n${body.summary.trim()}\n\n--- End summary ---`,
                at: Date.now(),
              },
            ]);
            // Clear sessionId so the bridge / cloud loop doesn't try to
            // resume against a stale chat thread that no longer matches.
            setSessionId(null);
          } catch (err) {
            appendSystem(
              `Compact failed: ${err instanceof Error ? err.message : "network_error"}. History unchanged.`,
            );
          }
        })();
        return;
      }
    }
  }

  /**
   * Internal: send a user message with full routing logic. send() is the
   * thin entry point from the composer; submitText also powers the
   * "Retry on the other mode" button below the error banner — that retry
   * passes a modeOverride so we route to the alternate path WITHOUT
   * having to wait for setChatMode to flush before reading state.
   */
  async function submitText(
    text: string,
    modeOverride?: ChatMode,
    attachmentsForTurn: ChatAttachmentSummary[] = [],
  ) {
    if (!text || streaming) return;
    setError(null);
    setErrorCode(null);
    const now = Date.now();
    const newMessages: Msg[] = [
      ...messages,
      {
        role: "user",
        content: text,
        at: now,
        attachments: attachmentsForTurn.length > 0 ? attachmentsForTurn : undefined,
      },
    ];
    const outboundMessages = newMessages.map((m) => ({ role: m.role, content: m.content }));
    const attachmentPayload = attachmentsForTurn.map((att) => ({
      id: att.id,
      filename: att.filename,
      mime_type: att.mime_type,
      size_bytes: att.size_bytes,
      parser: att.parser,
      text_excerpt: att.text_excerpt || null,
    }));
    setMessages(newMessages);
    // Stamp the assistant placeholder with the runtime we expect to
    // service this turn, derived from the same picker state the routing
    // logic below uses. This lets the operator verify (a) "yes, Gemini
    // really did run" or (b) "no, it fell back to cloud because the
    // bridge dropped." Updated downstream if the bridge sends back an
    // `info` event with the actual runtime it dispatched to.
    const expectedRuntime = computeExpectedRuntime({
      chatMode,
      modeOverride,
      bridgeOnline,
      cliRuntime,
      cfgProvider: cfg?.provider,
      cfgModel: cfg?.model,
    });
    setMessages((m) => [
      ...m,
      { role: "assistant", content: "", at: Date.now(), runtime: expectedRuntime },
    ]);
    setStreaming(true);
    setThinking(true);
    setStreamStartedAt(Date.now());
    // Resolve routing intent — honors the chat-mode picker, with an explicit
    // modeOverride taking precedence (used by the "Retry on the other mode"
    // button below the error banner so the retry routes to the OTHER path
    // without waiting for a setChatMode flush to land in React state).
    const activeMode: ChatMode = modeOverride ?? chatMode;
    // Phase 3 routing — the 4-mode union collapses into "bridge-pinned" vs
    // "cloud path." Both cloud_only and cloud_bridge_tools go through
    // /api/chat; they differ only in whether bridge tools join the palette
    // (resolved server-side via tool_routing below).
    const wantsBridge =
      activeMode === "cli" ||
      (activeMode === "auto" && bridgeOnline === true);
    // 2026-06-08 stub-fix: proxy mode + serverBridgeOnline means the bridge
    // is reachable via the same-origin /api/bridge/chat proxy — the
    // browser's failed localhost probe is irrelevant. Without this guard,
    // the previous code errored out on every CLI send from a browser that
    // can't see localhost:9100 (i.e., every browser on a remote VPS deploy),
    // even though the proxy path below at line ~1684 would handle it just
    // fine. Matches the renderCliOption gate at the dropdown layer.
    const effectiveBridgeOnline =
      bridgeOnline === true ||
      (isProxyMode && serverBridgeOnline === true);
    if (activeMode === "cli" && !effectiveBridgeOnline) {
      // Pinned to bridge but neither the local probe NOR the proxy path
      // can reach the bridge. Two very different situations to surface
      // differently (ADR-0006):
      //
      //   A. The tenant has a bridge online elsewhere (typical multi-
      //      employee model: admin's always-on machine). Tell the
      //      employee whose machine owns the bridge so they understand
      //      the model + suggest switching to API-key mode for this
      //      session.
      //
      //   B. No bridge anywhere in the tenant. Tell them to start one
      //      on their own machine or switch modes.
      const tenantHasRemoteBridge =
        tenantBridgeOwner?.online === true &&
        (tenantBridgeOwner.machine_label || tenantBridgeOwner.owner_display_name);
      if (tenantHasRemoteBridge) {
        const owner = tenantBridgeOwner!.owner_display_name;
        const machine = tenantBridgeOwner!.machine_label;
        const where = owner && machine
          ? `${owner}'s machine (${machine})`
          : owner
            ? `${owner}'s machine`
            : machine
              ? machine
              : "another teammate's machine";
        setError(
          `Bridge runs on ${where} and isn't reachable from this browser. ` +
          "Switch the chat mode to API key for this session, or open the dashboard on the machine that owns the bridge."
        );
      } else {
        setError(
          "Pinned to CLI (local bridge), but no bridge is online. " +
          "Start the bridge on your machine (`pm2 restart claude-bridge` / `bravo bridge serve`), " +
          "or switch the mode to API key."
        );
      }
      setStreaming(false);
      setMessages((m) => m.slice(0, -1));
      return;
    }
    setStatusPhase(wantsBridge ? "spawning" : "thinking");
    setStatusDetail("");

    try {
      // Routing now respects the chat-mode picker (chatMode):
      //   - "cli" or ("auto" + bridgeOnline)
      //         → bridge endpoints (Claude Code subprocess or local Ollama)
      //   - "cloud_only" / "cloud_bridge_tools" / ("auto" + bridge offline)
      //         → /api/chat (cloud relay with operator's API key + native
      //           tool_use loop on Anthropic provider). The cloud_only vs
      //           cloud_bridge_tools split is conveyed via the tool_routing
      //           body field below — the URL is the same.
      const isOllama = cfg?.provider === "ollama";
      const useBridge = wantsBridge;
      // Ollama local-chat is a localhost-operator feature only — its URL is the
      // direct bridge (browser->127.0.0.1). In proxy mode that bridge is the
      // private VPS (unreachable from the browser, no bearer), so disable the
      // direct local-chat path and fall through to the same-origin proxy
      // (/api/bridge/chat). Employees use the subscription CLIs, not Ollama.
      const useLocalChat = useBridge && isOllama && cliRuntime === "claude" && !isProxyMode;
      // Proxy mode: bridge chat goes through the same-origin proxy
      // (/api/bridge/chat), which authenticates via the Supabase cookie and
      // attaches the VPS bearer server-side. The request body shape is
      // unchanged — the proxy forwards it through and overrides identity
      // fields server-side. Operator localhost keeps the direct path.
      const url = useLocalChat
        ? `${BRIDGE_CHAT_BASE}/local-chat`
        : useBridge && isProxyMode
          ? "/api/bridge/chat"
          : useBridge
            ? `${BRIDGE_CHAT_BASE}/chat`
            : "/api/chat";
      const body = useLocalChat
        ? {
            // Bridge `/local-chat` payload: model + messages. The bridge
            // resolves base_url from its own .env.agents (OLLAMA_BASE_URL
            // / LM_STUDIO_BASE_URL) since the operator's saved URL is
            // encrypted in Supabase and the dashboard never has it
            // unencrypted on the client side. System prompt is built
            // by the bridge from agent_roots like the Claude Code path.
            model: cfg?.model || "llama3.3",
            messages: outboundMessages,
            attachments: attachmentPayload,
          }
        : useBridge
          ? {
              agent,
              messages: outboundMessages,
              session_id: sessionId,
              cli_provider: cliRuntime,
              attachments: attachmentPayload,
              tab_id: tabId,  // warm pool key — stable across the widget's lifetime
              // Plan vs Build — bridge_chat_server honors this since 2026-05-22.
              // Claude CLI path: swaps --permission-mode to "plan", bypasses
              // warm pool so the cold spawn picks up the new mode.
              // Legacy /v1/messages path: filters tools + plan overlay.
              // Codex/Gemini CLI: advisory overlay only (no hard gate).
              chat_mode: planMode,
            }
          : {
              agent_key: agent,
              session_id: sessionId,
              messages: outboundMessages,
              attachments: attachmentPayload,
              // Hint to /api/chat which cloud-tool surface to use. "tools"
              // gives the native Anthropic tool_use loop; route will fall
              // back to "markers" automatically for non-Anthropic providers.
              cloud_tools: "tools" as const,
              // Phase 3 tool_routing — "cloud_only" force-disables bridge
              // tools even when the bridge is online (operator opt-out for
              // the "I don't want this LLM running bash on my machine"
              // case). "bridge_proxy" is the default and what auto +
              // cloud_bridge_tools both want; server falls back to
              // cloud-only automatically when the bridge isn't reachable.
              tool_routing:
                activeMode === "cloud_only"
                  ? ("cloud_only" as const)
                  : ("bridge_proxy" as const),
              // Plan vs Build (2026-05-22 OpenCode-style). Server filters
              // write tools out + appends the plan-mode prompt overlay
              // when this is "plan". Default is "build" (full tools).
              chat_mode: planMode,
            };
      // Stash an AbortController so the operator can Stop mid-stream.
      // Cleared in the finally block below; the stream reader catches the
      // AbortError naturally and falls through to the same cleanup path
      // as a normal stream end.
      const abortCtl = new AbortController();
      activeStreamControllerRef.current = abortCtl;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: CHAT_FETCH_TIMEOUT_MS,
        signal: abortCtl.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = asRecord(await safeReadJson(res));
        setError(getString(errBody?.error) || `http_${res.status}`);
        setErrorCode(getString(errBody?.code));
        setLastFailedMode(useBridge ? "cli" : "cloud");
        setStreaming(false);
        setMessages((m) => m.slice(0, -1));
        return;
      }
      // Flipped to true the first time we get any assistant text. Used after
      // the loop to detect silent-stream failures without having to read
      // React state from inside another setter.
      let receivedAnyContent = false;
      // Captured by the SSE `error` event handler below so the post-
      // stream "empty content" check can decide whether to overwrite
      // with the generic banner or trust the specific bridge error.
      // Alpha.6 — bridge emits {code, message} so we can drive specific
      // UX (install CLI, sign in to provider, switch to API-key mode).
      let streamErrorCode = "";
      let streamErrorMessage = "";
      // Populated when the cloud tool_use loop pauses on a deferred tool
      // (defer:true on a tool definition — see lib/cloud-tool-runner.ts).
      // After the SSE stream closes, we proxy this to localhost:9100 via
      // the bridge's /exec-tool, then POST the result to /api/chat/resume
      // and consume the resumed SSE stream. Repeat for any further
      // deferred tools until the iteration finishes or hits its cap.
      type PendingTool = {
        tool_use_id: string;
        name: string;
        input: Record<string, unknown>;
        resume_state: unknown;
        /** HMAC signature minted by /api/chat (Phase H). The browser must
         *  forward it verbatim on the resume POST so the route can
         *  verify the resume_state hasn't been tampered with. */
        resume_signature: string;
      };
      let pendingToolUse: PendingTool | null = null;

      /**
       * Consume an SSE Response body. Side-effects React state (messages,
       * tool calls, status) through the surrounding closures. Returns when
       * the stream closes — either because the turn completed cleanly OR
       * because tool_use_pending fired (the model wants a deferred tool
       * executed locally). The caller checks pendingToolUse to decide
       * whether to resume.
       */
      const consumeStream = async (stream: Response): Promise<void> => {
        if (!stream.body) return;
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const readWithWatchdog = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
          new Promise((resolve, reject) => {
            const timer = window.setTimeout(
              () => reject(new Error("stream_inactivity_timeout")),
              SSE_INACTIVITY_TIMEOUT_MS,
            );
            reader.read().then(
              (result) => {
                window.clearTimeout(timer);
                resolve(result);
              },
              (err) => {
                window.clearTimeout(timer);
                reject(err);
              },
            );
          });
      while (true) {
        const { done, value } = await readWithWatchdog();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          // SSE data field is provider-shape-dependent (Anthropic delta vs
          // OpenAI choices vs Gemini candidates). Each downstream branch
          // reads its own shape-specific fields, so the wire-level type
          // is genuinely any here — narrowing at this seam would cascade
          // through every provider branch below.
          let parsed: Record<string, unknown> | null;
          try {
            parsed = asRecord(JSON.parse(data));
          } catch {
            continue;
          }
          if (!parsed) continue;
          if (event === "session" && typeof parsed.session_id === "string") setSessionId(parsed.session_id);
          else if (event === "agent_status") {
            // Phases the bridge emits:
            //   "spawning"    — before claude subprocess is up (cold path)
            //   "thinking"    — subprocess alive, model reasoning
            //   "tool"        — currently running a tool
            //   "warm_resume" — warm-pool path: persistent process took
            //                   the turn; cold-start was skipped entirely
            const phase = String(parsed.phase || "");
            if (phase === "spawning" || phase === "thinking" || phase === "tool" || phase === "warm_resume") {
              setStatusPhase(phase as "spawning" | "thinking" | "tool" | "warm_resume");
              if (phase === "spawning" && parsed.cwd) {
                const cwd = String(parsed.cwd);
                const last = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
                setStatusDetail(last);
              } else {
                setStatusDetail("");
              }
            }
          }
          else if (event === "delta" && typeof parsed.text === "string") {
            setThinking(false);
            setStatusPhase(null);
            if (parsed.text.length > 0) receivedAnyContent = true;
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, content: last.content + parsed.text };
              }
              return next;
            });
          } else if (event === "cloud_tool_call") {
            // Native tool_use loop — model called a tool MID-stream, runner
            // is executing now. Push onto the unified toolCalls list (same
            // surface the CLI/bridge path uses) so CLI mode and API mode
            // render tool activity identically. The matching cloud_tool_result
            // event arrives a moment later and patches `output`.
            //
            // Counts as content for the "agent returned no response" check
            // (Codex P2 finding 2026-05-24). The streaming redactor's
            // hold-back behavior can suppress all text deltas during a
            // tool-only turn (model emits a few chars, calls a deferred
            // tool, resume finishes without more text). Without this,
            // the assistant bubble would be removed as empty even though
            // the tool ran successfully.
            receivedAnyContent = true;
            const toolName = String(parsed.name || "tool");
            const entryId = `cloud-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setThinking(true);
            setStatusPhase("tool");
            setStatusDetail(toolName);
            // Stash the id on the inputs object so the matching result can
            // find this entry via the most-recent-pending-by-name lookup
            // below (since the SSE protocol doesn't echo our generated id
            // back from the route).
            setToolCalls((prev) => [
              ...prev,
              {
                id: entryId,
                kind: toolName,
                label: toolName,
                detail: asRecord(parsed.input) ? truncateJson(asRecord(parsed.input)!) : undefined,
                createdAt: Date.now(),
              },
            ]);
          } else if (event === "cloud_tool_result") {
            // Cloud-mode tool result — either from the native tool_use loop
            // (cloud-tool-runner.ts, mid-stream) or the legacy text marker
            // path (cloud-tools.ts, post-stream). Two surfaces:
            //   1. Update the matching toolCalls entry so chrome matches CLI
            //   2. (Legacy compat) also push a cloudResults pill — the
            //      below-transcript renderer still consumes them for the
            //      markers path. Harmless duplication; cloudResults is the
            //      summary line, toolCalls is the expandable detail row.
            const toolName = String(parsed.name || "?");
            setToolCalls((prev) => {
              const next = [...prev];
              // Find the most recent matching pending entry from this kind.
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].kind === toolName && next[i].output === undefined && !next[i].completedAt) {
                  next[i] = {
                    ...next[i],
                    output: getString(parsed.summary) || undefined,
                    error: !parsed.ok,
                    completedAt: Date.now(),
                  };
                  break;
                }
              }
              return next;
            });
            setCloudResults((prev) => [
              ...prev,
              {
                uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                ok: !!parsed.ok,
                name: toolName,
                summary: getString(parsed.summary) || undefined,
                error: getString(parsed.error) || undefined,
                data: parsed.data,
              },
            ]);
          } else if (event === "tool_use_pending") {
            // Phase 2: deferred tool. The cloud runner paused because the
            // model called a tool that needs the operator's local bridge
            // (send_email, read_file, bash, etc.). Stash the pending data
            // and exit the read loop — the outer resume loop below will
            // POST the call to localhost:9100/exec-tool and then POST the
            // result to /api/chat/resume to continue the model's iteration.
            //
            // Counts as content (same rationale as cloud_tool_call above)
            // — a deferred tool firing means the turn DID produce a real
            // action even if the redactor swallowed the surrounding text.
            receivedAnyContent = true;
            pendingToolUse = {
              tool_use_id: String(parsed.tool_use_id || ""),
              name: String(parsed.name || "tool"),
              input: asRecord(parsed.input) || {},
              resume_state: parsed.resume_state,
              // Phase H signature — opaque to the browser, must echo
              // verbatim on the resume POST so the server can verify
              // the resume_state hasn't been tampered with.
              resume_signature: String(parsed.resume_signature || ""),
            };
            // Show "calling NAME..." chip in the toolCalls strip so the
            // operator sees activity while the bridge runs the tool.
            const entryId = `bridge-${pendingToolUse.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setThinking(true);
            setStatusPhase("tool");
            setStatusDetail(pendingToolUse.name);
            setToolCalls((prev) => [
              ...prev,
              {
                id: entryId,
                kind: pendingToolUse!.name,
                label: pendingToolUse!.name,
                detail: truncateJson(pendingToolUse!.input),
                createdAt: Date.now(),
              },
            ]);
            // No early return — let the SSE stream finish naturally.
            // The outer resume loop checks pendingToolUse after the
            // stream closes.
          } else if (event === "action") {
            setActions((prev) => [
              ...prev,
              {
                ok: !!parsed.ok,
                type: String(parsed.type || "?"),
                summary: getString(parsed.summary) || undefined,
                error: getString(parsed.error) || undefined,
                uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              },
            ]);
          } else if (event === "tool") {
            setThinking(true);
            setStatusPhase("tool");
            setStatusDetail(_toolLabel(parsed));
            const toolName = String(parsed.name || "tool");
            const toolUseId = String(parsed.tool_use_id || "");
            const isClaudePath = !!parsed.raw_name;
            if (isClaudePath) {
              // Claude Code subprocess path — unified pill list.
              const entryId = toolUseId || `${toolName}-${Date.now()}-${Math.random()}`;
              setToolCalls((prev) => [
                ...prev,
                {
                  id: entryId,
                  kind: toolName,
                  label: _toolLabel(parsed),
                  detail: _toolDetail(parsed),
                  createdAt: Date.now(),
                },
              ]);
            } else {
              // Legacy bridge path — split read/run lists (kept for
              // OASIS_CHAT_LEGACY=1 rollback support).
              if (toolName === "read_file") {
                setToolReads((prev) => [
                  ...prev,
                  {
                    path: String(parsed.path || ""),
                    body: typeof parsed.body === "string" ? parsed.body : undefined,
                  },
                ]);
              } else if (toolName === "run_script") {
                setToolRuns((prev) => [
                  ...prev,
                  {
                    script: String(parsed.script || ""),
                    args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
                    confirm: !!parsed.confirm,
                    output: typeof parsed.output === "string" ? parsed.output : undefined,
                  },
                ]);
              }
            }
          } else if (event === "tool_result") {
            const toolUseId = String(parsed.tool_use_id || "");
            const body =
              typeof parsed.body === "string"
                ? parsed.body
                : typeof parsed.output === "string"
                  ? parsed.output
                  : undefined;
            // Match by tool_use_id first (Claude Code), then by name+ordinal
            // for legacy path.
            if (toolUseId) {
              setToolCalls((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].id === toolUseId) {
                    next[i] = {
                      ...next[i],
                      output: body,
                      error: !!parsed.error,
                      elapsed_s: undefined,
                      completedAt: Date.now(),
                    };
                    break;
                  }
                }
                return next;
              });
            }
            if (parsed.name === "read_file") {
              setToolReads((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].path === String(parsed.path || "") && next[i].body === undefined) {
                    next[i] = { ...next[i], body };
                    break;
                  }
                }
                return next;
              });
            } else if (parsed.name === "run_script") {
              setToolRuns((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].script === String(parsed.script || "") && next[i].output === undefined) {
                    next[i] = { ...next[i], output: body, elapsed_s: undefined };
                    break;
                  }
                }
                return next;
              });
            }
          } else if (event === "tool_progress" && parsed.name === "run_script") {
            // Bridge ticks every 10s while a long script runs. Surface the
            // elapsed time on the matching pill so the operator knows it's
            // still working (a 90s ceo_dashboard otherwise feels broken).
            setToolRuns((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].script === String(parsed.script || "") && next[i].output === undefined) {
                  next[i] = {
                    ...next[i],
                    elapsed_s: Number(parsed.elapsed_s) || 0,
                  };
                  break;
                }
              }
              return next;
            });
          } else if (event === "error") {
            // Surface the stderr detail when the bridge supplies one
            // (e.g., claude_exit_1 with the actual claude error message)
            // so the operator can see WHY the subprocess crashed instead
            // of just a cryptic exit code.
            //
            // Alpha.6 — the bridge now emits a structured `code` field
            // (cli_not_found, cli_empty_output, cli_auth_required, etc.)
            // alongside the human `message`. We mirror code into local
            // `streamErrorCode` so the post-stream empty-content check
            // below doesn't clobber it with the generic banner.
            const msg = String(parsed.message || "stream_error");
            const code = parsed.code ? String(parsed.code) : "";
            const rawDetail = parsed.detail ? String(parsed.detail) : "";
            const detail = rawDetail.slice(0, 1500);
            setError(detail ? `${msg}\n\n${detail}` : msg);
            if (code) setErrorCode(code);
            streamErrorCode = code || streamErrorCode;
            streamErrorMessage = msg;
            // Auto-clear sessionId on subprocess crashes so the next
            // Send doesn't pass --resume <stale-id> to claude. The user
            // gets a clean retry without having to click refresh.
            // claude_exit_*, claude_spawn_failed, and claude_stream_failed
            // all qualify.
            if (msg.startsWith("claude_") || msg.includes("session not found")) {
              setSessionId(null);
            }
          }
        }
      }
      };
      // ─── End of consumeStream definition ──────────────────────────────

      // Drive the initial SSE stream.
      await consumeStream(res);

      // Phase 2 resume loop: if the cloud runner paused on a deferred
      // tool, proxy it to the local bridge and POST the result back to
      // /api/chat/resume. The resumed stream may pause AGAIN on another
      // deferred tool; loop until the model finishes or the resume cap
      // is hit (mirrors MAX_TOOL_ITERATIONS server-side).
      let resumeCount = 0;
      while (pendingToolUse && resumeCount < 8) {
        // Explicit cast — TS can't narrow a closure-captured `let` via the
        // while condition (the consumeStream arrow function mutates it,
        // so flow analysis treats every read as potentially the original
        // null). Asserting against the explicit type alias is cleaner
        // than NonNullable<typeof ...> for the same reason.
        const pending: PendingTool = pendingToolUse as PendingTool;
        pendingToolUse = null;
        resumeCount += 1;

        // 1) Hit the local bridge to execute the tool. Bridge must be
        //    online for this to work — if it's not, fall through with
        //    is_error so the model sees the failure and can adapt.
        let toolOutput = "";
        let toolIsError = false;
        try {
          const bridgeRes = await fetchWithTimeout(`${BRIDGE_CHAT_BASE}/exec-tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tool_name: pending.name,
              input: pending.input,
            }),
            timeoutMs: BRIDGE_TOOL_TIMEOUT_MS,
          });
          const bridgePayload = await bridgeRes.json().catch(() => null);
          if (!bridgeRes.ok || !bridgePayload?.ok) {
            toolOutput = `bridge_exec_failed:${bridgeRes.status}:${bridgePayload?.error || "unknown"}`;
            toolIsError = true;
          } else {
            toolOutput = String(bridgePayload.output ?? "");
            toolIsError = Boolean(bridgePayload.is_error);
          }
        } catch (bridgeErr) {
          toolOutput = `bridge_unreachable:${bridgeErr instanceof Error ? bridgeErr.message : "fetch_failed"}`;
          toolIsError = true;
        }

        // Patch the matching toolCalls pill with the result (mirrors the
        // cloud_tool_result event handler above).
        setToolCalls((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].kind === pending.name && next[i].output === undefined && !next[i].completedAt) {
              next[i] = {
                ...next[i],
                output: toolOutput.slice(0, 2000),
                error: toolIsError,
                completedAt: Date.now(),
              };
              break;
            }
          }
          return next;
        });

        // 2) POST the result to /api/chat/resume. New SSE response —
        //    feed it through the same consumeStream. The resume_signature
        //    (Phase H) MUST be passed verbatim — the server signs on
        //    tool_use_pending emit and verifies here. Without it the
        //    route returns resume_signature_missing_signature.
        const resumeRes = await fetchWithTimeout("/api/chat/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_key: agent,
            session_id: sessionId,
            resume_state: pending.resume_state,
            resume_signature: pending.resume_signature,
            tool_use_id: pending.tool_use_id,
            tool_result: { content: toolOutput, is_error: toolIsError },
          }),
          timeoutMs: RESUME_FETCH_TIMEOUT_MS,
        });
        if (!resumeRes.ok || !resumeRes.body) {
          const e = asRecord(await safeReadJson(resumeRes));
          setError(getString(e?.error) || `resume_http_${resumeRes.status}`);
          break;
        }
        await consumeStream(resumeRes);
      }
      if (resumeCount >= 8 && pendingToolUse) {
        setError(
          "Tool loop exceeded the safety cap (8 deferred tools per turn). The model kept asking for tools without finishing — try splitting the request into smaller steps."
        );
      }

      // Stream closed. If no delta ever fired, the bridge (or cloud route)
      // ended the stream without emitting any content — silent failure.
      // Surface it instead of leaving the operator staring at an empty
      // bubble (CC's reported "glitches out after 2s, no response" symptom).
      // Tracked via local boolean so we don't have to read React state
      // from inside another setter's updater (strict-mode double-invoke
      // hazard).
      if (!receivedAnyContent) {
        // Alpha.6 — if the SSE stream already emitted a specific error
        // (code + message), trust that. Only fall back to the generic
        // "no response" banner when the bridge closed silently without
        // any error event at all. The previous behaviour ALWAYS wrote
        // the generic banner here, which clobbered "Gemini CLI isn't
        // installed" / "Codex says you need to sign in" with a useless
        // "check bridge logs" string.
        if (!streamErrorMessage) {
          setError(
            "The agent returned no response. The bridge closed the stream without sending any text or error. " +
              (useBridge
                ? "Open Operations → Local Bridge for CLI status, or use the Retry button below to try API-key mode."
                : "Often a provider quota or network blip — try again, or check Settings → AI provider accounts.")
          );
        }
        // Stash which route just failed so the error banner can offer a
        // one-click retry on the OTHER route (CLI bridge ↔ cloud API key).
        setLastFailedMode(useBridge ? "cli" : "cloud");
        // Stale session_id can keep tripping the same failure if the
        // server-side process crashed — clear it for a clean retry.
        setSessionId(null);
        // Drop the empty placeholder bubble.
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last && last.role === "assistant" && last.content.trim().length === 0) {
            return m.slice(0, -1);
          }
          return m;
        });
      } else {
        // Successful turn — clear any stale "last failed mode" tracking so
        // the retry button doesn't linger past the next happy message.
        setLastFailedMode(null);
        // Tick the history sidebar so the freshly-saved session lands
        // in the operator's "previous chats" list without a page reload.
        setHistoryRefresh((n) => n + 1);
      }
    } catch (e) {
      // AbortError from a Stop-button click isn't an error in the
      // operator-perceived sense — they MEANT to interrupt the stream.
      // Render a quiet system note instead of the red banner, and keep
      // whatever assistant text streamed before they hit Stop.
      const isAbort =
        (e instanceof Error && e.name === "AbortError") ||
        (typeof e === "object" && e !== null && "name" in e && (e as { name?: string }).name === "AbortError");
      if (isAbort) {
        setMessages((m) => {
          const last = m[m.length - 1];
          // Drop the placeholder if literally nothing streamed; otherwise
          // keep the partial assistant message so the operator can see
          // what the model got out before they stopped it.
          if (last && last.role === "assistant" && last.content.trim().length === 0) {
            return [...m.slice(0, -1), { role: "system", content: "Stopped.", at: Date.now() }];
          }
          return [...m, { role: "system", content: "Stopped.", at: Date.now() }];
        });
      } else {
        setError(e instanceof Error ? e.message : "request_failed");
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last && last.role === "assistant" && last.content.trim().length === 0) {
            return m.slice(0, -1);
          }
          return m;
        });
      }
    } finally {
      // Clear the stream abort controller so a stale Stop click can't
      // abort the NEXT turn. Safe to clear unconditionally — the
      // controller is replaced on every send().
      activeStreamControllerRef.current = null;
      setStreaming(false);
      setThinking(false);
      setStatusPhase(null);
      setStatusDetail("");
      setStreamStartedAt(null);
      setElapsedTick(0);
      // Auto-focus the input so power-users can keep typing
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  /**
   * Insert a slash command into the composer. Used by both keyboard nav
   * (Tab/Enter when the menu is open) and click handlers. The trailing
   * space sets the operator up to either submit immediately (commands
   * like /plan, /build, /clear) or start typing args (/agent, /model,
   * /compact). Closes the menu side-effect via setSlashMenuDismissed.
   */
  function insertSlashCommand(name: SlashCommandName) {
    setInput(`/${name} `);
    setSlashMenuDismissed(true);
    setSlashSelectedIdx(0);
    // Re-focus the textarea — onMouseDown's preventDefault keeps focus
    // for click events, but Enter/Tab via keyboard doesn't need this
    // (focus never left). Defensive call so both paths land in the
    // same final state.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /**
   * Insert an arg value into a `/<command> ` composition. Replaces
   * whatever the operator was typing after the space with the picked
   * value — so `/agent atl` → pick "atlas" → `/agent atlas`. Does NOT
   * auto-submit; the operator can edit further or hit Enter.
   */
  function insertSlashArg(value: string) {
    if (!slashArgCommand) return;
    setInput(`/${slashArgCommand} ${value}`);
    setSlashArgDismissed(true);
    setSlashArgSelectedIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Arg menu navigation takes priority over command menu — they can't
    // both be open at once (mutually-exclusive trigger patterns), but
    // checking arg first keeps the logic linear.
    if (slashArgOpen) {
      const argMatches = filterArgCandidates(slashArgQuery, argCandidates);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (argMatches.length > 0) {
          setSlashArgSelectedIdx((idx) => (idx + 1) % argMatches.length);
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (argMatches.length > 0) {
          setSlashArgSelectedIdx((idx) => (idx - 1 + argMatches.length) % argMatches.length);
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const pick = argMatches[slashArgSelectedIdx];
        if (pick) insertSlashArg(pick.value);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Same accept-or-fall-through semantics as the command menu.
        if (argMatches.length > 0) {
          e.preventDefault();
          insertSlashArg(argMatches[slashArgSelectedIdx].value);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashArgDismissed(true);
        return;
      }
    }
    // Slash menu navigation — only intercept when the menu is open so
    // regular textarea typing isn't affected.
    if (slashMenuOpen) {
      const matches = filterCommands(slashQuery);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (matches.length > 0) {
          setSlashSelectedIdx((idx) => (idx + 1) % matches.length);
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (matches.length > 0) {
          setSlashSelectedIdx((idx) => (idx - 1 + matches.length) % matches.length);
        }
        return;
      }
      if (e.key === "Tab") {
        // Tab is the canonical "insert this and let me keep typing" key.
        // Always inserts the highlighted command regardless of Shift.
        e.preventDefault();
        const pick = matches[slashSelectedIdx];
        if (pick) insertSlashCommand(pick);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // When the menu has at least one match, Enter accepts the
        // selection (same UX as VS Code's IntelliSense). When the
        // menu has no matches, Enter falls through to the normal
        // submit path — the operator typed gibberish like `/foo`,
        // sending it as a regular message is the right escape hatch.
        if (matches.length > 0) {
          e.preventDefault();
          insertSlashCommand(matches[slashSelectedIdx]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      ref={chatContainerRef}
      /* Height: on desktop the chat is a fixed 640px panel that lives
         alongside other widgets on the page. On mobile (where the
         viewport is the only real estate) we let it size to the
         viewport minus the topbar (3.5rem) + page padding (1.5rem) +
         section header above the chat (~8rem) = ~13rem total chrome,
         leaving the chat to fill the rest. Uses 100dvh so iOS Safari's
         dynamic toolbar collapse doesn't cause layout jumps as the URL
         bar shows/hides. */
      className={`chat-container agent-${agent} flex flex-col h-[calc(100dvh-13rem)] min-h-[28rem] md:h-[640px] md:min-h-0`}
    >
      {/* Aurora wash inside the bordered container */}
      <div className="chat-aurora absolute inset-0 pointer-events-none" />

      {/* Header — agent picker only. Routing (cloud-API-key vs local-bridge)
          is decided automatically: use the desktop bridge when it's paired
          and online, otherwise the per-agent API key from Settings → Agents.
          The previous Auto/Cloud/Desktop dropdown over-exposed a one-time
          configuration decision as a per-message choice — gone 2026-05-14
          per CC. accessMode state stays internally as "auto" so the
          downstream routing logic + status labels keep working. */}
      {/* Header padding: tighter on mobile so the agent picker +
          history button + status text don't get squeezed off-screen. */}
      <div className="flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3 md:py-4 relative z-10">
        {/* Chat history sidebar trigger. Closed state = compact button
            sitting flush with the agent picker; open state = full drawer
            overlay positioned by the component itself. Clicking a past
            session calls loadPastSession() which restores the messages
            into this widget and resumes the chat_sessions row. */}
        <ChatHistorySidebar
          agentKey={agent}
          activeSessionId={sessionId}
          onLoadSession={(id) => void loadPastSession(id)}
          onNewChat={() => reset()}
          refreshKey={historyRefresh}
        />
        {/* Defensive fallback — if the page passed an empty agentKeys array (legacy
            profile.agents_enabled out of sync with chat-eligible agents), always
            include the current `agent` selection so the dropdown isn't a void
            rectangle that breaks the chat. */}
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          /* text-base on mobile keeps iOS from auto-zooming on the
             native select picker; text-sm on desktop matches the
             surrounding header density. min-w-0 on mobile lets the
             agent picker shrink when the header gets crowded — the
             pre-fix `min-w-[120px]` pushed everything else off-screen
             on phones <420px (CC reported 2026-05-24 mobile chat
             unusable). */
          className="bg-bg-elev border border-bg-border rounded-lg px-2 md:px-3 py-2 text-base md:text-sm text-fg uppercase tracking-[0.14em] font-bold focus:outline-none focus:border-accent transition-colors cursor-pointer min-w-0 md:min-w-[120px] max-w-[40vw] md:max-w-none truncate"
          aria-label="Choose agent"
        >
          {(agentKeys.length > 0 ? agentKeys : [agent]).map((k) => (
            <option key={k} value={k}>
              {agentDisplayName(k)}
            </option>
          ))}
        </select>
        {/* Desktop info pane — agent tagline + provider/status line. Hidden
            on mobile where the screen has no room for two lines of meta
            text; mobile shows just the short status pill below. */}
        <div className="hidden md:block flex-1 min-w-0">
          <div className="text-xs text-fg-muted truncate">
            {getAgentInfo(agent).tagline}
          </div>
          <div className="text-xs text-fg-dim font-mono truncate">
            <span title={accessTitle} className={bridgeReady ? "text-accent" : undefined}>
              {bridgeReady && (
                <Cpu className="w-3 h-3 inline-block mr-1 -mt-0.5" />
              )}
              {activeStatus}
            </span>
          </div>
        </div>
        {/* Mobile-only compact status — one short pill so the operator
            still sees whether they're routed through the bridge or a
            cloud key. */}
        <div className="md:hidden flex-1 min-w-0">
          <span
            title={accessTitle}
            className={`text-[10px] font-mono truncate block ${bridgeReady ? "text-accent" : "text-fg-dim"}`}
          >
            {bridgeReady && <Cpu className="w-3 h-3 inline-block mr-1 -mt-0.5" />}
            {activeStatus}
          </span>
        </div>
        {/*
          Chat-mode picker — Phase 3 of giggly-reef (2026-05-15). Four real
          combinations of (who-owns-the-LLM, who-owns-the-tools):
            - Auto:                bridge if paired+online, else cloud
            - CLI:                 bridge owns LLM + tools (subscription)
            - API · cloud tools:   API key LLM, ONLY the 11 cloud tools
            - API + local tools:   API key LLM, bridge owns tool execution
          The last option is disabled while the bridge is offline — the
          model would emit tool_use for read_file/bash/send_email and the
          browser-proxy would have nothing to forward to. The picker
          tooltip explains why it's grey.
          See type ChatMode docs at the top of this file.
          Per-tenant gate: the picker only renders for tenants that flip
          manifest.ui.advanced_picker = true (OASIS HQ). End-user tenants
          (SunBiz, SUGA) get advancedPicker=false and the dropdown is
          hidden entirely — Auto-mode handles routing silently. CC's
          framing 2026-05-15: "if one of them just works correctly,"
          the CLI-vs-API distinction is irrelevant to end users.
        */}
        {advancedPicker && (
          <select
            /* Single 4-option route picker. CC's feedback 2026-06-06: the
               old 4 options (Best path / On my computer / Cloud chat only /
               Cloud + my files) didn't match his mental model and the
               secondary CLI-runtime dropdown was confusing in addition.
               One picker, four routes, the only ones that exist:
                 - Codex CLI         (cli + codex runtime)
                 - Gemini CLI        (cli + gemini runtime)
                 - Claude Code CLI   (cli + claude runtime)
                 - API (cloud)       (cloud_only — uses operator's API key)
               CLI options grey out when the bridge is offline; API lights
               up as the only usable choice. */
            value={chatMode === "cli" ? `cli:${cliRuntime}` : "api"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "cli:codex") {
                setChatMode("cli");
                setCliRuntime("codex");
              } else if (v === "cli:gemini") {
                setChatMode("cli");
                setCliRuntime("gemini");
              } else if (v === "cli:claude") {
                setChatMode("cli");
                setCliRuntime("claude");
              } else if (v === "api") {
                setChatMode("cloud_only");
              }
            }}
            /* Hidden on mobile — route choice is a desktop concern; phones
               default to whatever the bridge last used. */
            className="hidden md:block bg-bg-elev border border-bg-border rounded-lg px-2 py-2 text-[11px] text-fg-muted focus:outline-none focus:border-accent transition-colors cursor-pointer"
            aria-label="Chat route"
            title={accessTitle}
          >
            {/* Three near-identical CLI options — extracted via renderCliOption
                below. The label distinguishes three states (online / online
                but unreachable from this browser / daemon offline) and the
                tooltip explains each. */}
            {renderCliOption({
              value: "cli:codex",
              displayName: "Codex CLI",
              onlineTooltip: "OpenAI Codex on your machine. Best for backend, deep debugging, code review.",
              offlineTooltip: "Bridge offline — start the daemon on the machine that runs Codex.",
              bridgeOnline,
              serverBridgeOnline,
            })}
            {renderCliOption({
              value: "cli:gemini",
              displayName: "Gemini CLI",
              onlineTooltip: "Google Gemini on your machine. Cheaper for high-volume reasoning.",
              offlineTooltip: "Bridge offline — start the daemon on the machine that runs Gemini.",
              bridgeOnline,
              serverBridgeOnline,
            })}
            {renderCliOption({
              value: "cli:claude",
              displayName: "Claude Code CLI",
              onlineTooltip: "Anthropic Claude on your machine. Best for architecture, conversation, writing.",
              offlineTooltip: "Bridge offline — start the daemon on the machine that runs Claude Code.",
              bridgeOnline,
              serverBridgeOnline,
            })}
            <option
              value="api"
              title="Uses your saved API key. No local files. Always available — fallback when the CLIs aren't reachable."
            >
              API (cloud){bridgeOnline === true ? "" : " — recommended now"}
            </option>
          </select>
        )}
        {planMode === "plan" && (
          // Plan-mode header badge. Redundant with the new Plan/Execute
          // toggle in the composer, but kept here as a quiet, always-
          // visible state indicator so operators scrolling through long
          // chats never lose track of the current mode. Click flips back
          // to Execute, matching the toggle below.
          <button
            type="button"
            onClick={() => {
              setPlanMode("build");
              setMessages((m) => [
                ...m,
                {
                  role: "system",
                  content: "Execute mode active — full agent capabilities restored.",
                  at: Date.now(),
                },
              ]);
            }}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border transition-colors border-status-warm/40 bg-status-warm/10 text-status-warm hover:bg-status-warm/20"
            title={
              effectiveMode === "cli"
                ? "Plan mode active — Claude CLI uses --permission-mode plan; Codex/Gemini CLIs apply the overlay advisorily. Click to switch to Execute mode."
                : "Plan mode active — agent is restricted to read-only tools. Click to switch to Execute mode."
            }
          >
            ● PLAN MODE
          </button>
        )}
        {/* Secondary CLI-runtime select removed 2026-06-06. The runtime
            is now baked into the primary route picker above (Codex CLI /
            Gemini CLI / Claude Code CLI / API), so this dropdown was
            duplicating the same choice with worse labels. Non-advanced
            tenants (advancedPicker=false) didn't see the picker but also
            don't see this — they keep whatever the bridge defaults to. */}
        {usage && (
          <span
            className="text-[10px] font-mono text-fg-dim border border-bg-border bg-bg-elev rounded-full px-2 py-0.5 hidden sm:inline-flex items-center gap-1"
            title={`OpenRouter usage this period${usage.limit ? ` (limit $${usage.limit.toFixed(2)})` : ""}`}
          >
            ${usage.usage.toFixed(2)}
            {usage.limit !== null ? ` / $${usage.limit.toFixed(2)}` : ""}
          </span>
        )}
        {messages.length > 0 && (
          <button
            type="button"
            onClick={reset}
            /* Hidden on mobile — the History panel's "+ New chat"
               button covers this. Keeping it desktop-only frees one
               more slot in the cramped phone header. */
            className="hidden md:inline-flex text-fg-dim hover:text-accent transition-colors p-1"
            title="Start new conversation"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={toggleFullscreen}
          /* Hidden on mobile — fullscreen toggle is a desktop affordance.
             Phones are already full-bleed. */
          className="hidden md:inline-flex text-fg-dim hover:text-accent transition-colors p-1"
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Open chat fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 className="w-4 h-4" />
          ) : (
            <Maximize2 className="w-4 h-4" />
          )}
        </button>
        <Link
          href="/settings#agents"
          className="text-fg-dim hover:text-accent transition-colors p-1"
          title="Configure agent in Settings"
        >
          <Cog className="w-4 h-4" />
        </Link>
      </div>

      {/* Animated rail beneath the header */}
      <div className="chat-rail" />

      {/* The previous "Desktop offline" banner gated on accessMode === "desktop"
          and bridgeOnline === false. Both are gone with the picker — the
          accessMode forced-cloud path doesn't exist anymore, so a missing
          bridge just means the chat falls through to the cloud API key
          silently. Bridge-onboarding nudges, if needed later, belong in
          Settings → Devices, not as a chat-blocking banner. */}

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 py-5 space-y-4 chat-scroll relative z-10"
      >
        {!messages.length && !error && (
          <EmptyTranscript
            ready={!!ready}
            agent={agent}
            agentDisplayName={agentDisplayName}
            configsLoaded={configsLoaded}
            isAdmin={!!isAdmin}
            currentProvider={cfg?.provider ?? null}
            onSuggestion={applySuggestion}
          />
        )}
        {messages.map((m, i) => {
          const isLastAssistant = i === messages.length - 1 && m.role === "assistant";
          // Show the tool timeline ABOVE the in-progress assistant bubble
          // so CC sees the agent working (read → bash → grep → …) BEFORE
          // the final text answer lands. Matches Claude Code's CLI rhythm.
          // Real toolCalls win; synthCalls fill the silence when the model
          // is just thinking (40-60s of cold-start latency before any real
          // tool fires).
          const showRealTools = isLastAssistant && toolCalls.length > 0;
          const showSynthTools = isLastAssistant && toolCalls.length === 0 && synthCalls.length > 0;
          return (
            <div key={i} className="contents">
              {showRealTools && (
                process.env.NEXT_PUBLIC_TOOL_TIMELINE === "false"
                  ? <ToolCallList entries={toolCalls} />
                  : <ToolTimelineList entries={toolCalls} />
              )}
              {showSynthTools && (
                <ToolTimelineList entries={synthCalls} />
              )}
              {(showRealTools || showSynthTools) && thinking && streaming && (
                <ThinkingIndicator
                  phase={statusPhase}
                  detail={statusDetail}
                  agent={agent}
                  elapsed={elapsedLabel}
                />
              )}
              <Bubble
                role={m.role}
                agent={agent}
                agentDisplayName={agentDisplayName}
                content={stripActionMarkers(m.content)}
                attachments={m.attachments}
                at={m.at}
                streaming={streaming && isLastAssistant}
              />
              {/* Runtime indicator — answers "did Gemini really run, or did
                  the bridge fall back?". Only renders for assistant
                  messages that finished streaming (so the operator
                  doesn't see "via gemini" flicker before the response
                  actually lands) AND that have content (skip empty
                  placeholders that were cleared by an error). */}
              {m.role === "assistant" &&
                m.runtime &&
                m.content.trim().length > 0 &&
                !(streaming && isLastAssistant) && (
                  <div className="text-[10px] text-fg-dim font-mono mt-1 ml-2 inline-flex items-center gap-1.5">
                    <span>via {m.runtime.label}</span>
                    {m.runtime.detail && (
                      <>
                        <span>·</span>
                        <span>{m.runtime.detail}</span>
                      </>
                    )}
                  </div>
                )}
            </div>
          );
        })}
        {thinking && streaming && toolCalls.length === 0 && synthCalls.length === 0 && (
          <ThinkingIndicator
            phase={statusPhase}
            detail={statusDetail}
            agent={agent}
            elapsed={elapsedLabel}
          />
        )}
        {toolReads.length > 0 && (
          <ToolReadList
            entries={toolReads}
            expanded={expandedReads}
            onToggle={(i) => {
              setExpandedReads((prev) => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              });
            }}
          />
        )}
        {toolRuns.length > 0 && (
          <ToolRunList
            entries={toolRuns}
            expanded={expandedRuns}
            onToggle={(i) => {
              setExpandedRuns((prev) => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              });
            }}
          />
        )}
        {cloudResults.length > 0 && (
          <div className="ml-9 space-y-1.5 border-l border-bg-border pl-3 mt-1">
            {cloudResults.map((r) => (
              <div
                key={r.uid}
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs font-mono ${
                  r.ok
                    ? "border-accent/40 bg-accent/5 text-accent"
                    : "border-status-warm/40 bg-status-warm/10 text-status-warm"
                }`}
                title={r.ok ? "cloud tool ran successfully" : "cloud tool failed"}
              >
                <Database className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-bold uppercase tracking-wider text-[10px]">
                      {r.ok ? "looked up" : "lookup failed"}
                    </span>
                    <span className="text-fg-muted">{r.name}</span>
                  </div>
                  <div className="font-sans mt-0.5 text-fg break-words">
                    {r.summary || r.error || "(no summary)"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="space-y-1.5">
            {actions.filter((a) => !a.dismissed).map((a) => {
              const verifyOn = process.env.NEXT_PUBLIC_VERIFY_ACTIONS !== "false";
              const needsAck = verifyOn && a.ok; // mutating + applied -> needs ack
              return (
                <div
                  key={a.uid}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs font-mono ${
                    a.ok
                      ? needsAck
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-status-engaged/40 bg-status-engaged/10 text-status-engaged"
                      : "border-status-warm/40 bg-status-warm/10 text-status-warm"
                  }`}
                >
                  <Check className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${a.ok ? "" : "hidden"}`} />
                  <AlertCircle className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${a.ok ? "hidden" : ""}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-bold uppercase tracking-wider text-[10px]">
                        {a.ok ? (needsAck ? "applied — verify" : "applied") : "rejected"}
                      </span>
                      <span className="text-fg-muted">{a.type}</span>
                    </div>
                    <div className="font-sans mt-0.5 text-fg break-words">
                      {a.summary || a.error || "(no detail)"}
                    </div>
                  </div>
                  {needsAck && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Link
                        href="/runs"
                        className="text-[10px] uppercase tracking-wider underline decoration-accent/40 hover:decoration-accent"
                        title="See full mutation history"
                      >
                        history
                      </Link>
                      <button
                        type="button"
                        onClick={() =>
                          setActions((prev) =>
                            prev.map((x) =>
                              x.uid === a.uid ? { ...x, dismissed: true } : x
                            )
                          )
                        }
                        className="px-2 py-0.5 rounded border border-accent/40 hover:bg-accent/20 text-[10px] uppercase tracking-wider"
                        title="Acknowledge — dismiss this verification pill"
                      >
                        got it
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1 min-w-0 flex-1">
              {errorCode === "key_decrypt_failed" ? (
                <>
                  <div className="font-bold">Your saved AI key needs a refresh.</div>
                  <div className="text-xs text-fg-muted font-sans">
                    The encryption envelope on your stored provider key has changed since you last saved it, so it can no longer be decrypted. Open{" "}
                    <Link href="/settings#providers" className="text-accent underline">
                      Settings → AI setup
                    </Link>{" "}
                    and click <strong>Replace key</strong> on the affected provider — paste the same value, save, and you&apos;re back. Takes 30 seconds.
                  </div>
                </>
              ) : errorCode === "cli_not_found" ? (
                <>
                  <div className="font-bold">The local CLI for this agent isn&apos;t installed.</div>
                  <div className="text-xs text-fg-muted font-sans whitespace-pre-wrap">{error}</div>
                  <div className="text-xs text-fg-muted font-sans">
                    Either install it (the message above tells you how) or use the Retry button below to switch to API-key mode.
                  </div>
                </>
              ) : errorCode === "cli_auth_required" ? (
                <>
                  <div className="font-bold">The CLI needs to sign in first.</div>
                  <div className="text-xs text-fg-muted font-sans whitespace-pre-wrap">{error}</div>
                  <div className="text-xs text-fg-muted font-sans">
                    Open Terminal and run the command shown above, then click Retry.
                  </div>
                </>
              ) : errorCode === "cli_outdated" ? (
                <>
                  <div className="font-bold">Your CLI is too old for this build.</div>
                  <div className="text-xs text-fg-muted font-sans whitespace-pre-wrap">{error}</div>
                </>
              ) : errorCode === "cli_empty_output" ? (
                <>
                  <div className="font-bold">The CLI ran but returned nothing.</div>
                  <div className="text-xs text-fg-muted font-sans whitespace-pre-wrap">{error}</div>
                  <div className="text-xs text-fg-muted font-sans">
                    Usually a quota or auth issue. Try Retry on API-key mode below, or check the CLI in Terminal.
                  </div>
                </>
              ) : errorCode === "cli_timeout" ? (
                <>
                  <div className="font-bold">The CLI timed out.</div>
                  <div className="text-xs text-fg-muted font-sans">
                    The bridge gave up waiting (6h ceiling). Check the bridge logs for a stuck subprocess, or retry on API-key mode which streams.
                  </div>
                </>
              ) : errorCode === "cli_nonzero_exit" ? (
                <>
                  <div className="font-bold">The CLI exited with an error.</div>
                  <div className="text-xs text-fg-muted font-sans whitespace-pre-wrap">{error}</div>
                </>
              ) : error.startsWith("provider_temporarily_unavailable") ? (
                <>
                  <div className="font-bold">Provider had a hiccup.</div>
                  <div className="text-xs text-fg-muted font-sans">
                    The chat retried 3 times and the upstream LLM is still unhappy. Usually clears in a minute. Try again, or switch model in <Link href="/settings#agents" className="text-accent underline">Settings</Link>.
                  </div>
                </>
              ) : (
                <div className="font-mono break-words whitespace-pre-wrap text-[11px] leading-relaxed">{error}</div>
              )}
              {error === "admin_no_platform_key" && (
                <div className="text-xs text-fg-muted font-sans">
                  Admin chat needs a platform key. Two ways: (1) run{" "}
                  <code className="bg-bg-elev px-1 py-0.5 rounded text-accent">bravo bridge seed-keys</code>{" "}
                  on your machine to push your local Anthropic / OpenAI / OpenRouter key into the dashboard, or (2) add{" "}
                  <code className="bg-bg-elev px-1 py-0.5 rounded text-accent">PLATFORM_DEFAULT_OPENROUTER_API_KEY</code>{" "}
                  in Vercel env vars.
                </div>
              )}
              {error === "agent_not_configured" && (
                <div className="text-xs text-fg-muted font-sans">
                  No provider key on file. Open{" "}
                  <Link href="/settings#providers" className="text-accent underline">
                    Settings → AI provider accounts
                  </Link>{" "}
                  and click Connect — it applies to every agent in one shot.
                </div>
              )}
              {error === "no_api_key" && (
                <div className="text-xs text-fg-muted font-sans">
                  This agent&apos;s provider row exists but has no key. Open{" "}
                  <Link href="/settings#providers" className="text-accent underline">
                    Settings → AI provider accounts
                  </Link>{" "}
                  and Connect (or Replace key) for the matching provider.
                </div>
              )}
              {error === "agent_disabled" && (
                <div className="text-xs text-fg-muted font-sans">
                  This agent is disabled. Open{" "}
                  <Link href="/settings#agents" className="text-accent underline">
                    Settings → Agents
                  </Link>{" "}
                  and flip its enabled toggle.
                </div>
              )}
              {error === "rate_limited" && (
                <div className="text-xs text-fg-muted font-sans">
                  Too many messages too fast. Wait ~15 seconds and try again.
                </div>
              )}
              {/* One-click recovery: if a route failed (CLI or cloud), offer
                  to re-send the same message on the OTHER route. The retry
                  pops the trailing user message from history before calling
                  submitText so the chat doesn't double-print "yo wsp" once
                  the assistant replies.

                  Phase 3 — the picker now has 4 modes (auto / cli /
                  cloud_only / cloud_bridge_tools). The retry button picks
                  the most-likely-working alternate within the OTHER bucket:
                    - cli failed   → cloud_bridge_tools (if bridge online),
                                      else cloud_only
                    - cloud failed → cli (if bridge ready) */}
              {(() => {
                if (!lastFailedMode || streaming) return null;
                // Map the collapsed bucket to a concrete ChatMode the
                // retry will route through. cloud_bridge_tools is the
                // preferred "other cloud" because it has the broadest
                // tool surface; fall back to cloud_only when the bridge
                // isn't reachable.
                const otherMode: ChatMode =
                  lastFailedMode === "cli"
                    ? (bridgeOnline === true ? "cloud_bridge_tools" : "cloud_only")
                    : "cli";
                const otherReady =
                  otherMode === "cli"
                    ? bridgeReady
                    : (cloudReady || isAdmin);
                if (!otherReady) return null;
                // Last user message — what we'll re-send. If history has no
                // user message somehow, the button shouldn't appear.
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                if (!lastUser) return null;
                const otherLabel =
                  otherMode === "cli"
                    ? "CLI (local bridge)"
                    : otherMode === "cloud_only"
                      ? "API key · cloud tools only"
                      : "API key + local tools";
                return (
                  <button
                    type="button"
                    onClick={() => {
                      const text = lastUser.content;
                      setLastFailedMode(null);
                      setError(null);
    setErrorCode(null);
                      // Pop the trailing user message so submitText doesn't
                      // print it twice when it re-pushes its own copy.
                      setMessages((m) => {
                        const last = m[m.length - 1];
                        if (last && last.role === "user" && last.content === text) {
                          return m.slice(0, -1);
                        }
                        return m;
                      });
                      // Update the persisted picker too so subsequent turns
                      // default to the working path.
                      setChatMode(otherMode);
                      void submitText(text, otherMode, lastUser.attachments || []);
                    }}
                    className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-accent/40 bg-accent/10 hover:bg-accent/20 text-accent text-xs font-bold transition-colors"
                  >
                    Retry on {otherLabel} →
                  </button>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {awayFromBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute right-6 bottom-24 z-20 rounded-full border border-accent/40 bg-bg-panel/90 backdrop-blur px-3 py-1.5 text-[11px] font-mono text-accent hover:bg-accent/10 transition-colors flex items-center gap-1 shadow-[0_4px_16px_-4px_rgba(0,212,255,0.4)]"
        >
          <ArrowDown className="w-3 h-3" /> jump to latest
        </button>
      )}

      {/* Composer */}
      <form
        data-chat-composer
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        /* Composer padding: tighter side padding on mobile (px-3) so the
           textarea + send button + tool-buttons row have more horizontal
           room. Bottom padding bumps slightly (pb-5) so the send button
           clears the iOS home-indicator safe area on phones. */
        className="border-t border-bg-border px-3 md:px-5 py-3 pb-5 md:py-4 relative z-10 bg-bg-panel/40 backdrop-blur space-y-2"
      >
        {(pendingAttachments.length > 0 || attachmentError) && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {pendingAttachments.map((att) => (
              <span
                key={att.id}
                className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-accent"
                title={att.filename}
              >
                <FileText className="h-3 w-3" />
                <span className="max-w-[18rem] truncate">{att.filename}</span>
                <span className="text-fg-dim">{formatBytes(att.size_bytes)}</span>
                <button
                  type="button"
                  onClick={() => removePendingAttachment(att.id)}
                  className="rounded p-0.5 hover:bg-accent/15"
                  title="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {attachmentError && (
              <span className="inline-flex items-center gap-1 rounded-md border border-status-warm/30 bg-status-warm/10 px-2 py-1 text-status-warm">
                <AlertCircle className="h-3 w-3" />
                {attachmentError}
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2 relative">
          {/* Slash-command autocomplete — anchored above the textarea
              via the parent's relative positioning. Renders only when
              the input is in slash-trigger shape. The arg menu and
              command menu are mutually exclusive triggers so we can
              short-circuit on the arg-open branch. */}
          {slashArgOpen && slashArgCommand && (
            <div className="absolute left-[3.5rem] right-0 bottom-0 pointer-events-none">
              <div className="pointer-events-auto">
                <SlashArgMenu
                  query={slashArgQuery}
                  candidates={argCandidates}
                  command={slashArgCommand}
                  selectedIndex={slashArgSelectedIdx}
                  onSelect={insertSlashArg}
                />
              </div>
            </div>
          )}
          {!slashArgOpen && slashMenuOpen && (
            <div className="absolute left-[3.5rem] right-0 bottom-0 pointer-events-none">
              <div className="pointer-events-auto">
                <SlashCommandMenu
                  query={slashQuery}
                  selectedIndex={slashSelectedIdx}
                  onSelect={insertSlashCommand}
                />
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => attachFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={!ready || streaming || uploadingAttachments}
            onClick={() => fileInputRef.current?.click()}
            className="h-11 w-11 inline-flex items-center justify-center rounded-lg border border-bg-border bg-bg-elev hover:border-accent/50 hover:text-accent disabled:opacity-50 transition-colors"
            title="Attach files"
          >
            {uploadingAttachments ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          </button>
          {/* Plan / Execute segmented toggle. Two-state switch the operator
              flips in one click — no slash command required. Mirrors the
              /plan and /build commands; either path lands in the same
              planMode state and triggers the same system pill. Lives next
              to the attach button so the affordance is always visible. */}
          <div
            role="group"
            aria-label="Agent mode"
            className="inline-flex items-stretch rounded-lg border border-bg-border bg-bg-elev overflow-hidden h-11"
          >
            <button
              type="button"
              disabled={streaming}
              onClick={() => {
                if (planMode === "plan") return;
                setPlanMode("plan");
                setMessages((m) => [
                  ...m,
                  {
                    role: "system",
                    content:
                      "Plan mode active — agent is restricted to read-only tools. Hit Execute when you're ready to run.",
                    at: Date.now(),
                  },
                ]);
              }}
              className={`px-2 md:px-3 text-[11px] uppercase tracking-wider font-bold transition-colors ${
                planMode === "plan"
                  ? "bg-status-warm/15 text-status-warm border-r border-status-warm/30"
                  : "text-fg-dim hover:text-fg-muted border-r border-bg-border"
              } disabled:opacity-50`}
              title="Plan mode: agent reads, searches, and proposes a plan but never writes or executes. Use this when you want to think before acting."
            >
              Plan
            </button>
            <button
              type="button"
              disabled={streaming}
              onClick={() => {
                if (planMode === "build") return;
                setPlanMode("build");
                setMessages((m) => [
                  ...m,
                  {
                    role: "system",
                    content:
                      "Execute mode active — full agent capabilities restored.",
                    at: Date.now(),
                  },
                ]);
              }}
              className={`px-2 md:px-3 text-[11px] uppercase tracking-wider font-bold transition-colors ${
                planMode === "build"
                  ? "bg-accent/15 text-accent"
                  : "text-fg-dim hover:text-fg-muted"
              } disabled:opacity-50`}
              title="Execute mode: agent has full tool access — reads, writes, runs scripts, sends messages. Permissions are auto-approved for this dashboard chat."
            >
              Execute
            </button>
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={composerPlaceholder}
            disabled={!ready || streaming}
            rows={1}
            /* text-base on mobile prevents iOS Safari's auto-zoom on
               focus (it zooms whenever an input's font-size is <16px).
               Stays text-sm on desktop where the smaller font matches
               surrounding UI density. */
            className="flex-1 bg-bg-elev border border-bg-border rounded-lg px-3.5 py-3 md:py-2.5 text-base md:text-sm text-fg placeholder-fg-dim focus:outline-none focus:border-accent disabled:opacity-50 resize-none max-h-32"
            style={{ minHeight: "3rem" }}
          />
          {streaming ? (
            // Stop button — fires AbortController.abort() on the active
            // stream so the operator can interrupt a runaway model
            // before it eats their entire context budget. The catch
            // block above translates AbortError into a "Stopped."
            // system pill so the red error banner doesn't flash.
            <button
              type="button"
              onClick={() => activeStreamControllerRef.current?.abort()}
              className="btn-send !bg-status-warm/15 !text-status-warm !border !border-status-warm/40 hover:!bg-status-warm/25"
              title="Stop the agent mid-stream. Whatever streamed before this click stays in the conversation."
            >
              <Square className="w-4 h-4 fill-current" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!ready || uploadingAttachments || (!input.trim() && pendingAttachments.length === 0)}
              className="btn-send"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function EmptyTranscript({
  ready,
  agent,
  agentDisplayName,
  configsLoaded,
  isAdmin,
  currentProvider,
  onSuggestion,
}: {
  ready: boolean;
  agent: string;
  /** Lookup that returns the operator's per-user nickname for an agent
   *  (Solara → "Ada") or the canonical label when no override exists.
   *  Plumbed through from the chat widget so EmptyTranscript doesn't
   *  have to call useAgentDisplayNames itself (would double-fetch). */
  agentDisplayName: (agentKey: string) => string;
  configsLoaded: boolean;
  isAdmin: boolean;
  currentProvider: string | null;
  onSuggestion: (text: string) => void;
}) {
  if (!configsLoaded) {
    return (
      <div className="flex items-center gap-2 text-fg-dim text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> loading agent config…
      </div>
    );
  }
  if (!ready) {
    // Ollama models need the desktop bridge running (they're local-only,
    // not reachable from Vercel). All other providers work in pure cloud
    // mode once a key is saved.
    const needsDesktop = currentProvider === "ollama";
    const agentLabel = agentDisplayName(agent).toUpperCase();
    return (
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-5 text-sm space-y-3">
        <div className="flex items-center gap-2 text-accent font-bold uppercase tracking-[0.14em] text-xs">
          <Sparkles className="w-4 h-4" /> Set up {agentLabel}
        </div>
        <p className="text-fg">
          {needsDesktop
            ? `${agentLabel} needs OASIS Desktop running before it can use local files, tools, or local models.`
            : `${agentLabel} needs a model + API key before it can chat. The easiest path is OpenRouter - one key gets you Claude, GPT, and Gemini.`}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {!needsDesktop && (
            <a
              href="https://openrouter.ai/sign-up"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-xs"
            >
              Get OpenRouter key
            </a>
          )}
          <Link href="/settings#agents" className="btn-secondary text-xs">
            Open Settings
          </Link>
        </div>
      </div>
    );
  }
  const suggestions = _suggestionsFor(agent);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-bg-border bg-bg-elev/50 p-5 text-sm space-y-2">
        <div className="text-accent font-bold uppercase tracking-[0.14em] text-xs flex items-center gap-2">
          <span className="agent-pill-dot" />
          Ready
        </div>
        <p className="text-fg-muted">
          {isAdmin
            ? `Talking to ${agentDisplayName(agent).toUpperCase()} via the platform default key.`
            : `${agentDisplayName(agent).toUpperCase()} is configured and ready.`} Ask anything — strategy, drafting, debugging, ops.
        </p>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-fg-muted mb-2">
          Try one of these
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              className="text-left rounded-lg border border-bg-border bg-bg-elev/40 hover:border-accent/40 hover:bg-accent/5 transition-all px-3 py-2.5 text-xs text-fg leading-snug"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bubble({
  role,
  agent,
  agentDisplayName,
  content,
  attachments,
  at,
  streaming,
}: {
  role: Role;
  agent: string;
  /** Operator's per-user agent name lookup (Solara → "Ada"). Plumbed
   *  through from the chat widget so download/export headers reflect
   *  the rename. Falls back to canonical labels via the hook. */
  agentDisplayName: (agentKey: string) => string;
  content: string;
  attachments?: ChatAttachmentSummary[];
  at: number;
  streaming: boolean;
}) {
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Show export controls only on completed assistant messages — mid-stream
  // partial markdown would download as a half-doc, which is just confusing.
  const showExports = !isUser && !streaming && content.trim().length > 0;

  return (
    <div className={`group flex items-start gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && <AgentAvatar agent={agent} />}
      <div className={`max-w-[88%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        <div
          /* text-[15px] on mobile is just enough to be comfortably
             readable on a phone while staying tighter than text-base.
             Desktop drops back to text-sm to match the surrounding UI
             density. */
          className={`rounded-2xl px-4 py-3 text-[15px] md:text-sm leading-relaxed ${
            isUser ? "bubble-user" : `bubble-assistant ${streaming ? "streaming" : ""}`
          }`}
        >
          {content ? (
            <FormattedContent content={content} />
          ) : streaming ? (
            <div className="typing-dots"><span /><span /><span /></div>
          ) : null}
          {attachments && attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((att) => (
                <span
                  key={att.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-bg-border/70 bg-bg-deep/30 px-2 py-1 text-[11px] text-fg-muted"
                  title={att.filename}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate">{att.filename}</span>
                  <span className="text-fg-dim">{formatBytes(att.size_bytes)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Meta row: timestamp + copy/export. .hover-reveal keeps it
            visible at low opacity on touch (so copy/export are
            tappable) and hides it on desktop until the bubble's
            group-hover fires. See globals.css. */}
        <div className="hover-reveal flex items-center gap-2 px-1 text-[10px] text-fg-dim transition-opacity">
          <span className="font-mono">{_relTime(at)}</span>
          {!isUser && content && (
            <button
              type="button"
              onClick={handleCopy}
              className="hover:text-accent transition-colors inline-flex items-center gap-0.5"
              title="Copy reply"
            >
              {copied ? <Check className="w-3 h-3 text-status-engaged" /> : <Clipboard className="w-3 h-3" />}
              {copied ? "copied" : "copy"}
            </button>
          )}
          {showExports && (
            <MessageDownloadMenu content={content} agent={agent} agentDisplayLabel={agentDisplayName(agent)} />
          )}
        </div>
      </div>
      {isUser && <UserAvatar />}
    </div>
  );
}

function AgentAvatar({ agent }: { agent: string }) {
  const info = getAgentInfo(agent);
  const initial = info.label.slice(0, 1).toUpperCase();
  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black tracking-tight border bg-bg-elev/80 ${info.textClass}`}
      style={{ borderColor: "currentColor" }}
      title={info.label}
    >
      {initial}
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black tracking-tight border border-bg-border bg-bg-elev/80 text-fg-muted">
      You
    </div>
  );
}

function ToolReadList({
  entries,
  expanded,
  onToggle,
}: {
  entries: Array<{ path: string; body?: string }>;
  expanded: Set<number>;
  onToggle: (i: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      {entries.map((p, i) => {
        const isOpen = expanded.has(i);
        const canExpand = !!p.body;
        return (
          <div key={i} className="text-[11px]">
            <button
              type="button"
              disabled={!canExpand}
              onClick={() => canExpand && onToggle(i)}
              className={`inline-flex items-center gap-1 font-mono px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-accent ${
                canExpand ? "hover:bg-accent/20 cursor-pointer" : "cursor-default"
              }`}
              title={canExpand ? "Click to expand file body" : "Agent read this file"}
            >
              {canExpand && <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />}
              read · {p.path}
            </button>
            {isOpen && p.body && (
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-accent/20 bg-bg-deep/60 p-2 text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                <code>{p.body}</code>
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolRunList({
  entries,
  expanded,
  onToggle,
}: {
  entries: Array<{
    script: string;
    args: string[];
    confirm: boolean;
    output?: string;
    elapsed_s?: number;
  }>;
  expanded: Set<number>;
  onToggle: (i: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      {entries.map((r, i) => {
        const isOpen = expanded.has(i);
        const canExpand = !!r.output;
        const isRunning = !r.output && (r.elapsed_s ?? 0) > 0;
        const tone = isRunning
          ? "bg-accent/10 border-accent/30 text-accent animate-pulse-slow"
          : r.confirm
            ? "bg-status-engaged/15 border-status-engaged/30 text-status-engaged"
            : "bg-status-warm/10 border-status-warm/30 text-status-warm";
        return (
          <div key={i} className="text-[11px]">
            <button
              type="button"
              disabled={!canExpand}
              onClick={() => canExpand && onToggle(i)}
              className={`inline-flex items-center gap-1 font-mono px-2 py-0.5 rounded-full border ${tone} ${
                canExpand ? "hover:opacity-90 cursor-pointer" : "cursor-default"
              }`}
              title={
                isRunning
                  ? `Script still running… (${r.elapsed_s}s elapsed)`
                  : r.confirm
                    ? "Agent ran this allowlisted script"
                    : "Agent attempted a mutating script without confirm — bounced for safety"
              }
            >
              {canExpand && <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />}
              {isRunning ? "running" : r.confirm ? "ran" : "blocked"} · {r.script}
              {r.args.length > 0 ? ` ${r.args.slice(0, 4).join(" ")}${r.args.length > 4 ? "…" : ""}` : ""}
              {isRunning ? ` · ${r.elapsed_s}s` : ""}
            </button>
            {isOpen && r.output && (
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-bg-border bg-bg-deep/60 p-2 text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                <code>{r.output}</code>
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Unified pill list for the Claude Code subprocess path. Each entry is
 * one tool invocation (Read, Edit, Write, Bash, Glob, Grep, WebFetch,
 * MCP server call, etc). Output streams in via tool_result correlated
 * by tool_use_id. Click to expand the body inline.
 */
function ToolCallList({
  entries,
}: {
  entries: Array<{
    id: string;
    kind: string;
    label: string;
    detail?: string;
    output?: string;
    error?: boolean;
  }>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const tone = (e: { error?: boolean; output?: string }) =>
    e.error
      ? "bg-status-warm/10 border-status-warm/30 text-status-warm"
      : e.output
        ? "bg-accent/10 border-accent/30 text-accent"
        : "bg-bg-elev/40 border-bg-border text-fg-muted animate-pulse-slow";
  return (
    <div className="space-y-1.5">
      {entries.map((e) => {
        const isOpen = expanded.has(e.id);
        const canExpand = !!e.output;
        return (
          <div key={e.id} className="text-[11px]">
            <button
              type="button"
              disabled={!canExpand}
              onClick={() => canExpand && toggle(e.id)}
              className={`inline-flex items-center gap-1 font-mono px-2 py-0.5 rounded-full border ${tone(e)} ${
                canExpand ? "hover:opacity-90 cursor-pointer" : "cursor-default"
              }`}
              title={e.error ? "tool returned an error" : canExpand ? "click to expand output" : "running…"}
            >
              {canExpand && (
                <ChevronRight
                  className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
                />
              )}
              <span className="font-bold">{e.label}</span>
              {e.detail && (
                <span className="text-fg-dim truncate max-w-[28ch]">· {e.detail}</span>
              )}
            </button>
            {isOpen && e.output && (
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-bg-border bg-bg-deep/60 p-2 text-[10px] font-mono text-fg-muted whitespace-pre-wrap">
                <code>{e.output}</code>
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}


/**
 * Pulsing dots + status copy with elapsed time. Used both above the in-
 * progress assistant bubble (when tools are streaming) and below the user
 * message (before the first tool fires). Single component to keep the
 * status copy in one place.
 */
/**
 * Narration ticker — when no real tool events are firing (e.g., the
 * cloud /api/chat path is just thinking, or the bridge is between
 * tool calls), the UI used to go silent for 30+ seconds. This cycles
 * through plausible activity descriptions based on elapsed seconds so
 * CC sees motion and isn't left wondering if the chat hung.
 *
 * The phases are intentionally generic — they describe what an LLM is
 * actually doing under the hood (loading context, reasoning, drafting)
 * rather than promising specific tool calls that may not happen.
 */
const NARRATION_PHASES: Array<{ at: number; label: string }> = [
  { at: 0, label: "thinking" },
  { at: 6, label: "loading context" },
  { at: 12, label: "considering tools" },
  { at: 20, label: "reasoning through this" },
  { at: 30, label: "drafting response" },
  { at: 45, label: "almost there" },
  { at: 60, label: "still working — long task" },
];

function _narrationFor(elapsedSec: number): string {
  let label = NARRATION_PHASES[0].label;
  for (const p of NARRATION_PHASES) {
    if (elapsedSec >= p.at) label = p.label;
  }
  return label;
}

function ThinkingIndicator({
  phase,
  detail,
  agent,
  elapsed,
}: {
  phase: "spawning" | "thinking" | "tool" | "warm_resume" | null;
  detail: string;
  agent: string;
  elapsed: string;
}) {
  // Convert "M:SS" elapsed back to seconds for narration phase lookup.
  const elapsedSec = (() => {
    const m = elapsed.match(/^(\d+):(\d+)$/);
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
  })();
  const narration = _narrationFor(elapsedSec);
  const label =
    phase === "spawning"
      ? `starting ${agent.toLowerCase()}${detail ? ` in ${detail}` : ""}…`
      : phase === "warm_resume"
        ? `${agent.toLowerCase()} resuming (warm)…`
        : phase === "tool"
          ? `running ${detail || "tool"}…`
          : `${narration}…`;
  return (
    <div className="flex items-center gap-2 text-fg-dim text-xs ml-9">
      <span className="typing-dots"><span /><span /><span /></span>
      <span>
        {label}
        {elapsed && (
          <span className="ml-1.5 font-mono text-fg-dim/70">({elapsed})</span>
        )}
      </span>
    </div>
  );
}

function _relTime(at: number): string {
  if (!at) return "";
  const diff = Date.now() - at;
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lightweight markdown-ish formatter — handles fenced code blocks and inline
 * code. Anything more advanced is intentionally deferred (no link rewriting,
 * no XSS surface). Plaintext + code + line breaks.
 */
/**
 * FormattedContent — renders the assistant's markdown using the SAME
 * renderer as the export pipeline (lib/markdown.ts). What you see in
 * the chat bubble is what you get when you click Download → MD/HTML/PDF.
 *
 * Security: lib/markdown.mdToHtml escapes the entire input before
 * applying any markdown patterns, then filters link hrefs against
 * dangerous URL schemes. The output is safe to render via
 * dangerouslySetInnerHTML — no path lets raw HTML through. See the
 * security comment in lib/markdown.ts before changing.
 *
 * Previously the chat bubble only handled fenced code blocks + inline
 * code, displaying `**bold**` / `# heading` as literal text. CC's
 * download was richer than the chat — confusing UX. They now match.
 */
function FormattedContent({ content }: { content: string }) {
  const html = mdToHtml(content);
  return (
    <div
      className="markdown-bubble whitespace-normal"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Strip <dashboard-action ...> markers from the displayed text. The agent
 * emits these so the server can apply mutations; users don't want to see
 * the raw JSON tags in the bubble. The applied/rejected pills below the
 * transcript are the human-facing surface for these.
 */
function stripActionMarkers(text: string): string {
  return text
    .replace(/<dashboard-action\s+type=["'][a-z_]+["']\s*>[\s\S]*?<\/dashboard-action>/gi, "")
    // Cloud-tool markers are also stripped from display — results render
    // as separate inline pills (cloud_tool_result SSE events).
    .replace(/<cloud-tool\s+name=["'][a-z0-9_]+["']\s*>[\s\S]*?<\/cloud-tool>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type FetchWithTimeoutInit = RequestInit & { timeoutMs?: number };

async function fetchWithTimeout(input: RequestInfo | URL, init: FetchWithTimeoutInit = {}): Promise<Response> {
  const { timeoutMs = CHAT_FETCH_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  let signalListener: (() => void) | null = null;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signalListener = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", signalListener, { once: true });
  }
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && !(signal?.aborted)) {
      throw new Error(`request_timeout_${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
    if (signal && signalListener) signal.removeEventListener("abort", signalListener);
  }
}

async function readAttachmentExcerpt(file: File, mimeType: string): Promise<{
  parser: "csv_text" | "plain_text" | "metadata_only";
  text: string | null;
  truncated: boolean;
}> {
  if (!isTextLikeAttachment(file.name, mimeType)) {
    return { parser: "metadata_only", text: null, truncated: false };
  }
  const sample = file.slice(0, TEXT_ATTACHMENT_READ_BYTES);
  const decoded = (await sample.text()).replace(/\u0000/g, "").trim();
  if (!decoded) return { parser: "metadata_only", text: null, truncated: false };
  const text =
    decoded.length > MAX_ATTACHMENT_EXCERPT_CHARS
      ? decoded.slice(0, MAX_ATTACHMENT_EXCERPT_CHARS)
      : decoded;
  const lowerName = file.name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return {
    parser: lowerName.endsWith(".csv") || lowerMime.includes("csv") ? "csv_text" : "plain_text",
    text,
    truncated: file.size > sample.size || decoded.length > MAX_ATTACHMENT_EXCERPT_CHARS,
  };
}

function isTextLikeAttachment(filename: string, mimeType: string): boolean {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return (
    lowerMime.startsWith("text/") ||
    lowerMime.includes("json") ||
    lowerMime.includes("xml") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".xml")
  );
}

function normalizeAttachmentSummary(value: unknown): ChatAttachmentSummary | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = getString(row.id);
  const filename = getString(row.filename);
  const sizeBytes = typeof row.size_bytes === "number" ? row.size_bytes : Number(row.size_bytes);
  if (!id || !filename || !Number.isFinite(sizeBytes)) return null;
  return {
    id,
    filename,
    mime_type: getString(row.mime_type),
    size_bytes: Math.max(0, Math.trunc(sizeBytes)),
    parser: getString(row.parser) || "metadata_only",
    text_excerpt: getString(row.text_excerpt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function safeReadJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}
