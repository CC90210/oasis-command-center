---
tags: [playbook, sales, ai-audit, runbook, founders]
updated: 2026-10-28
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

Everything is on the **AI audits** board (Sales, AI audits): where each audit's lead is on the Pipeline, the audit's step, any flag, and the next thing to do. Its **Setup** list says what a real audit still needs (confirmed prices, the tax rule, the Mac, PDF storage, private links, the mailbox, Stripe) and whether emails and payments to clients are live or in test mode. Anything marked **Needs you** stops a real audit: fix it there first. The same list is on AI audit settings.

---

## One pipeline

An audit is not a second pipeline. The deal has one set of stages, the **Pipeline's**, in both the Warm inbound and Cold outbound queues. The founder meeting is the audit's discovery call. The audit adds **steps** inside the Pipeline stages from the meeting onward:

| Pipeline stage | Audit steps inside it |
|---|---|
| Before the meeting (Assigned to Qualified) | Audit opened, Pre-call research |
| Founder Meeting | Meeting booked |
| Meeting Held | Profile from the call, Transcript to approve (Gate 1), Research and writing, Audit to approve (Gate 2) |
| Proposal Sent | Audit sent, Client reading it, At checkout |
| Won | Paid |
| Onboarding | Onboarding |
| In Build | Active client |

- The AI audits board counts each audit under the stage its lead is in on the Pipeline, under the same name and colour. On the Pipeline, a deal with an open audit shows **AI audit:** and its step on its row, linking to the audit.
- They move together. Each audit step moves the lead forward. When the lead moves on the Pipeline, the audit follows within five minutes: a founder meeting booked moves it to Meeting booked, and, on the lead's first audit, the lead at Meeting Held moves it to Profile from the call. A later audit holds its own meeting.
- **Lost on the Pipeline.** An audit that was never delivered and is not yet at final approval is declined with it. Once one was delivered, or its email may have gone out (a revision after delivery included), the client may still have a page and a Pay button; and at final approval an email may be pending. Then the audit is flagged for you instead: check it, then decline it on the audit to close them. The flag never hides a refund, a dispute or a failed step, and it clears by itself if the lead comes back from Lost.
- Starting a lead's first audit when it is already past the meeting starts it at Profile from the call.

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

- Open the lead and choose **Start AI audit** when the call is booked, if there is no engagement yet. An Oasis Meet call held after that attaches its transcript by itself; an engagement opened before the booking moves to Meeting booked by itself once the founder meeting is booked. A call held before the engagement was opened is attached by hand on **Call and transcripts**.
- Read the **pre-call research brief** at the top of **Call and transcripts**. It builds by itself once the engagement reaches Pre-call research or Meeting booked; press **Build the brief** to build it sooner or again. It shows:
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
- Any change to the profile or the transcripts afterwards withdraws the card; ask again. Once approved, the profile is frozen. To correct it, move the audit back to **Transcript to approve** and authorize again.

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
- **The opening, rewritten by AI.** After the draft exists, the AI engine you chose at Gate 1 (Claude on your Mac, or the workspace's cloud model) rewrites the draft's own paragraphs in four parts, the Executive Overview, the Current Business Assessment and the short introductions to Key Findings and to Estimated Business Impact, one paragraph for one, in plainer words. It is given only each paragraph and the facts it rests on, never the call's words or your notes. A rewrite replaces its paragraph only if every sentence in it uses nothing its paragraph and cited facts do not already hold: the same figures as the same kind of thing for the same period, none of them dropped; no new word, tool, company, "not", comparison ("more than", "up to") or result ("save", "win back"); a likely problem still said as likely; and no promise ("will"), price, cost or general rule ("most owners", "often"). Otherwise the draft's own paragraph stays, and the **Research** tab lists each sentence held back with why. If you edit the draft while the AI is writing, your edit wins and its answer is discarded; if the Mac's model call fails, press **Write the opening with AI** again for a fresh pass. With no AI engine authorized, nothing is rewritten.
- **The proposal draft.** One line for each catalogue item the opportunities need. A line is priced only from a confirmed catalogue item; every other line is marked as needing your price, and the proposal cannot be submitted until you price it.
- **Read it as the client will.** Personalise the wording, remove anything that does not fit, and check every figure against what it cites.

When you write or change a part yourself:

- **Sources first**, then **findings** (each with a label), then **estimates** (each with inputs, assumptions and a range).
- Then the nine sections. Every figure cites something. The editor checks this as you type, and the list at the top must be empty before you can submit.
- Use **Preview** to see exactly what the client will see.

## Pricing

- Prices come from the **Price catalogue** only after you confirm them there. Until then an item is "proposed" and cannot be used. You confirmed the catalogue on 2026-10-27: every price is in USD, and the paid security audit is retired (the free audit replaces it).
- For custom work, add a custom line and type the price yourself. The system records that you set it. Only the workspace owner can type a price: anyone else's line waits as "needs your price".
- A line with no price blocks submission. That is on purpose: no proposal goes out with a guessed fee.
- **USD is the core currency.** A client who would rather pay in CAD gets the same prices converted: set the exchange rate once in **AI audit settings** ("Use the Bank of Canada rate" fills it in; nothing changes until you save), then switch that client's proposal to CAD. Every catalogue line converts to the cent and shows the rate it used, and the client's page says so in one line under the price table. With no rate saved, a CAD proposal can use only prices you type. Prices you typed are never converted: check them when you switch currency.
- The tax rule is set: OASIS is not registered for HST yet (under the $30K small-supplier threshold), so proposals add no tax. When you register, change it in **AI audit settings** and add your number.
- Monthly fees are shown beside the total and start after launch. Optional add-ons are listed outside the total.
- **What the draft prices.** Each opportunity brings its catalogue item. The AI sales setter is drafted at the tier the catalogue describes for the client: launch for one lead source, scale for several. The complete tier is yours to choose. An item only the roadmap's Later column needs is drafted as an optional add-on, outside the total: a firm price for what to do now, and open options for later.
- **Payback on the cover.** The audit says how fast the work pays back only after you set **The client's figures are in** (the audit's business details) to the proposal's currency. It then works from the full one-time price, less any monthly fee, and counts only revenue from work in the price, never staff time. Without that setting, the audit makes no payback claim.

