/**
 * tests/marketing-contrast.test.ts - fg-faint never colours readable text on
 * the public marketing site.
 *
 * WHY (2026-10-12 oasisai.work technical audit, PER-02)
 * -----------------------------------------------------
 * Lighthouse failed color-contrast on every commercial page: the footer's
 * "Registered in ..." line used text-fg-faint, #45454b on #050608 = 2.12:1
 * against a 4.5:1 floor (WCAG 2.2 AA). app/globals.css already marks fg-faint
 * "decorative only"; nothing enforced it. fg-dim (#82828a) is ~5.3:1.
 *
 * RULE: on marketing surfaces, `text-fg-faint` is allowed only on an element
 * hidden from assistive tech (aria-hidden="true"), and never as placeholder
 * text. Borders (border-fg-faint) are decoration and stay allowed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(__dirname, "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const files = [
  ...tsxFiles(join(root, "components/marketing")),
  ...tsxFiles(join(root, "app/(marketing)")),
];
assert.ok(files.length > 10, "scanned the marketing surfaces");

const offenders: string[] = [];
for (const file of files) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const where = `${relative(root, file)}:${i + 1}`;
    if (/placeholder:text-fg-faint/.test(line)) offenders.push(`${where} placeholder text`);
    // `text-fg-faint` as a class token (not hover:/placeholder: variants),
    // skipping comments that merely mention it.
    if (/(^|["'`\s])text-fg-faint\b/.test(line) && !/^\s*(\/\/|\*|\{\/\*)/.test(line)) {
      if (!/aria-hidden="true"/.test(line)) offenders.push(`${where} text without aria-hidden`);
    }
  });
}
assert.deepEqual(offenders, [], `fg-faint used for readable text:\n${offenders.join("\n")}`);

console.log("marketing-contrast: all assertions passed");
