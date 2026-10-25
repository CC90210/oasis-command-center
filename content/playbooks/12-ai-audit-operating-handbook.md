---
tags: [playbook, sales, ai-audit, runbook, founders]
updated: 2026-10-25
---

# Free AI Audit: operating handbook

> How one Free AI Audit runs, from the first call to an onboarded client. Written for daily use by CC. The system does the bookkeeping; this page is about the decisions only a person can make.

---

## The shape of it

1. A lead asks for the free audit, or you start one from their lead page (**Start AI audit**).
2. You run the discovery call and capture what the client tells you.
3. **Gate 1: you authorize** the client's information for processing. Nothing is researched or written before this. (The automated research and writing arrive in later phases. Today you write the profile and the audit yourself.)
4. The audit is drafted: nine sections, every finding labelled.
5. You price it from the confirmed catalogue, or type a price for custom work.
6. You submit it. The Mac prints the PDF.
7. **Gate 2: you approve the exact audit, PDF, proposal and email.** Only then does anything reach the client.
8. The client opens a private link, reads it, and can pay through Stripe.
9. Stripe confirms the payment. Pressing Pay never counts.
10. Onboarding starts by itself: client record, project, checklist, and a welcome email waiting for your one-tap approval.

Everything is on the **AI audits** board (Sales, AI audits): each engagement's stage, any flag, and the next thing to do.

---

## The four labels

Every finding in an audit carries exactly one of these. The client's page explains them with a legend.

| Label | Use it when | It needs |
|---|---|---|
| Verified fact | A source we can point to, a check we ran, or something the client confirmed with evidence | At least one source |
| Client-reported | The client told us, and we have not checked it | A source of kind "client" (the call) |
| Reasonable estimate | A calculation | Its inputs, its assumptions and a range |
| Hypothesis | A likely problem we have not confirmed | No figure of its own, and a way to test it |

**Never type a number you cannot point to.** A paragraph that states a figure must cite the finding, estimate or source it comes from, or the audit cannot be submitted. When you do not know something, put it under "What we could not verify". A visible gap builds more trust than a guess.

---

## Before the call

- Open the lead and choose **Start AI audit** if there is no engagement yet.
- Read what they wrote on the form and look at their website.
- Have one question ready for each figure the estimates need: lead volume, response time, close rate, average job value, hours on admin, the cost of an hour of staff time.
- Decide what you will **not** say: no prices, no promised results, no statistics you cannot source.

Decision point: if the business is not a fit, mark the engagement **declined** with a short reason and refer them on. Declining is a fine outcome.

## During the call

- Get consent to record, and say plainly that the call is analysed with AI services that work for OASIS.
- Ask about the business before any technology. AI comes in only after you understand their process.
- When they give a vague answer ("a lot of leads"), ask for a range and how they know.
- If they offer a password or a login, stop them. Access is set up later through Connections, never on a call or by email.
- Close with what happens next: a free audit, when to expect it, and that there is no obligation.

## Right after the call

- Move the engagement to **Discovery Call Completed**.
- Open **Discovery profile** and enter each fact with its label and where it came from. Mark something Verified only if you saw the evidence, and say what it was.
- Move to **Transcript Awaiting Approval** when the profile is complete. This is your Gate 1 moment: you are confirming the client's information may be used for the audit.

## Writing the audit

- **Sources first**, then **findings** (each with a label), then **estimates** (each with inputs, assumptions and a range).
- Then the nine sections. Every figure cites something. The editor checks this as you type, and the list at the top must be empty before you can submit.
- Use **Preview** to see exactly what the client will see.

## Pricing

- Prices come from the **Price catalogue** only after you confirm them there. Until then an item is "proposed" and cannot be used.
- For custom work, add a custom line and type the price yourself. The system records that you set it. Only the workspace owner can type a price: anyone else's line waits as "needs your price".
- A line with no price blocks submission. That is on purpose: no proposal goes out with a guessed fee.
- Catalogue items only price a proposal in their own currency. Switch a proposal's currency and its items wait for a price again.
- Set the tax rule once in **AI audit settings** before the first real proposal.
- Monthly fees are shown beside the total and start after launch. Optional add-ons are listed outside the total.

