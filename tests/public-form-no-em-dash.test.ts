/**
 * public-form-no-em-dash.test.ts - no em dash in the words a prospect reads on
 * a public form or offer page (2026-10-11, Adon: "business \u2014 and where",
 * "First \u2014 who am I talking to?" on the public AI audit page). An em dash
 * reads as machine-written in customer copy, so customer copy uses commas,
 * periods, colons or parentheses.
 *
 * Scans, with the TypeScript parser (never a pattern over comments), every
 * string literal, template text and JSX text in:
 *   - the code that draws public form and offer pages, and
 *   - the definitions that seed public forms (the OASIS funnels, the client
 *     onboarding form, the SunBiz templates, a new workspace's starter forms,
 *     the form themes' customer-facing headline and thanks text).
 *
 * The OPERATOR_ONLY list names the few strings in those files that only an
 * operator ever sees (the builder's preview label, the theme picker's
 * descriptions, an error a developer reads). Anything else with an em dash
 * fails this test.
 *
 * What this cannot see: copy already saved in the database. The live AI audit
 * form's steps are a row in `forms` (seeded from lib/forms/oasis-ai-audit-seed.ts
 * before this fix); its text changes only when that row is re-seeded or edited.
 *
 * Run: node --conditions=react-server --import tsx tests/public-form-no-em-dash.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DASH = "\u2014";

const SCAN = [
  "app/f",
  "components/offer-pages",
  "lib/offer-pages",
  "components/forms/FormPublicClient.tsx",
  "components/forms/FormRenderer.tsx",
  "components/forms/MultiFileDropzone.tsx",
  "components/forms/SignaturePad.tsx",
  "components/forms/AddressAutocompleteField.tsx",
  "components/forms/ComboboxField.tsx",
  "components/brand/SafeLogo.tsx",
  "lib/forms/oasis-ai-audit-seed.ts",
  "lib/forms/oasis-funnel-seed.ts",
  "lib/forms/oasis-client-onboarding-seed.ts",
  "lib/forms/sunbiz-templates.ts",
  "lib/forms/tenant-form-config.ts",
  "lib/forms/themes.ts",
];

/** Strings in the scanned files that only an operator or a developer ever reads. */
const OPERATOR_ONLY: ReadonlyArray<[string, string]> = [
  ["components/forms/FormRenderer.tsx", "Live preview"],
  ["lib/forms/themes.ts", "Matches sunbizfunding.com"],
  ["lib/forms/themes.ts", "Original SunBiz Funding intake"],
  ["lib/forms/themes.ts", "Deep navy + brass"],
  ["lib/forms/oasis-client-onboarding-seed.ts", "buildClientOnboardingRow: tenantId is required"],
];

function files(p: string, out: string[] = []): string[] {
  const full = join(ROOT, p);
  if (statSync(full).isDirectory()) {
    for (const n of readdirSync(full)) files(join(p, n), out);
  } else if (/\.(ts|tsx)$/.test(p)) out.push(full);
  return out;
}

/** Every literal or JSX text in `code` that holds an em dash, as `line: text`. */
export function dashedLiterals(code: string, fileName: string): Array<{ line: number; text: string }> {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const K = ts.SyntaxKind;
  const LITERALS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText]);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node) => {
    if (LITERALS.has(n.kind)) {
      const text = n.getText(sf);
      if (text.includes(DASH)) found.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: text.replace(/\s+/g, " ").trim() });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// The scanner itself must see a dash in each kind of literal, and none in a comment.
const probe = dashedLiterals(
  [
    `// a comment ${DASH} ignored`,
    `const a = "plain ${DASH} string";`,
    `const b = \`template ${DASH} text\`;`,
    `const c = <p>JSX ${DASH} text</p>;`,
  ].join("\n"),
  "probe.tsx",
);
assert.deepEqual(probe.map((p) => p.line), [2, 3, 4], "the scanner sees string, template and JSX text, and skips comments");

const offenders: string[] = [];
for (const p of SCAN) {
  for (const file of files(p)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    for (const hit of dashedLiterals(readFileSync(file, "utf8"), file)) {
      const allowed = OPERATOR_ONLY.some(([f, start]) => f === rel && hit.text.replace(/^["'`>]/, "").trimStart().startsWith(start));
      if (!allowed) offenders.push(`${rel}:${hit.line}: ${hit.text.slice(0, 120)}`);
    }
  }
}
assert.deepEqual(offenders, [], `em dash in customer copy:\n${offenders.join("\n")}`);

// The exact lines Adon saw on the public AI audit page, as they now read in the seed.
const seed = readFileSync(join(ROOT, "lib/forms/oasis-ai-audit-seed.ts"), "utf8");
for (const line of [
  "in your business, and where it doesn't.",
  '"First, who am I talking to?"',
  '"Optional, but it lets me look at your actual setup before we speak."',
  '"So I can follow up with you personally. I read every one."',
]) {
  assert.ok(seed.includes(line), `the AI audit seed reads: ${line}`);
}

console.log("public-form-no-em-dash: all passed");
