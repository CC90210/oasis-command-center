/**
 * lib/playbook/element-markdown.ts - turn a server-rendered React element tree
 * (a live legal page) into markdown, so the documents hub can show, copy and
 * download the EXACT text a page publishes without a second copy of it.
 *
 * WHY. The privacy policy, the terms and the DMCA policy are written as JSX in
 * app/(marketing)/*, filled from lib/legal/constants.ts. A markdown copy kept
 * beside them would drift the first time either changed (the old catalog said
 * "Privacy policy: stub" while /privacy was live). Rendering the page's own
 * element tree means the hub's text IS the page's text.
 *
 * WHAT IT HANDLES. Plain server components (functions without hooks) are
 * called. Headings, paragraphs, lists (nested), tables, pre, blockquote,
 * strong/em/code/links/line breaks become their markdown forms. <nav> and
 * <footer> are page chrome and are skipped. A client component (a client
 * reference, forwardRef or memo object) is not called: its children are
 * rendered, and one with an `href` (next/link) becomes a link.
 *
 * FAILS LOUD. An async component (a Promise) or a render deeper than 80 levels
 * throws: a partial legal text is worse than an error.
 */

import { isValidElement, type ReactElement, type ReactNode } from "react";

/** Relative links in the downloaded file point at the live site. */
export const LIVE_ORIGIN = "https://oasisai.work";

const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const SKIP = new Set(["nav", "footer", "script", "style", "button", "form", "svg", "img", "input", "select", "textarea", "noscript"]);
const INLINE = new Set(["span", "strong", "b", "em", "i", "code", "a", "br", "small", "abbr", "time", "sup", "sub", "u", "mark", "label", "cite", "q", "kbd", "s"]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const MAX_DEPTH = 80;

type Props = Record<string, unknown> & { children?: ReactNode };
type Out = { blocks: string[]; inline: string[] };

function isOpaque(type: unknown): boolean {
  if (typeof type === "string") return false;
  if (typeof type === "function") return (type as { $$typeof?: unknown }).$$typeof === CLIENT_REFERENCE;
  return true; // Fragment (symbol), forwardRef / memo / lazy / client reference objects
}

/** Call a plain server component. Throws on an async one. */
function expand(el: ReactElement, depth: number): ReactNode {
  if (depth > MAX_DEPTH) throw new Error("element-markdown: render deeper than 80 levels");
  const out = (el.type as (p: Props) => unknown)(el.props as Props);
  if (out && typeof (out as Promise<unknown>).then === "function") {
    throw new Error("element-markdown: async component in a live document; render it before converting");
  }
  return out as ReactNode;
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\n]+/g, " ");
}

function linkMd(href: unknown, text: string): string {
  const label = text.trim();
  const h = typeof href === "string" ? href : "";
  if (!h || h.startsWith("mailto:") || h.startsWith("tel:") || h.startsWith("#")) return label;
  const abs = h.startsWith("/") ? `${LIVE_ORIGIN}${h}` : h;
  if (!label) return `<${abs}>`;
  return `[${label}](${abs})`;
}

function wrap(mark: string, inner: string): string {
  const t = inner.trim();
  if (!t) return inner;
  const lead = inner.match(/^\s*/)?.[0] ? " " : "";
  const trail = inner.match(/\s*$/)?.[0] ? " " : "";
  return `${lead}${mark}${t}${mark}${trail}`;
}

/** Inline text of any node. Block elements inside inline context join with a space. */
function inlineOf(node: ReactNode, depth = 0): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return collapse(String(node));
  if (Array.isArray(node)) return node.map((n) => inlineOf(n as ReactNode, depth + 1)).join("");
  if (!isValidElement(node)) return "";
  const props = (node.props ?? {}) as Props;
  if (typeof node.type === "function" && !isOpaque(node.type)) return inlineOf(expand(node, depth), depth + 1);
  if (isOpaque(node.type)) {
    const inner = inlineOf(props.children, depth + 1);
    return props.href ? linkMd(props.href, inner) : inner;
  }
  const tag = node.type as string;
  if (SKIP.has(tag)) return "";
  const inner = () => inlineOf(props.children, depth + 1);
  // Spacing that CSS draws: a span with a right margin ("1." before a heading's
  // title) is followed by a space, and a display:block span (a badge or a note
  // under a table cell's name) is its own phrase, set off with " - ".
  const cls = typeof props.className === "string" ? props.className : "";
  if (tag === "span" && /(^|\s)block(\s|$)/.test(cls)) {
    const t = inner().trim();
    return t ? ` - ${t}` : "";
  }
  if (tag === "span" && /(^|\s)(mr|mx|pr|px)-/.test(cls)) return `${inner()} `;
  switch (tag) {
    case "strong":
    case "b":
      return wrap("**", inner());
    case "em":
    case "i":
    case "cite":
      return wrap("_", inner());
    case "code":
    case "kbd":
      return "`" + inner().trim() + "`";
    case "a":
      return linkMd(props.href, inner());
    case "br":
      return "\\\n";
    default:
      return INLINE.has(tag) ? inner() : ` ${inner()} `;
  }
}

function flush(out: Out): void {
  const text = out.inline.join("").replace(/ *\\\n */g, "\\\n").replace(/[ \t]+/g, " ").trim();
  out.inline = [];
  if (text) out.blocks.push(text);
}