## Submitting and Gate 2

- Press **Submit for final approval**. The audit and proposal freeze, and the Mac prints the PDF (the Mac must be on). If the Mac fails to print three times, the engagement is flagged and you get one alert. Fix the Mac, then press **Retry PDF**.
- When the PDF is ready, an **AI audit delivery** card appears in **Feed, under Needs you**. Press **Open the audit and its PDF** on the card: the page the client will see, with the PDF they get at its top (**Download the PDF**). Read both and the email on the card, and approve only if every word is right.
- Changed your mind? **Reopen for edits** before you approve. The frozen versions are kept, and new drafts open.
- Only the workspace owner can approve. An admin who presses Approve is told so, and the card stays waiting for you.
- Approving checks the stored PDF file itself, not just its record. If the file is missing or altered, nothing is sent: reopen the audit and submit it again.

Decision point: if the card says it ran in **dry run**, nothing was sent; the engagement's overview says so too. Audit delivery, its follow-ups and a paying client's welcome email share their own live switch (LIVE_SEND_AI_AUDIT), and the client's Pay button has another (LIVE_SEND_STRIPE_CHECKOUT). The general live-send switch turns on neither. Turn them on deliberately, then use **Retry delivery**, which appears after a dry run. The overview and the Setup list say which switches are live. While payments are in test mode, a client who presses Pay is told payment is not open yet, and you get an urgent alert.

## After delivery

- The board shows when the client first opened it. Opening counts only when the page has been visible for a few seconds, so a mail scanner does not count.
- If it is **stalled** (not opened in 3 days, or opened and unpaid for 7), a short follow-up email waits for your approval in **Needs you**: one for each kind of stall, never more. It resends the same private link the client already has. Read it and approve it as it is; only the workspace owner can. If you would rather say something else, send the card back (or let it expire after 7 days) and reply from your inbox. It goes only to the address the audit was sent to, only if the client still has not paid and the link still works, and a "not opened" note only if they still have not opened it; nothing is ever sent by itself. A card that stops fitting while it waits (the client paid, declined or was sent a new link) is withdrawn by itself.
- Present the audit on a short call if they want one. Walk through the findings first and the price last.
- Objections: answer with the evidence in the audit, not with pressure. "Not now" is a valid answer; note when to check back.

## Payment and onboarding

