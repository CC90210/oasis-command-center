/**
 * mail-sender step — V6.9.5 (hotfix from V6.9.2).
 *
 * Sends outbound email through the bridge `/exec-tool` endpoint using the
 * existing `send_email` cloud tool. The bridge's `send_email` handler
 * routes through `scripts/integrations/google_tool.py` (operator's Gmail
 * OAuth) which itself respects the empire's CASL + cap chokepoints.
 *
 * Wire format per `lib/cloud-tool-runner.ts:496` + `lib/prompts-library.ts:569`:
 *   POST /exec-tool { tool_name: "send_email", input: { to, subject, body, from? } }
 *
 * The `send_email` tool's `to` field is a single string. For multi-recipient
 * sends we loop sequentially and stop on first failure, accumulating success
 * count so the workflow_run audit shows partial-send state honestly.
 *
 * Input shape:
 *   { to: string | string[],
 *     subject: string,
 *     body: string,             // HTML or plaintext
 *     from?: string }           // optional override; defaults to operator's primary Gmail
 *
 * Per-run cap enforcement: this step honors ctx.outbound_cap_remaining.
 * Returns `failed: outbound_cap_would_exceed` BEFORE any send when the
 * recipient count exceeds the remaining cap.
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type MailSenderInput = {
  to?: string | string[];
  subject?: string;
  body?: string;
  from?: string;
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
    if (recipients.length === 0) return { status: "failed", error: "empty_recipient_list" };
    if (recipients.length > ctx.outbound_cap_remaining) {
      return {
        status: "failed",
        error: `outbound_cap_would_exceed: ${recipients.length} recipients, ${ctx.outbound_cap_remaining} remaining`,
      };
    }

    const bridgeUrl = process.env.BRAVO_BRIDGE_URL ?? "http://localhost:9100";
    const bridgeToken = process.env.BRAVO_BRIDGE_TOKEN ?? "";

    const successes: string[] = [];
    const failures: Array<{ to: string; error: string }> = [];

    for (const recipient of recipients) {
      try {
        const res = await fetch(`${bridgeUrl}/exec-tool`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}),
          },
          body: JSON.stringify({
            tool_name: "send_email",
            input: {
              to: recipient,
              subject: input.subject,
              body: input.body,
              ...(input.from ? { from: input.from } : {}),
            },
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          failures.push({ to: recipient, error: `http_${res.status}: ${text.slice(0, 200)}` });
          break;
        }
        const payload = (await res.json()) as { ok?: boolean; error?: string };
        if (!payload.ok) {
          failures.push({ to: recipient, error: payload.error || "bridge_unknown_error" });
          break;
        }
        successes.push(recipient);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ to: recipient, error: `bridge_unreachable: ${message}` });
        break;
      }
    }

    if (failures.length > 0) {
      return {
        status: "failed",
        error: `partial_send: ${successes.length} sent, first failure on ${failures[0].to}: ${failures[0].error}`,
      };
    }
    return {
      status: "complete",
      output: { recipient_count: successes.length, recipients: successes },
    };
  },
};

export default handler;
