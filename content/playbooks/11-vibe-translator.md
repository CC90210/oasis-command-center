---
tags: [playbook, prompt-engineering, translator, anti-slop, operator]
---

# Vibe Translator — V9.1

Audience: Operator

The operating manual for **AI #1** in [the OASIS Loop](/playbook/10-oasis-loop) — the Prompt
Engineer that turns your brain dump into a system message the executor can build from. The
prompt itself is **Prompt translator** in the [Prompts Library](/playbook/prompts); copy it into
a fresh chat and this page is what it does once it's running.

**What changed in V9.1.** V8.0 had exactly two outcomes for a fact it could not verify: invent a
default, or bury it in OPEN QUESTIONS where the executor finds it *after* building the wrong
thing. V9.1 adds the third and usually correct one — **it asks you 2 to 4 questions, once,
before it writes the prompt.** Cost: one message. Alternative cost: a rebuild.

---

## The iron rule

> **Extrapolate ambition. Never extrapolate facts.**

The translator widens the scope to the complete working system you obviously want — the empty
state, the guard, the alert, the cron, the test. But every concrete detail (table, column, route
path, env key) has to come from reading the source. A confident guess is the most expensive
thing it can emit, because the executor builds on it without knowing it was a guess.

**The V9.1 corollary:** a fact it cannot read and cannot infer safely is not a default — it is a
**question**. It asks, or it labels the assumption. It never lets a guess enter the prompt
dressed as a decision.

---

## Phase 1 — Dissect the dump into four layers

Nothing is written until all four are filled. Anything a layer can't close becomes an open
question in **1e**, never a quiet default.

### 1a. Intent & vocabulary

- Restate the ask in one sentence you would confirm.
- Canonicalize every domain term — *tenant*, *lead*, *interaction*, *drip sequence*, *Pulse* —
  against the empire glossary. Never re-derive a term that's already defined.
- Separate the **stated** ask from the **implied** system, and name the implied parts out loud
  so you can veto them now instead of discovering them later.
- Voice notes are lossy: numbers, names and domains survive dictation badly, so every literal
  gets echoed back for confirmation. Screenshots are evidence — the image gets opened, not
  paraphrased. A screenshot of a UI is the spec, including its spacing and type scale.

### 1b. Data & backend contracts

- Exact tables and columns, read from the source. A guessed column fails at runtime, in
  production, silently.
- Migration needed, and does it cross a tenant boundary — reads scoped **and** writes stamped.
- Background work: a cron row, a daemon, or neither.
- Idempotency: what the dedup key is, and where it persists.

### 1c. Frontend & interaction

- Component hierarchy, and where state lives — server component, client, or the URL.
- The empty, loading and error states — **all three**, or it isn't shipped.
- Real palette and type scale. If the answer is "gradient hero plus three icon cards," start
  again.
- Which repo owns it. Dashboard work is this one.

### 1d. Harness & tool routing

- The exact scripts, routes, MCP tools and subagents the plan touches.
- Probe every service before claiming a gap — AVAILABLE means authorized, so run the tool.
- Model calls go through the subscription CLI, never an API key. Outbound email goes through the
  send gateway, no exceptions.

### 1e. Open questions — the collection point

Every gap the four layers couldn't close lands here in one list, written as:

> **the gap · the default I'd take · what a wrong default costs**

That third field is what the next phase sorts on. An empty list is only valid if it can say why
— a suspiciously clean 1e usually means a guess already slipped in as a fact.

---

## Phase 1.5 — The Interactive Clarification Loop

**The rule.** Before writing the system message, the translator reads 1e and decides per item:
*ask you now*, or *decide it and say so*. If anything is high-leverage it **stops and asks — 2
to 4 questions, in one message** — then folds the answers in and continues.

It never asks permission to build. It asks for the facts that decide *what* to build.

### What earns a question

Only when a wrong default **can't be undone with one edit**:

| Class | It asks when | Example |
|---|---|---|
| **Missing external context** | Only you can create the account, key, domain or approval, and the design branches on which exists | "New Resend domain, or the existing Gmail sender?" |
| **Unstated business logic** | A number or rule that's a *choice*, not a fact — pricing, cadence, thresholds, who gets notified | "Does a lead read as gone quiet at 14 days or 30?" |
| **Ambiguous user/tenant boundary** | Whose data this touches, and what a wrong-tenant or logged-out visitor sees | "Per-tenant like /leads, or a cross-tenant view only you see?" |
| **Undefined edge case** | The failure, duplicate or empty path changes the contract, not just a message string | "Second submission from the same email — update the row, or insert a new one?" |

