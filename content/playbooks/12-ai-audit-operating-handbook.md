---
tags: [playbook, sales, ai-audit, runbook, founders]
updated: 2026-10-26
---

# Free AI Audit: operating handbook

> How one Free AI Audit runs, from the first call to an onboarded client. Written for daily use by CC. The system does the bookkeeping; this page is about the decisions only a person can make.

---

## The shape of it

1. A lead asks for the free audit, or you start one from their lead page (**Start AI audit**).
2. You run the discovery call and capture what the client tells you.
3. **Gate 1: you authorize** the client's information for processing: an approval card, in Needs you, that names the exact profile, transcripts and call notes. Nothing is researched or written, and nothing can be submitted, before you approve it. Research then runs by itself, and the audit and its proposal are drafted from it (see Research and Writing the audit, below). You read and edit every word.
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
- Read the **pre-call research brief** at the top of **Call and transcripts**. It builds by itself once the engagement reaches Research in Progress or Discovery Call Scheduled; press **Build the brief** to build it sooner or again. It shows:
  - what their website shows, checked by the Command Center (Verified), such as whether visitors can book online, call in one tap, or chat;
  - what they said on the form (Client-reported);
  - likely problems to test on the call (Hypotheses, never facts until the client confirms them);
  - the questions to spend time on, and what could not be checked.
- The brief reads only the business's own public website, with plain requests, and never sends their details to an AI service. A social profile instead of a website is listed for you to look at by hand.
- Have one question ready for each figure the estimates need: lead volume, response time, close rate, average job value, hours on admin, the cost of an hour of staff time.
- Decide what you will **not** say: no prices, no promised results, no statistics you cannot source.

Decision point: if the business is not a fit, mark the engagement **declined** with a short reason and refer them on. Declining is a fine outcome.

## During the call

Run it from the **live-call screen** (Call and transcripts, Open the live-call screen): the questions in order, notes that save as you type, a box for each figure, and what the audit still needs. The Discovery Call Handbook explains every question.

- Get consent to record, and say plainly that the call is analysed with AI services that work for OASIS.
- Ask about the business before any technology. AI comes in only after you understand their process.
- When they give a vague answer ("a lot of leads"), ask for a range and how they know.
- If they offer a password or a login, stop them. Access is set up later through Connections, never on a call or by email.
- Close with what happens next: a free audit, when to expect it, and that there is no obligation.

## Right after the call

- Open **Call and transcripts**. Paste or upload the transcript (.txt, .vtt or .srt), tick that the client agreed to the recording, and say whether they agreed to AI analysis. Answer both again for each transcript. A call held in the lead's Oasis Meet room needs none of that: its transcript joins the engagement by itself once Meet has it ready, timed from the start of the meeting, when every guest agreed to the recording on joining and you recorded the client's answer about AI analysis on the profile (the opening question; an answer another founder records, or one labelled a hypothesis, does not count). Otherwise it waits under Transcripts, with the reason and an alert, and only you attach it, saying what the client agreed to. It waits when that answer is missing, when part of the audio did not reach the server, when a guest was removed or no guest is heard, or when it was attached to an audit before. A call that ended before the engagement was opened is not attached by itself and raises no alert: it is listed under Transcripts for you to attach by hand. If you recorded that the client said no to the recording, no transcript of the call can be used, from Meet or pasted. Record the answer later and the next run attaches it. A guest who did not agree to the recording means the Meet transcript cannot be used at all. A Meet transcript you delete is never attached again by itself. Deleting the meeting in Oasis Meet does not delete the copy attached to the audit: delete it here too if the client asked for their call to be deleted. Attaching one again with the other answer about AI analysis is refused: delete it first, then attach it.
- What looks like a password, a PIN, a card or account number or a key is taken out before the transcript is stored, and the screen says how many. No check catches every way a person can say one, so press **View lines** and read what is stored before you ask for authorization. Only you (the workspace owner) can delete a transcript; after Gate 1, deleting one cancels the authorization.
- Open **Discovery profile** and check each fact: its label and where it came from. Mark something Verified only if you saw the evidence, and say what it was. Figures you typed on the live-call screen are already there.
- Press **Ask for authorization**. The card lists what will be frozen, who processes it (Claude on your Mac, the cloud account, or no AI if the client said no), and what is still missing. Approve it in **Needs you**. Only the owner can.
- Any change to the profile or the transcripts afterwards withdraws the card; ask again. Once approved, the profile is frozen. To correct it, move the engagement back to **Transcript Awaiting Approval** and authorize again.

