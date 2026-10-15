/**
 * components/automations/guided/steps.tsx - the body of steps 1 to 4: Department, Job, Connections, Runs on.
 *
 * Presentation only. What is allowed, what is refused and in which words all come from
 * lib/automations/guided/view.ts, which wraps the same validator the API runs, so the sentence under a
 * field is the sentence the server would give. A field's error shows once the person has touched it;
 * until then the reason Next is waiting is said beside the button instead.
 */
import { DESK_TOOLS } from "@/lib/os/desk/catalog";
import type { GuidedValidation, InputField } from "@/lib/automations/guided/types";
import { readToolsFor, templatesFor } from "@/lib/automations/guided/templates";
import type { GuidedContextView } from "@/lib/automations/guided/api-types";
import {
  availableDepartments,
  canDraftEmails,
  canEditDays,
  canEditTime,
  chipLabel,
  connectionRows,
  departmentLabel,
  departmentPurpose,
  draftTemplate,
  errorAt,
  nextRunsView,
  pickDepartment,
  pickTemplate,
  planFor,
  presetOf,
  readyMadeCount,
  requiredSlugs,
  scheduleDays,
  scheduleTime,
  setInput,
  setOutput,
  setSchedulePreset,
  setScheduleDays,
  setScheduleTime,
  setTool,
  choiceStyle,
  DAY_FULL,
  type Draft,
} from "@/lib/automations/guided/view";
import {
  Check,
  ChipGroup,
  ChoiceControl,
  CheckRow,
  ConnectionMark,
  Field,
  GroupField,
  NumberControl,
  Notice,
  OptionCard,
  RepairAnchor,
  Segmented,
  TAP,
  TextControl,
} from "./ui";

export type StepProps = {
  draft: Draft;
  ctx: GuidedContextView;
  validation: GuidedValidation;
  touched: ReadonlySet<string>;
  touch: (field: string) => void;
  update: (next: Draft) => void;
};

/** What the panels inside the Job step need: the same as a step, without the workspace. */
type PanelProps = Omit<StepProps, "ctx">;

// ── 1. Department ────────────────────────────────────────────────────────

export function DepartmentStep({ draft, ctx, update }: Pick<StepProps, "draft" | "ctx" | "update">) {
  const departments = availableDepartments(ctx);
  if (departments.length === 0) {
    return (
      <Notice tone="info" live={false}>
        You do not have access to a department here yet, so there is nothing to automate. Ask the owner of this workspace to give you access.
      </Notice>
    );
  }
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Department</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {departments.map((d) => {
          const count = readyMadeCount(d, ctx);
          return (
            <OptionCard key={d} name="department" value={d} checked={draft.department === d} onSelect={() => update(pickDepartment(draft, d))} title={departmentLabel(d)}>
              <span className="block">{departmentPurpose(d)}</span>
              <span className="block text-xs text-fg-dim">
                {count} ready-made {count === 1 ? "job" : "jobs"}
              </span>
            </OptionCard>
          );
        })}
      </div>
    </fieldset>
  );
}

// ── 2. Job ───────────────────────────────────────────────────────────────

export function JobStep({ draft, ctx, validation, touched, touch, update, now }: StepProps & { now: Date }) {
  const department = draft.department;
  if (!department) {
    return (
      <Notice tone="info" live={false}>
        Pick a department first, then come back to choose the job.
      </Notice>
    );
  }
  const templates = templatesFor(department, { companyFinancials: ctx.companyFinancials });
  const template = draftTemplate(draft);
  const templateError = errorAt(validation, "template", touched);
  return (
    <div className="space-y-8">
      <fieldset className="min-w-0">
        <legend className="sr-only">Jobs for {departmentLabel(department)}</legend>
        <div className="space-y-3">
          {templates.map((t) => (
            <OptionCard
              key={t.id}
              name="job"
              value={t.id}
              checked={draft.templateId === t.id}
              dashed={Boolean(t.custom)}
              onSelect={() => {
                touch("template");
                update(pickTemplate(draft, t));
              }}
              title={t.title}
            >
              <span className="block text-fg">{t.promise}</span>
              <span className="block text-xs">
                <span className="font-medium">Reads:</span> {t.reads}
              </span>
              <span className="block text-xs">
                <span className="font-medium">Never:</span> {t.never}
              </span>
            </OptionCard>
          ))}
        </div>
        {templateError && (
          <p role="alert" className="mt-2 text-xs text-status-hot">
            {templateError}
          </p>
        )}
      </fieldset>

      {template && <JobSettings draft={draft} validation={validation} touched={touched} touch={touch} update={update} />}
      {template && <SchedulePanel draft={draft} validation={validation} touched={touched} touch={touch} update={update} now={now} />}
    </div>
  );
}

