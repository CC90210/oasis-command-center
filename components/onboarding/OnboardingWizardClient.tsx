"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronLeft,
  Download,
  Loader2,
  ShoppingBag,
  Sparkles,
  Users,
} from "lucide-react";
import {
  WIZARD_QUESTIONS,
  type TemplateKey,
  type WizardQuestion,
} from "@/lib/manifest/templates";
import { BridgeInstallLink } from "@/components/settings/BridgeInstallLink";

type Answers = Record<string, string | string[]>;

/**
 * The owner's workspace setup (2026-09-30 rewrite).
 *
 * What changed and why:
 *   - The agent picker is gone. It offered OASIS's own house agents and the
 *     SunBiz pack, and a client workspace ended up with them. The owner now
 *     picks DEPARTMENTS (Chief of Staff, Sales, Marketing, Client Success,
 *     Finance, Operations) plus opt-in add-ons; each department brings a
 *     neutral teammate named for it (lib/provisioning/team.ts).
 *   - The business-funding industry and its SunBiz drip sequences are gone.
 *   - "Where does your team talk?" and "Fast classifier (Jev, optional)" are
 *     new steps, saved to manifest.integrations.chat_apps / .jev.
 *   - No URL slug field: the workspace keeps its own address.
 *   - No invented prices or taglines, and nothing defaults to "OASIS AI".
 */

type Step =
  | "industry"
  | "questions"
  | "departments"
  | "chat_apps"
  | "jev"
  | "brand"
  | "confirm"
  | "submitting"
  | "done";

export type WizardOptions = {
  /** The workspace's own name, as OASIS created it. The brand placeholder. */
  workspaceName: string;
  departments: Array<{ key: string; label: string; purpose: string; teammate: string | null; locked: boolean }>;
  defaultDepartments: string[];
  modules: Array<{ key: string; label: string; description: string }>;
};

const INDUSTRIES: {
  key: TemplateKey;
  title: string;
  blurb: string;
  Icon: typeof Building2;
}[] = [
  { key: "real_estate", title: "Real Estate", blurb: "Brokerages, teams, individual agents. Leads, properties, deals, commissions.", Icon: Building2 },
  { key: "ecommerce", title: "E-commerce", blurb: "Stores moving real product. Orders, customers, inventory, marketing.", Icon: ShoppingBag },
  { key: "agency", title: "Agency", blurb: "Service businesses delivering client work. Clients, projects, retainers, invoices.", Icon: Users },
  { key: "custom", title: "Custom", blurb: "Your business does not fit a box. Start from the departments and shape it with OASIS.", Icon: Sparkles },
];

const CHAT_APPS: Array<{ key: string; label: string; note: string }> = [
  { key: "slack", label: "Slack", note: "Slack connects in Settings > Chat apps." },
  { key: "teams", label: "Microsoft Teams", note: "Recorded so OASIS knows to set it up for you." },
  { key: "telegram", label: "Telegram", note: "Recorded so OASIS knows to set it up for you." },
  { key: "email", label: "Email only", note: "Your team works over email." },
];

const STEP_ORDER: Step[] = ["industry", "questions", "departments", "chat_apps", "jev", "brand", "confirm"];

/**
 * canInstallBridge: the server's verified platform-operator verdict
 * (app/onboarding/wizard/page.tsx). Only the operator is offered the bridge
 * install at the end; see OnboardingDoneChoices.
 */
