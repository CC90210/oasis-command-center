import Link from "next/link";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Cloud,
  Cpu,
  Download,
  KeyRound,
  Network,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";

export const dynamic = "force-dynamic";

const FLOW = [
  {
    title: "Build the agent",
    body: "Choose the first operator, answer the personalization questions, and generate a blueprint before an account is created.",
    Icon: BrainCircuit,
  },
  {
    title: "Create the workspace",
    body: "Sign up once the blueprint is ready. The onboarding wizard turns your answers into a tenant manifest, enabled agents, and a working dashboard.",
    Icon: Bot,
  },
  {
    title: "Connect execution",
    body: "Use cloud mode for API-key chat or install the desktop app for local files, tools, daemons, and the full agent loop.",
    Icon: Cpu,
  },
  {
    title: "Operate daily",
    body: "Agents, reasoning traces, playbooks, automations, health, and settings become the six surfaces operators use to run the system.",
    Icon: Workflow,
  },
];

const SURFACES = [
  ["Agents", "Chat with Bravo, Atlas, Maven, and custom agents. Cloud mode uses provider keys. Desktop mode uses the local bridge and full tool loop."],
  ["Reasoning", "Replay tool calls, decisions, hypotheses, and action chains so operators can see how an agent reached a conclusion."],
  ["Playbook", "Operator SOPs, onboarding guides, and prompts that can be launched into the agent instead of read as dead documentation."],
  ["Automations", "Scheduled jobs, snapshots, daemons, run history, next run times, and visible errors."],
  ["Health", "State DB, bridge status, event-router health, guard modes, retriever freshness, and system signals."],
  ["Settings", "Provider keys, model overrides, roles, notification preferences, devices, and tenant controls."],
];

export default function CommandCentreExplainedPage() {
  return (
    <main className="min-h-screen bg-[#03070a] text-fg">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_72%_18%,rgba(52,211,153,0.16),transparent_28%),radial-gradient(circle_at_16%_70%,rgba(59,130,246,0.12),transparent_32%),linear-gradient(180deg,#05080d,#020405)]" />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/welcome" className="flex items-center gap-3">
          <OasisLogo size={34} priority />
          <span className="leading-none">
            <span className="block text-[11px] font-black uppercase tracking-[0.2em] text-white">
              OASIS AI
            </span>
            <span className="block text-[9px] uppercase tracking-[0.26em] text-white/[0.45]">
              Command Centre
            </span>
          </span>
        </Link>
        <Link
          href="/welcome#choose-agent"
          className="rounded-full border border-emerald-200/[0.30] bg-emerald-200/[0.08] px-3 py-2 text-xs font-bold text-emerald-100 transition-colors hover:border-emerald-200/[0.55]"
        >
          Start
        </Link>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8 sm:pt-20">
        <div className="max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-100/[0.80]">
            <Network className="h-3.5 w-3.5" />
            End to end
          </div>
          <h1 className="text-[clamp(3rem,7vw,6.8rem)] font-black leading-[0.9] tracking-tight text-white">
            What the Agent Command Centre actually is.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-white/[0.66]">
            The Command Centre is the operating layer around your AI agents. It
            turns a signup into a personalized workspace, then gives the
            operator one place to chat, inspect reasoning, launch playbooks,
            watch automations, check system health, and control models.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/configure"
              className="inline-flex h-12 items-center gap-2 rounded-md border border-emerald-200/[0.35] bg-emerald-200 px-5 text-sm font-black text-[#03110d] shadow-[0_0_36px_-10px_rgba(52,211,153,0.95)]"
            >
              Build your agent
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/download"
              className="inline-flex h-12 items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.06] px-5 text-sm font-semibold text-white/[0.76]"
            >
              <Download className="h-4 w-4" />
              Download desktop app
            </Link>
          </div>
        </div>

        <section className="mt-16 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {FLOW.map(({ title, body, Icon }) => (
            <div key={title} className="border border-white/10 bg-white/[0.045] p-5">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-md border border-emerald-200/[0.25] bg-emerald-200/[0.08] text-emerald-100">
                <Icon className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-black text-white">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-white/[0.58]">{body}</p>
            </div>
          ))}
        </section>

        <section className="mt-16 grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-200/[0.70]">
              The six tabs
            </div>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-white">
              Everything has a job.
            </h2>
            <p className="mt-4 text-sm leading-7 text-white/[0.58]">
              A new operator should not need docs to understand the system. Each
              tab fronts a real operating surface, and the onboarding flow
              should explain why those surfaces exist before the user lands
              inside.
            </p>
          </div>

          <div className="grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-2">
            {SURFACES.map(([title, body]) => (
              <div key={title} className="bg-[#05090d]/92 p-5">
                <h3 className="font-black text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/[0.56]">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 grid gap-4 lg:grid-cols-3">
          <InfoBlock
            icon={<Cloud className="h-5 w-5" />}
            title="Cloud mode"
            text="Runs in the dashboard through the provider key you connect. Good for strategy, drafting, and cloud-safe tools."
          />
          <InfoBlock
            icon={<Cpu className="h-5 w-5" />}
            title="Desktop mode"
            text="Pairs your machine through the local bridge. This unlocks local files, scripts, daemons, and richer tool execution."
          />
          <InfoBlock
            icon={<KeyRound className="h-5 w-5" />}
            title="Your keys"
            text="Providers are connected in Settings. The system resolves user override, tenant default, then platform fallback."
          />
        </section>

        <section className="mt-16 border border-emerald-200/[0.25] bg-emerald-200/[0.07] p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-100/[0.70]">
                <ShieldCheck className="h-4 w-4" />
                Correct first step
              </div>
              <h2 className="mt-3 text-2xl font-black text-white">
                Build the agent before creating the account.
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/[0.60]">
                The account is just the container. The important thing is the
                agent blueprint: role, context, tools, and operating style.
              </p>
            </div>
            <Link
              href="/welcome#choose-agent"
              className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-md bg-emerald-200 px-5 text-sm font-black text-[#03110d]"
            >
              Choose entry path
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </section>
    </main>
  );
}

function InfoBlock({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="border border-white/10 bg-white/[0.045] p-5">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.06] text-white/[0.76]">
        {icon}
      </div>
      <h3 className="font-black text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-white/[0.56]">{text}</p>
    </div>
  );
}