Everything else it decides and records. **Deciding is the default; asking is the exception it
earns.**

### What it must never spend a question on

- Anything a search of the codebase answers. Asking you for a column name is a guess with a
  politeness wrapper.
- Anything the glossary already defines.
- Anything a credential probe answers. "Do we have Stripe access?" is a command, not a question.
- **Permission to proceed.** "Shall I start?", "does this plan look good?" — Fix-First mode ended
  those.
- Cosmetic preference it should own: naming, file layout, which helper to reuse. If your answer
  would be "you pick," it should have picked.

### The shape of a good question set

Numbered, two lines each, **with the default already attached**, so a one-word reply unblocks the
whole build. You should be able to answer `1b, 2 default, 3 yes` and be done.

```
Two things I can't read from the repo, then I build:

1. Cold-lead cutoff — 14 days or 30?  [default: 14, matches the existing drip gap]
2. This view — you-only across all tenants, or scoped per tenant like /leads?
   [default: per-tenant, consistent with every other view]
```

**Budget: 2–4 questions, one round.** A second round only if an answer opens a genuinely new
fork. Three rounds isn't clarification, it's a design meeting — at that point it takes the rest
as stated assumptions and ships the prompt.

**Where it asks.** In chat by default. If the runtime has a native question control and you're at
the keyboard, it uses that instead — same budget, recommended option first. Never a modal in an
unattended run.

### Unattended runs never block

When the protocol runs where nobody can answer — a cron job, a background agent, a hand-off from
another agent — the loop does not wait. It takes the default, marks it in the prompt as
`[ASSUMED: … — unconfirmed]` rather than as a decision, copies every one into OPEN QUESTIONS, and
forces any **irreversible** dependent step to stop for your confirmation before it runs: money,
sends, migrations, production pushes.

A deadlocked cron is worse than a labelled assumption. An *unlabelled* assumption is worse than
both.

### What your answer is — and what it isn't

Your reply is ground truth for **decisions**. It gets tagged `[VERIFIED: CC Clarification]`, given
the same standing as a command's output, and written into the step that consumes it — so the
executor, which never saw this conversation, doesn't re-ask you something you already answered.

**But your reply is not evidence about the state of the code.** "That column is already there" is
a belief, not a check. System facts still get verified against the source and tagged with the
command that proved them. If the live check contradicts the recollection, it says so in one
sentence and uses the live result.

Durable answers get written down — a threshold, a naming convention, a cadence you'll want again
gets one dated line in the empire's pattern log. **You should never answer the same question
twice.**

---

## Phase 2 — The 7 production defenses

These are the defects that actually reach production from vibe-coded work. **Every** prompt the
translator emits carries this block, scoped to the task. A defense that doesn't apply is marked
`N/A — <reason>`, never deleted — silence reads as "handled."

| # | Defense | What it means here |
|---|---|---|
| 1 | **Probe credentials first** | Run the capability probe before claiming any gap. AVAILABLE means authorized — run the tool. Never try to read an env file; the guard blocks it and logs the attempt. "No access" is true only after the probe fails and the output is quoted. |
| 2 | **No UI-only security** | Authorization is re-checked server-side on **every** route — session or bridge token verified server-side, never trusted from the request body. A hidden nav item is not a blocked route; a client-side redirect is not a gate. |
| 3 | **Tenant data isolation** | API routes here run with the service role and **bypass RLS**, so the explicit `tenant_id` filter *is* the boundary. Every query filters it, every insert stamps it, and the tenant is resolved server-side from the auth cookie or bridge token — never from the body. A new `.from(...)` without a nearby `.eq('tenant_id', ...)` is a cross-tenant leak. Prove it by loading as logged-out **and** as a user of the wrong tenant. See the [Security Model](/playbook/security). |
| 4 | **Closed-loop error tracking** | No empty `catch {}`, no broad catch that returns a success shape. Log the real error and publish an event row so it surfaces on a dashboard instead of dying silently. A caught-and-hidden exception is the most expensive defect in this system. |
| 5 | **Verified restore point before schema change** | Snapshot first, verify the snapshot is fresh and complete, then dry-run the migration. The snapshot is a *logical* baseline — byte-level restore is Supabase PITR, so confirm the PITR window covers it before anything destructive. If verification fails you don't have a restore point: escalate, don't apply. |
| 6 | **Server-side payment math** | Every amount computed server-side from the database or a Stripe price object, never from a client-supplied number. Webhooks verify the signature *before* trusting the body and dedup on the event id, scoped by tenant. Money always needs your confirmation. |
| 7 | **Zero unrequested visual rewrites** | Touch only the components the request names. Before shipping a UI change, capture the pages and compare side by side against the previous state or your reference image. A redesign nobody asked for is two defects at once. |

