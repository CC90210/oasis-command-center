# AI provider applications — drafts for CC to sign (2026-09-29)

CC signs and sends both. Plan v2 §F4.5.

Replies are recorded in the brain router's terms policy table (plan §F4.3). Nothing is built on subscription login until one of these is approved in writing.

---

## 1. Anthropic — contact sales

**Send via:** https://www.anthropic.com/contact-sales. This is the channel Anthropic's Claude Code legal page names for questions about permitted authentication methods.

**Subject:** OASIS OS: permitted authentication for a Claude-powered business operating system

Hello,

I run OASIS AI Solutions in Montreal, with my co-owner Adon. We are building **OASIS OS**, a web and desktop "business operating system" for service businesses doing $10–50K a month. Each business gets departments (Sales, Marketing, Client Success, Finance, Operations and a Chief of Staff) that are AI teammates. They draft, research and run routine work. Every outward action waits for a human approval.

We build on Claude and want to stay squarely inside your terms. Our default is that each client connects their **own Claude API key** (or Claude through their own Bedrock, Vertex or Foundry account), stored encrypted per client and used only for that client. We have three questions:

1. **Plan login approval.** Your Agent SDK docs say third-party developers may not offer claude.ai login or plan rate limits "unless previously approved". Many of our clients already pay for Claude Pro or Max and ask to use it. Can OASIS OS apply for that approval? If so, what are the criteria and the process?

2. **The unmodified Claude Code binary.** Your Claude Code legal page permits "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code." Our desktop app would launch the client's own, unmodified `claude` binary on the client's own computer, after the client signed in through Anthropic's own flow. We would never read, copy or proxy their credentials, and we would never resell usage. Does that cover **scheduled, unattended jobs for the client's own business** (for example a weekly finance report), or should scheduled work always use an API key?

3. **Our own team.** Today our two-person company's shared automations run on one founder's Max plan. We intend to move them to a Claude API workspace under your Commercial Terms, and we would welcome guidance on the right plan (Team or API) and on your DPA and data-retention options for our clients' data.

We are also evaluating Claude Managed Agents with a self-hosted sandbox for our cloud runner, and would welcome a contact there.

Thank you,
Conaugh McKenna
Co-founder, OASIS AI Solutions — conaugh@oasisai.work — https://oasisai.work

---

## 2. OpenAI — "Sign in with ChatGPT" interest form

**Send via:** https://openai.com/form/sign-in-with-chatgpt-interest/ (the form for paid or remotely hosted apps).

The answers to paste into the form's fields follow.

- **Company:** OASIS AI Solutions (Montreal, Canada). Website: https://oasisai.work
- **Product:** OASIS OS, a paid web and desktop business operating system for service businesses doing $10–50K a month. It has AI department teammates (Sales, Marketing, Client Success, Finance, Operations, Chief of Staff), and every outward action requires human approval.
- **Hosting:** remotely hosted (Cloudflare Workers), plus an optional desktop app on the client's own computer.
- **Use of ChatGPT plan usage:**
  - Clients who already pay for ChatGPT Plus or Pro could power their departments with their own plan instead of an API key.
  - Text and function-tool calls through the Responses API.
  - On the desktop app, the Codex app-server for coding-harness jobs (for example, writing and testing a small automation script) in the client's own workspace folder.
- **Safeguards:**
  - Per-client data isolation.
  - Approvals before any outward action.
  - Per-app spending caps shown to the owner.
  - No sharing of one user's plan across users.
  - We never collect or store ChatGPT credentials outside the official flow.
- **Expected volume:** early pilots in Q4 2026 (under 20 businesses), growing through 2027.
- **Contact:** Conaugh McKenna, conaugh@oasisai.work

---

## Status

| Application | Sent | Reply | Recorded in the policy table |
|---|---|---|---|
| Anthropic contact sales | — | — | — |
| OpenAI SIWC interest form | — | — | — |

Related: `06-agent-runtime-harness-onboarding.md` §2 · plan v2 §F4.
