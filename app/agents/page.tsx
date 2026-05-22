import { Card, PageHeader, EmptyState, Tag } from "@/components/Card";
import ChatWidget from "@/components/ChatWidget";
import { timeAgo, truncate } from "@/lib/fmt";
import { formatEventType, formatPublisher } from "@/lib/event-bus-display";
import { agentStates, recentEvents, getActiveProfile, integrationsHealth, aiServicesWithKey } from "@/lib/queries";
import { FAMILY_AGENT_KEYS, getAgentInfo } from "@/lib/agents";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { catalogFor } from "@/lib/agent-catalog";
import { getAgentStats } from "@/lib/agent-stats";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { Clock, Cog, Download, Workflow } from "lucide-react";
import Link from "next/link";

// Returns true if the tenant has zero non-revoked bridge pairings —
// used to gate the "install bridge" banner above the chat. Suppresses
// for operators who have ever paired (don't nag people who deliberately
// turned the bridge off).
async function _tenantHasNoBridge(tenantId: string | null): Promise<boolean> {
  if (!tenantId) return true;
  try {
    const db = getServiceSupabase();
    const { data } = await db
      .from("bridge_pairings")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("revoked_at", null)
      .limit(1);
    return !data || data.length === 0;
  } catch (err) {
    // Failed to check — don't show banner on transient DB error. Logged
    // so a persistently-broken bridge_pairings query is surfaced in Vercel
    // logs instead of silently suppressing the onboarding nudge.
    console.error("[agents.tenant_has_no_bridge]", err);
    return false;
  }
}

export const dynamic = "force-dynamic";

// An agent is "live" if its state_snapshot ticked in the last 15 minutes
const FRESHNESS_MS = 15 * 60 * 1000;

