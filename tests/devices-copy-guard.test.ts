/**
 * tests/devices-copy-guard.test.ts - every screen that connects a computer
 * calls it the OASIS AI Command Center bridge, never Claude Code.
 *
 * CC, 2026-10-02 (tracker #62, raised twice): Settings > Devices said "Install
 * Claude Code CLI bridge ... your dashboard chat will use your local Claude
 * Code subscription". The bridge "has nothing to do with Claude Code": it
 * connects a computer so agents can run automations, use its terminal and
 * start command-line tools, whatever model they use.
 *
 * WHAT IS CHECKED. The text a viewer can see in each file below, read with the
 * TypeScript parser so comments and import paths never count: string literals
 * (JSX attribute values included), template-literal chunks, and the text of
 * every JSX element with its children joined (so a phrase split across
 * elements or {" "} is still one phrase). None of it may name Claude Code, a
 * Claude subscription, `bravo setup`, .env.agents, the CEO-Agent repository or
 * `gh auth`. The new names are pinned too, so a revert to other wording fails.
 *
 * TWO ALLOWANCES, each structural and each pinned below:
 *   - The collapsed <details> whose <summary> is "OASIS team computers only",
 *     in the operator's install modal and install wizard only. The full install
 *     clones a private repository, so OASIS's own computers need the GitHub
 *     CLI signed in; that paragraph stays there, closed by default.
 *   - In LocalCliProvidersCard's CARDS catalogue, the label "Claude Code": the
 *     card lists the command-line tools a computer can run (Claude Code, Codex
 *     CLI, Gemini CLI) by their own names. That is the "whatever model" choice,
 *     not the bridge's name. Only that exact label, as a `label`, is allowed.
 *
 * Run: node --conditions=react-server --import tsx tests/devices-copy-guard.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");

const FORBIDDEN = /Claude Code|Claude subscription|bravo setup|\.env\.agents|CEO-Agent|gh auth/i;
const OPERATOR_BLOCK = "OASIS team computers only";
/** Dynamic JSX content ({expr}) joins nothing: a phrase cannot run through it. */
const GAP = " | ";

const ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&bull;": "*",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};
const decode = (s: string) => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);
const squash = (s: string) => decode(s).replace(/\s+/g, " ").trim();

type Hit = { line: number; text: string };
type Scan = {
  /** Every visible string: literals, template chunks, each JSX element's joined text. */
  visible: Hit[];
  /** Visible strings that match FORBIDDEN and no allowance covers. */
  offenders: Hit[];
  /** One entry per operator <details> block: its joined text and whether it renders open. */
  operatorBlocks: Array<{ text: string; open: boolean }>;
  /** Forbidden strings the CLI-catalogue allowance let through. */
  catalogueAllowed: Hit[];
};

type Options = {
  /** Skip the "OASIS team computers only" <details> block (operator surfaces only). */
  operatorBlocks?: boolean;
  /** Name of the CLI catalogue whose `label: "Claude Code"` is allowed. */
  catalogue?: string;
};

