/**
 * Writes the Skills tab as static HTML pages (Training, Library, a kind of work, the skill sheet)
 * from the synthetic fixture, for the web-design-audit screenshots (JARVIS plan 3, Task 12).
 * Usage: node --import tsx tests/skills-tab-static.render.ts <out-dir>   (then compile app.css into <out-dir>)
 *
 * D9 (progress.md): every class on the wrapper markup below must already be generated from a real
 * app source (app/, components/, content/ - tailwind.config.ts's content globs), never a class
 * that lives only in this test file, because this file is outside those globs and would compile to
 * nothing. Where no real-app class covers it (the sheet's fixed panel width), inline style is used
 * instead. `mx-auto w-full max-w-7xl px-4 md:px-8 py-6 md:py-8` mirrors components/MainShell.tsx's
 * real CONTENT_WIDTH canvas verbatim, so the audit sees the actual production content width, not an
 * invented one.
 */
export {};

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: skills-tab-static.render.ts <out-dir>");
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { SkillsTabView } = await import("../components/playbook/skills/SkillsTab");
  const { LibraryView } = await import("../components/playbook/skills/LibraryView");
  const { SkillSheetBody } = await import("../components/playbook/skills/SkillSheet");
  const F = await import("./skills-tab-fixture");
  const noop = () => undefined;
  const base = { lib: F.LIB, computer: F.COMPUTER, computers: [F.COMPUTER], changes: F.CHANGES, nowIso: F.NOW, onRefresh: noop };
  const pages: Record<string, string> = {
    training: renderToStaticMarkup(React.createElement(SkillsTabView, base)),
    library: renderToStaticMarkup(React.createElement(SkillsTabView, { ...base, initialView: "library" })),
    group: renderToStaticMarkup(React.createElement(LibraryView, { lib: F.LIB, group: "debug", onGroup: noop, onOpenSkill: noop })),
    // D9: `max-w-[440px]` has no match anywhere in app/components/content (the real sheet uses
    // `lg:w-[440px]`, a different utility string), so the width is inline style, not a class.
    // `rounded-2xl border border-hairline bg-bg-raised p-5` are each already generated elsewhere
    // (components/playbook/skills/SkillSheet.tsx itself uses "border border-hairline bg-bg-raised";
    // rounded-2xl and p-5 are each used in dozens of other app files).
    sheet: `<div style="max-width:440px" class="rounded-2xl border border-hairline bg-bg-raised p-5">${renderToStaticMarkup(React.createElement(SkillSheetBody, { lib: F.LIB, name: "graft", onAction: noop }))}</div>`,
  };
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(pages)) {
    writeFileSync(join(out, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skills ${name}</title><link rel="stylesheet" href="app.css"></head><body class="bg-bg-rail text-fg"><main class="mx-auto w-full max-w-7xl px-4 md:px-8 py-6 md:py-8">${body}</main></body></html>`);
  }
  console.log(`wrote ${Object.keys(pages).length} pages to ${out}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
