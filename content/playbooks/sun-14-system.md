---
tags: [sunbiz, onboarding, manual, system]
---

# System

Audience: Client-facing

The plumbing behind the pipeline: importing leads, your intake forms, the drip campaigns, your team, automations, and settings.

## Import

Bring in leads by CSV — two lanes.

- **Warm pipeline tab** — paste or upload a CSV straight into Leads. Set a default source, choose Skip duplicates by email / phone / business, then **Import N leads**. **Insert sample** shows the expected columns; **View leads** opens the result.
- **Cold list tab** — a holding pen for prospecting. Pick or create a list, upload a CSV, map each column (Business / Contact / Phone / Email / Skip), then **Import**. Work them through the stage rail (Imported, Contacted, Replied, Qualified, Promoted, Dead); **Promote** moves a contact into the warm pipeline.

## Forms

Your three application forms plus your personal links. This replaced JotForm.

- **Three step cards:** Initial Lead Capture (the short interest form), Full Application (the full app), Bank Statement Upload. Each has **Open form editor** and **Preview live form**.
- **Per-agent links** — **Copy** buttons for Jordan, Alex, and Matt. This is the link you share with prospects — a lead from your link is assigned to you automatically.

95% of your time here is just clicking Copy on your own link.

## Sequences

The automatic drip campaigns — welcome messages, reminders, nudges that fire on stage changes.

- **The list** shows each sequence with a **Live / Paused** toggle, **Edit**, and **Delete**.
- **New sequence** — start one from a template.
- The **new-lead welcome email** — Full Application + Bank Statement links, signed by the assigned agent — is sent **automatically the instant a prospect submits the interest form**. That's a built-in form action, *not* a drip you manage here; the sequences in this list are the **follow-up nudges** that fire on later stage changes (viewed, sent, signed, missing info, declined, …).
- An older **Inquiry Welcomer** drip ships **Paused** — leave it off. The automatic welcome email above replaces it; turning it on would double-message new leads.

Mostly set-and-forget. You'll rarely touch this beyond toggling one on or off.

## Team

Add and manage teammates.

- **Generate link** creates a one-time, 7-day invite link; **Copy** it to send. Optionally set the email and a Role (Admin, Loan officer, Processor, Read only, Member).
- **Revoke** kills a pending invite; **Remove** takes a member off the tenant.

## Automations

The scheduled background jobs running for SunBiz (lead scoring, follow-up checks, daily briefs).

- **New automation** — name it, pick an agent, set a schedule (friendly Preset or raw Custom cron).
- **Draft with AI** — describe what you want in plain English ("every Monday 7am, pull funded deals and text me a summary") and the agent writes the script; **Inspect generated Python** to see it; Save, then flip the toggle on.
- **Toggle / Edit / Delete** existing jobs.
- **Background workers** — the always-on VPS daemons that run the pipeline (sequence runner, lender-reply classifier, cold-outreach runner, sentinel, chat bridge, cron poller, event router). You see each one's health, and as an **owner/admin** you can **Start / Stop / Restart** any of them — the signal goes straight to the server. Other roles see them read-only.

Agents rarely need this. It's here for power moves later.

## Settings

Configuration — owner-level.

- **Profile** — your name, phone, targets. Save profile.
- **Branding** — upload the SunBiz logo.
- **Integrations** — API keys for the tools (TextTorrent, Kixie, email, etc.): Save, Test, Clear.
- Team invites, password, device pairing, and AI provider keys also live here.

Matt (owner) handles this. Alex and Jordan rarely need it.