## Research

Research starts by itself within a few minutes of your approval at Gate 1, on the engagement's **Research** tab, and moves one step every five minutes:

1. It reads the client's website again, obeying its robots.txt, and checks it. That is our own measurement, so it is Verified.
2. It runs Google PageSpeed for the home page, as a phone sees it. Also our own measurement.
3. Your Mac searches the web with the business's public facts only: its name, website, city and kind of business. Nothing the client said on the call goes into the search. The search is Claude on your Mac, so it runs only when that is the engine you authorized at Gate 1; with the cloud model or no AI engine, research goes on without it and says so under Gaps.
4. The Command Center reads each page the search found itself, under that site's own robots.txt, and stores the text around each claim. A page behind a login (Instagram, Facebook, LinkedIn) is listed as a gap and never read.
5. The evidence rules decide every label. A page's claim counts as Verified only when one passage of one sentence of the page states it: every figure in it, each counting the same thing ("120 reviews" is never "120 photos") with the same "over" or "under"; every long word and most of the rest; the same yes or no and the same tense (a page that says "not available" never proves "available", and "formerly offered" never proves "offers"); and never the opposite word ("closed" never proves "open"). A page that answered with an error proves nothing. A listing proves something only when it is the business's own: it names the business and, when the business's city, web address or phone is known, shows one of them. On it, the business's name must come just before the figures, with no other business's name or figures and no "similar", "sponsored" or "featured" in between, so a competitor's rating on the business's page is never the business's. Each figure counts only what the page ties to it ("Reviews (95)", "4.5 stars"): a date, a sub-score or a number between two different labels counts nothing. A claim about a competitor is about the name it gives itself, held to the same rules. A claim written in another script is never Verified. A true claim these rules hold back is not lost: the panel lists it with the reason, and you can add the fact yourself when you review the draft. A published benchmark needs a public body or a named research firm, and a date in the last three years; any other site is not a reliable source for figures. Anything that fails is downgraded or dropped, never upgraded, and the panel lists what was taken out and why. A figure you marked as a hypothesis in the profile is not used in an estimate: the estimate is listed under Gaps until you confirm the figure.

The tab then shows what was measured and confirmed, what the client said (from the profile you authorized), the likely problems to test, the estimates with their inputs and assumptions, every gap, and every source with what was stored from it.

- **Estimates are ranges.** Each rests on the client's own figures and on assumptions shown as ranges. If you know better for this business, change a range under **Assumptions**: the estimates on the page follow at once, and the stored run keeps the ranges it was built with. Only the owner changes them.
- **The web search waits for your Mac.** If no Mac runs it within six hours, research carries on without it and says so under Gaps. Turn the Mac on and press **Research again** for a full run.
- **Research again** builds a new version. Earlier versions stay exactly as they were.
- Research stops by itself when the authorization stops holding (a transcript deleted, the engagement moved back, declined or cancelled), and the stored research is deleted: at once when a transcript is deleted, otherwise within a few minutes. Authorize again and it runs again.
- A stored run holds the profile's answers as you authorized them, never quotes from the call; for each answer it keeps where it came from (the transcript's line numbers), for you only.
- A step that fails is tried again after 1 minute, then after 5. A third failure stops the run and you get an alert: press **Research again**.

## Writing the audit

When the first research run finishes, the audit and the proposal are drafted for you. You can draft them again from the **Research** tab (**Next: the audit and the proposal**); that replaces what the draft says, and the page asks first.

