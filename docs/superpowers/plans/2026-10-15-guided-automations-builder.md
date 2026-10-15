# Guided Automations builder: plan

**Date:** 2026-10-15 · **Owner:** Bravo for CC · **Spec:** `docs/superpowers/specs/2026-10-14-money-automations-agent-training-design.md` §4 (approved)
**Branch:** `feat/guided-automations-builder-20261015` · **Repo:** `CC90210/oasis-command-center`

## 1. What CC asked for (2026-10-15, with a screenshot of the live page)

The Automations page opens on one big "Describe what you want" box that asks an AI to write a script. CC: it is "so free and open", it should be **structured**, with **templates built in**, and the work is done only when it is done.

## 2. What exists today (verified in the code, not remembered)

- **Safe run engine, built and connected to nothing ("dark").** `lib/os/runs/executor.ts driveAutomationRun`, `store.ts claimAutomationRun`, `dept_chat_runs` receipts, the per-department tool palettes (`lib/os/desk/catalog.ts`), a tool allowlist (`only`), `propose_email` as the only write (an approval card, sends nothing), and a preview mode. No production caller; `enqueueRun` never writes `automation_id` / `scheduled_for`; a task's conversation would show in the chat list; `RUN_STATUSES` has no `missed`.
- **Schedule library for exactly this wizard.** `lib/automations/schedule-plan.ts`: `validatePlan`, `planToCron`, `describePlan`, `nextRuns` (DST-correct, Toronto default), a gap rule. `nextRuns` has no production caller yet.
- **Connector truth and repair links.** `lib/os/connectors.ts`, `lib/setup-links.ts`. **Presence helpers:** `lib/devices/presence.ts`.
- **The free-text path** (`DescribeAutomationFlow`, `/api/automations/draft`, `/save-draft`) writes a Python script for a connected computer. Operator/agents-owner only. It stays, under **Advanced**.
- `action_type = department_task` is a reserved constant with **no** validator, creator or dispatcher; four places refuse it today.
- No template catalogue exists. The only runnable jobs are 4 OASIS script rows and the house cron.
- **Not adopted:** the stale uncommitted work in `oasis-command-center-funnel-integration-20261012`. It runs arbitrary Python on a computer (the opposite of proposal-only), has no templates, no Cloud option, no preview or separate activation, mismatched departments, and a poll route that returns 503 for the whole tenant on one bad binding. Reference only its pairing-ownership checks.

## 3. What CC will see

`/automations` opens on **"New automation"** with five steps and a live right-hand summary:

1. **Department.** Chief of Staff, Sales, Marketing, Support, Finance (OASIS only), Operations. Each shows how many templates it has.
2. **Job.** Template cards for that department (plain-English promise, "never does" line, what it reads). Each template has typed inputs (pickers and short fields, no essay box) and a **schedule** chosen from presets or the schedule library, with **the next 3 runs in Toronto time**. A seventh card, **"Something else"**, is a *structured* custom brief: one objective sentence (fenced as data, 400 characters), a checklist of the department's read tools, and an output choice (digest or email drafts for approval). Never a blank prompt that can do anything.
3. **Connections.** The template's required apps shown as Connected / Needs attention / Not connected, from the Connections hub's own status, each with its exact repair link. A missing required app blocks activation, not saving.
4. **Runs on.** **Cloud** (the workspace's AI account, with an honest "uses your AI account" note and the account's state). Connected computers are listed disabled with the reason ("computers run advanced scripts today; guided automations run in the cloud"), not faked.
5. **Review.** A plain-English sentence of what will happen, who sees the result and where. **Save** (always paused) → **Test now** (preview only: reads, shows "would draft N emails", files nothing, shows the run receipt) → **Turn on** (explicit; revalidates everything).

**Your automations** list shows each guided automation with its status (Paused / On / Needs attention), next run in Toronto time, last result in words, and the receipt of its last run. **Advanced** keeps today's script composer and technical inventory, unchanged.

## 4. Architecture

```
template catalogue (pure TS, versioned)  --> validated payload (action_payload JSON)
   wizard UI  --draft/save--> POST /api/automations/guided (tenant_cron_jobs, enabled=0, action_type=department_task)
              --test------->  POST /api/automations/guided/[id]/test   (engine, mode=preview, receipt)
              --turn on---->  PATCH .../activate (atomic toggle path, revalidated)
   cron minute --> /api/cron/dispatch-automations --> claim due rows atomically --> enqueue run(source=automation, automation_id, scheduled_for)
                   --> driveAutomationRun (deadline, history none, tool allowlist) --> dept_chat_runs receipt --> last_run_* on the row
```

