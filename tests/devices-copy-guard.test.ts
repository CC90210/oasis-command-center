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
 * (JSX attribute values included), template literals, `+` concatenations,
 * conditional branches, and the text of every JSX element with its children
 * joined. A same-file `const` string is resolved where it is used, so
 * `const first = "Claude"; <p>{first} Code</p>` is the phrase "Claude Code".
 * Before matching, HTML entities are decoded (named and numeric) and every run
 * of punctuation or space between words counts as one space, so "Claude-Code",
 * "Claude  Code" and "Claude&#45;Code" all read as "Claude Code". None of it
 * may name Claude Code, a Claude subscription, `bravo setup`, .env.agents, the
 * CEO-Agent repository or `gh auth`. The new names are pinned too, so a revert
 * to other wording fails.
 *
 * Static only: a part that arrives at run time (a prop, a fetched string, a
 * `let`) cannot be read from source, so it is a gap no phrase runs through.
 *
 * TWO ALLOWANCES, each structural and each pinned below:
 *   - The collapsed <details> whose <summary> is "OASIS team computers only",
 *     in the operator's install modal and install wizard only. The full install
 *     clones a private repository, so OASIS's own computers need the GitHub
 *     CLI signed in; that paragraph stays there, closed by default.
 *   - In LocalCliProvidersCard's CARDS catalogue, the Claude Code entry's own
 *     label, install command and docs link: the card lists the command-line
 *     tools a computer can run (Claude Code, Codex CLI, Gemini CLI) by their
 *     real names and packages. That is the "whatever model" choice, not the
 *     bridge's name. Only those three fields of the `key: "claude"` entry are
 *     allowed, and the test pins exactly what they say.
 *
 * Run: node --conditions=react-server --import tsx tests/devices-copy-guard.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");

const FORBIDDEN_TERMS = ["Claude Code", "Claude subscription", "bravo setup", ".env.agents", "CEO-Agent", "gh auth"];
const OPERATOR_BLOCK = "OASIS team computers only";
/** A part known only at run time. Its "x" is a word of its own, so no phrase runs through it. */
const GAP = " {x} ";
/** Ways one expression or element can print, kept per node so a page of conditionals stays cheap. */
const MAX_VARIANTS = 128;

/** Named entities that print as a space or a mark between words. Any other name is left as written. */
const SEPARATOR_ENTITIES = new Set([
  "nbsp", "ensp", "emsp", "emsp13", "emsp14", "numsp", "puncsp", "thinsp", "hairsp", "zerowidthspace",
  "zwnj", "zwj", "shy", "tab", "newline", "dash", "hyphen", "ndash", "mdash", "minus", "horbar", "bull",
  "middot", "centerdot", "hellip", "lsquo", "rsquo", "ldquo", "rdquo", "laquo", "raquo", "rarr", "larr",
  "period", "comma", "colon", "semi", "lowbar", "sol", "bsol", "verbar", "vert", "excl", "quest", "num",
  "ast", "plus", "equals",
]);
const PLAIN_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Named and numeric HTML entities decoded, as JSX and the browser print them. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    const name = body.toLowerCase();
    if (name in PLAIN_ENTITIES) return PLAIN_ENTITIES[name];
    return SEPARATOR_ENTITIES.has(name) ? " " : whole;
  });
}