- **What the draft holds.** The research's findings, sources, estimates and gaps as they stand, with the labels the evidence rules gave them. The opportunities come from fixed rules over those findings, each citing what it rests on; the roadmap puts the quick wins first. The wording is fixed and plain. A figure appears only where it cites the finding or estimate that holds it.
- **What it leaves out.** Nothing internal reaches the client: no line numbers, no quotes from the call, none of your notes, no budget, and none of the questions written for you. The client's own sources show as "our discovery call with you", "your answers on the audit form" and "confirmed with you".
- **The opening, written by AI.** After the draft exists, the AI engine you chose at Gate 1 (Claude on your Mac, or the workspace's cloud model) rewrites four parts in plainer words: the Executive Overview, the Current Business Assessment, and the short introductions to Key Findings and to Estimated Business Impact. It is given only the draft's own findings, estimates, opportunities and gaps, never the call's words or your notes. Each sentence it writes is checked before it is kept: every figure must be one that the finding or estimate it cites states, for the same period ("10 calls a week" is not "10 calls a month"); a name, a time frame or a general rule ("most owners", "studies show") must be one the audit already states; and it may not promise a result or mention prices. A sentence that fails is held back, and the **Research** tab lists it with the reason. A part where nothing passed keeps the draft's own wording. If you edit the draft while the AI is writing, your edit wins and its answer is discarded. With no AI engine authorized, nothing is rewritten. To run it again, press **Write the opening with AI**.
- **The proposal draft.** One line for each catalogue item the opportunities need. A line is priced only from a confirmed catalogue item; every other line is marked as needing your price, and the proposal cannot be submitted until you price it.
- **Read it as the client will.** Personalise the wording, remove anything that does not fit, and check every figure against what it cites.

When you write or change a part yourself:

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
| "Payment was refunded" or "disputed" | Nothing was deleted. Decide whether to pause the project; respond to a dispute in Stripe. Refunding the duplicate of two payments leaves the proposal paid, and onboarding carries on. |
| "Second payment for the same proposal" | Refund one in Stripe. Onboarding ran only once. |
| "Delivery failed" | Read the reason on the approval, fix it, then **Retry delivery**. |
| "Audit sent, but not yet recorded" | The client has the email. Do **not** retry: that would send a second one. The next tick finishes the record within five minutes. |
| "Audit email may have been sent" | The mail server stopped answering after taking the email. Look in the Sent folder. If it is there, press **It was sent**. If not, press **It was not sent: send again**, which stops the old link first. |
| "Payment received for a declined (or cancelled) audit" | The money is real and nothing was onboarded. Refund it in Stripe, or talk to the client and start a new engagement. |
| "Research stopped" on the Research tab | The authorization no longer holds: a transcript was deleted, or the engagement moved back. Authorize again, then press **Research again**. |
| Research is waiting on the web search | The Mac is off or offline. After six hours research carries on without the search, with a gap. Turn the Mac on and press **Research again** for a full run. |
| "PDF not printed" | The Mac failed three times. Check that it is on and online, then press **Retry PDF**. |
| The PDF never arrives | The Mac runner is off or offline. Turn the Mac on; the job is picked up within a minute. |
| The client asks for changes before paying | Reopen is only possible before delivery. After delivery, a revision is a new version and a new link (coming in a later phase; until then, answer by email). |
| "Call transcript waiting" | An Oasis Meet transcript was not attached by itself; the alert says why. If the client's answer about AI analysis is missing, record it on the live-call screen and the next run attaches it. Otherwise open **Call and transcripts**, check that it is this audit's call, and attach it by hand. A guest who did not agree to the recording means it cannot be used; one over 500 KB is never cut: paste the part that matters instead. |
| The client asks you to delete a recorded call | Deleting the recording in Oasis Meet does not delete the copy attached to the audit. Delete the transcript under **Call and transcripts** too (only you can). |
| The client asks you to delete their data | Write it down and tell CC's operations process; the data purge arrives in a later phase. |

## Testing safely

- The permanent test prospect is "[TEST] OASIS Audit Fixture Co", priced with a fixture-only catalogue item that never appears on a real proposal.
- Automated tests never send email or create Stripe sessions.
- The one live check (an email to your own inbox and one real but unpaid Stripe session, expired at once) runs only when you say go.