- **Payload** (`action_payload`): `{ v:1, template:{id,version}, department, inputs, tools, output, target:{kind:"cloud"}, approval:"proposal_only", runtime_cap_sec, schedule:{plan} }`. Validated by a hand-written strict validator (no new dependency; the Worker is at 99% of its cap). Unknown keys fail the parse; `tools` must be inside the template's list which must be inside the department's palette.
- **Safety:** saved paused; preview cannot send, publish, charge or delete; the only write is `propose_email` (approval card to a lead's stored address, caps per run/day); owner/admin + department gate on create, revalidated on activate and at **every** dispatch (live seat, department gate, tool availability, AI account state); a leaver's rows are already disabled by `team-activation.ts`; fenced inputs; secrets never in payloads or responses.
- **Bundle:** budget 65,024 KiB of 65,536 KiB. Plan: measure first (`scripts/worker-composition.mjs`, #614), reuse modules the run routes already bundle, add no dependency, keep server-only code out of client components, and report the size delta of every PR.

## 5. Template catalogue v1 (every one buildable with today's palettes)

| Department | Template | Reads | Output |
|---|---|---|---|
| Chief of Staff | **Daily brief** | numbers, approvals, pipeline, calendar | digest |
| Sales | **Follow-up drafts** | pipeline, leads, lead history | email drafts for approval (max 3 per run) |
| Sales | **Stalled-lead digest** | pipeline | digest |
| Support | **At-risk tickets and projects** | tickets, projects | digest |
| Marketing | **Weekly marketing numbers** | department numbers, approvals | digest |
| Finance (OASIS) | **Weekly money summary** | finance metrics | digest |
| Operations | **Overnight routines and connections check** | routines, connections | digest |
| any | **Something else (structured)** | the department's read tools, chosen by the person | digest or drafts |

Not offered (cannot be done safely today): "send to Telegram/Slack", lead scoring, anything that sends, posts, charges or edits a record. The wizard says so.

## 6. Work breakdown, owners, gates

| # | Task | Owner | Done when |
|---|---|---|---|
| M0 | Bundle report in CI (#614) and a size delta in every PR | Bravo | first real breakdown read; headroom known |
| M1 | Contract: types, template catalogue, strict payload validator, preview-run request shape | Bravo | pure, tested, no server imports, mutation-checked |
| M2 | Engine wiring: `automation_id`/`scheduled_for` writes, origin filter on conversations, `missed` status, automation `startTurn` with allowlist + preview, receipt read | Codex (backend) | engine tests green; a preview run on a test DB produces a receipt and files nothing |
| M3 | Dispatcher: `/api/cron/dispatch-automations`, Worker + registry + driver entries, atomic claim, miss handling, per-dispatch revalidation | Codex (backend) | tests pin claim-once, miss, revalidation, no double run |
| M4 | API: create/update (paused), test, activate, pause, delete, list with receipts; gates | Bravo | gates + payload validation + tenant scoping tested |
| M5 | Wizard UI + list + Advanced fold, mobile, empty/error states | Claude UI agent | render tests per step; no raw JSON; honest states |
| M6 | Integration, full local regression (all 27 CI groups), CI green, independent reviews (Codex + fresh reviewer), fixes | Bravo | every finding fixed or flagged |
| M7 | Deploy, then production verification: real preview run on prod with a receipt, a paused automation created and removed, page loads, bundle size reported | Bravo | evidence in the report |

Rules for every PR: claim paths with `coord_claim.py`; `git add -A` in a dedicated worktree and read `git show --stat` before push; no `main` pushes; squash-merge only when CI is green and bot findings are zero.

## 7. Definition of done

1. A person can pick a department, pick a template, fill typed inputs, see the next 3 runs in Toronto time, see connection status with repair links, choose Cloud, save paused, **Test now** and read the receipt, and **Turn on**, all without writing a prompt or code.
2. A turned-on automation actually runs on schedule in production and leaves a receipt and a last result on its row; a missed slot is recorded as missed, never silently replayed.
3. Nothing a guided automation does can send, post, charge or delete; drafts wait in Needs you.
4. The old composer still works, under Advanced.
5. Typecheck, lint, all CI groups, build, Worker size gate green; Codex and a fresh reviewer found nothing unresolved; production check done and reported with output.

## 8. Risks and decisions made

- **Cloud only first.** A computer run would get the full chat palette (the claim route has no automation handling). Shipping that would break the safety promise, so computers stay disabled in step 4 with the reason shown. Revisit after M7.
- **Cloud needs a working AI account.** The workspace default is a Gemini key today; step 4 shows the account's state and blocks Turn on when it cannot run.
- **Bundle:** if the measured headroom cannot hold M1-M5 (~200-400 KiB), a bundle diet PR comes first.
- **"Support"** in the spec is `client_success` in the code; the label is "Support", the key stays.