/** Lower case, entities decoded, every run of anything but a letter or a digit one space. */
export function normalise(s: string): string {
  return decodeEntities(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The forbidden terms in that same form ("CEO-Agent" is "ceo agent", ".env.agents"
 * is "env agents"). A term must start a word and may run on ("Claude Codes").
 */
export const FORBIDDEN = new RegExp(`(?:^| )(?:${FORBIDDEN_TERMS.map(normalise).join("|")})`);
export const isForbidden = (s: string) => FORBIDDEN.test(normalise(s));

/** Text as a viewer reads it: entities decoded, whitespace collapsed. */
const squash = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
/** Something besides run-time gaps. */
const meaningful = (s: string) => /[a-z0-9]/i.test(s.split(GAP.trim()).join(""));

type Hit = { line: number; text: string };
type Scan = {
  /** Every visible string: literals, evaluated expressions, each JSX element's joined text. */
  visible: Hit[];
  /** Visible strings that read as a forbidden term and no allowance covers. */
  offenders: Hit[];
  /** One entry per operator <details> block: its joined text and whether it renders open. */
  operatorBlocks: Array<{ text: string; open: boolean }>;
  /** Forbidden strings the CLI-catalogue allowance let through. */
  catalogueAllowed: Hit[];
};

type Options = {
  /** Skip the "OASIS team computers only" <details> block (operator surfaces only). */
  operatorBlocks?: boolean;
  /** Name of the CLI catalogue whose Claude Code entry may name the tool. */
  catalogue?: string;
};

/** The Claude Code entry's own fields in the CLI catalogue: its name, its install command, its docs link. */
const CATALOGUE_FIELDS = new Set(["label", "install_command", "install_url"]);

function tagName(el: ts.JsxElement | ts.JsxSelfClosingElement, sf: ts.SourceFile): string {
  return (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText(sf);
}

function attributeNames(el: ts.JsxElement): string[] {
  return el.openingElement.attributes.properties
    .filter(ts.isJsxAttribute)
    .map((a) => a.name.getText());
}

/** Expressions that only pass a value through. */
function isWrapper(n: ts.Node): n is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n);
}

/** Expressions that build a string out of other expressions. */
function buildsString(n: ts.Node): boolean {
  if (ts.isTemplateExpression(n) || ts.isConditionalExpression(n)) return true;
  if (!ts.isBinaryExpression(n)) return false;
  const op = n.operatorToken.kind;
  return (
    op === ts.SyntaxKind.PlusToken ||
    op === ts.SyntaxKind.BarBarToken ||
    op === ts.SyntaxKind.QuestionQuestionToken ||
    op === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

export function scanVisibleText(code: string, fileName: string, opts: Options = {}): Scan {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out: Scan = { visible: [], offenders: [], operatorBlocks: [], catalogueAllowed: [] };

  // Every same-file `const name = <expr>`, in any scope. A name bound twice
  // contributes both values, so shadowing can only add matches, never hide one.
  const consts = new Map<string, ts.Expression[]>();
  const collectConsts = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      consts.set(n.name.text, [...(consts.get(n.name.text) ?? []), n.initializer]);
    }
    ts.forEachChild(n, collectConsts);
  };
  collectConsts(sf);

  const isOperatorBlock = (n: ts.Node): n is ts.JsxElement => {
    if (!ts.isJsxElement(n) || tagName(n, sf) !== "details") return false;
    const summary = n.children.find((c): c is ts.JsxElement => ts.isJsxElement(c) && tagName(c, sf) === "summary");
    return Boolean(summary) && squash(summary!.children.map((c) => (ts.isJsxText(c) ? c.text : GAP)).join("")) === OPERATOR_BLOCK;
  };

  /** A field of the Claude Code entry (`key: "claude"`) inside `const <catalogue> = ...`. */
  const isCatalogueField = (n: ts.StringLiteral): boolean => {
    if (!opts.catalogue) return false;
    const prop = n.parent;
    if (!prop || !ts.isPropertyAssignment(prop) || prop.initializer !== n || !CATALOGUE_FIELDS.has(prop.name.getText(sf))) return false;
    const entry = prop.parent;
    if (!ts.isObjectLiteralExpression(entry)) return false;
    const isClaude = entry.properties.some(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "key" && ts.isStringLiteral(p.initializer) && p.initializer.text === "claude",
    );
    if (!isClaude) return false;
    for (let p: ts.Node | undefined = entry.parent; p; p = p.parent) {
      if (ts.isVariableDeclaration(p)) return p.name.getText(sf) === opts.catalogue;
    }
    return false;
  };

  const cap = (xs: string[]) => [...new Set(xs)].slice(0, MAX_VARIANTS);
  const product = (a: string[], b: string[]): string[] => {
    const r: string[] = [];
    for (const x of a) {
      for (const y of b) {
        r.push(x + y);
        if (r.length >= MAX_VARIANTS) return cap(r);
      }
    }
    return cap(r);
  };
  const union = (...lists: string[][]) => cap(lists.flat());

  /** Every string an expression can print, as far as this file alone can tell; a run-time part is GAP. */
  const values = (e: ts.Node | undefined, seen: ReadonlySet<string>): string[] => {
    if (!e) return [GAP];
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return [e.text];
    if (isWrapper(e)) return values(e.expression, seen);
    if (ts.isTemplateExpression(e)) {
      let acc = [e.head.text];
      for (const span of e.templateSpans) acc = product(product(acc, values(span.expression, seen)), [span.literal.text]);
      return acc;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return product(values(e.left, seen), values(e.right, seen));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return union(values(e.left, seen), values(e.right, seen));
      }
      // In JSX, `cond && x` prints nothing or x.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union([""], values(e.right, seen));
      return [GAP];
    }
    if (ts.isConditionalExpression(e)) return union(values(e.whenTrue, seen), values(e.whenFalse, seen));
    if (ts.isIdentifier(e)) {
      const inits = consts.get(e.text);
      if (!inits || seen.has(e.text)) return [GAP];
      const next = new Set(seen).add(e.text);
      return union(...inits.map((init) => values(init, next)));
    }
    if (ts.isJsxElement(e) || ts.isJsxFragment(e)) return joined(e, seen);
    return [GAP];
  };

  /** The text of a JSX element with its children joined, one entry per way it can print. */
  const joined = (n: ts.JsxElement | ts.JsxFragment, seen: ReadonlySet<string>): string[] =>
    opts.operatorBlocks && isOperatorBlock(n) ? [GAP] : childText(n, seen);

  /** The children of a JSX element joined, one entry per way they can print. */
  const childText = (n: ts.JsxElement | ts.JsxFragment, seen: ReadonlySet<string>): string[] => {
    let acc = [""];
    for (const c of n.children) {
      let part: string[];
      if (ts.isJsxText(c)) part = [c.text.replace(/\s+/g, " ")];
      // {/* a comment */} has no expression and prints nothing.
      else if (ts.isJsxExpression(c)) part = c.expression ? values(c.expression, seen) : [""];
      else if (ts.isJsxElement(c) || ts.isJsxFragment(c)) part = joined(c, seen);
      else part = [GAP];
      acc = product(acc, part);
    }
    return acc;
  };

  const record = (line: number, raw: string, allowed = false) => {
    const text = squash(raw);
    if (!meaningful(text)) return;
    out.visible.push({ line, text });
    if (!isForbidden(text)) return;
    if (allowed) out.catalogueAllowed.push({ line, text });
    else out.offenders.push({ line, text });
  };

  /** Records each JSX element's joined text, innermost match only. Returns whether a match was recorded inside. */
  const visitJsx = (n: ts.JsxElement | ts.JsxFragment): boolean => {
    let inner = false;
    for (const child of n.children) {
      if ((ts.isJsxElement(child) || ts.isJsxFragment(child)) && !(opts.operatorBlocks && isOperatorBlock(child))) {
        inner = visitJsx(child) || inner;
      }
    }
    let hit = false;
    for (const variant of joined(n, new Set())) {
      const text = squash(variant);
      if (!meaningful(text)) continue;
      out.visible.push({ line: lineOf(n), text });
      if (!inner && !hit && isForbidden(text)) {
        out.offenders.push({ line: lineOf(n), text });
        hit = true;
      }
    }
    return inner || hit;
  };

  const outerParent = (n: ts.Node): ts.Node | undefined => {
    let p = n.parent;
    while (p && isWrapper(p)) p = p.parent;
    return p;
  };

  const visit = (n: ts.Node): void => {
    // Module paths are not words on a screen.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (opts.operatorBlocks && isOperatorBlock(n)) {
      out.operatorBlocks.push({
        text: squash(childText(n, new Set()).join(" ")),
        open: attributeNames(n).includes("open"),
      });
      return;
    }
    if ((ts.isJsxElement(n) || ts.isJsxFragment(n)) && !(n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)))) {
      // The outermost element of a JSX tree: walk its element text once.
      visitJsx(n);
    }
    if (buildsString(n)) {
      // The whole expression, once: `"a" + b + "c"` is one string, not three.
      const p = outerParent(n);
      if (!(p && (buildsString(p) || ts.isTemplateSpan(p)))) {
        for (const v of values(n, new Set())) record(lineOf(n), v);
      }
    }
    if (ts.isStringLiteral(n)) record(lineOf(n), n.text, isCatalogueField(n));
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
    assert.ok(scanVisibleText(code, file).offenders.length > 0, code);
  }
});
check("a phrase split across JSX children is still one phrase", () => {
  assert.ok(scanVisibleText('<p>your local Claude{" "}Code login</p>', "a.tsx").offenders.length > 0);
  assert.ok(scanVisibleText("<p>click <strong>Install</strong> Claude Code here</p>", "a.tsx").offenders.length > 0);
  assert.ok(scanVisibleText("<p>\n  your local Claude\n  Code login\n</p>", "a.tsx").offenders.length > 0);
});
check("copy assembled through expressions is still read (the review's bypasses)", () => {
  const flagged: Array<[string, string]> = [
    ['const first = "Claude"; const x = <p>{first} Code</p>;', "a const word joined to JSX text"],
    ['const brand = "Claude " + "Code"; const x = <p>{brand}</p>;', "a const built with +"],
    ['const first = "Claude"; const t = `${first} Code`;', "a template literal with a const part"],
    ['const first = "Claude"; confirm(first + " Code");', "a concatenation passed to a call"],
    ['const first = "Claude"; const x = <b title={first + " Code"}>x</b>;', "a concatenated attribute"],
    ['const a = "Claude"; const b = a; const x = <p>{b} Code</p>;', "a const of a const"],
    ['const x = <p>{ok ? "Claude" : "Other"} Code</p>;', "one branch of a conditional"],
    ['const x = <p>{ok && "Claude"} Code</p>;', "a conditional with &&"],
    ['const x = <p>{name ?? "Claude"} Code</p>;', "a fallback with ??"],
  ];
  for (const [code, why] of flagged) assert.ok(scanVisibleText(code, "a.tsx").offenders.length > 0, `${why}: ${code}`);
});
check("entities, hyphens, underscores and extra spaces between the words are still the phrase", () => {
  const flagged: Array<[string, string]> = [
    ["const x = <p>Claude-Code</p>;", "a hyphen"],
    ["const x = <p>Claude&#45;Code</p>;", "a numeric entity"],
    ["const x = <p>Claude&#x2D;Code</p>;", "a hex entity"],
    ["const x = <p>Claude&nbsp;Code</p>;", "a named entity"],
    ["const x = <p>Claude&mdash;Code</p>;", "a dash entity"],
    ['confirm("Claude  Code");', "two spaces"],
    ['confirm("claude_code");', "an underscore, lower case"],
    ['const s = "CEO Agent";', "the repository name with a space"],
    ['const s = "copy it to .env-agents";', "the secrets file with a hyphen"],
    ['const s = "run gh  auth login";', "two spaces in gh auth"],
    ['const s = "Bravo-Setup";', "the setup command with a hyphen and capitals"],
  ];
  for (const [code, why] of flagged) assert.ok(scanVisibleText(code, "a.tsx").offenders.length > 0, `${why}: ${code}`);
});
check("comments, import paths, look-alike words and run-time gaps stay clean", () => {
  const clean: Array<[string, string]> = [
    ["// Install Claude Code CLI bridge\nconst x = 1;", "a line comment"],
    ["/* run `bravo setup`, then gh auth */\nconst x = 1;", "a block comment"],
    ["const x = <p>{/* Claude Code */}Settings</p>;", "a JSX comment"],
    ['import x from "./claude-code/gh-auth";', "an import path"],
    ['export { y } from "./CEO-Agent";', "a re-export path"],
    ['const s = "Uses your Claude Max / Pro subscription.";', "Claude and subscription apart"],
    ["const x = <p>Claude{name}Code</p>;", "a run-time value between the words"],
    ['let first = "Claude"; first = "Other"; const x = <p>{first} Code</p>;', "a `let`, which can change at run time"],
  ];
  for (const [code, why] of clean) assert.deepEqual(show(scanVisibleText(code, "a.tsx").offenders), [], `${why}: ${code}`);
});
check("a match is reported once, at the innermost element that holds it", () => {
  const hits = scanVisibleText("<div><p>ok</p><p><span>Claude Code</span> here</p></div>", "a.tsx").offenders;
  assert.deepEqual(show(hits), ["1: Claude Code"]);
});
check("the operator block is skipped only on operator surfaces, only with its exact summary, and is reported", () => {
  const block = '<details><summary>OASIS team computers only</summary><p>{"run `gh auth login` first"}</p></details>';
  const operator = scanVisibleText(block, "a.tsx", { operatorBlocks: true });
  assert.deepEqual(operator.offenders, []);
  assert.equal(operator.operatorBlocks.length, 1);
  assert.equal(operator.operatorBlocks[0].open, false);
  assert.ok(operator.operatorBlocks[0].text.includes("run `gh auth login` first"), "the block's own text is kept for the checks below");
  assert.ok(scanVisibleText(block, "a.tsx").offenders.length > 0, "without the allowance the same block is read like any other text");
  const other = '<details><summary>More</summary><p>{"run `gh auth login` first"}</p></details>';
  assert.ok(scanVisibleText(other, "a.tsx", { operatorBlocks: true }).offenders.length > 0, "another <details> is read");
  const near = '<details><summary>OASIS team computers only, and clients</summary><p>gh auth login</p></details>';
  assert.ok(scanVisibleText(near, "a.tsx", { operatorBlocks: true }).offenders.length > 0, "the summary must match exactly");
  const open = scanVisibleText(block.replace("<details>", "<details open>"), "a.tsx", { operatorBlocks: true });
  assert.equal(open.operatorBlocks[0].open, true, "an open block is reported as open");
});
check("the catalogue allowance covers only the claude entry's label, install command and docs link in the named catalogue", () => {
  const entry =
    '{ key: "claude", label: "Claude Code", blurb: "x", install_url: "https://docs.example.test/claude-code/start", install_command: "npm i -g @anthropic-ai/claude-code" }';
  const ok = scanVisibleText(`const CARDS = [${entry}];`, "a.tsx", { catalogue: "CARDS" });
  assert.deepEqual(ok.offenders, []);
  assert.equal(ok.catalogueAllowed.length, 3);
  for (const code of [
    `const OTHER = [${entry}];`,
    'const CARDS = [{ key: "claude", blurb: "the Claude Code way" }];',
    'const CARDS = [{ key: "codex", label: "Claude Code" }];',
    'const CARDS = [{ key: "claude", label: "Claude Code" }]; const t = "Claude Code";',
  ]) {
    assert.ok(scanVisibleText(code, "a.tsx", { catalogue: "CARDS" }).offenders.length > 0, code);
  }
  assert.ok(scanVisibleText(`const CARDS = [${entry}];`, "a.tsx").offenders.length > 0, "no allowance without the option");
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
check("the CLI catalogue allowance lets through exactly the Claude Code entry's name, install command and docs link", () => {
  assert.deepEqual(scan(CATALOGUE_FILE).catalogueAllowed.map((h) => h.text), [
    "Claude Code",
    "https://docs.anthropic.com/en/docs/claude-code/quickstart",
    "npm install -g @anthropic-ai/claude-code",
  ]);
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
check("the Whispr card describes where the clean-up goes for every route, not a sign-in", () => {
  // Whispr's README: the speech model is local unless the Groq backend is chosen;
  // the clean-up tries its routes in order, and every route but a local Ollama
  // model sends the text out (some by a sign-in, some by an API key).
  const rel = "components/settings/addons.ts";
  for (const needle of [
    "By default the speech model runs on your computer",
    "The AI clean-up uses the first provider in Whispr's settings that can run",
    "an online provider receives the transcript, a local model keeps it on this computer.",
    "With clean-up off and the default speech model, nothing leaves.",
  ]) {
    assert.ok(shows(rel, needle), `${rel}: missing "${needle}"`);
  }
  assert.ok(!scan(rel).visible.some((h) => /signed in|logged in|OpenCode/i.test(h.text)), "the clean-up is not described as a sign-in or by a product name");
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
