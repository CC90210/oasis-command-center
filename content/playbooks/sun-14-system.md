---
tags: [sunbiz, operations, manual, system]
---

# Systems

Audience: Client-facing

Systems is the operational plumbing: imports, forms, sequences, team access, automations, and settings.

## Import

Use Import for CSV work.

- **Warm pipeline** imports known leads straight into the working pipeline.
- **Cold list** imports prospects for outreach before they become warm leads.
- Map columns deliberately. Bad names, phones, or emails create duplicate work.
- Skip duplicates when possible.

## Forms

Forms is where the SunBiz funnel lives.

- **Initial Lead Capture** creates the first lead.
- **Full Application** collects lender-ready merchant data.
- **Bank Statement Upload** captures the core document package.
- Rep-specific links should be used for Ezra, Ethan, and Matt so leads route to the right owner.
- If a rep's email, phone, or role changes, update Team/settings first and confirm the live link before sharing it publicly.

## Sequences

Sequences are the automated nudges that follow stage changes.

- Keep the built-in welcome path aligned with the forms.
- Do not turn on duplicate welcome drips.
- Review any paused sequence before enabling it. A paused sequence may be paused for compliance or duplication reasons.

## Templates

Templates are the approved HTML email assets at `/templates`.

- Use them for cold outreach, follow-up, consolidation, seasonal, and vertical campaigns.
- Check merge fields before copying HTML into a sending system.
- Do not remove unsubscribe language.
- If the copy needs a new campaign angle, create a new template source instead of editing the generated file directly.

## Team

Team controls who can work inside the tenant.

- Matt owns admin access.
- Ezra and Ethan should have only the permissions they need for their lane.
- Revoke unused invites.
- Remove old accounts instead of letting stale access linger.

## Automations

Automations are the background workers and scheduled jobs.

- Treat worker controls like production switches.
- Restart only when there is a real operational reason.
- If a job affects sending, imports, lender outreach, or deal state, tell Matt before changing it.

## Settings

Settings is owner-level.

- Branding, integrations, AI keys, device pairing, and account settings live here.
- Test integrations after changing them.
- Do not paste secrets into chat, notes, or playbook docs.
