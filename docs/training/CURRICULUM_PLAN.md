# Training curriculum — rebuild plan

Supersedes the Phase 1/2 shape in `~/.claude/plans/parsed-gathering-sifakis.md` for
everything below the tab itself. The tab, nav, roleplay and progress storage stay.

Adon's brief, 2026-09-17: the questions are vague and uneducational; make them precise
and simpler with clearer options; build a real curriculum off the founder-playbook and
other books; make it Quizlet-styled and more interactive; divide it into much smaller
phases; cover the Oasis AI ladder from simple workflows to agent harnesses; and go deep
on volume sales, cold calls and cold outreach.

Two research streams informed this. Both are summarised here rather than cited loosely,
because several findings contradict what we already shipped.

---

## 1. What the learning research changes

| Finding | Source | What it breaks here |
|---|---|---|
| **Three options, not four** | Rodriguez 2005 meta-analysis, 80 years of data | `OPTION_COUNT = 4` in `lib/training/drills.ts` |
| Only 13.8% of 4-option items have all 3 distractors functioning | Tarrant 2009, n=1,542 distractors | Most of our items are 2-option items in disguise |
| **Cover test**: the stem must be answerable with options hidden | Haladyna, Downing & Rodriguez 2002 | Measured: **4 of 34** shipped stems fail it mechanically (`find-d`, `find-frequency`, `obj-prevented`, `open-specific`) |
| Feedback must say why each **wrong** option is wrong | Butler & Roediger 2008; Roediger & Marsh 2005 | Our `because` explains only the right answer |
| MCQs without feedback **install** false knowledge (negative suggestion effect) | Roediger & Marsh 2005 | Plausible distractors without per-distractor feedback make reps worse |
| Mastery = 3 correct recalls across 3 **separate** sessions | Rawson & Dunlosky 2022 | `training_progress.right_count` would call a rep trained after one guess |
| One correct in each of 3 sessions beats three correct in one session by over 2x | Rawson & Dunlosky 2022 | We currently credit repeats inside a session |
| Re-show gap of roughly 3-6 days for a 30-day retention target | Cepeda 2008, n over 1,350 | No scheduling exists at all today |
| Interleave confusable things; **block** new terminology | Brunmair & Richter 2019, 59 studies | Section-at-a-time is right for intro, wrong for objection types |
| No timer on anything that counts toward a record | WCAG 2.2.1 | Constrains any Match or speed mode |
| Quizzing moves **declarative knowledge only** | Taylor, Russ-Eft & Chan 2005, 117 studies | The tab must say so. Knowledge is what decays; skill is not built by quizzing |
| Never rank reps on role-play scores | Journal of Selling | Role-play performance did not predict live selling |

Banned from all copy: **"87% of sales training is forgotten in 30 days."** No primary
source exists for any version of it. Cite spacing and retrieval effect sizes instead.

## 2. What the corpus research changes

**The cold-call script gap.** The founder-playbook has cold email at four touch points,
warm reactivation, ACA, VFWPA, a SPIN call opening, commitment proposals, Mom Test
deflections, and a principle-annotated cold email with an anti-example. It has **zero
phone openers, zero voicemails, zero gatekeeper turns** across all 20 skill directories.

Decision (Adon, 2026-09-17): APEX drafts the dial scripts, Adon approves before any rep
sees them. They are labeled as **our authorship**, never attributed to Hormozi or Rackham.

**Never teach as fact** — the corpus's own replication notes:

- Kitty Genovese "38 witnesses" — factually false, debunked 2007 (Manning, Levine & Collins)
- Milgram "65%" unqualified — 1 of 24 conditions, range 0-92%
- Hofling "95%" — a 1966 figure; modern replications land at 16-30%
- Rackham "10x more need-payoff questions" — labeled rhetorical, no published baseline
- Any single value-to-price multiplier — `100m-offers` says 10x in one file and over 5x in another

**Contradictions that must be gated, not averaged:**

1. **Scarcity and urgency.** Hormozi prescribes them; SPIN says they backfire in major
   sales. Gate every such item on deal size, decision-maker count and buyer sophistication.
2. **Mom Test vs SPIN.** Mom Test forbids "would you buy" and "would it be useful"; SPIN's
   need-payoff questions are exactly that form. Gate on product maturity, never blend.
3. **Volume vs planning.** Rule of 100 governs top-of-funnel touches; per-call planning
   governs the booked meeting. Both are right at different funnel stages.