function JobSettings({ draft, validation, touched, touch, update }: PanelProps) {
  const template = draftTemplate(draft);
  if (!template) return null;
  return (
    <section aria-labelledby="gb-settings-h" className="space-y-5 border-t border-hairline pt-6">
      <h4 id="gb-settings-h" className="text-sm font-semibold text-fg">
        Settings
      </h4>
      {template.inputs.length === 0 && <p className="text-sm text-fg-muted">This job has nothing to set up. Choose when it runs below.</p>}
      {template.inputs.map((f) => (
        <InputFieldView key={f.name} field={f} draft={draft} error={errorAt(validation, f.name, touched)} touch={touch} update={update} />
      ))}
      {template.custom && <CustomExtras draft={draft} validation={validation} touched={touched} touch={touch} update={update} />}
    </section>
  );
}

function InputFieldView({ field, draft, error, touch, update }: { field: InputField; draft: Draft; error: string | null; touch: (f: string) => void; update: (d: Draft) => void }) {
  const id = `gb-in-${field.name}`;
  const set = (value: string | number) => {
    touch(field.name);
    update(setInput(draft, field.name, value));
  };
  const raw = draft.inputs[field.name];
  if (field.kind === "choice") {
    const value = String(raw ?? field.default);
    if (choiceStyle(field) === "select") {
      return (
        <Field id={id} label={field.label} help={field.help} error={error}>
          {(describedBy) => <ChoiceControl field={field} id={id} value={value} onChange={set} describedBy={describedBy} />}
        </Field>
      );
    }
    return (
      <GroupField id={id} legend={field.label} help={field.help} error={error}>
        {(describedBy) => <ChoiceControl field={field} id={id} value={value} onChange={set} describedBy={describedBy} />}
      </GroupField>
    );
  }
  if (field.kind === "number") {
    return (
      <Field id={id} label={field.label} help={field.help} error={error}>
        {(describedBy) => (
          <NumberControl
            id={id}
            label={field.label}
            value={typeof raw === "number" || typeof raw === "string" ? raw : field.default}
            min={field.min}
            max={field.max}
            unit={field.unit}
            onChange={set}
            onBlur={() => touch(field.name)}
            describedBy={describedBy}
            invalid={Boolean(error)}
          />
        )}
      </Field>
    );
  }
  return (
    <Field id={id} label={field.label} help={field.help} error={error}>
      {(describedBy) => (
        <TextControl
          id={id}
          value={String(raw ?? field.default)}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          onChange={set}
          onBlur={() => touch(field.name)}
          describedBy={describedBy}
          invalid={Boolean(error)}
        />
      )}
    </Field>
  );
}

/** The structured custom brief's other two parts: the reads it may use, and what it hands back. */
function CustomExtras({ draft, validation, touched, touch, update }: PanelProps) {
  const department = draft.department;
  if (!department) return null;
  const drafts = canDraftEmails(department);
  return (
    <>
      <GroupField id="gb-tools" legend="What may it read?" help="It can only look at what you tick. Tick at least one." error={errorAt(validation, "tools", touched)}>
        {() => (
          <div className="grid gap-2 sm:grid-cols-2">
            {readToolsFor(department).map((t) => (
              <CheckRow
                key={t}
                id={`gb-tool-${t}`}
                name="tools"
                checked={draft.tools.includes(t)}
                onToggle={(on) => {
                  touch("tools");
                  update(setTool(draft, t, on));
                }}
                title={DESK_TOOLS[t].label}
                summary={DESK_TOOLS[t].summary}
              />
            ))}
          </div>
        )}
      </GroupField>
      <GroupField id="gb-output" legend="What do you want back?" error={errorAt(validation, "output", touched)}>
        {() => (
          <div className="space-y-2">
            <Segmented
              name="gb-output"
              value={draft.output}
              onChange={(v) => {
                touch("output");
                update(setOutput(draft, v === "email_drafts" ? "email_drafts" : "digest"));
              }}
              options={[
                { value: "digest", label: "A written summary" },
                { value: "email_drafts", label: "Email drafts for approval", disabled: !drafts },
              ]}
            />
            {!drafts && <p className="text-xs text-fg-dim">{departmentLabel(department)} cannot draft emails yet, so a written summary is the only result here.</p>}
            {draft.output === "email_drafts" && <p className="text-xs text-fg-muted">Each email waits in Needs you until a person approves it. Nothing is sent without that.</p>}
          </div>
        )}
      </GroupField>
    </>
  );
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function SchedulePanel({ draft, validation, touched, touch, update, now }: PanelProps & { now: Date }) {
  const template = draftTemplate(draft);
  if (!template) return null;
  const preset = presetOf(template, draft.schedule);
  const plan = planFor(template, draft.schedule);
  const error = errorAt(validation, "schedule", touched);
  const days = scheduleDays(template, draft.schedule);
  return (
    <section aria-labelledby="gb-when-h" className="space-y-4 border-t border-hairline pt-6">
      <h4 id="gb-when-h" className="text-sm font-semibold text-fg">
        When should it run?
      </h4>
      <GroupField id="gb-when" legend="Schedule" error={error} hideLegend>
        {() => (
          <ChipGroup
            name="gb-when"
            type="radio"
            options={template.schedulePresets
              .filter((p) => !(p.plan.mode === "manual" && draft.output === "email_drafts"))
              .map((p) => ({ value: p.id, label: chipLabel(p, draft.schedule) }))}
            isChecked={(v) => draft.schedule?.presetId === v}
            onToggle={(v) => {
              touch("schedule");
              update(setSchedulePreset(draft, v));
            }}
          />
        )}
      </GroupField>

      {preset && (canEditTime(preset) || canEditDays(preset)) && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          {canEditTime(preset) && (
            <Field id="gb-when-time" label="Time of day" help="In Toronto time." error={null}>
              {(describedBy) => (
                <input
                  id="gb-when-time"
                  type="time"
                  step={60}
                  value={scheduleTime(template, draft.schedule)}
                  aria-describedby={describedBy}
                  onChange={(e) => {
                    touch("schedule");
                    update(setScheduleTime(draft, e.target.value));
                  }}
                  className={`input ${TAP} w-auto`}
                />
              )}
            </Field>
          )}
          {canEditDays(preset) && (
            <GroupField id="gb-when-days" legend="Days" error={null}>
              {() => (
                <ChipGroup
                  name="gb-when-days"
                  type="checkbox"
                  options={WEEK_ORDER.map((d) => ({ value: String(d), label: DAY_SHORT[d], srLabel: DAY_FULL[d] }))}
                  isChecked={(v) => days.includes(Number(v))}
                  onToggle={(v) => {
                    const d = Number(v);
                    touch("schedule");
                    update(setScheduleDays(draft, days.includes(d) ? days.filter((x) => x !== d) : [...days, d]));
                  }}
                />
              )}
            </GroupField>
          )}
        </div>
      )}

      {plan && <NextRuns plan={plan} now={now} />}
    </section>
  );
}

