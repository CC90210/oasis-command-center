# Training content conflicts, for Adon to settle

Found 2026-09-16 while building the Training tab, by reading the three source documents
against each other. Every conflict below is quoted, not paraphrased.

**Why this file exists.** Training turns these documents into drills, and a drill has a
right answer. Where two documents disagree, there is no right answer to teach, and
picking one silently would put an unapproved sentence into fifteen reps' mouths. That is
the same failure the objection approval gate exists to prevent, arriving through a
different door.

**What was done in the meantime.** Training teaches only what all three documents
survive. Nothing below is drilled until it is settled.

---

## 1. Price. Three documents, three incompatible rules. 🔴

| Source | What it says |
|---|---|
| `AI_Sales_Playbook_For_Reps.md` | "A first workflow normally falls between $2,500 and $5,000." Carries a seven-row price table in **USD**. |
| `OASIS_UNDENIABLE_OFFER_STRATEGY.md` §5 | "CA$497 to start. CA$197 a month." |
| `OASIS_UNDENIABLE_OFFER_STRATEGY.md` §8.2 | "🔴 BLOCKING — No price exists anywhere." |
| `OASIS_UNDENIABLE_OFFER_STRATEGY.md` §5 | "These numbers are a recommendation, not a decision... Adon signs off before any rep says a number out loud." |
| `OASIS_SALES_TRAINING_COURSE.md`, Module 10 | "How much does it cost?" → "we confirm the quote after we map the actual process and integrations." |

Three different instructions to a rep who is asked the most common question there is:
quote a range, quote one fixed number, or quote nothing.

**Taught instead:** the rule all three survive. A rep does not say a number. They map the
problem and a quote is confirmed afterwards. No drill in Training has a price as its
correct answer.

**Needed from Adon:** either the approved numbers, or a decision that reps never quote.
Until then the pricing section of Training cannot be built, and §8.2 remains true.

---

## 2. Website pricing is explicitly disowned by one document 🔴

`OASIS_SALES_TRAINING_COURSE.md`, Offer 4, warns reps directly:

> "Previous internal strategies contained proposed website pricing and guarantees that
> were not approved. Do not quote old numbers, 'unlimited edits,' performance
> superiority, or a seven-day guarantee unless the current deal sheet authorizes them."

`OASIS_UNDENIABLE_OFFER_STRATEGY.md`'s rep card contains "Live in 7 days" and a
no-per-edit-bill content promise.

One document instructs reps not to say what the other hands them to say.

**Needed from Adon:** which is current, and whether a deal sheet authorises the seven-day
clock.

---

## 3. Whether to mention AI on the first call

| Source | Position |
|---|---|
| `AI_Sales_Playbook_For_Reps.md` | AI-forward. Titled "Small Business AI Sales Playbook", openers name AI, carries a "We already use AI" objection. |
| `OASIS_UNDENIABLE_OFFER_STRATEGY.md` rep card | "❌ Anything about AI on call one" / "Do not lead with AI." |

Materially different first calls.

**Note:** the live objection catalog already follows the second rule. A copy rule in
`lib/web-leads/objections/copy-rules.ts`'s sibling test bans "AI" in a today-stage title
or summary. So the shipped product agrees with the offer strategy, and the playbook is
the outlier.

---

## 4. What the flagship actually is

- `AI_Sales_Playbook_For_Reps.md`: the **Lead to Booking System**, first purchase "First Win Sprint"
- `OASIS_UNDENIABLE_OFFER_STRATEGY.md`: a **website plus a monthly fee**, single SKU
- `OASIS_SALES_TRAINING_COURSE.md`: **three buying lanes**, with the website only an entry offer

A rep asked "what does Oasis sell?" gets three different answers depending on which
document they read last.

---

## 5. The package taxonomies do not reconcile

| Source | Taxonomy |
|---|---|
| Playbook | 5 named packages |
| Course | 19 numbered Offers in 3 lanes |
| Offer strategy | 1 SKU |

These are not different levels of detail on one model. They are three models.

**Taught instead:** the course's 4 Offer Labels (Standard / Sell after discovery / Proof
of capability / Internal or not promiseable), because they are about what a rep may
PROMISE rather than what exists, and all three documents agree a rep must not promise
beyond what is approved.

---

## 6. Two buyer taxonomies

- Course, Module 9: **4 buyer maturity levels**
- Playbook: **5 buyer awareness levels**, "Level 1 Unaware or uninterested" → "Level 5 Advanced and strategic"

Not a conflict of fact, but a rep cannot hold two overlapping ladders.

**Decision taken for Phase 1:** the playbook's five. Finer-grained, and the 35 outreach
openers are already keyed to it. Recorded here so it is a choice on the record rather
than an accident of whichever file was read first.

---

## 7. Currency

USD in the playbook, CA$ in the offer strategy. Subsumed by conflict 1, noted because it
would silently corrupt any price drill even after the amounts are settled.

---

## What unblocks what

| Settle this | And Training can add |
|---|---|
| 1 and 7 | The pricing conversation section, package and band drills |
| 2 | The website offer taught with its real scope and guarantee |
| 3 | The opening section taught one way rather than hedged |
| 4 and 5 | "What we sell" as one model instead of the safe subset |

Nothing here blocks Phase 1. Every one of them blocks a section that would otherwise be
worth building.