## 3. The AI ladder already exists

The 19 offers in `OASIS_SALES_TRAINING_COURSE.md` are already ordered by ascending AI
sophistication. No new curriculum is needed, only down-levelling.

| Rung | Offers | What the rep explains |
|---|---|---|
| Simple workflows | 1-5 | One repeated manual task, automated |
| Revenue capture | 6-10 | Speed-to-lead, reactivation, CRM |
| Workflow systems | 11-13 | Intake, portals, integration |
| Decision systems | 14-16 | Document reading, underwriting, dashboards |
| Agent harnesses | 17-19 | Knowledge assistant, agent team, command centre |

Carried guardrail, verbatim from Offer 18: **"do not lead with the phrase 'agent
harness'."** The course gives a novice explanation and an advanced-buyer explanation.
Choosing between them is a far better drill than any vocabulary question we ship today.

---

## Phasing

Ordered so no item is authored before the rules that bind it exist. Authoring 300 items
and then discovering the authoring rules were wrong is the expensive failure here.

### Phase 0 — the authoring lint and the engine fix

Blocking. Everything after this depends on it.

- `lib/training/authoring-rules.ts`, pure with no imports, mirroring `copy-rules.ts`:
  A1 three options (4 allowed, 5 rejected); A2 ban all/none of the above; A3 block
  negated stems except flagged compliance items; A4 the cover test; A5 option homogeneity
  (length clue, grammatical form, clang clue); A6 ban absolutes in options; A7 every
  distractor carries the real rep error it represents; A8 every distractor carries why it
  is wrong; A9 option order randomised per presentation.
- `OPTION_COUNT` moves from 4 to 3 in `lib/training/drills.ts`.
- `DrillItem` gains `stem`, `whyRight`, `distractors: {text, whyWrong, realError}[]`,
  `source` and `provenance`. `because` splits into `whyRight` plus per-distractor `whyWrong`.
- Every lint rule proven to fire: plant the defect, observe the named failure, restore,
  compare md5.

### Phase 1 — rebuild the 34 items under the new rules

**The measured problem is not the one the lint catches.** Only 4 of 34 stems fail a
mechanical rule. The larger defect is invisible to any lint: **11 of 34 items quiz
internal taxonomy** — the four offer labels, the three buying lanes, the four FIND
letters — rather than a judgment a rep makes on a call. A rep can ace all eleven and
still not be able to open a dial. This is the "cannot tell whether a question is worth
asking" limit stated at the top of `authoring-rules.ts`, and it is why Phase 1 is human
rewriting rather than a lint run.

Delete the taxonomy quizzes. Every surviving item is a judgment call with a cost attached.
Target around 60 items that pass the lint, replacing 34 of which roughly a third should
not exist in any form.

### Phase 2 — the curriculum, as many small units

Tracks, each split into units of 8-12 items, one visibly closable unit per sitting.

A: What we sell. B: The AI ladder. C: Who you are talking to. D: Volume outreach.
E: The cold call (Phase 5). F: Discovery. G: Offer. H: Objections (the live engine).
I: Advancing and commitment. J: Guardrails and compliance.

### Phase 3 — the scheduler

Migration 175. Mastery is 3 correct across 3 distinct sessions; no credit for repeats
within a session; a miss re-shows at a lag of at least 3 items and resets the count; next
due in 3-6 days. A mastery bar, pre-credited, never percent-correct.

### Phase 4 — more game modes

Sequence (order the steps: SPIN, More Better New, the 7 lead-magnet steps, FIND) is the
highest-value addition, because so many of these frameworks are strictly ordered. Then
Spot the Error, Say It Your Way, and Match with a mandatory untimed equivalent earning
equal credit.

### Phase 5 — the dial track

Authored by APEX, approved by Adon, labeled as ours. Openers, voicemail, gatekeeper, the
one-close rule, and Advance vs Continuation.

### Phase 6 — manager view

Mastery per rep per unit. Never role-play scores. Never a streak as a proficiency signal.

---

## What this plan does NOT do

- No pricing items until `CONTENT_CONFLICTS.md` is settled.
- No claim that the tab improves selling. It moves declarative knowledge, which is the
  component that decays. Skill comes from the role-play and from call review.
- No streaks in any manager-facing view.
- No arcade or speed mode without an untimed, equal-credit path.