- The client pays on Stripe's page. The engagement moves to **Paid** only when the server has re-read the session from Stripe and the amount, currency and proposal all match.
- Marking an engagement **declined** or **cancelled** also stops its open payment link at Stripe. If a payment still lands (the client paid moments before), it is kept, the engagement is flagged, and you get an urgent alert. Nothing is refunded automatically: you decide.
- Onboarding then runs by itself: client record, delivery project, checklist, and a welcome email for your one-tap approval. It links the client's own onboarding form (a personal link, so their answers attach to their record, not to a new lead) and the kickoff booking page. If the form cannot be linked, the email says a form follows, and you see that on the card before you approve. It goes to the address the audit was sent to, under the audit's own switch, so it goes out as soon as audits do.
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
| "A client could not pay" | They pressed Pay and no checkout opened: client payments are in test mode, Stripe is not connected, or Stripe refused (the alert says which). Fix it on the Setup list, then reply to the client. |
| The call had no transcript (a phone call, or no recording) | In the Gate 1 box on **Call and transcripts**, press **The call is done**, check the profile, then ask for authorization. |
| The PDF never arrives | The Mac runner is off or offline. Turn the Mac on; the job is picked up within a minute. |
| The client asks for changes before paying | Before delivery, press **Reopen for edits**. After delivery, press **Revise and send again** (owner only). Any payment page the client has open stops working at once, and the audit goes back to Research and writing with drafts copied from what the client has; the email is reworded as an update. The client keeps reading the delivered version until you submit, approve and send the new one: that delivery replaces their link, and the old one stops working; if that email fails, their earlier link works again. A paid audit cannot be revised, and Revise waits while money is moving: a payment Stripe confirmed, a checkout the client completed (a bank payment can take days to clear), or a Pay press still opening its page. If the drafts cannot be made, the engagement goes back to what the client has and you can press it again. |
| "Call transcript waiting" | An Oasis Meet transcript was not attached by itself; the alert says why. If the client's answer about AI analysis is missing, record it on the live-call screen and the next run attaches it. Otherwise open **Call and transcripts**, check that it is this audit's call, and attach it by hand. A guest who did not agree to the recording means it cannot be used; one over 500 KB is never cut: paste the part that matters instead. |
| The client asks you to delete a recorded call | Deleting the recording in Oasis Meet does not delete the copy attached to the audit. Delete the transcript under **Call and transcripts** too (only you can). |
| The client asks you to delete their data | Delete each transcript on the engagement (that wipes the call's words and voids the authorization), and the meeting in Oasis Meet if there was one. The lead itself cannot be deleted while it has an audit: the audit's history points at it. Write the request down for CC's operations process; the full data purge arrives in a later phase. |

## Testing safely

- The permanent test prospect is "[TEST] OASIS Audit Fixture Co", priced with a fixture-only catalogue item that never appears on a real proposal. It is set up once, on your go; until then, a lead with your own email address works for a run in test mode.
- Automated tests never send email or create Stripe sessions.
- In dry run, an approved follow-up is recorded, not sent, and that link gets no second card for the same reason. Test follow-ups on the fixture, never on a real client.
- The one live check (an email to your own inbox and one real but unpaid Stripe session, expired at once) runs only when you say go.

### The acceptance run, step by step

Each step is one of the ten acceptance checks (docs/BUILD_ACCEPTANCE_STANDARD.md). Every step but the last runs with live sending off, so nothing leaves the building.

1. **The fixture exists and stays apart.** Open the engagement for "[TEST] OASIS Audit Fixture Co" on the AI audits board. Its email is an inbox you own, it is marked as a fixture, and its only catalogue item is the fixture item. It is not created yet: it is set up once, on your go, before the first run.
2. **Only the owner passes a gate.** An admin who is not the owner presses approve on its Gate 1 card: the card waits for you.
3. **The settings resolve without showing a key.** The board's Setup list shows the Mac, PDF storage, private links, the mailbox and Stripe as ready, and both client switches as test mode, never a key's value.
4. **The inputs hold.** Paste the fixture transcript, with its traps: two different lead counts, an offered password and an instruction to the AI. The password is taken out, the two counts are flagged, and the instruction stays text.
5. **The work is right.** After you approve Gate 1, research runs, the audit and proposal are drafted, and every figure cites a source.
6. **It reads right.** Open Preview on a phone and on a desktop, then the PDF.
7. **The guards hold.** No transcript quote, line number or note of yours appears on the client page; every finding carries a label.
8. **Failures are handled.** Press Retry PDF with the Mac asleep: it waits, then asks you. Approving Gate 2 twice sends one email.
9. **The live canary (only when you say go).** With live sending on for this one run, approve Gate 2 for the fixture. One email reaches your own inbox. Pressing Pay opens one real Stripe page, which is expired at once. Nothing is paid.
10. **The receipt and the clean-up.** The board shows Audit sent with the email's message id, the Stripe session shows expired, and live sending is switched off again.
