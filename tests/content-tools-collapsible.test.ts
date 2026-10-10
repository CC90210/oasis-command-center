/**
 * tests/content-tools-collapsible.test.ts — Content Tools page: both
 * sections (Tools, Whiteboard) are the same disclosure
 * (components/leads/CollapsibleSection.tsx), proven two ways without a
 * browser:
 *
 *   1. CollapsibleSection's own server markup, for a few prop combinations:
 *      aria-expanded reflects the open/closed state, children are drawn ONLY
 *      when open (not merely hidden with CSS), and the toggle is a real
 *      <button type="button"> - keyboard-operable by construction (Enter and
 *      Space are the browser's own default activation on a button; this file
 *      adds nothing for that).
 *   2. The real Content Tools page (app/founders/marketing/tools/page.tsx),
 *      through the real founder gate: it wires exactly two
 *      CollapsibleSection elements, "Tools" and "Whiteboard", each with its
 *      own storageKey (so Adon's choice on one never collapses the other)
 *      and open by default (defaultCollapsed={false}, this page's behaviour
 *      before 2026-10-10).
 *
 * NOT covered here (needs a real browser): that a click actually flips the
 * section and that the choice survives a reload via localStorage. Both are
 * plain DOM/localStorage behaviour with no server-renderable surface to pin;
 * CollapsibleSection's toggle()/localStorage code is read here, not driven.
 *
 * Run: node --conditions=react-server --import tsx tests/content-tools-collapsible.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as ReactNS from "react";
import { USERS, check, finish, login, setupToolsDatabase } from "./_tools-harness";

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the
// classic runtime, which expects a global React (same as every other
// page-render check in this suite).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const root = join(__dirname, "..");

function renderMarkup(cases: Array<{ id: string; defaultCollapsed: boolean }>): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/content-tools-collapsible.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step;
    // react-dom/server refuses to load under it, so the child drops it.
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { markup: Record<string, string> }).markup;
}

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as El, ...nodes((n as El).props.children)] : [];

async function main() {
  console.log("content-tools-collapsible:");

  await check("CollapsibleSection: aria-expanded and the children follow defaultCollapsed; the toggle is a real button", () => {
    const m = renderMarkup([
      { id: "open", defaultCollapsed: false },
      { id: "closed", defaultCollapsed: true },
    ]);
    assert.match(m.open, /<button type="button"[^>]*aria-expanded="true"/, "open: a real button, aria-expanded true");
    assert.match(m.closed, /<button type="button"[^>]*aria-expanded="false"/, "closed: aria-expanded false");
    assert.match(m.open, /the body is here/, "open: the children are drawn");
    assert.doesNotMatch(m.closed, /the body is here/, "closed: the children are not drawn at all, not merely hidden");
  });

  await check("the Content Tools page wires Tools and Whiteboard as two independent, open-by-default disclosures", async () => {
    await setupToolsDatabase();
    await login(USERS.cc);
    const { CollapsibleSection } = await import("../components/leads/CollapsibleSection");
    const Page = (await import("../app/founders/marketing/tools/page")).default;
    const tree = await Page();
    const sections = nodes(tree).filter((n) => n.type === CollapsibleSection);
    assert.deepEqual(
      sections.map((s) => [s.props.title, s.props.storageKey, s.props.defaultCollapsed]),
      [
        ["Tools", "content-tools:tools", false],
        ["Whiteboard", "content-tools:whiteboard", false],
      ],
      "two sections, each its own storage key, both open by default",
    );
  });

  finish("content-tools-collapsible");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
