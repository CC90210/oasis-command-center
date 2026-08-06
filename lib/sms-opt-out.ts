import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Was this inbound reply an opt-out?
 *
 * THIS WAS ANCHORED AND EXACT until 2026-08-05: /^(STOP|UNSUBSCRIBE|QUIT|
 * CANCEL|END)$/i. A bare unpunctuated keyword matched and nothing else did, so
 * "Stop." with a period, "STOP!", "please stop texting me" and "take me off
 * your list" all sailed through as ordinary replies.
 *
 * The effect was measurable: 600 outbound SMS over 30 days produced ZERO
 * recorded opt-outs and ZERO suppression rows, against an expected 1-5%.
 *
 * That is not a style problem. 47 CFR 64.1200(a)(10), in force since
 * 2025-04-11, requires honoring revocation by ANY REASONABLE MEANS — a
 * consumer may not be required to use a particular word. Statutory damages are
 * $500 per message, $1,500 willful, with a private right of action and no cap.
 *
 * Detection now lives in lib/sms/compliance.ts, which is pure and tested
 * against both the regulatory keywords and natural-language revocation, and is
 * checked for FALSE POSITIVES too ("I want to cancel my other loan" must not
 * suppress a live deal).
 */
import { detectOptOut } from "@/lib/sms/compliance";

export function isStopCommand(body: unknown): boolean {
  if (typeof body !== "string") return false;
  return detectOptOut(body).optOut;
}

/** The full verdict, for callers that want to route "likely" opt-outs to human
 *  review while still suppressing immediately. Suppression is not deferred
 *  pending review: honoring late is the violation. */
export function classifyOptOut(body: unknown) {
  return detectOptOut(typeof body === "string" ? body : "");
}

function findCaslComplianceScript(): string | null {
  const roots = Array.from(new Set([
    process.cwd(),
    resolve(process.cwd(), "../.."),
  ]));

  for (const root of roots) {
    const candidate = join(root, "scripts", "casl_compliance.py");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function suppressPhoneViaCasl(
  phone: string,
  source: "twilio_inbound" | "texttorrent_inbound",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const script = findCaslComplianceScript();
  if (!script) {
    return Promise.resolve({ ok: false, error: "scripts/casl_compliance.py not found" });
  }

  const repoRoot = dirname(dirname(script));
  const pythonBin = process.env.PYTHON_BIN || process.env.PYTHON || "python";

  return new Promise((resolveResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveResult(result);
    };

    const proc = spawn(
      pythonBin,
      [
        script,
        "suppress-phone",
        "--phone",
        phone,
        "--reason",
        "stop_received",
        "--source",
        source,
      ],
      { cwd: repoRoot, shell: false, windowsHide: process.platform === "win32" },
    );

    timeout = setTimeout(() => {
      if (!settled) {
        proc.kill();
        finish({ ok: false, error: "casl_compliance.py suppress-phone timed out" });
      }
    }, 10_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        const detail = (stderr || stdout || `exit ${code}`).slice(0, 500);
        finish({ ok: false, error: detail });
      }
    });
  });
}
