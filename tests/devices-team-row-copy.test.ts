/**
 * devices-team-row-copy.test.ts - D0: Team computers mislabelled. Every row
 * in "Team computers" (components/settings/YourComputersCard.tsx) reused
 * rowLine's not_approved text, "Waiting for your approval" -- true wording
 * for the viewer's OWN device, false for a teammate's: CC's Mac and CCPC
 * told Adon THEY were waiting on his approval of them, which was never true.
 *
 * Fix: a separate teamRowLine for Team computers only, which never says
 * "your"/"you" and always names the owner (falling back to "a teammate" /
 * "A teammate's computer" when the owner's name could not be resolved).
 * "Your computers" (the viewer's own list) is untouched -- "Waiting for
 * your approval" there is correct, it is literally the viewer's own device.
 *
 * Run: node --conditions=react-server --import tsx tests/devices-team-row-copy.test.ts
 */
import assert from "node:assert/strict";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const { teamRowLine } = await import("../components/settings/YourComputersCard");
  // timeAgo() (inside YourComputersCard.tsx) reads the real wall clock
  // (Date.now()), not an injectable "now" -- so RECENT/OLD must be relative
  // to the ACTUAL current time, never a fixed calendar date, or "X ago"
  // reads as "just now" (ms < 0) whenever the fixed date is in the future
  // relative to whenever this test actually runs.
  const NOW = Date.now();
  const RECENT = new Date(NOW - 10_000).toISOString(); // 10s ago: online
  // lib/devices/presence.ts: ONLINE_MS = 150_000, IDLE_MS = 600_000. 5
  // minutes ago is inside that band -- idle, never offline, never "online".
  const IDLE_AGO = new Date(NOW - 5 * 60_000).toISOString();
  const OLD = new Date(NOW - 20 * 60_000).toISOString(); // 20min ago: offline

  console.log("devices-team-row-copy:");

  check("a not-approved team row names the owner and says 'Online', never 'your approval'", () => {
    const line = teamRowLine("CC's computer", "CC", "not_approved", null, RECENT, NOW);
    assert.doesNotMatch(line, /your approval/i, `team row still says "your approval": ${line}`);
    assert.doesNotMatch(line, /\byou\b|\byour\b/i, `team row addresses the viewer directly: ${line}`);
    assert.match(line, /\bCC\b/, `team row does not name the owner: ${line}`);
    assert.equal(line, "CC's computer · Online · not yet approved by CC for department work");
  });

  check("a not-approved team row for an IDLE teammate's computer (150-600s heartbeat) says 'Idle', never 'Online' (Codex review, P2)", () => {
    const line = teamRowLine("CC's computer", "CC", "not_approved", null, IDLE_AGO, NOW);
    assert.equal(line, "CC's computer · Idle · not yet approved by CC for department work");
    assert.doesNotMatch(line, /\bOnline\b/, `an idle heartbeat read as Online: ${line}`);
  });

  check("a not-approved team row for an offline teammate's computer still never says 'your approval'", () => {
    const line = teamRowLine("CCPC", "CC", "not_approved", null, OLD, NOW);
    assert.doesNotMatch(line, /your approval/i, `team row still says "your approval": ${line}`);
    assert.match(line, /Offline since/, `an offline teammate's row does not say so: ${line}`);
    assert.match(line, /not yet approved by CC/);
  });

  check("an unresolved owner name falls back to 'a teammate', never blank, never 'your'", () => {
    const line = teamRowLine("A teammate's computer", "a teammate", "not_approved", null, RECENT, NOW);
    assert.doesNotMatch(line, /your approval/i);
    assert.match(line, /not yet approved by a teammate for department work/);
  });

  check("can_answer / busy / offline / blocked team rows are unaffected (same wording as the viewer's own list)", () => {
    assert.equal(teamRowLine("CC's computer", "CC", "can_answer", RECENT, RECENT, NOW), "CC's computer · Ready for department work, checked 10 s ago");
    assert.equal(teamRowLine("CC's computer", "CC", "busy", null, RECENT, NOW), "CC's computer · Finishing a reply");
    assert.equal(teamRowLine("CC's computer", "CC", "offline", null, OLD, NOW), "CC's computer · Offline since 20 min ago");
    assert.match(teamRowLine("CC's computer", "CC", "blocked:subscription_auth_failure", null, RECENT, NOW), /Claude Code is signed out/);
  });

  // ── The source itself: the "Team computers" render block must call
  // teamRowLine, never the plain rowLine it used to share with the
  // viewer's own list (a regression in the WIRING, not the function, would
  // slip past every check above).
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "..", "components/settings/YourComputersCard.tsx"), "utf8");
  const teamBlock = src.slice(src.indexOf('summary className="cursor-pointer'), src.indexOf("</details>"));
  check("the Team computers render block calls teamRowLine, not the bare rowLine it used to share with the viewer's own list", () => {
    assert.match(teamBlock, /teamRowLine\(/, "Team computers no longer calls teamRowLine");
    assert.doesNotMatch(teamBlock, /[^.]\browLine\(/, "Team computers still calls the plain rowLine (the original bug)");
  });

  if (failures) {
    console.error(`devices-team-row-copy: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("devices-team-row-copy: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
