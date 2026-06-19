import fs from "fs/promises";
import os from "os";
import path from "path";

const MAX_FILE_BYTES = 250_000;
const MAX_SEARCH_FILES = 90;

const ROOT_DOCS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "ARCHITECTURE.md",
  "README.md",
]);

// ---------------------------------------------------------------------------
// Per-agent repo resolution.
//
// Cloud-mode agents can inspect their OWN repo's brain/memory via readBrainDoc
// and searchMemory. The repo is resolved from the agent slug so a new fleet
// agent (Lex, future verticals) is queryable from the dashboard the moment it
// has a row here — no per-agent code path. Bravo is the default so existing
// callers that don't pass a slug behave exactly as before.
//
// Each repo is overrideable at runtime via env (set these in Vercel):
//   <AGENT>_REPO          absolute local repo root (server-side fast path)
//   <AGENT>_REPO_RAW_BASE raw.githubusercontent base for the fallback fetch
//   <AGENT>_REPO_TREE_URL git trees API url for the search file list
// ---------------------------------------------------------------------------
type AgentRepoSpec = {
  localRootEnv: string;
  defaultLocalDir: string; // relative to os.homedir()
  rawBaseEnv: string;
  rawBaseDefault: string;
  treeUrlEnv: string;
  treeUrlDefault: string;
};

const AGENT_REPOS: Record<string, AgentRepoSpec> = {
  bravo: {
    localRootEnv: "BRAVO_REPO",
    defaultLocalDir: "Business-Empire-Agent",
    rawBaseEnv: "BRAVO_REPO_RAW_BASE",
    rawBaseDefault: "https://raw.githubusercontent.com/CC90210/CEO-Agent/main",
    treeUrlEnv: "BRAVO_REPO_TREE_URL",
    treeUrlDefault: "https://api.github.com/repos/CC90210/CEO-Agent/git/trees/main?recursive=1",
  },
  lex: {
    localRootEnv: "LEX_REPO",
    defaultLocalDir: "APPS/Lex-Agent",
    rawBaseEnv: "LEX_REPO_RAW_BASE",
    rawBaseDefault: "https://raw.githubusercontent.com/CC90210/Lex-Agent/main",
    treeUrlEnv: "LEX_REPO_TREE_URL",
    treeUrlDefault: "https://api.github.com/repos/CC90210/Lex-Agent/git/trees/main?recursive=1",
  },
};

const DEFAULT_AGENT = "bravo";

type RepoConfig = {
  agent: string;
  localRoot: string | null;
  rawBase: string;
  treeUrl: string;
};

function resolveRepo(slugRaw: unknown): RepoConfig {
  const slug = String(slugRaw || DEFAULT_AGENT).trim().toLowerCase() || DEFAULT_AGENT;
  const known = AGENT_REPOS[slug] ? slug : DEFAULT_AGENT;
  const spec = AGENT_REPOS[known];
  const localRoot =
    process.env[spec.localRootEnv] ||
    path.join(os.homedir(), ...spec.defaultLocalDir.split("/"));
  const rawBase = (process.env[spec.rawBaseEnv] || spec.rawBaseDefault).replace(/\/+$/, "");
  const treeUrl = process.env[spec.treeUrlEnv] || spec.treeUrlDefault;
  return { agent: known, localRoot, rawBase, treeUrl };
}

type RepoRead = {
  path: string;
  source: "local" | "github";
  content: string;
};

export type ReadBrainDocResult = RepoRead & {
  agent: string;
  chars: number;
  truncated: boolean;
};

export type SearchMemoryResult = {
  agent: string;
  query: string;
  source: "local" | "github" | "mixed";
  count: number;
  matches: Array<{
    path: string;
    line: number;
    score: number;
    excerpt: string;
  }>;
};

export async function readBrainDoc(input: Record<string, unknown>): Promise<ReadBrainDocResult> {
  const repo = resolveRepo(input.agent_slug ?? input.agent);
  const repoPath = normalizeKnowledgePath(String(input.path || ""));
  const maxChars = clamp(Number(input.max_chars) || 12_000, 1_000, 40_000);
  const read = await readRepoText(repoPath, repo);
  const clipped = clip(read.content, maxChars);
  return {
    ...read,
    agent: repo.agent,
    content: clipped.text,
    chars: read.content.length,
    truncated: clipped.truncated,
  };
}

