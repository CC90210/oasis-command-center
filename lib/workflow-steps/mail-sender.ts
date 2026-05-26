/**
 * mail-sender step — V6.9.5.1 (correctness over functionality).
 *
 * V6.9.2 shipped a broken wire format (would 400 at bridge).
 * V6.9.5 fixed the wire format by routing through the bridge's `send_email`
 * tool — but `send_email` calls `scripts/integrations/google_tool.py` which
 * is documented at google_tool.py:262 as an OPERATOR CLI exception that
 * INTENTIONALLY BYPASSES `send_gateway`. Pipeline / agent-driven outbound
 * MUST route through `send_gateway` (CASL + cooldown + daily-cap chokepoint),
 * per ADR-0003.
 *
 * Until the bridge exposes a `send_gateway` tool (V6.9.X.x deferred — bridge-
 * side work in scripts/bravo_cli/bridge_chat_server.py), this step refuses
 * to fire from a workflow context. Better to fail with a clear setup pointer
 * than silently bypass the empire chokepoint.
 *
 * Input shape (preserved for when the chokepoint surface ships):
 *   { to: string | string[],
 *     subject: string,
 *     body: string,
 *     from?: string,
 *     tenant_brand?: string }
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type MailSenderInput = {
  to?: string | string[];
  subject?: string;
  body?: string;
  from?: string;
  tenant_brand?: string;
};

const handler: WorkflowStep = {
  type: "mail-sender",
  async execute(rawInput: unknown, _ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as MailSenderInput;
    // Surface input validation errors even when the step is gated off, so
    // workflow authors can see they shaped the inputs correctly.
    if (!input.to) return { status: "failed", error: "missing_to" };
    if (!input.subject) return { status: "failed", error: "missing_subject" };
    if (!input.body) return { status: "failed", error: "missing_body" };

    return {
      status: "failed",
      error:
        "send_gateway_not_yet_exposed_via_bridge: mail-sender requires a bridge-exposed send_gateway tool to honor ADR-0003 (CASL + cooldown + daily-cap chokepoint). Bridge currently exposes send_email which bypasses send_gateway by design (see scripts/integrations/google_tool.py:262). V6.9.X.x deferred — bridge-side work in scripts/bravo_cli/bridge_chat_server.py must expose send_gateway as a tool_name first.",
    };
  },
};

export default handler;