export function OnboardingWizardClient({
  userEmail,
  canInstallBridge,
  options,
}: {
  userEmail?: string;
  canInstallBridge: boolean;
  options: WizardOptions;
}) {
  const [step, setStep] = useState<Step>("industry");
  const [template, setTemplate] = useState<TemplateKey | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [departments, setDepartments] = useState<string[]>(options.defaultDepartments);
  const [modules, setModules] = useState<string[]>([]);
  const [chatApps, setChatApps] = useState<string[]>([]);
  const [jev, setJev] = useState<"off" | "shadow">("off");
  const [error, setError] = useState<string | null>(null);

  const questions: WizardQuestion[] = useMemo(
    () => (template ? WIZARD_QUESTIONS[template] : []),
    [template]
  );

  const brandName = (answers.brand_name as string) || "";
  const tagline = (answers.tagline as string) || "";
  const departmentLabels = options.departments.filter((d) => departments.includes(d.key)).map((d) => d.label);

  function answerKeyChange(id: string, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function requiredQuestionsAnswered(): boolean {
    return questions
      .filter((q) => q.required)
      .every((q) => {
        const v = answers[q.id];
        if (v === undefined) return false;
        if (typeof v === "string") return v.trim().length > 0;
        return Array.isArray(v) && v.length > 0;
      });
  }

  function toggle(list: string[], key: string): string[] {
    return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }

  function toggleChatApp(key: string) {
    // "Email only" cannot sit beside a chat app, in either direction.
    setChatApps((prev) =>
      key === "email" ? (prev.includes("email") ? [] : ["email"]) : toggle(prev.filter((k) => k !== "email"), key),
    );
  }

  async function submit() {
    if (!template) return;
    setError(null);
    setStep("submitting");
    try {
      const res = await fetch("/api/onboarding/wizard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template,
          answers: { ...answers, departments, modules, chat_apps: chatApps, jev },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | { ok: true; slug: string; version: number }
        | { ok: false; error?: string; reason?: string; message?: string };
      if (!data.ok) {
        setError(data.reason || data.message || "Your workspace could not be saved. Try again.");
        setStep("confirm");
        return;
      }
      setStep("done");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setStep("confirm");
    }
  }

  return (
    <div className="min-h-screen bg-bg-deep text-fg flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-4xl space-y-8">
        <Header step={step} />

        {step === "industry" && (
          <section className="grid gap-4 md:grid-cols-2">
            {INDUSTRIES.map(({ key, title, blurb, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTemplate(key);
                  setStep("questions");
                }}
                className="group text-left rounded-2xl border border-bg-border bg-bg-elev/40 hover:border-accent/40 hover:bg-bg-elev/70 p-5 transition-colors flex flex-col"
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-bg-border bg-bg-deep text-fg-muted">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="font-bold text-base text-fg">{title}</div>
                </div>
                <p className="mt-3 text-sm text-fg-muted leading-relaxed">{blurb}</p>
                <div className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                  Start here <ArrowRight className="h-3.5 w-3.5" />
                </div>
              </button>
            ))}
          </section>
        )}

        {step === "questions" && template && (
          <Panel title="A few quick questions" intro="Skip anything optional. You can change all of this later.">
            <div className="space-y-4">
              {questions.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  placeholder={q.id === "brand_name" ? options.workspaceName || "Your business name" : q.placeholder}
                  value={answers[q.id]}
                  onChange={(v) => answerKeyChange(q.id, v)}
                />
              ))}
            </div>
            <Nav onBack={() => setStep("industry")} onNext={() => setStep("departments")} nextDisabled={!requiredQuestionsAnswered()} />
          </Panel>
        )}

        {step === "departments" && (
          <Panel
            title="Pick your departments"
            intro="Each department is a page for that part of your business. Where a department has an AI teammate, it comes with it, named for the department."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {options.departments.map((d) => {
                const active = departments.includes(d.key);
                return (
                  <label
                    key={d.key}
                    className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
                      active ? "border-accent/60 bg-accent/5" : "border-bg-border bg-bg-deep/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-accent"
                      checked={active}
                      disabled={d.locked}
                      onChange={() => setDepartments((prev) => toggle(prev, d.key))}
                    />
                    <span>
                      <span className="font-semibold text-fg">{d.label}</span>
                      <span className="block text-xs text-fg-muted">{d.purpose}</span>
                      <span className="block text-xs text-fg-dim">
                        {d.teammate ? `Comes with: ${d.teammate}` : "No AI teammate yet for this department"}
                        {d.locked ? " · always included" : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-fg">Add-ons (optional)</h3>
              <p className="text-xs text-fg-muted">
                Tell OASIS what else you want. Add-ons turn on with your plan; picking one here records the request.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {options.modules.map((m) => (
                  <label key={m.key} className="flex items-start gap-3 rounded-lg border border-bg-border bg-bg-deep/40 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-accent"
                      checked={modules.includes(m.key)}
                      onChange={() => setModules((prev) => toggle(prev, m.key))}
                    />
                    <span>
                      <span className="text-fg">{m.label}</span>
                      <span className="block text-xs text-fg-muted">{m.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <Nav onBack={() => setStep("questions")} onNext={() => setStep("chat_apps")} />
          </Panel>
        )}

        {step === "chat_apps" && (
          <Panel title="Where does your team talk?" intro="Pick every place your team works together. Nothing is connected yet; this tells OASIS where to reach you.">
            <div className="grid gap-2 sm:grid-cols-2">
              {CHAT_APPS.map((a) => (
                <label key={a.key} className="flex items-start gap-3 rounded-xl border border-bg-border bg-bg-deep/40 px-4 py-3 text-sm">
                  <input type="checkbox" className="mt-1 accent-accent" checked={chatApps.includes(a.key)} onChange={() => toggleChatApp(a.key)} />
                  <span>
                    <span className="font-semibold text-fg">{a.label}</span>
                    <span className="block text-xs text-fg-muted">{a.note}</span>
                  </span>
                </label>
              ))}
            </div>
            <Nav onBack={() => setStep("departments")} onNext={() => setStep("jev")} />
          </Panel>
        )}

        {step === "jev" && (
          <Panel
            title="Fast classifier (Jev, optional)"
            intro="Jev sorts incoming messages quickly, for example which ones are new leads. In shadow mode it runs beside your normal setup and records its answers without acting on them, so you can compare. It is off unless you turn it on."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["off", "Off", "Nothing is sent to Jev."],
                  ["shadow", "Shadow", "Jev sorts beside the normal path and changes nothing."],
                ] as const
              ).map(([value, label, note]) => (
                <label key={value} className="flex items-start gap-3 rounded-xl border border-bg-border bg-bg-deep/40 px-4 py-3 text-sm">
                  <input type="radio" name="jev" className="mt-1 accent-accent" checked={jev === value} onChange={() => setJev(value)} />
                  <span>
                    <span className="font-semibold text-fg">{label}</span>
                    <span className="block text-xs text-fg-muted">{note}</span>
                  </span>
                </label>
              ))}
            </div>
            <Nav onBack={() => setStep("chat_apps")} onNext={() => setStep("brand")} />
          </Panel>
        )}

        {step === "brand" && (
          <Panel title="Name your workspace" intro="The name shows in the header and across every page.">
            <FieldRow label="Business name" required>
              <input
                type="text"
                value={brandName}
                onChange={(e) => answerKeyChange("brand_name", e.target.value)}
                placeholder={options.workspaceName || "Your business name"}
                className="w-full rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
              />
            </FieldRow>
            <FieldRow label="Footer line" hint="Optional. A short line under your name.">
              <input
                type="text"
                value={tagline}
                onChange={(e) => answerKeyChange("tagline", e.target.value)}
                className="w-full rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
              />
            </FieldRow>
            <Nav onBack={() => setStep("jev")} onNext={() => setStep("confirm")} nextDisabled={!brandName.trim()} nextLabel="Review" />
          </Panel>
        )}

        {step === "confirm" && template && (
          <Panel title="Ready to set up your workspace" intro="Check the details, then save. You can change them later.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Summary label="Business name" value={brandName} />
              <Summary label="Starting point" value={INDUSTRIES.find((i) => i.key === template)?.title || template} />
              <Summary label="Departments" value={departmentLabels.join(", ")} full />
              <Summary
                label="Add-ons requested"
                value={modules.length ? options.modules.filter((m) => modules.includes(m.key)).map((m) => m.label).join(", ") : "None"}
                full
              />
              <Summary
                label="Where your team talks"
                value={chatApps.length ? CHAT_APPS.filter((a) => chatApps.includes(a.key)).map((a) => a.label).join(", ") : "Not answered"}
              />
              <Summary label="Fast classifier" value={jev === "shadow" ? "Shadow" : "Off"} />
              {userEmail && <Summary label="Signed in as" value={userEmail} full />}
            </div>
            {error && (
              <div role="alert" className="rounded-xl border border-status-hot/40 bg-status-hot/10 px-4 py-2.5 text-sm text-fg inline-flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2">
              <button type="button" onClick={() => setStep("brand")} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
                <ChevronLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <button type="button" onClick={submit} className="btn-send inline-flex items-center gap-1.5 !px-4 !py-2 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                Set up my workspace
              </button>
            </div>
          </Panel>
        )}

        {step === "submitting" && (
          <section className="rounded-2xl border border-bg-border bg-bg-elev/40 p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-accent mx-auto" />
            <div className="mt-3 font-bold">Saving your workspace…</div>
          </section>
        )}

        {step === "done" && <OnboardingDoneChoices canInstallBridge={canInstallBridge} dashboardHref="/" />}
      </div>
    </div>
  );
}

/**
 * The "workspace is live" step. Its own function with no hooks so
 * tests/f0-containment.test.ts renders both versions for real.
 *
 * The "Pair a machine" card goes to /settings/devices/install, which installs
 * the bridge for the verified platform operator only (F0 containment,
 * 2026-09-29). Everyone else would land on a page with nothing to install, so
 * for them the card, its "Recommended" badge and the "pair later from
 * Settings → Devices" line (an operator-only section) are all gone, and the
 * dashboard card takes the full width instead of leaving an empty slot.
 */
export function OnboardingDoneChoices({
  canInstallBridge,
  dashboardHref,
}: {
  canInstallBridge: boolean;
  dashboardHref: string;
}) {
  const pairCard = canInstallBridge === true;
  return (
    <section className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-8 space-y-6">
      <div className="text-center space-y-2">
        <CheckCircle2 className="h-10 w-10 text-emerald-300 mx-auto" />
        <div className="text-xl font-bold">Your workspace is live.</div>
        <p className="text-sm text-fg-muted max-w-md mx-auto">
          {pairCard
            ? "Manifest saved, agents enabled, branding applied. Two ways to use it from here — pick what fits your setup."
            : "Manifest saved, agents enabled, branding applied."}
        </p>
      </div>

      {/* Operator: two CTAs side by side. Pair-a-machine is the recommended
          path with a local computer (CLI chat, file access, automations);
          Open-the-dashboard is the no-machine path. Everyone else: the
          dashboard card alone. */}
      <div className={pairCard ? "grid sm:grid-cols-2 gap-3" : "grid gap-3"}>
        <BridgeInstallLink
          canInstallBridge={pairCard}
          className="rounded-xl border-2 border-accent bg-accent/10 p-5 hover:bg-accent/20 transition-colors flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-accent" />
            <div className="font-bold text-fg">Pair a machine</div>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-accent font-bold">
              Recommended
            </span>
          </div>
          <p className="text-xs text-fg-muted leading-relaxed">
            Run one command on your laptop / desktop. Unlocks CLI chat
            with your Claude subscription, local file access, and the
            automations engine. ~1 minute.
          </p>
        </BridgeInstallLink>

        {/* A full page load, not <Link>: the root layout does not re-render on
            a soft navigation, so leaving this full-bleed flow client-side
            painted the workspace with no rail and no header (2026-09-30 local
            e2e walk). */}
        <a
          href={dashboardHref}
          className="rounded-xl border border-bg-border bg-bg-elev p-5 hover:border-accent-muted/40 transition-colors flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <ArrowRight className="w-5 h-5 text-fg-muted" />
            <div className="font-bold text-fg">Open dashboard now</div>
          </div>
          <p className="text-xs text-fg-muted leading-relaxed">
            {pairCard
              ? "Go straight to your workspace. Chat runs in cloud mode with your saved API key. You can pair a machine later from Settings → Devices."
              : "Go straight to your workspace. Chat runs in cloud mode with your saved API key."}
          </p>
        </a>
      </div>
    </section>
  );
}

function Header({ step }: { step: Step }) {
  // One page title; each step's own heading lives in its panel, so the two
  // never repeat each other.
  const index = STEP_ORDER.indexOf(step);
  return (
    <header className="text-center space-y-2">
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
        {step === "industry" ? "What kind of business is this?" : "Set up your workspace"}
      </h1>
      {index >= 0 && (
        <div className="text-sm text-fg-muted">
          Step {index + 1} of {STEP_ORDER.length}
        </div>
      )}
    </header>
  );
}

function Panel({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-bg-border bg-bg-elev/40 p-6 space-y-5">
      <div>
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="text-sm text-fg-muted mt-1">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function Nav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = "Continue",
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <button type="button" onClick={onBack} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
        <ChevronLeft className="h-3.5 w-3.5" />
        Back
      </button>
      <button type="button" onClick={onNext} disabled={nextDisabled} className="btn-send inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
        {nextLabel} <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function FieldRow({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-fg">
        {label}
        {required && <span className="ml-1 text-accent">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-fg-dim">{hint}</span>}
    </label>
  );
}

function Summary({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`rounded-xl border border-bg-border bg-bg-elev/40 px-4 py-2.5 ${full ? "sm:col-span-2" : ""}`}>
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-0.5 text-sm text-fg">{value || "(empty)"}</div>
    </div>
  );
}

function QuestionField({
  question,
  placeholder,
  value,
  onChange,
}: {
  question: WizardQuestion;
  placeholder?: string;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  if (question.kind === "text") {
    return (
      <FieldRow label={question.prompt} hint={question.hint} required={question.required}>
        <input
          type="text"
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
        />
      </FieldRow>
    );
  }
  if (question.kind === "longtext") {
    return (
      <FieldRow label={question.prompt} hint={question.hint} required={question.required}>
        <textarea
          rows={3}
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full resize-none rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
        />
      </FieldRow>
    );
  }
  if (question.kind === "number") {
    return (
      <FieldRow label={question.prompt} hint={question.hint} required={question.required}>
        <input
          type="number"
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
        />
      </FieldRow>
    );
  }
  if (question.kind === "single_choice") {
    return (
      <FieldRow label={question.prompt} hint={question.hint} required={question.required}>
        <div className="grid gap-2 sm:grid-cols-2">
          {(question.choices || []).map((c) => {
            const active = value === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => onChange(c.value)}
                className={`text-left rounded-xl border px-4 py-2.5 text-sm transition-colors ${
                  active
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-bg-border bg-bg-deep/40 text-fg-muted hover:border-accent/40 hover:bg-bg-elev/40"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </FieldRow>
    );
  }
  // multi_choice
  const arr = Array.isArray(value) ? value : [];
  return (
    <FieldRow label={question.prompt} hint={question.hint} required={question.required}>
      <div className="grid gap-2 sm:grid-cols-2">
        {(question.choices || []).map((c) => {
          const active = arr.includes(c.value);
          return (
            <button
              key={c.value}
              type="button"
              onClick={() => {
                const next = active ? arr.filter((v) => v !== c.value) : [...arr, c.value];
                onChange(next);
              }}
              className={`text-left rounded-xl border px-4 py-2.5 text-sm transition-colors ${
                active
                  ? "border-accent bg-accent-soft text-fg"
                  : "border-bg-border bg-bg-deep/40 text-fg-muted hover:border-accent/40 hover:bg-bg-elev/40"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </FieldRow>
  );
}