## Submitting and Gate 2

- Press **Submit for final approval**. The audit and proposal freeze, and the Mac prints the PDF (the Mac must be on). If the Mac fails to print three times, the engagement is flagged and you get one alert. Fix the Mac, then press **Retry PDF**.
- When the PDF is ready, an **AI audit delivery** card appears in **Feed, under Needs you**. Open the PDF from the engagement's Delivery tab, read the email on the card, and approve only if every word is right.
- Changed your mind? **Reopen for edits** before you approve. The frozen versions are kept, and new drafts open.
- Only the workspace owner can approve. An admin who presses Approve is told so, and the card stays waiting for you.
- Approving checks the stored PDF file itself, not just its record. If the file is missing or altered, nothing is sent: reopen the audit and submit it again.

Decision point: if the card says it ran in **dry run**, nothing was sent. Audit delivery has its own live switch (LIVE_SEND_AI_AUDIT), and the client's Pay button has another (LIVE_SEND_STRIPE_CHECKOUT). The general live-send switch turns on neither. Turn them on deliberately, then use **Retry delivery**, which appears after a dry run.

## After delivery

- The board shows when the client first opened it. Opening counts only when the page has been visible for a few seconds, so a mail scanner does not count.
- If it is **stalled** (not opened in 3 days, or opened and unpaid for 7), follow up in your own words. The system flags; it never chases the client by itself.
- Present the audit on a short call if they want one. Walk through the findings first and the price last.
- Objections: answer with the evidence in the audit, not with pressure. "Not now" is a valid answer; note when to check back.

## Payment and onboarding

- The client pays on Stripe's page. The engagement moves to **Payment Confirmed** only when the server has re-read the session from Stripe and the amount, currency and proposal all match.
- Marking an engagement **declined** or **cancelled** also stops its open payment link at Stripe. If a payment still lands (the client paid moments before), it is kept, the engagement is flagged, and you get an urgent alert. Nothing is refunded automatically: you decide.
- Onboarding then runs by itself: client record, delivery project, checklist, and a welcome email for your one-tap approval (it links the onboarding form and the kickoff booking page).
- When every checklist task is done, the engagement becomes **Active Client** and the lead moves into the build. That closes the audit cycle: the delivery project carries the client from there.

---

## When something goes wrong

| What you see | What to do |
|---|---|
| "Needs you: payment check" | Stripe's amount or binding did not match. Open Stripe, compare, and contact the client before anything else. |
| "Payment was refunded" or "disputed" | Nothing was deleted. Decide whether to pause the project; respond to a dispute in Stripe. |
| "Second payment for the same proposal" | Refund one in Stripe. Onboarding ran only once. |
| "Delivery failed" | Read the reason on the approval, fix it, then **Retry delivery**. |
| "Audit sent, but not yet recorded" | The client has the email. Do **not** retry: that would send a second one. The next tick finishes the record within five minutes. |
| "Payment received for a declined (or cancelled) audit" | The money is real and nothing was onboarded. Refund it in Stripe, or talk to the client and start a new engagement. |
| "PDF not printed" | The Mac failed three times. Check that it is on and online, then press **Retry PDF**. |
| The PDF never arrives | The Mac runner is off or offline. Turn the Mac on; the job is picked up within a minute. |
| The client asks for changes before paying | Reopen is only possible before delivery. After delivery, a revision is a new version and a new link (coming in a later phase; until then, answer by email). |
| The client asks you to delete their data | Write it down and tell CC's operations process; the data purge arrives in a later phase. |

## Testing safely

- The permanent test prospect is "[TEST] OASIS Audit Fixture Co", priced with a fixture-only catalogue item that never appears on a real proposal.
- Automated tests never send email or create Stripe sessions.
- The one live check (an email to your own inbox and one real but unpaid Stripe session, expired at once) runs only when you say go.