function NextRuns({ plan, now }: { plan: NonNullable<ReturnType<typeof planFor>>; now: Date }) {
  const view = nextRunsView(plan, now);
  if (view.kind !== "runs") return <p className="text-sm text-fg-muted">{view.text}</p>;
  return (
    <div aria-live="polite">
      <p className="text-sm font-medium text-fg">Next runs:</p>
      <ol className="mt-1 space-y-0.5 text-sm tabular-nums text-fg-muted">
        {view.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  );
}

// ── 3. Connections ───────────────────────────────────────────────────────

export function ConnectionsStep({ draft, ctx, onRecheck, rechecking }: { draft: Draft; ctx: GuidedContextView; onRecheck: () => void; rechecking: boolean }) {
  const rows = connectionRows(requiredSlugs(draft), ctx.connections);
  if (rows.length === 0) {
    return <p className="rounded-lg border border-hairline bg-bg-deep px-4 py-3 text-sm text-fg">This one needs no connected apps.</p>;
  }
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
        {rows.map((r) => (
          <li key={r.slug} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-semibold text-fg">{r.label}</p>
              <ConnectionMark state={r.state} label={r.stateLabel} />
            </div>
            {r.repair ? (
              <RepairAnchor link={r.repair} />
            ) : r.state !== "connected" ? (
              <p className="text-xs text-fg-muted">Connect it from Settings, under Connections.</p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-sm text-fg-muted">You can save this without connecting these apps. Turning it on needs every app above to be connected.</p>
      <button type="button" className={`btn-secondary ${TAP} disabled:cursor-not-allowed disabled:opacity-50`} onClick={onRecheck} disabled={rechecking}>
        {rechecking ? "Checking..." : "Check again"}
      </button>
    </div>
  );
}

// ── 4. Runs on ───────────────────────────────────────────────────────────

export function RunsOnStep({ ctx }: { ctx: GuidedContextView }) {
  const cloud = ctx.cloud;
  const noop = () => undefined;
  return (
    <div className="space-y-4">
      <fieldset className="min-w-0 space-y-3">
        <legend className="sr-only">Where it runs</legend>
        <OptionCard name="runs-on" value="cloud" checked onSelect={noop} title="Cloud">
          <span className="block text-fg">Runs in the cloud using your workspace&apos;s AI account.</span>
        </OptionCard>
        <OptionCard name="runs-on" value="computers" checked={false} disabled onSelect={noop} title="Your computers">
          <span className="block">Computers run advanced scripts today. Guided automations run in the cloud so they can never touch your files.</span>
        </OptionCard>
      </fieldset>
      {cloud.ready ? (
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-status-engaged">
          <Check />
          Cloud is ready.
        </p>
      ) : (
        <div className="space-y-1">
          <Notice tone="warn">
            Cloud is not ready: {cloud.reason ?? "it cannot run automations right now."} You can still save this. It cannot be turned on until Cloud is ready.
          </Notice>
          {cloud.repair && <RepairAnchor link={cloud.repair} />}
        </div>
      )}
    </div>
  );
}