function childElements(node: ReactNode, depth: number): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: ReactNode, d: number) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x as ReactNode, d + 1);
      return;
    }
    if (!isValidElement(n)) return;
    if (typeof n.type === "function" && !isOpaque(n.type)) {
      visit(expand(n, d), d + 1);
      return;
    }
    if (isOpaque(n.type) && !(n.props as Props).href) {
      visit((n.props as Props).children, d + 1);
      return;
    }
    out.push(n);
  };
  visit(node, depth);
  return out;
}

function listMd(el: ReactElement, ordered: boolean, indent: string, depth: number): string {
  const lines: string[] = [];
  let n = 0;
  for (const li of childElements((el.props as Props).children, depth + 1)) {
    if (li.type !== "li") continue;
    n += 1;
    const parts = ([] as ReactNode[]).concat((li.props as Props).children ?? []);
    const inlineParts: ReactNode[] = [];
    const nested: ReactElement[] = [];
    for (const p of parts.flat(Infinity as 1) as ReactNode[]) {
      if (isValidElement(p) && (p.type === "ul" || p.type === "ol")) nested.push(p);
      else inlineParts.push(p);
    }
    const text = inlineOf(inlineParts, depth + 1).replace(/[ \t]+/g, " ").trim();
    lines.push(`${indent}${ordered ? `${n}.` : "-"} ${text}`);
    for (const sub of nested) lines.push(listMd(sub, sub.type === "ol", `${indent}   `, depth + 1));
  }
  return lines.join("\n");
}

function tableMd(el: ReactElement, depth: number): string {
  const rows: Array<{ cells: string[]; header: boolean }> = [];
  const visit = (node: ReactNode, d: number) => {
    for (const child of childElements(node, d)) {
      if (child.type === "tr") {
        const cells = childElements((child.props as Props).children, d + 1).filter((c) => c.type === "th" || c.type === "td");
        rows.push({
          header: cells.length > 0 && cells.every((c) => c.type === "th"),
          cells: cells.map((c) => inlineOf((c.props as Props).children, d + 2).replace(/\\\n/g, " ").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()),
        });
      } else {
        visit((child.props as Props).children, d + 1);
      }
    }
  };
  visit((el.props as Props).children, depth + 1);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill("")];
  const headerRow = rows[0].header ? rows.shift()! : { cells: Array(width).fill(" "), header: true };
  const lines = [`| ${pad(headerRow.cells).join(" | ")} |`, `|${Array(width).fill("---").join("|")}|`];
  for (const r of rows) lines.push(`| ${pad(r.cells).join(" | ")} |`);
  return lines.join("\n");
}

function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => plainText(n as ReactNode)).join("");
  if (!isValidElement(node)) return "";
  if (typeof node.type === "function" && !isOpaque(node.type)) return plainText(expand(node, 0));
  return plainText((node.props as Props).children);
}

function walk(node: ReactNode, out: Out, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error("element-markdown: render deeper than 80 levels");
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.inline.push(collapse(String(node)));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n as ReactNode, out, depth + 1);
    return;
  }
  if (!isValidElement(node)) return;
  const props = (node.props ?? {}) as Props;
  if (typeof node.type === "function" && !isOpaque(node.type)) {
    walk(expand(node, depth), out, depth + 1);
    return;
  }
  if (isOpaque(node.type)) {
    if (props.href) out.inline.push(linkMd(props.href, inlineOf(props.children, depth + 1)));
    else walk(props.children, out, depth + 1);
    return;
  }
  const tag = node.type as string;
  if (SKIP.has(tag)) return;
  if (INLINE.has(tag)) {
    out.inline.push(inlineOf(node, depth));
    return;
  }
  flush(out);
  if (tag in HEADINGS) {
    out.blocks.push(`${"#".repeat(HEADINGS[tag])} ${inlineOf(props.children, depth + 1).trim()}`);
  } else if (tag === "p") {
    out.inline.push(inlineOf(props.children, depth + 1));
    flush(out);
  } else if (tag === "ul" || tag === "ol") {
    const md = listMd(node, tag === "ol", "", depth);
    if (md) out.blocks.push(md);
  } else if (tag === "li") {
    out.blocks.push(`- ${inlineOf(props.children, depth + 1).trim()}`);
  } else if (tag === "table") {
    const md = tableMd(node, depth);
    if (md) out.blocks.push(md);
  } else if (tag === "pre") {
    out.blocks.push("```\n" + plainText(props.children).replace(/\n+$/, "") + "\n```");
  } else if (tag === "hr") {
    out.blocks.push("---");
  } else if (tag === "blockquote") {
    const inner: Out = { blocks: [], inline: [] };
    walk(props.children, inner, depth + 1);
    flush(inner);
    out.blocks.push(inner.blocks.join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
  } else {
    // div, section, article, header, main, aside, figure, dl, ...: a container.
    walk(props.children, out, depth + 1);
  }
  flush(out);
}

/** The markdown of an element tree. */
export function elementToMarkdown(node: ReactNode): string {
  const out: Out = { blocks: [], inline: [] };
  walk(node, out, 0);
  flush(out);
  return out.blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