export async function searchMemory(input: Record<string, unknown>): Promise<SearchMemoryResult> {
  const repo = resolveRepo(input.agent_slug ?? input.agent);
  const query = String(input.query || "").trim();
  if (query.length < 2) throw new Error("query_too_short");
  const limit = clamp(Number(input.limit) || 8, 1, 20);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) throw new Error("query_too_short");

  const paths = await listSearchablePaths(repo);
  const matches: SearchMemoryResult["matches"] = [];
  const sources = new Set<"local" | "github">();

  for (const repoPath of paths.slice(0, MAX_SEARCH_FILES)) {
    let read: RepoRead;
    try {
      read = await readRepoText(repoPath, repo);
    } catch {
      continue;
    }
    sources.add(read.source);
    const lines = read.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx] || "";
      const lower = line.toLowerCase();
      const hits = terms.filter((term) => lower.includes(term)).length;
      const exact = lower.includes(query.toLowerCase()) ? 1 : 0;
      if (hits === 0 && exact === 0) continue;
      const start = Math.max(0, idx - 2);
      const end = Math.min(lines.length, idx + 3);
      const excerpt = lines
        .slice(start, end)
        .map((l, off) => `${start + off + 1}: ${l}`)
        .join("\n");
      const pathBoost = repoPath.toLowerCase().includes(terms[0] || "") ? 2 : 0;
      matches.push({
        path: repoPath,
        line: idx + 1,
        score: exact * 8 + hits * 3 + pathBoost,
        excerpt: clip(excerpt, 1_200).text,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  const source =
    sources.size > 1 ? "mixed" : sources.has("local") ? "local" : sources.has("github") ? "github" : "local";
  return {
    agent: repo.agent,
    query,
    source,
    count: matches.length,
    matches: matches.slice(0, limit),
  };
}

export function normalizeKnowledgePath(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) throw new Error("path_required");
  const normalized = path.posix.normalize(cleaned).replace(/^(\.\/)+/, "");
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("path_not_allowed");
  }
  if (!isAllowedKnowledgePath(normalized)) {
    throw new Error(`path_not_allowed:${normalized}`);
  }
  return normalized;
}

function isAllowedKnowledgePath(repoPath: string): boolean {
  if (ROOT_DOCS.has(repoPath)) return true;
  if (repoPath.startsWith("brain/") && repoPath.endsWith(".md")) return true;
  if (repoPath.startsWith("memory/") && repoPath.endsWith(".md")) return true;
  if (repoPath.startsWith("docs/adr/") && repoPath.endsWith(".md")) return true;
  if (/^skills\/[^/]+\/SKILL\.md$/.test(repoPath)) return true;
  if (/^prompts\/[A-Za-z0-9_.-]+\.md$/.test(repoPath)) return true;
  return false;
}

async function readRepoText(repoPath: string, repo: RepoConfig): Promise<RepoRead> {
  const localRoot = repo.localRoot;
  if (localRoot) {
    try {
      const root = path.resolve(localRoot);
      const full = path.resolve(root, ...repoPath.split("/"));
      const rootCmp = root.toLowerCase();
      const fullCmp = full.toLowerCase();
      if (fullCmp !== rootCmp && !fullCmp.startsWith(`${rootCmp}${path.sep}`)) {
        throw new Error("path_escape_blocked");
      }
      const stat = await fs.stat(full);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        return { path: repoPath, source: "local", content: await fs.readFile(full, "utf8") };
      }
      if (stat.isFile()) throw new Error("file_too_large");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }

  const url = `${repo.rawBase}/${repoPath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetchWithTimeout(url, { headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`repo_fetch_${res.status}`);
  const content = await res.text();
  if (content.length > MAX_FILE_BYTES) throw new Error("file_too_large");
  return { path: repoPath, source: "github", content };
}

async function listSearchablePaths(repo: RepoConfig): Promise<string[]> {
  const localRoot = repo.localRoot;
  if (localRoot && (await dirExists(localRoot))) {
    const paths = new Set<string>();
    for (const doc of ROOT_DOCS) {
      if (await fileExists(path.join(localRoot, doc))) paths.add(doc);
    }
    for (const dir of ["brain", "memory", "docs/adr"]) {
      await walkMarkdown(localRoot, dir, paths);
    }
    return [...paths].filter(isAllowedKnowledgePath).sort();
  }

  const res = await fetchWithTimeout(repo.treeUrl, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`repo_tree_${res.status}`);
  const body = (await res.json().catch(() => null)) as
    | { tree?: Array<{ path?: string; type?: string; size?: number }> }
    | null;
  const paths = (body?.tree || [])
    .filter((item) => item.type === "blob")
    .map((item) => String(item.path || ""))
    .filter((p) => isAllowedKnowledgePath(p))
    .filter((p) => ROOT_DOCS.has(p) || p.startsWith("brain/") || p.startsWith("memory/") || p.startsWith("docs/adr/"))
    .sort();
  return paths;
}

async function walkMarkdown(root: string, relDir: string, out: Set<string>): Promise<void> {
  const fullDir = path.join(root, ...relDir.split("/"));
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await walkMarkdown(root, rel, out);
    } else if (entry.isFile() && rel.endsWith(".md")) {
      out.add(rel);
    }
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`,
    truncated: true,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}
