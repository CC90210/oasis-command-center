---
tags: [onboarding, client, playbook, operator]
updated: 2026-09-30
---

# New Client Onboarding - Operator Playbook

Audience: operator

**Who:** an OASIS founder standing up a client's workspace.
**When:** a business has signed and needs its Command Center.
**Status (2026-09-30):** the in-app client setup flow is being rebuilt. Every step below is what the product does today; a step it does not do yet says **Missing - needs CC** and what is needed.

---

## What is shared and what is per client

- **One application.** Every client signs in at https://oasisai.work. It runs on Cloudflare Workers; there is no per-client deploy and no per-client domain.
- **One database.** Turso (libSQL). Every tenant-scoped table carries a `tenant_id`, and the application filters every query on it. The isolation is enforced by the application, not by database policies, so never describe it to a client as database-enforced.
- **Per client:** a workspace (a `tenants` row and its manifest), the people invited into it, the AI account it connects, and the apps it connects.

## Step 1 - Create the workspace and its first owner

Today a client workspace and its first owner are created from the BEA harness with `scripts/provision_client_tenant.py` (it reads `CLIENT_EMAIL`, `CLIENT_PASSWORD`, `CLIENT_BRAND` and `CLIENT_FULL_NAME` from the environment, so no credential sits in the command). An owner cannot be invited from inside the app: the invite form never offers the Owner role.

**Missing - needs CC:** confirm this is the path to use until the in-app client setup ships, and who sends the owner their first password.

## Step 2 - The owner invites their team

The owner (or an administrator) opens **Team** and sends invites. In a client workspace the roles offered are **Team member** and **Administrator**; the OASIS sales roles are offered only inside OASIS's own workspaces. Each invite is a link to `/invite/<token>`; the person signs up from that link and lands in the workspace.

## Step 3 - Connect an AI account

A department channel answers only when the workspace has its own AI account connected in **Settings > AI** (`/settings/ai`). Until then each channel says "No AI account is connected for this workspace yet" and tells an owner where to connect one. OASIS's own key never answers a client's channel.

## Step 4 - What the client sees in the departments

- **Sales** and **Client Success** have a neutral AI teammate for every workspace.
- **Chief of Staff, Marketing, Finance and Operations** say "This department's AI teammate has not been set up for your workspace yet." Do not promise them until they are built.
- Channel replies are drafts. Nothing is sent from a channel.

## Step 5 - Connect their apps

The owner connects their apps in **Settings > Connections** (`/settings/connections`). Each app shows its own connected or not-connected state; do not tell a client an app is connected until that page says so.

## Step 6 - Support

Clients ask for help through the support form at `/f/oasis-ai-cc/support`. A submission becomes a ticket on the **Support desk** (`/tickets`), never a lead.

## What to NOT promise

- **Installing anything on the client's computer.** The desktop bridge install for clients is paused until the desktop runner ships (see the Client deployment runbook).
- **A per-client database or data residency outside the United States.** Turso stores every workspace in the United States (the privacy policy's sub-processor list says so).
- **A per-client domain.** Every client signs in at oasisai.work.

## When something breaks

- **A department channel says "Not working".** The last message reached the AI provider and was refused; the channel shows the provider's reason. Most often the key has no credit or was revoked: the owner replaces it in Settings > AI.
- **An invite link does not work.** Invites expire; send a new one from Team (a new invite replaces the old one for the same email).
- **Anything that looks like another client's data.** Stop and tell CC at once. It is a Law 25 confidentiality incident until proven otherwise and goes in the incident register (Playbook > Business documentation > Law 25 incident register).