function tagName(el: ts.JsxElement | ts.JsxSelfClosingElement, sf: ts.SourceFile): string {
  return (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText(sf);
}

function attributeNames(el: ts.JsxElement): string[] {
  return el.openingElement.attributes.properties
    .filter(ts.isJsxAttribute)
    .map((a) => a.name.getText());
}

export function scanVisibleText(code: string, fileName: string, opts: Options = {}): Scan {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out: Scan = { visible: [], offenders: [], operatorBlocks: [], catalogueAllowed: [] };

  const isOperatorBlock = (n: ts.Node): n is ts.JsxElement => {
    if (!ts.isJsxElement(n) || tagName(n, sf) !== "details") return false;
    const summary = n.children.find((c): c is ts.JsxElement => ts.isJsxElement(c) && tagName(c, sf) === "summary");
    return Boolean(summary) && squash(summary!.children.map((c) => (ts.isJsxText(c) ? c.text : GAP)).join("")) === OPERATOR_BLOCK;
  };

  /** The CLI catalogue's own label for Claude Code: `label: "Claude Code"` inside `const <catalogue> = ...`. */
  const isCatalogueLabel = (n: ts.StringLiteral): boolean => {
    if (!opts.catalogue || n.text !== "Claude Code") return false;
    const prop = n.parent;
    if (!prop || !ts.isPropertyAssignment(prop) || prop.initializer !== n || prop.name.getText(sf) !== "label") return false;
    for (let p: ts.Node | undefined = prop.parent; p; p = p.parent) {
      if (ts.isVariableDeclaration(p)) return p.name.getText(sf) === opts.catalogue;
    }
    return false;
  };

  /** The text of a JSX node with its children joined, as React would print the static parts. */
  const joined = (n: ts.Node): string => {
    if (ts.isJsxText(n)) return n.text.replace(/\s+/g, " ");
    if (ts.isJsxExpression(n)) {
      const e = n.expression;
      if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
      return GAP;
    }
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      if (opts.operatorBlocks && isOperatorBlock(n)) return GAP;
      return n.children.map(joined).join("");
    }
    return GAP;
  };

  const record = (line: number, text: string, allowed = false) => {
    const t = squash(text);
    if (!t) return;
    out.visible.push({ line, text: t });
    if (!FORBIDDEN.test(t)) return;
    if (allowed) out.catalogueAllowed.push({ line, text: t });
    else out.offenders.push({ line, text: t });
  };

  /** Records each JSX element's joined text, innermost match only. Returns whether a match was recorded inside. */
  const visitJsx = (n: ts.JsxElement | ts.JsxFragment): boolean => {
    let inner = false;
    for (const child of n.children) {
      if (ts.isJsxElement(child) || ts.isJsxFragment(child)) {
        if (opts.operatorBlocks && isOperatorBlock(child)) continue;
        inner = visitJsx(child) || inner;
      }
    }
    const text = squash(joined(n));
    if (!text) return inner;
    out.visible.push({ line: lineOf(n), text });
    if (!inner && FORBIDDEN.test(text)) {
      out.offenders.push({ line: lineOf(n), text });
      return true;
    }
    return inner || FORBIDDEN.test(text);
  };

  const visit = (n: ts.Node): void => {
    // Module paths are not words on a screen.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (opts.operatorBlocks && isOperatorBlock(n)) {
      out.operatorBlocks.push({
        text: squash(n.children.map(joined).join("")),
        open: attributeNames(n).includes("open"),
      });
      return;
    }
    if ((ts.isJsxElement(n) || ts.isJsxFragment(n)) && !(n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)))) {
      // The outermost element of a JSX tree: walk its element text once.
      visitJsx(n);
    }
    if (ts.isStringLiteral(n)) record(lineOf(n), n.text, isCatalogueLabel(n));
    else if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      record(lineOf(n), n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const show = (hits: Hit[]) => hits.map((h) => `${h.line}: ${h.text.slice(0, 110)}`);

console.log("devices-copy-guard:");

// -- The scanner catches what it claims to (synthetic sources) ---------------
check("JSX text, attribute values, string literals and template chunks are all read", () => {
  const cases: Array<[string, string]> = [
    ["<h2>Install Claude Code CLI bridge</h2>", "a.tsx"],
    ['<button title="paste it during `bravo setup`">x</button>', "a.tsx"],
    ['confirm("Re-pair via `bravo setup`.");', "a.ts"],
    ["const m = `uses your Claude subscription ${n}`;", "a.ts"],
    ["const m = `${n} reads your .env.agents`;", "a.ts"],
    ['const s = { privacy: "runs through the Claude Code you are logged into" };', "a.ts"],
  ];
  for (const [code, file] of cases) {
    assert.equal(scanVisibleText(code, file).offenders.length, 1, code);
  }
});
check("a phrase split across JSX children is still one phrase", () => {
  assert.equal(scanVisibleText('<p>your local Claude{" "}Code login</p>', "a.tsx").offenders.length, 1);
  assert.equal(scanVisibleText("<p>click <strong>Install</strong> Claude Code here</p>", "a.tsx").offenders.length, 1);
  assert.equal(scanVisibleText("<p>\n  your local Claude\n  Code login\n</p>", "a.tsx").offenders.length, 1);
  // Dynamic content separates words: no phrase runs through an expression.
  assert.equal(scanVisibleText("<p>Claude{name}Code</p>", "a.tsx").offenders.length, 0);
});
check("a match is reported once, at the innermost element that holds it", () => {
  const hits = scanVisibleText("<div><p>ok</p><p><span>Claude Code</span> here</p></div>", "a.tsx").offenders;
  assert.deepEqual(show(hits), ["1: Claude Code"]);
});
check("comments and import paths are not on a screen", () => {
  const code = '// Install Claude Code CLI bridge\n/* bravo setup */\nimport x from "./claude code/gh auth";\nexport { y } from "./CEO-Agent";\n';
  assert.deepEqual(scanVisibleText(code, "a.tsx").offenders, []);
});
check("the operator block is skipped only on operator surfaces, only with its exact summary, and is reported", () => {
  const block = '<details><summary>OASIS team computers only</summary><p>{"run `gh auth login` first"}</p></details>';
  const operator = scanVisibleText(block, "a.tsx", { operatorBlocks: true });
  assert.deepEqual(operator.offenders, []);
  assert.equal(operator.operatorBlocks.length, 1);
  assert.equal(operator.operatorBlocks[0].open, false);
  assert.ok(operator.operatorBlocks[0].text.includes("run `gh auth login` first"), "the block's own text is kept for the checks below");
  assert.equal(scanVisibleText(block, "a.tsx").offenders.length > 0, true, "without the allowance the same block is read like any other text");
  const other = '<details><summary>More</summary><p>{"run `gh auth login` first"}</p></details>';
  assert.equal(scanVisibleText(other, "a.tsx", { operatorBlocks: true }).offenders.length > 0, true, "another <details> is read");
  const near = '<details><summary>OASIS team computers only, and clients</summary><p>gh auth login</p></details>';
  assert.equal(scanVisibleText(near, "a.tsx", { operatorBlocks: true }).offenders.length > 0, true, "the summary must match exactly");
  const open = scanVisibleText(block.replace("<details>", "<details open>"), "a.tsx", { operatorBlocks: true });
  assert.equal(open.operatorBlocks[0].open, true, "an open block is reported as open");
});
check("the catalogue allowance covers only `label: \"Claude Code\"` inside the named catalogue", () => {
  const ok = scanVisibleText('const CARDS = [{ label: "Claude Code", blurb: "x" }];', "a.tsx", { catalogue: "CARDS" });
  assert.deepEqual(ok.offenders, []);
  assert.equal(ok.catalogueAllowed.length, 1);
  for (const code of [
    'const OTHER = [{ label: "Claude Code" }];',
    'const CARDS = [{ blurb: "Claude Code" }];',
    'const CARDS = [{ label: "Install Claude Code CLI bridge" }];',
    'const CARDS = [{ label: "Claude Code" }]; const t = "Claude Code";',
  ]) {
    assert.ok(scanVisibleText(code, "a.tsx", { catalogue: "CARDS" }).offenders.length > 0, code);
  }
  assert.ok(scanVisibleText('const CARDS = [{ label: "Claude Code" }];', "a.tsx").offenders.length > 0, "no allowance without the option");
});

// -- This repository -----------------------------------------------------------
const OPERATOR_SURFACES = ["components/settings/InstallBridgeModal.tsx", "app/settings/devices/install/InstallBridgeWizard.tsx"];
const CATALOGUE_FILE = "components/settings/LocalCliProvidersCard.tsx";
const FILES = [
  "components/settings/InstallBridgeModal.tsx",
  "components/settings/DevicesEditor.tsx",
  "app/settings/devices/install/page.tsx",
  "app/settings/devices/install/InstallBridgeWizard.tsx",
  "app/settings/devices/install/PairBridgeOnly.tsx",
  "lib/bridge-install-guidance.ts",
  CATALOGUE_FILE,
  "components/settings/addons.ts",
  "components/os/OsRail.tsx",
];

const scans = new Map<string, Scan>();
for (const rel of FILES) {
  scans.set(
    rel,
    scanVisibleText(readFileSync(join(ROOT, rel), "utf8"), rel, {
      operatorBlocks: OPERATOR_SURFACES.includes(rel),
      catalogue: rel === CATALOGUE_FILE ? "CARDS" : undefined,
    }),
  );
}
const scan = (rel: string) => scans.get(rel)!;
const shows = (rel: string, needle: string) => scan(rel).visible.some((h) => h.text.includes(needle));

check("every guarded file was read and has visible text (fails closed on a moved file)", () => {
  for (const rel of FILES) assert.ok(scan(rel).visible.length > 0, `${rel}: no visible text found`);
});
for (const rel of FILES) {
  check(`${rel}: no Claude Code, Claude subscription, bravo setup, .env.agents, CEO-Agent or gh auth on screen`, () => {
    assert.deepEqual(show(scan(rel).offenders), []);
  });
}
check("the GitHub sign-in paragraph lives in one closed 'OASIS team computers only' block on each operator surface", () => {
  for (const rel of OPERATOR_SURFACES) {
    const blocks = scan(rel).operatorBlocks;
    assert.equal(blocks.length, 1, `${rel}: ${blocks.length} operator blocks`);
    assert.equal(blocks[0].open, false, `${rel}: the operator block must start closed`);
    assert.ok(blocks[0].text.includes("`gh auth login` choosing HTTPS") && blocks[0].text.includes("`gh auth setup-git`"), `${rel}: the git-credential step left the block`);
  }
});
check("no other guarded file has an operator block (a client screen gets no exemption)", () => {
  for (const rel of FILES.filter((f) => !OPERATOR_SURFACES.includes(f))) {
    const s = scanVisibleText(readFileSync(join(ROOT, rel), "utf8"), rel, { operatorBlocks: true });
    assert.deepEqual(s.operatorBlocks, [], rel);
  }
});
check("the CLI catalogue allowance lets through exactly one label, Claude Code, in LocalCliProvidersCard", () => {
  assert.deepEqual(scan(CATALOGUE_FILE).catalogueAllowed.map((h) => h.text), ["Claude Code"]);
  for (const rel of FILES.filter((f) => f !== CATALOGUE_FILE)) assert.deepEqual(scan(rel).catalogueAllowed, [], rel);
});

// The new names, so a revert to other wording fails too.
check("the install modal: Connect this computer, OASIS AI Command Center, the two modes and the success line", () => {
  const rel = "components/settings/InstallBridgeModal.tsx";
  for (const needle of [
    "Connect this computer",
    "Installs the OASIS AI Command Center bridge so your agents can use this computer's files, tools and scheduled jobs.",
    "New computer: full install",
    "Already installed: connect only",
    "This computer is connected to OASIS AI Command Center.",
    "Agents can now use this computer for files, tools and scheduled jobs.",
  ]) {
    assert.ok(shows(rel, needle), `${rel}: missing "${needle}"`);
  }
});
check("the install wizard matches the modal", () => {
  const rel = "app/settings/devices/install/InstallBridgeWizard.tsx";
  for (const needle of [
    "Connect this computer",
    "New computer: full install",
    "Already installed: connect only",
    "This computer is connected to OASIS AI Command Center.",
    "Agents can now use this computer for files, tools and scheduled jobs.",
  ]) {
    assert.ok(shows(rel, needle), `${rel}: missing "${needle}"`);
  }
});
check("Settings > Devices: the empty state, both buttons and the pair-code line", () => {
  const rel = "components/settings/DevicesEditor.tsx";
  for (const needle of [
    "No computers connected yet. Connect one so your agents can use its files, tools and scheduled jobs. Chat works without one.",
    "Connect this computer",
    "Connect another computer",
    "Enter this code in the OASIS installer on the other computer.",
  ]) {
    assert.ok(shows(rel, needle), `${rel}: missing "${needle}"`);
  }
});
check("Settings > Devices: every truncated name or fingerprint carries its full text as a tooltip", () => {
  const rel = "components/settings/DevicesEditor.tsx";
  const sf = ts.createSourceFile(rel, readFileSync(join(ROOT, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const truncated: Array<{ line: number; titled: boolean }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) {
      const attrs = n.openingElement.attributes.properties.filter(ts.isJsxAttribute);
      const cls = attrs.find((a) => a.name.getText(sf) === "className")?.initializer;
      if (cls && ts.isStringLiteral(cls) && /(^|\s)truncate(\s|$)/.test(cls.text)) {
        truncated.push({
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          titled: attrs.some((a) => a.name.getText(sf) === "title"),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(truncated.length >= 2, `expected the label and fingerprint cells, found ${truncated.length}`);
  assert.deepEqual(truncated.filter((t) => !t.titled).map((t) => t.line), [], "truncated cells without a title");
});
check("the install page: its header names OASIS AI Command Center, and the two cards say cloud vs connected computer", () => {
  const rel = "app/settings/devices/install/page.tsx";
  for (const needle of ["Connect a computer to OASIS AI Command Center", "Cloud only (your AI account)", "With a connected computer"]) {
    assert.ok(shows(rel, needle), `${rel}: missing "${needle}"`);
  }
  for (const gone of ["tool_use", "MCP", "Playwright"]) assert.ok(!shows(rel, gone), `${rel}: still shows "${gone}"`);
});
check("the client's pair-only card names the OASIS bridge", () => {
  assert.ok(shows("app/settings/devices/install/PairBridgeOnly.tsx", "Pair a computer that already has the OASIS bridge"));
});
check("the CLI card says it couldn't reach the computer's bridge, not 'bridge returned <n>'", () => {
  assert.ok(shows(CATALOGUE_FILE, "Couldn't reach this computer's bridge (status"));
  assert.ok(!scan(CATALOGUE_FILE).visible.some((h) => /bridge returned/i.test(h.text)));
});
check("the Whispr card says the clean-up uses the AI tool signed in on the computer, naming no product", () => {
  assert.ok(shows("components/settings/addons.ts", "the AI clean-up of your words, done with the AI tool you are already signed in to on this computer; switch it off and nothing leaves."));
  assert.ok(!shows("components/settings/addons.ts", "OpenCode"));
});
check("the rail's status dot speaks of your computer connection", () => {
  for (const needle of ["Checking your computer connection", "Couldn't check your computer connection", "Computer connected in the last 5 minutes"]) {
    assert.ok(shows("components/os/OsRail.tsx", needle), `OsRail: missing "${needle}"`);
  }
  assert.ok(!shows("components/os/OsRail.tsx", "bridge daemon"));
});
check("the recovery hint without a known OS points at Settings > Devices on the connected computer", () => {
  assert.ok(shows("lib/bridge-install-guidance.ts", "Open Settings > Devices"));
  assert.ok(!shows("lib/bridge-install-guidance.ts", "paired machine"));
});

if (failures > 0) {
  console.log(`devices-copy-guard: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`devices-copy-guard: all passed (${FILES.length} files)`);
