import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const corePath = join(process.cwd(), "lib/notify/bounce-alert-core.ts");
  assert.ok(existsSync(corePath), "bounce watchdog needs a reusable per-brand decay identity");

  const core = await import("../lib/notify/bounce-alert-core");
  const t0 = new Date("2026-09-23T09:00:00Z");

  assert.notEqual(
    core.bounceAlertKey("sunbiz"),
    core.bounceAlertKey("bluerise"),
    "independent mailboxes must not suppress each other's first alert",
  );
  assert.equal(
    core.bounceFailureSignature("imap", "Socket timeout at 09:00:01"),
    core.bounceFailureSignature("imap", "Socket timeout at 09:00:19"),
    "volatile retry details must not mint a new incident signature",
  );

  const stateByKey = new Map<string, {
    lastSignature: string;
    lastAlertedAt: string;
    repeatN: number;
  }>();
  let sends = 0;
  for (const [brand, offsetMs] of [
    ["sunbiz", 0],
    ["sunbiz", 20_000],
    ["bluerise", 0],
    ["bluerise", 20_000],
  ] as const) {
    const key = core.bounceAlertKey(brand);
    const decision = core.decideBounceAlert(
      "imap",
      "Socket timeout",
      stateByKey.get(key),
      new Date(t0.getTime() + offsetMs),
    );
    if (decision.send) {
      sends += 1;
      stateByKey.set(key, {
        lastSignature: decision.signature,
        lastAlertedAt: new Date(t0.getTime() + offsetMs).toISOString(),
        repeatN: decision.nextRepeatN,
      });
    }
  }
  assert.equal(
    sends,
    2,
    "two brands plus their immediate scheduler retries must page twice, not four times",
  );

  const route = readFileSync(
  join(process.cwd(), "app/api/cron/scan-bounces/route.ts"),
  "utf8",
);
  assert.ok(
    route.includes('from "@/lib/notify/bounce-alert-core"'),
    "route must use the shared bounce decay identity",
  );
  assert.ok(route.includes('.from("ops_alert_state")'), "route must persist alert decay state");
  assert.ok(route.includes("resetBounceAlert"), "a healthy scan must reset the incident episode");
  assert.ok(
    !route.includes("IMAP connect to submissions@ failed"),
    "alert must not hardcode the SunBiz mailbox for every brand",
  );
  assert.ok(
    route.includes("IMAP connect to ${escapeTelegramHtml(mailboxLabel)} failed"),
    "alert must name the actual mailbox",
  );

  console.log("scan-bounces alert decay: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
