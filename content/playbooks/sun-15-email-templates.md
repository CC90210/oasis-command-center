---
tags: [sunbiz, operations, manual, templates, email]
---

# HTML Outreach Pipeline

Audience: Client-facing

This is the first SunBiz playbook because the HTML library is not just reference material. It is the working pipeline for picking a design, handing it to Helios, sending an approved email, and creating new HTML assets when the current library does not cover the campaign.

## The Workflow

1. Open **Template Library** from the Playbook card or the sidebar.
2. Search or filter until you find the right design.
3. Click **Preview** to inspect the rendered HTML with sample SunBiz data.
4. Check the merge fields on the card or modal footer.
5. Click **Use with Helios** to open the Agent tab with the template key, subject, and required variables preloaded.
6. Tell Helios the lead or campaign target.
7. Review the merged subject and body.
8. Approve only when the recipient, variables, unsubscribe link, and send intent are correct.

No template should jump straight to a real send. The Agent tab is the review lane.

## Create New HTML

Use **Create New HTML** when the campaign needs a fresh design.

The button opens Helios with a build prompt. Helios should ask for:

- campaign goal,
- audience or vertical,
- sender lane (Ezra, Ethan, or Matt),
- required merge fields,
- CTA,
- compliance footer,
- whether the new template is cold outreach, follow-up, consolidation, seasonal, or vertical.

After the draft is approved, the source belongs under `lib/cold-outreach/templates/`, then the generated catalog must be refreshed. Do not hand-edit `lib/cold-outreach/templates.generated.ts`.

## What Is In The Library

The current library contains 28 HTML templates:

- Cold outreach and first-touch funding offers.
- Follow-up and re-engagement emails.
- Abandoned application recovery.
- Consolidation and debt-stack messaging.
- Seasonal campaigns.
- Industry-specific templates for construction, restaurants, retail/ecommerce, and similar verticals.

## Required Variables

The templates use merge fields. The page shows the variables per template before you copy HTML.

- `{{first_name}}` - merchant contact first name.
- `{{business_name}}` - merchant business name.
- `{{year}}` - current year.
- `{{unsubscribe_url}}` - required commercial-email opt-out link.
- `{{rep_name}}`, `{{rep_title}}`, `{{rep_phone}}`, `{{rep_email}}` - SunBiz sender details.
- `{{city}}`, `{{industry}}` - local/vertical context when a template needs it.
- `{{prequal_amount}}` - pre-qualified amount for offer-style copy.
- `{{referral_reward}}` - referral incentive when a referral template uses it.

Never send a commercial template with unresolved variables. Never remove `{{unsubscribe_url}}`.

## Page Controls

- **Search** finds by template name, subject, file key, or merge field.
- **Category filters** narrow the library to first touch, T1-T5 cadence, follow-up, consolidation, vertical, or seasonal.
- **Preview** renders the email in a sandboxed frame with sample values.
- **HTML** shows source code for inspection.
- **Copy HTML** copies the raw HTML when another system needs it.
- **Use with Helios** opens the Agent tab with this exact design selected.
- **Create Variant** asks Helios to build a new HTML using the selected design as the reference point.

## Who Uses Which Templates

- **Ezra** uses first-touch, follow-up, vertical, and seasonal templates to create momentum.
- **Ethan** uses application-abandoned, missing-doc, consolidation, and offer-context templates to move files forward.
- **Matt** reviews templates that affect brand, lender relationships, compliance posture, or a new campaign angle.
- **Helios** can help select and adapt copy, but a human reviews before real sends.
- **Solara** can explain where a template fits in the pipeline, but Helios owns sales/outreach language.

## Source Of Truth

The page reads from `lib/cold-outreach/templates.generated.ts`, which is generated from the HTML files under `lib/cold-outreach/templates/`. Edit source HTML, regenerate, then verify the Templates page. Do not hand-edit the generated file.