---

## Phase 3 — The output: one system message, seven headings

One message, no preamble above it and no commentary below it. Every clarified answer appears
**inside the heading that depends on it** — the executor is a fresh context and never saw the
conversation where you answered.

````markdown
# OBJECTIVE
[2–3 sentences: the outcome, not the activity. Name the repo, the branch, and the
canonical vocabulary this task uses. Any clarification that changed the objective
itself belongs here, tagged [VERIFIED: CC Clarification].]

# CONTEXT
[Repos and paths involved. Current branch. The authoritative files, each with the
command that VERIFIED it — file:line for anything the executor must not re-derive.]

# CONTRACTS
[The exact table/column, route signature, env key, or clarified business rule this
task depends on. Each carries its provenance: the command that verified it, or
[VERIFIED: CC Clarification]. Never an assumption presented as a fact.]

# BUILD
[Numbered, ordered, actionable. Every step names the exact file it touches and what
changes in it. "Update the schema" is not a step — name the table and the column.
Cover UI, backend, schema and harness wiring as applicable.]

# GUARDRAILS
[Fix-First execution: no permission requests, no proposals, zero stubs, zero TODOs —
a genuine blocker is named explicitly, never left silent. Surgical scope: touch only
what this prompt names. Outbound through the send gateway; model calls through the
subscription CLI, never an API key. Then the 7 defenses above, scoped to this task,
with any inapplicable row marked N/A — <reason>. Never delete a row.]

# VERIFICATION
[The exact commands, and for each the output that proves it passed. "Verify it works"
is not a verification — name the command and the string its output must contain.]

# OPEN QUESTIONS
[What a default silently decided and Phase 1.5 didn't put to you, each with the
default taken. On an unattended run, every [ASSUMED: … — unconfirmed] item appears
here verbatim. Anything you already answered does NOT belong here — it's a resolved
fact in CONTRACTS. Empty is valid; omitting the section is not.]
````

Then a **single** sign-off line. Not a summary of the summary.

**The quality bar.** "Update the schema" isn't a step until it names the table and the column.
"Verify it works" isn't a verification until it names the command and the string its output must
contain. And if OPEN QUESTIONS repeats something you already answered, the loop leaked — that
belongs in the step that consumes it.

---

## Reading it against the engineering skill

The same protocol lives in the Business-Empire-Agent repo as
`skills/vibe-to-execution/SKILL.md`, where it's written as four numbered sections instead of
seven flat headings. Same content, different rendering — the mapping is exact:

| 7 headings (this page, the Prompts Library) | 4 sections (the engineering skill) |
|---|---|
| OBJECTIVE | § 1 Objective & Executive Summary |
| CONTEXT | § 1, second half — repo, branch, vocabulary |
| CONTRACTS | § 2, the `CONTRACT:` line of each phase |
| BUILD | § 2, the `MUTATION:` line of each phase |
| GUARDRAILS | § 3 Strict Execution Rules + § 3.1 the 7 defenses |
| VERIFICATION | § 2, the `VERIFY:` line of each phase |
| OPEN QUESTIONS | § 4 Open Questions |

Nothing is dropped either way. The 4-section form interleaves contract → mutation → verify per
phase, which reads better inside an IDE. The 7-heading form groups them by kind, which reads
better when the whole prompt is pasted into a fresh chat — which is why it's the shape the
Command Center ships.

---

## When not to use it

A loose request isn't every request. A one-line question gets a one-line answer; a single-file
fix just gets fixed. The protocol's overhead exceeds the task unless the request is **prose
implying a system**, a one-liner hiding a schema, or an explicit ask for a spec.

The clarification loop scales with the protocol, not independently: a task too small for this
playbook is too small for a clarifying question. Asking is a tool for load-bearing forks, and it
stops being cheap the moment it becomes a habit — an agent that asks about everything has just
moved its own work onto your desk, which is the exact inversion of the point.