export default async function AgentsPage() {
  const profile = await getActiveProfile();
  const user = await getSessionUser();
  const isAdmin = isOperatorEmail(user?.email);

  // Resolve manifest BEFORE the parallel fetch so we can scope
  // agentStates() by the tenant's enabled agents. agent_state_snapshot
  // has no tenant_id column yet — see queries.ts:agentStates() docstring.
  const manifestForAgents = await getTenantManifestForUser(profile?.tenant_id ?? null);
  const manifestEnabledSlugs = (manifestForAgents?.agents || [])
    .filter((a) => a.enabled)
    .map((a) => a.slug.toLowerCase());

  const [states, events, integrations, stats, noBridge, aiServices] = await Promise.all([
    agentStates(manifestEnabledSlugs),
    // sinceDays: 0 — same fix as /operations. Default 7-day window left
    // the Event Bus card looking empty when crons / inbound traffic had
    // been quiet for a week, even though the table had history.
    recentEvents(25, {
      sinceDays: 0,
      agentNames: manifestEnabledSlugs,
      isOperator: isAdmin,
    }),
    integrationsHealth(profile?.tenant_id || null),
    getAgentStats(profile?.primary_agent || "bravo"),
    _tenantHasNoBridge(profile?.tenant_id || null),
    aiServicesWithKey(profile?.tenant_id || null),
  ]);
  // No provider keys on file AND bridge offline AND non-operator. Operators
  // have the platform fallback so chat works without a per-agent key — they
  // don't need the nudge. Client tenants without either path can't chat
  // until they wire one up, so we surface a hard CTA above the chat.
  const noCloudProvider = aiServices.size === 0;
  const showProviderNudge = noCloudProvider && noBridge && !isAdmin;

  const familySet = new Set(FAMILY_AGENT_KEYS);
  // For the "Agent family" card below we still want the rich metadata from
  // AGENT_REGISTRY — so the enabled list intersects manifest.agents with the
  // family registry when both are populated, otherwise falls back gracefully.
  const enabledList = manifestEnabledSlugs.length > 0
    ? manifestEnabledSlugs
    : profile?.agents_enabled?.length
      ? profile.agents_enabled
      : FAMILY_AGENT_KEYS;
  const explicitTenantAgents = manifestEnabledSlugs.length > 0 || !!profile?.agents_enabled?.length;
  const enabled = enabledList.filter((k) => explicitTenantAgents || familySet.has(k));
  const byName = new Map(states.map((s) => [s.agent_name, s]));
  const integrationByName = new Map(integrations.map((i) => [i.service, i]));

  const rows = enabled.map((name) => {
    const state = byName.get(name) || null;
    // Fall back to integrations_health for agents that ping there instead of state_snapshot
    const intg = integrationByName.get(name) || null;
    const lastTickMs = state?.last_tick_at ? new Date(state.last_tick_at).getTime() : 0;
    const lastPingMs = intg?.last_ping_at ? new Date(intg.last_ping_at).getTime() : 0;
    const freshestMs = Math.max(lastTickMs, lastPingMs);
    const live = freshestMs > 0 && Date.now() - freshestMs < FRESHNESS_MS;
    return {
      name,
      info: getAgentInfo(name),
      state,
      intg,
      live,
      lastSignalAt: freshestMs ? new Date(freshestMs).toISOString() : null,
    };
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Agents"
        subtitle="Every agent wired to your Command Center, plus the live event bus tape."
        action={
          <Tag tone="accent">
            {rows.filter((r) => r.live).length} / {enabled.length} live
          </Tag>
        }
      />

      <section className="space-y-2">
        <header className="flex items-end justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-fg">Chat</h2>
            <div className="text-xs text-fg-muted mt-1">
              {isAdmin
                ? "Chat any agent. Two paths: (1) Local bridge — spawns the Claude Code CLI on your machine using your Claude subscription, full file/script access. (2) Cloud mode — uses the API key you saved per agent (OpenRouter / Anthropic / OpenAI / Gemini) to power the chat without a Claude subscription. Same persona either way; the bridge path can also write files. Clients run cloud mode by default."
                : "Talk to any agent in your family — set up your provider + key in Settings → Agents. The key powers the chat (no Claude Code subscription needed)."}
            </div>
            <div className="mt-2 rounded-md border border-bg-border bg-bg-elev/40 px-3 py-2 text-[11.5px] text-fg-muted max-w-3xl leading-relaxed">
              <span className="text-fg font-semibold">Workspace default vs. personal override:</span>{" "}
              {isAdmin
                ? "The keys you save in Settings → Agents are the workspace default — every employee on this tenant uses them. Each employee can also paste their OWN key under Settings → My Agents to route only their chat through their personal account."
                : "Settings → Agents is the workspace-wide config (admin-only). Your personal override lives in Settings → My Agents — paste your own key there and only your chat uses it."}
            </div>
          </div>
        </header>
        {/* Tenant has neither cloud provider keys nor a paired bridge — chat
            can't work at all. Hard CTA pointing to both onboarding paths. */}
        {showProviderNudge && (
          <div className="rounded-lg border border-status-warm/40 bg-status-warm/5 px-4 py-3 space-y-2">
            <div className="text-sm font-bold text-fg">
              Wire up an AI provider so your agents can think.
            </div>
            <div className="text-xs text-fg-muted leading-relaxed">
              Pick one (you can do both): connect a cloud provider key (works
              from anywhere) or install the local bridge (uses your Claude
              Code subscription, gives the agent file system access).
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link
                href="/settings#providers"
                className="btn-primary inline-flex items-center gap-1.5 text-xs"
              >
                Connect a provider →
              </Link>
              <Link
                href="/settings/devices/install"
                className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              >
                <Download className="w-3 h-3" />
                Install the bridge →
              </Link>
            </div>
          </div>
        )}
        {/* Bridge-not-installed nudge — shown when the operator already has
            cloud chat working (provider key OR operator fallback) but hasn't
            paired a bridge yet. Soft CTA, not blocking. */}
        {noBridge && !showProviderNudge && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-fg-muted">
              <span className="font-bold text-fg">Chat is running in cloud mode.</span>{" "}
              Install the Claude Code CLI bridge to power chat with your local subscription + file access.
            </div>
            <Link
              href="/settings/devices/install"
              className="btn-primary inline-flex items-center gap-1.5 text-xs shrink-0"
            >
              <Download className="w-3 h-3" />
              Install bridge
            </Link>
          </div>
        )}
        <ChatWidget
          agentKeys={manifestEnabledSlugs.length > 0 ? manifestEnabledSlugs : enabled}
          defaultAgent={
            manifestForAgents?.agents.find((a) => a.primary && a.enabled)?.slug ||
            profile?.primary_agent ||
            manifestEnabledSlugs[0] ||
            "bravo"
          }
          isAdmin={isAdmin}
          // Phase 1 of SunBiz CRM build — gate the 4-mode chat picker
          // behind the tenant's manifest flag. OASIS keeps it (operator
          // view); SunBiz / SUGA / future end-user tenants don't show
          // the dropdown.
          advancedPicker={manifestForAgents?.ui?.advanced_picker ?? false}
        />
      </section>

      <Card
        title="Your agent family"
        subtitle={`The autonomous workers running on your behalf. Primary: ${profile?.primary_agent || "—"}. Each tile shows what the agent does and what's running for it right now.`}
      >
        <div className="space-y-5">
          <div className="rounded-lg border border-bg-border bg-bg p-4 text-sm text-fg-muted leading-relaxed">
            <div className="text-fg font-medium mb-1">How to read each tile</div>
            Every agent has up to three kinds of automation running for you:{" "}
            <span className="text-fg">Scheduled tasks</span> (fire on a clock — e.g. 7am daily briefing),{" "}
            <span className="text-fg">Always-on processes</span> (running locally on your machine — e.g. the inbox listener),{" "}
            <span className="text-fg">Workflows</span> (event-triggered — e.g. lead opens email → drip step fires).
            <div className="mt-2 text-fg-dim text-[11px]">
              Repo stats: {stats.skills} skills · {stats.scripts} scripts · {stats.chat_tools} callable tools · {stats.brain_files} brain files · {stats.workflows} workflows
            </div>
          </div>
          {enabled.map((key) => {
            const info = getAgentInfo(key);
            const cat = catalogFor(key);
            // Match this agent to its live row so we can surface
            // status + last-signal alongside the description.
            const row = rows.find((r) => r.name === key);
            const total = cat.crons.length + cat.processes.length + cat.workflows.length;
            return (
              <div
                key={key}
                className="rounded-lg border border-bg-border bg-bg-elev p-4 space-y-3"
              >
                {/* Identity row — label, role, live indicator. Consolidates the
                    "Agent family" card's status pill into the same tile that
                    lists what the agent runs. One agent = one tile. */}
                <div className="flex items-start gap-3 flex-wrap">
                  <div
                    className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${
                      row?.live
                        ? "bg-status-engaged shadow-[0_0_6px_rgba(16,185,129,0.6)] animate-pulse-slow"
                        : row?.lastSignalAt
                          ? "bg-status-warm"
                          : "bg-fg-faint"
                    }`}
                    title={
                      row?.live
                        ? "Live — agent has pinged in the last 15 minutes."
                        : row?.lastSignalAt
                          ? `Idle — last signal ${timeAgo(row.lastSignalAt)}.`
                          : "Never seen — agent has not paired with this Command Center yet."
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-bold uppercase tracking-[0.14em] text-sm ${info.textClass}`}>
                        {info.label}
                      </span>
                      <span className="text-xs text-fg-muted">{info.tagline}</span>
                    </div>
                    {info.description && (
                      <p className="text-sm text-fg mt-2 leading-relaxed">
                        {info.description}
                      </p>
                    )}
                    {info.askMeAbout && (
                      <div className="text-[11px] text-fg-muted mt-2 italic leading-relaxed">
                        <span className="text-fg-dim not-italic uppercase tracking-wider text-[9px] font-bold">Ask me about: </span>
                        {info.askMeAbout}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-[10px] uppercase tracking-wider text-fg-dim shrink-0">
                    {row?.live ? (
                      <span className="text-status-engaged font-mono normal-case tracking-normal">
                        live · {row.state ? `tick ${row.state.tick_count}` : "ping"}
                      </span>
                    ) : row?.lastSignalAt ? (
                      <span className="text-status-warm normal-case tracking-normal">
                        idle · {timeAgo(row.lastSignalAt)}
                      </span>
                    ) : (
                      <span className="text-fg-dim normal-case tracking-normal">never seen</span>
                    )}
                    {total > 0 && <div className="mt-1">{total} highlighted</div>}
                  </div>
                </div>

                {/* Catalog grid — only render when this agent actually has
                    anything to show. Empty agents (no crons, no processes,
                    no workflows yet) still get an identity row so the
                    operator can see they're part of the family. */}
                {total > 0 && (
                  <div className="grid sm:grid-cols-3 gap-3">
                    <CatalogColumn
                      title="Scheduled tasks"
                      hint="on a clock"
                      icon={<Clock className="w-3.5 h-3.5" />}
                      entries={cat.crons.map((c) => ({
                        name: c.name,
                        meta: c.schedule || c.location,
                        desc: c.description,
                      }))}
                    />
                    <CatalogColumn
                      title="Always-on processes"
                      hint="running locally"
                      icon={<Cog className="w-3.5 h-3.5" />}
                      entries={cat.processes.map((p) => ({
                        name: p.name,
                        meta: p.location,
                        desc: p.description,
                      }))}
                    />
                    <CatalogColumn
                      title="Workflows"
                      hint="event-triggered"
                      icon={<Workflow className="w-3.5 h-3.5" />}
                      entries={cat.workflows.map((w) => ({
                        name: w.name,
                        meta: w.location,
                        desc: w.description,
                      }))}
                    />
                  </div>
                )}
                {total === 0 && (
                  <div className="text-[11px] text-fg-dim italic pt-1">
                    No scheduled tasks, processes, or workflows wired yet — chat with this agent and it will start the work that produces them.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Event bus"
        subtitle="A live tape of every signal your agents publish — emails opened, leads bumped, statuses changed. Most recent first."
      >
        {events.length === 0 ? (
          <EmptyState message="No events yet. The bus fills up when a lead opens an email, an outbound goes out, or the reasoning loop ticks." />
        ) : (
          <ul className="divide-y divide-bg-border">
            {events.map((e) => {
              const payload = (e.payload || {}) as Record<string, unknown>;
              const cls = payload.classification as Record<string, unknown> | undefined;
              const subject = payload.subject as string | undefined;
              const prettyEvent = formatEventType(e.event_type);
              const prettyPublisher = formatPublisher(e.publisher_agent);
              // Subject-fallback caption — when a producer didn't include
              // payload.subject (legacy email_opened rows, lead-stage
              // transitions, dashboard actions) compose a meaningful
              // line from other payload fields so the row isn't blank.
              // Keeps the event tape scannable: every row has SOMETHING
              // identifying the entity it touched.
              const fallbackCaption = (() => {
                if (subject) return null;
                const recipient = (payload.recipient || payload.to) as string | undefined;
                const leadName = (payload.lead_name || payload.lead) as string | undefined;
                const action = payload.action_type as string | undefined;
                const recordId = (payload.record_id || payload.lead_id) as string | undefined;
                if (recipient) return `to ${recipient}`;
                if (leadName) return `lead: ${leadName}`;
                if (action) return `action: ${action}`;
                if (recordId) return `record ${String(recordId).slice(0, 8)}`;
                return null;
              })();
              return (
                <li key={e.id} className="py-2.5">
                  <div className="flex justify-between items-baseline gap-3">
                    <span title={e.event_type} className="inline-block">
                      <Tag tone="accent">{prettyEvent}</Tag>
                    </span>
                    <span className="text-xs text-fg-dim">
                      <span title={e.publisher_agent}>{prettyPublisher}</span>
                      {" · "}
                      {timeAgo(e.published_at)}
                    </span>
                  </div>
                  {subject ? (
                    <div className="text-fg mt-1.5 text-sm">{truncate(subject, 100)}</div>
                  ) : fallbackCaption ? (
                    <div className="text-fg-muted mt-1.5 text-xs italic">{fallbackCaption}</div>
                  ) : null}
                  {cls && (
                    <div className="text-xs text-fg-muted mt-1">
                      intent: {String(cls.intent || "—")} · priority:{" "}
                      {String(cls.priority || "—")} · sentiment:{" "}
                      {String(cls.sentiment || "—")}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CatalogColumn({
  title,
  icon,
  entries,
  hint,
}: {
  title: string;
  icon: React.ReactNode;
  entries: Array<{ name: string; meta: string; desc: string }>;
  /** Three-word clarifier rendered under the column header so operators
   *  don't have to scroll up to remember what differentiates the three
   *  columns. E.g. "on a clock" for Scheduled tasks. */
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-fg-muted mb-1">
        {icon}
        {title}
        <span className="text-fg-dim font-mono normal-case tracking-normal">
          ({entries.length})
        </span>
      </div>
      {hint && (
        <div className="text-[10px] text-fg-dim normal-case tracking-normal mb-2 italic">
          {hint}
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-[11px] text-fg-faint italic">none</div>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((e) => (
            <li key={e.name} className="text-xs leading-snug">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-fg font-medium">{prettifyEntryName(e.name)}</span>
                <span className="text-[10px] text-fg-dim">· {prettifyMeta(e.meta)}</span>
              </div>
              <div className="text-[11px] text-fg-muted mt-0.5">{e.desc}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Make engineering-style entry names readable. "lead_engine" → "Lead engine",
 * "snapshot-mrr" → "Snapshot MRR", "n8n inbound qualifier" → unchanged.
 * Keeps acronyms uppercase (MRR, EDI, POS, CRM, KPI, AI, CMO, CFO, CEO).
 */
function prettifyEntryName(raw: string): string {
  const ACRONYMS = new Set(["mrr", "edi", "pos", "crm", "kpi", "ai", "cmo", "cfo", "ceo", "n8n", "po", "rsvp", "fire"]);
  const cleaned = raw.replace(/[_-]+/g, " ").trim();
  return cleaned
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(" ");
}

/**
 * Cron strings → plain English. "0 3 * * *" → "Daily at 3:00 AM UTC".
 * Locations stay as-is (vercel/local/n8n/supabase) since CC understands those
 * after seeing them once.
 */
function prettifyMeta(meta: string): string {
  if (!meta) return "";
  // Cron format: minute hour dom month dow
  const cronMatch = meta.match(/^(\d+|\*)\s+(\d+|\*)\s+(\*)\s+(\*)\s+(\*)$/);
  if (cronMatch) {
    const [, min, hour] = cronMatch;
    if (min === "*" && hour === "*") return "every minute";
    if (min !== "*" && hour !== "*") {
      const h = Number(hour);
      const m = Number(min);
      const ampm = h < 12 ? "AM" : "PM";
      const h12 = h === 0 ? 12 : h <= 12 ? h : h - 12;
      const mm = m.toString().padStart(2, "0");
      return `daily at ${h12}:${mm} ${ampm} UTC`;
    }
    if (min !== "*" && hour === "*") return `every hour at :${min.padStart(2, "0")}`;
    if (min === "*" && hour !== "*") return `every minute during the ${hour}:00 UTC hour`;
  }
  // Step pattern: "*/15 * * * *" → "every 15 minutes"
  const stepMin = meta.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMin) return `every ${stepMin[1]} minutes`;
  // Step hour: "0 */4 * * *" → "every 4 hours"
  const stepHour = meta.match(/^(\d+)\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (stepHour) return `every ${stepHour[2]} hours at :${stepHour[1].padStart(2, "0")}`;
  return meta;
}
