/**
 * mail-sender step — V6.9.2.
 *
 * Sends an outbound email through the existing `send_gateway` chokepoint
 * (scripts/integrations/send_gateway.py in CEO-Agent). The empire
 * chokepoint enforces CASL compliance + daily caps + cooldowns; this
 * step must NOT bypass it. Calls the bridge's /exec-tool endpoint with
 * the send_gateway tool name.
 *
 * Input shape:
 *   { to: string | string[],
 *     subject: string,
 *     body: string,             // HTML or plaintext
 *     from?: string,            // optional override; defaults to tenant brand
 *     reply_to?: string,
 *     tenant_brand?: string }   // optional brand selector for send_gateway
 *
 * Per-run cap enforcement: each call decrements ctx.outbound_cap_remaining.
 * Run aborts when cap hits 0 (caller's responsibility to enforce; this
 * step short-circuits with `failed` when called past the cap).
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type MailSenderInput = {
  to?: string | string[];
  subject?: string;
  body?: string;
  from?: string;
  reply_to?: string;
  tenant_brand?: string;
};

const handler: WorkflowStep = {
  type: "mail-sender",
  async execute(rawInput: unknown, ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as MailSenderInput;
    if (!input.to) return { status: "failed", error: "missing_to" };
    if (!input.subject) return { status: "failed", error: "missing_subject" };
    if (!input.body) return { status: "failed", error: "missing_body" };
    if (ctx.outbound_cap_remaining <= 0) {
      return { status: "failed", error: "outbound_cap_exhausted" };
    }

    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    if (recipients.length > ctx.outbound_cap_remaining) {
      return {
        status: "failed",
        error: `outbound_cap_would_exceed: ${recipients.length} recipients, ${ctx.outbound_cap_remaining} remaining`,
      };
    }

    /* Route through bridge's send_gateway invocation surface. The bridge
       URL + token resolution is bridge-config; we read from env. The
       /exec-tool endpoint is the canonical operator-machine channel for
       outbound. */
    const bridgeUrl = process.env.BRAVO_BRIDGE_URL ?? "http://localhost:9100";
    const bridgeToken = process.env.BRAVO_BRIDGE_TOKEN ?? "";

    try {
      const res = await fetch(`${bridgeUrl}/exec-tool`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}),
        },
        body: JSON.stringify({
          tool: "send_gateway",
          tenant_id: ctx.tenant_id,
          run_id: ctx.run_id,
          input: {
            channel: "email",
            to: recipients,
            subject: input.subject,
            body: input.body,
            from: input.from,
            reply_to: input.reply_to,
            tenant_brand: input.tenant_brand,
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { status: "failed", error: `send_gateway_http_${res.status}: ${text.slice(0, 200)}` };
      }
      const payload = (await res.json()) as { ok?: boolean; error?: string; send_id?: string };
      if (!payload.ok) {
        return { status: "failed", error: payload.error || "send_gateway_unknown_error" };
      }
      return { status: "complete", output: { send_id: payload.send_id, recipient_count: recipients.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", error: `bridge_unreachable: ${message}` };
    }
  },
};

export default handler;
