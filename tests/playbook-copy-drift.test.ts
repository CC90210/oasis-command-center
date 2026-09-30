/**
 * playbook-copy-drift.test.ts - the Playbook never repeats a retired-stack
 * claim to an operator who may repeat it to a client.
 *
 * WHY (audit 2026-09-30, playbook-security-false-claims). /playbook/security,
 * billed as "the answer to is this safe for my client?", said isolation was
 * enforced by per-row database policies on the previous database, that the
 * encryption key lived on the previous host, and listed commands that no
 * longer run. OASIS runs on Turso (libSQL, no per-row policies: isolation is
 * the application's tenant_id filter) and Cloudflare Workers. The legal drift
 * test (tests/legal-compliance-drift.test.ts) scans only the public legal
 * pages, so nothing caught it under app/playbook.
 *
 * WHAT IS SCANNED
 *   app/playbook/**       every file, whole text (the pages)
 *   content/playbooks/**  every file, whole text (the bundled manual)
 *   lib/playbook/**       every string literal (what those pages render:
 *                         the security model, the catalog, the templates);
 *                         module specifiers are not rendered and not scanned.
 * BANNED: "RLS", "row-level security" (any case or hyphenation), "Supabase",
 * "Vercel"; and in the documents hub the stale OASIS facts the old catalog
 * carried: "GST/HST", "Q2 2026", "$5K MRR", and Ontario as OASIS's law or
 * place of incorporation.
 *
 * Run: node --conditions=react-server --import tsx tests/playbook-copy-drift.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["RLS", /\bRLS\b/],
  ["row-level security", /row[\s-]*level[\s-]*security/i],
  ["Supabase", /supabase/i],
  ["Vercel", /vercel/i],
];
// Stale OASIS facts (lib/business-docs.ts:98-237 before 2026-09-30).
const STALE_FACTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["GST/HST", /GST\s*\/\s*HST/i],
  ["Q2 2026", /\bQ2 2026\b/],
  ["$5K MRR", /\$\s*5\s*K\s*MRR/i],
  // Ontario is only ever named as what the old Drive drafts say, never as
  // OASIS's governing law or home.
  ["Ontario as OASIS's law", /\b(governing law|laws of|governed by)[^.\n]{0,60}\bOntario\b|\bOntario\b[^.\n]{0,40}\b(corporation|incorporat)|OASIS AI in Ontario/i],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every string literal and template chunk, skipping import/export module specifiers. */
function renderedStrings(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      out.push(n.text);
    } else if (ts.isJsxText(n)) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scan(): { scanned: string[]; hits: string[] } {
  const scanned: string[] = [];
  const hits: string[] = [];
  const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
  const check = (file: string, text: string, rules: ReadonlyArray<readonly [string, RegExp]>) => {
    for (const [name, re] of rules) if (re.test(text)) hits.push(`${rel(file)}: ${name}`);
  };
  for (const f of [...walk(join(ROOT, "app", "playbook")), ...walk(join(ROOT, "content", "playbooks"))]) {
    scanned.push(rel(f));
    const text = readFileSync(f, "utf8");
    check(f, text, BANNED);
    check(f, text, STALE_FACTS);
  }
  for (const f of walk(join(ROOT, "lib", "playbook")).filter((p) => /\.tsx?$/.test(p))) {
    scanned.push(rel(f));
    const text = renderedStrings(readFileSync(f, "utf8"), f).join("\n");
    check(f, text, BANNED);
    check(f, text, STALE_FACTS);
  }
  return { scanned, hits };
}

let failures = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

console.log("playbook-copy-drift:");
const { scanned, hits } = scan();

t("the scan covers every Playbook page, the bundled manual and the rendered hub sources", () => {
  for (const want of [
    "app/playbook/security/page.tsx",
    "app/playbook/page.tsx",
    "app/playbook/business/page.tsx",
    "app/playbook/business/[slug]/page.tsx",
    "app/playbook/client-deploy/page.tsx",
    "app/playbook/prompts/page.tsx",
    "content/playbooks/07-new-client-onboarding.md",
    "content/playbooks/10-oasis-loop.md",
    "lib/playbook/security-model.ts",
    "lib/playbook/catalog.ts",
  ]) {
    assert.ok(scanned.includes(want), `${want} was not scanned`);
  }
});

t("no Playbook page, manual or rendered hub source repeats a retired-stack claim or a stale OASIS fact", () => {
  assert.deepEqual(hits, []);
});

t("the security model states the real model: Turso, application-level tenant_id isolation, Worker secrets, R2", () => {
  const src = readFileSync(join(ROOT, "lib", "playbook", "security-model.ts"), "utf8");
  for (const fact of ["Turso", "tenant_id", "Cloudflare Worker secrets", "Cloudflare R2", "application-level isolation", "AES-256-GCM", "SHA-256"]) {
    assert.ok(src.includes(fact), `security model does not state: ${fact}`);
  }
  const page = readFileSync(join(ROOT, "app", "playbook", "security", "page.tsx"), "utf8");
  assert.match(page, /from "@\/lib\/playbook\/security-model"/, "the page must render from the one source");
});

t("the guard fires on each banned claim (planted), and not on an import specifier", () => {
  for (const planted of [
    "Every table is RLS-protected",
    "enforced by Row-Level Security policies",
    "row level security at every row",
    "One shared Supabase project",
    "master key on Vercel only",
  ]) {
    assert.ok(BANNED.some(([, re]) => re.test(planted)), `must reject: ${planted}`);
  }
  for (const planted of ["GST/HST registration threshold", "tax calendar for Q2 2026", "anchor to CC's $5K MRR", "governing law (Ontario)", "OASIS AI in Ontario"]) {
    assert.ok(STALE_FACTS.some(([, re]) => re.test(planted)), `must reject: ${planted}`);
  }
  assert.deepEqual(renderedStrings('import { x } from "@/lib/supabase-server";\nconst y = "ok";', "x.ts"), ["ok"]);
  assert.ok(!STALE_FACTS.some(([, re]) => re.test("both Drive drafts say 60/40 and Ontario")), "naming what the old drafts say is allowed");
});

if (failures > 0) {
  console.error(`playbook-copy-drift: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`playbook-copy-drift: all passed (${scanned.length} files scanned)`);
