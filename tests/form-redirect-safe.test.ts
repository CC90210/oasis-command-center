/**
 * A public form sends its visitor only to a web address or a path on this site.
 *
 * WHY. A form's redirect_url is typed by the workspace that owns the form, was
 * saved verbatim (app/api/forms/route.ts, app/api/forms/[id]/route.ts) and is
 * opened with `window.location.href` after the last step
 * (components/forms/FormPublicClient.tsx). A `javascript:` value there runs
 * script in this site's origin for every visitor who submits, signed-in
 * operators included: stored XSS (2026-10-19 audit). lib/forms/redirect-url.ts
 * safeFormRedirect now decides, the save routes refuse anything it refuses,
 * and the public page follows only what it allows.
 *
 * Run: node --conditions=react-server --import tsx tests/form-redirect-safe.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRedirectInput, safeFormRedirect } from "../lib/forms/redirect-url";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log("form-redirect-safe:");

check("script and data URLs are refused, however they are spelled", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "mailto:someone@example.com",
  ]) {
    assert.equal(safeFormRedirect(bad), null, JSON.stringify(bad));
  }
});

check("a path that is really another host is refused", () => {
  for (const bad of ["//evil.example/x", "/\\evil.example/x", "\\\\evil.example", "/\t/evil.example", "/\n/evil.example"]) {
    assert.equal(safeFormRedirect(bad), null, JSON.stringify(bad));
  }
});

check("web addresses pass through", () => {
  assert.equal(safeFormRedirect("https://example.com/thanks?x=1#top"), "https://example.com/thanks?x=1#top");
  assert.equal(safeFormRedirect("http://example.com"), "http://example.com/");
  assert.equal(safeFormRedirect("  https://example.com/a  "), "https://example.com/a");
});

check("a bare domain becomes https, not a path under the form page", () => {
  assert.equal(safeFormRedirect("example.com/thanks"), "https://example.com/thanks");
});

check("paths on this site keep their query and fragment", () => {
  assert.equal(safeFormRedirect("/f/oasis-ai-cc/ai-audit?utm_source=x&v=1#book"), "/f/oasis-ai-cc/ai-audit?utm_source=x&v=1#book");
  assert.equal(safeFormRedirect("/go/community?form=vsl"), "/go/community?form=vsl");
});

check("nothing, or not a string, is no redirect", () => {
  for (const empty of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(safeFormRedirect(empty), null);
  }
});

check("a request body's redirect_url: strings are checked, empty clears, anything else is refused", () => {
  assert.deepEqual(parseRedirectInput(undefined), { ok: true, value: null });
  assert.deepEqual(parseRedirectInput(null), { ok: true, value: null });
  assert.deepEqual(parseRedirectInput(""), { ok: true, value: null });
  assert.deepEqual(parseRedirectInput("   "), { ok: true, value: null });
  assert.deepEqual(parseRedirectInput("example.com/thanks"), { ok: true, value: "https://example.com/thanks" });
  assert.deepEqual(parseRedirectInput("/f/oasis-ai-cc/vsl"), { ok: true, value: "/f/oasis-ai-cc/vsl" });
  // String() would have turned the array into an accepted address, and `false`
  // used to clear the redirect silently (CodeRabbit on #710).
  for (const bad of [["example.com/thanks"], false, true, 0, 42, { url: "https://example.com" }, "javascript:alert(1)"]) {
    assert.deepEqual(parseRedirectInput(bad), { ok: false }, JSON.stringify(bad));
  }
  // The 2000-character cap the routes always applied still holds.
  const long = parseRedirectInput(`https://example.com/${"a".repeat(3000)}`);
  assert.ok(long.ok && long.value !== null && long.value.length <= 2000);
});

check("both save routes refuse what parseRedirectInput refuses", () => {
  for (const rel of ["app/api/forms/route.ts", "app/api/forms/[id]/route.ts"]) {
    const src = read(rel);
    assert.ok(src.includes('from "@/lib/forms/redirect-url"'), `${rel} imports the redirect check`);
    assert.ok(/parseRedirectInput\(body\.redirect_url\)/.test(src), `${rel} checks the submitted redirect_url`);
    assert.ok(src.includes('"invalid_redirect_url"'), `${rel} answers a refused redirect with a 400`);
    assert.ok(!/String\(body\.redirect_url\)/.test(src), `${rel} never coerces the raw value`);
  }
});

check("the public page navigates only through safeFormRedirect", () => {
  const src = read("components/forms/FormPublicClient.tsx");
  const assignments = src.match(/window\.location\.href\s*=\s*([^;]+);/g) ?? [];
  assert.deepEqual(assignments, ["window.location.href = safeTarget;"], "every navigation goes through the guard");
  assert.ok(/const safeTarget = safeFormRedirect\(target\);/.test(src));
});

if (failures > 0) {
  console.log(`form-redirect-safe: ${failures} failure(s)`);
  process.exit(1);
}
console.log("form-redirect-safe: all passed");
