/**
 * The persistent "Not ready? Join the free community" link (HANDOVER
 * 2026-10-12 sections 1.3 and 4): renders only when configured for a real
 * tenant/form, never for a preview, never a bare URL with no tracking
 * params, and never an em dash in its copy.
 *
 * Also pins lib/offers/preserve-query.ts, the pure query-preservation helper
 * FormPublicClient uses to carry kw/cat/utm/visit params onto a V2 router
 * destination across a same-tab navigation — including the open-redirect
 * guard (`isSafeInternalPath`), which is the one thing standing between a
 * server-trusted relative path and a client blindly navigating anywhere a
 * response claims.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-community-link.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendPreservedParams, isSafeInternalPath } from "../lib/offers/preserve-query";

function renderCommunityLink(): Record<string, string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
  const tokens = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t.length > 0);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--conditions" || tokens[i] === "-C") { i += 1; continue; }
    if (/^(--conditions=|-C=)/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
  else delete childEnv.NODE_OPTIONS;

  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-community-link.render.ts"], {
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(r.status, 0, `renderer failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function main() {
  console.log("offer-community-link:");

  const html = renderCommunityLink();

  console.log("  configured + real slugs renders the link with form/t params");
  assert.match(html.configured, /href="\/go\/community\?form=protocol&amp;t=oasis-ai-cc"/);
  assert.match(html.configured, />Not ready\? Join the free community</);
  assert.doesNotMatch(html.configured, /—/, "no em dash in the copy");
  assert.doesNotMatch(html.configured, /\bBravo\b|\bMaven\b|\bAtlas\b|\bAura\b|\bAPEX\b|\bKnut\b/, "never names a house agent");

  console.log("  not configured for this tenant renders nothing");
  assert.equal(html.notConfigured, "", "an unconfigured tenant must render no link at all");

  console.log("  null tenantSlug/formSlug (the owner's preview) renders nothing");
  assert.equal(html.previewNullSlugs, "", "a preview must never render a trackable link");

  console.log("preserve-query:");

  console.log("  appends utm/cat/visit params onto a bare relative path");
  assert.equal(
    appendPreservedParams("/f/oasis-ai-cc/protocol", { cat: "p1", kw: "launch", v: "visit-123" }),
    "/f/oasis-ai-cc/protocol?cat=p1&kw=launch&v=visit-123",
  );

  console.log("  merges onto a path that already carries a query string, without clobbering it");
  assert.equal(
    appendPreservedParams("/go/community?form=vsl&t=oasis-ai-cc", { v: "visit-123" }),
    "/go/community?form=vsl&t=oasis-ai-cc&v=visit-123",
  );

  console.log("  drops empty/undefined params silently");
  assert.equal(
    appendPreservedParams("/f/oasis-ai-cc/protocol", { cat: "", kw: undefined, utm_source: "google" }),
    "/f/oasis-ai-cc/protocol?utm_source=google",
  );

  console.log("  preserves a hash fragment");
  assert.equal(
    appendPreservedParams("/f/oasis-ai-cc/protocol#book", { cat: "p1" }),
    "/f/oasis-ai-cc/protocol?cat=p1#book",
  );

  console.log("  CommunityLink reads the visit id after hydration, never during render (no server/client href mismatch)");
  {
    const linkSrc = readFileSync("components/offer-pages/CommunityLink.tsx", "utf8");
    assert.match(linkSrc, /useEffect\(\(\) => \{\s*setVisitId\(peekVisitId\(\)\);\s*\}, \[\]\);/, "the visit id must be read inside a mount effect");
    assert.equal((linkSrc.match(/peekVisitId\(\)/g) ?? []).length, 1, "peekVisitId must not also be called during render");
  }

  console.log("  isSafeInternalPath rejects every open-redirect shape");
  assert.equal(isSafeInternalPath("/f/oasis-ai-cc/protocol"), true);
  assert.equal(isSafeInternalPath("//evil.example.com"), false, "protocol-relative must be refused");
  assert.equal(isSafeInternalPath("https://evil.example.com"), false);
  assert.equal(isSafeInternalPath("javascript:alert(1)"), false);
  assert.equal(isSafeInternalPath("/\\evil.example.com"), false, "a backslash is a slash to browsers: /\\evil.com goes off-site");
  assert.equal(isSafeInternalPath("/\\/evil.example.com"), false);
  assert.equal(isSafeInternalPath("/f/a\\b"), false, "no internal path needs a backslash anywhere");
  assert.equal(isSafeInternalPath("/f/oasis\tai"), false, "control characters are refused");
  assert.equal(isSafeInternalPath(""), false);
  assert.equal(isSafeInternalPath(null), false);
  assert.equal(isSafeInternalPath(undefined), false);

  console.log("  appendPreservedParams refuses to touch an unsafe path at all");
  assert.equal(appendPreservedParams("https://evil.example.com", { v: "x" }), "https://evil.example.com");

  console.log("offer-community-link: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
