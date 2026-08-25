/**
 * The geometry harness. Measures REAL RENDERED PIXELS in Chrome at five widths.
 *
 * WHY THIS EXISTS. On 2026-08-25 a fully-reasoned, tests-green, review-clean
 * layout shipped a 1122px table inside a 974px box with a control clipped away.
 * Nothing in the repo could have caught it: typecheck, tests, lint and build
 * render nothing, and the app's login wall is what has stopped every session
 * looking at this feature in a browser at all. Reasoning about CSS widths is
 * how that bug happened; the only defence is to measure.
 *
 * WHAT IT ASSERTS, and why each one is a bug that has actually shipped here:
 *   - no horizontal overflow of the page or of any `overflow-hidden` box
 *     (the clipped "View site" control);
 *   - no interactive control whose box lies outside its clipping ancestor
 *     (same bug, seen from the control's side rather than the container's);
 *   - no phone number rendered across more than one line (the operator's
 *     screenshot of `+1-416-` / `259-` / `9326`);
 *   - every interactive target at least 44x44 CSS px on touch widths
 *     (a 14px checkbox is a mis-claimed lead, and claims are compare-and-swap:
 *     a wrong claim is a real business a rep must not call).
 *
 * ─── HOW TO RUN IT ─────────────────────────────────────────────────────────
 *
 *   node .measure/build.mjs current     # real Tailwind CSS + a real React bundle
 *   node .measure/measure.mjs           # measures, screenshots, exits non-zero on a fail
 *
 * And to grade a change against what `main` ships, from a checkout of `main`:
 *
 *   node .measure/build.mjs baseline
 *   HARNESS_ENTRY=entry-baseline.tsx HARNESS_LABEL=baseline node .measure/measure.mjs
 *
 * Playwright is NOT a dependency of this repo and must not become one -- a
 * browser download in CI for a tool nobody runs there is a cost with no reader.
 * It is resolved from the global install (`npm i -g playwright && npx playwright
 * install chromium`). If that import fails, install it; do not stub it out and
 * report a pass.
 *
 * Artifacts (harness.js, harness.css, shots/, results-*.json) are gitignored.
 * Only the sources are committed, so the next session rebuilds in ~4 seconds.
 */
import { chromium } from "/Users/echel/AppData/Roaming/npm/node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * iPhone 12/13/14, iPhone Pro Max, iPad portrait, small laptop, laptop, and the
 * two desktop widths the rail's `2xl` breakpoint depends on. 1440 is the last
 * width where the rail is still a sheet and 1536 is the first where it is a
 * column again, so leaving them out would mean shipping the one transition
 * nobody had measured.
 */
const WIDTHS = [390, 414, 768, 1024, 1280, 1440, 1536];
/** Below Tailwind's `md` (768) MainShell drops the sidebar margin entirely.
 *  1024 is included as a touch width on purpose: an iPad in landscape is a
 *  touch device, and a 28px control does not know what breakpoint it is at. */
const TOUCH_MAX = 1024;
const MIN_TAP = 44;

// ---------------------------------------------------------------------------
// A harness that measures markup the app does not ship is worse than none: it
// reports a pass. These strings are copied from MainShell.tsx and
// WebLeadsBrowser.tsx into harness.html / entry.tsx, so they are checked back
// against their sources on every run.
// ---------------------------------------------------------------------------
function assertHarnessMatchesApp() {
  const shell = fs.readFileSync(path.join(repo, "components", "MainShell.tsx"), "utf8");
  const browser = fs.readFileSync(path.join(repo, "components", "web-leads", "WebLeadsBrowser.tsx"), "utf8");
  const html = fs.readFileSync(path.join(here, "harness.html"), "utf8");
  const entry = fs.readFileSync(path.join(here, process.env.HARNESS_ENTRY || "entry.tsx"), "utf8");
  const fail = [];
  for (const s of [
    "ml-0 md:ml-[var(--sidebar-w,15rem)] relative z-10 pt-14 md:pt-0 transition-[margin] duration-200",
    "mx-auto max-w-7xl px-4 md:px-8 py-6 md:py-8",
  ]) {
    // MainShell composes the second one from a CONTENT_WIDTH constant, so match
    // on the distinctive fragments rather than the assembled string.
    const needle = s.includes("max-w-7xl") ? "px-4 md:px-8 py-6 md:py-8" : s;
    if (!shell.includes(needle)) fail.push(`MainShell.tsx no longer contains: ${needle}`);
    if (!html.includes(s)) fail.push(`harness.html no longer contains: ${s}`);
  }
  for (const s of ['className="min-w-0 flex-1 space-y-4"']) {
    if (!browser.includes(s)) fail.push(`WebLeadsBrowser.tsx no longer contains: ${s}`);
    if (!entry.includes(s)) fail.push(`entry no longer contains: ${s}`);
  }
  // The row wrapper is the one the mobile work changes, so it is read out of
  // the app and required to be the one the harness renders.
  const m = browser.match(/const listBlock = \(\s*(?:\n\s*\/\/[^\n]*)*\s*\n?\s*<div className="([^"]+)"/);
  if (!m) fail.push("could not find WebLeadsBrowser's listBlock wrapper div");
  else if (!entry.includes(`<div className="${m[1]}">`)) {
    fail.push(`entry must render WebLeadsBrowser's listBlock wrapper verbatim: "${m[1]}"`);
  }
  if (fail.length) {
    console.error("HARNESS DRIFT -- it is no longer measuring the app:\n  " + fail.join("\n  "));
    process.exit(2);
  }
}

/** Runs in the page. Returns plain data only. */
const PROBE = () => {
  const out = {
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    // A modal that hides itself with CSS while keeping the body scroll lock is
    // an unscrollable page with nothing on screen to blame. Codex found exactly
    // that on the filter sheet across `2xl` (2026-08-25); this is what proves
    // the fix, at a real viewport width rather than by reading the source.
    bodyOverflow: document.body.style.overflow || getComputedStyle(document.body).overflowY,
    filterSheetOpen: Boolean(document.querySelector("[role='dialog'][aria-label='Filters']")),
    boxes: {},
    overflowing: [],
    clipped: [],
    wrappedPhones: [],
    smallTargets: [],
    targetCount: 0,
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  const describe = (el) => {
    const bits = [el.tagName.toLowerCase()];
    if (el.id) bits.push("#" + el.id);
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).slice(0, 4).join(".");
    if (cls) bits.push("." + cls);
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    if (label) bits.push(`"${label}"`);
    return bits.join(" ");
  };

  for (const [key, sel] of Object.entries({
    content: "#content",
    poolResults: "#pool .min-w-0.flex-1",
    mineResults: "#mine .min-w-0.flex-1",
    poolTable: "#pool table",
    mineTable: "#mine table",
    poolCards: "#pool [data-mobile-cards]",
    mineCards: "#mine [data-mobile-cards]",
    rail: "#pool aside",
  })) {
    const el = document.querySelector(sel);
    if (el && visible(el)) {
      const r = el.getBoundingClientRect();
      out.boxes[key] = { w: Math.round(r.width * 100) / 100, left: Math.round(r.left), right: Math.round(r.right) };
    } else {
      out.boxes[key] = null;
    }
  }

  // Any box that clips its own content horizontally.
  for (const el of document.querySelectorAll("*")) {
    if (!visible(el)) continue;
    // `sr-only` is a 1x1 clipping box by definition -- it is how the app hides
    // a label from sight while leaving it to a screen reader. Reporting it
    // would bury the real findings under one entry per visually-hidden label.
    if (el.closest(".sr-only")) continue;
    const cs = getComputedStyle(el);
    const clips = cs.overflowX === "hidden" || cs.overflowX === "clip";
    if (clips && el.scrollWidth > el.clientWidth + 1) {
      // `truncate` (overflow:hidden + text-overflow:ellipsis) clipping TEXT is
      // the designed behaviour, not a defect. Only report a box that is
      // clipping laid-out boxes.
      if (cs.textOverflow === "ellipsis" && el.children.length === 0) continue;
      out.overflowing.push({ el: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
  }

  // CALL MODE: the four dispositions must be ON SCREEN and in the bottom half
  // of it. This is the assertion that would have caught the pre-2026-08-25
  // layout, where they were the bottom of a single scrolling column and a rep
  // had to scroll past the talking points to log a call they had just made.
  const dialog = document.querySelector("[role='dialog'][aria-label='Call mode']");
  if (dialog) {
    const buttons = [...dialog.querySelectorAll("aside button")].filter(visible);
    // Matched on the label SPAN, not the button's textContent: the button also
    // contains a key cap that `display:none` hides on a phone but which still
    // contributes to textContent, so "No answer" is "No answer1" at every width.
    const dispositions = buttons.filter((b) => {
      const t = (b.querySelector("span")?.textContent || "").trim();
      return ["No answer", "Connected", "Interested", "Not interested"].includes(t);
    });
    out.dispositions = dispositions.map((b) => {
      const r = b.getBoundingClientRect();
      return {
        label: (b.querySelector("span")?.textContent || "").trim(),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        w: Math.round(r.width), h: Math.round(r.height),
        onScreen: r.bottom <= window.innerHeight + 1 && r.top >= 0,
        inThumbHalf: r.top >= window.innerHeight / 2,
      };
    });
    const main = dialog.querySelector("main");
    out.callMain = main
      ? { h: Math.round(main.getBoundingClientRect().height), scrolls: main.scrollHeight > main.clientHeight + 1 }
      : null;
    const tel = dialog.querySelector("a[href^='tel:']");
    if (tel) {
      const r = tel.getBoundingClientRect();
      out.callButton = { w: Math.round(r.width), h: Math.round(r.height), onScreen: r.bottom <= window.innerHeight + 1 };
    }
  }

  // Any interactive control whose box falls outside a clipping ancestor.
  const TARGETS = "a[href], button, input, select, textarea, [role='tab'], [role='button'], [tabindex]:not([tabindex='-1'])";
  const controls = [...document.querySelectorAll(TARGETS)].filter(visible);
  out.targetCount = controls.length;
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
      const pr = p.getBoundingClientRect();
      if (r.right > pr.right + 1 || r.left < pr.left - 1) {
        out.clipped.push({ el: describe(el), by: describe(p), elRight: Math.round(r.right), boxRight: Math.round(pr.right) });
        break;
      }
    }
  }

  // A phone number split across lines is not a phone number a rep can read.
  for (const el of document.querySelectorAll("a[href^='tel:'], [data-phone]")) {
    if (!visible(el)) continue;
    if (el.getClientRects().length > 1) out.wrappedPhones.push({ el: describe(el), lines: el.getClientRects().length });
  }

  // Tap targets. A control smaller than 44px is measured with its own padding
  // AND with any label that expands its hit area, which is why the <label>
  // wrapping a checkbox is credited to the checkbox.
  for (const el of controls) {
    let r = el.getBoundingClientRect();
    const lbl = el.closest("label");
    if (lbl) {
      const lr = lbl.getBoundingClientRect();
      r = { width: Math.max(r.width, lr.width), height: Math.max(r.height, lr.height) };
    }
    if (r.width < 44 || r.height < 44) {
      out.smallTargets.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return out;
};

const url = (surface) =>
  "file:///" + path.join(here, "harness.html").replace(/\\/g, "/") +
  (surface === "sheet" ? "?surface=list&sheet=1" : `?surface=${surface}`);

async function main() {
  assertHarnessMatchesApp();
  const label = process.env.HARNESS_LABEL || "current";
  const browser = await chromium.launch();
  const results = [];
  // "sheet" is the list with the filter overlay OPEN. A closed overlay cannot
  // overflow and cannot have a small tap target, so grading only the closed
  // state would grade the case that was never in doubt.
  const surfaces = process.env.HARNESS_ENTRY === "entry-baseline.tsx" ? ["list", "call"] : ["list", "sheet", "call"];
  for (const surface of surfaces) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
        isMobile: width <= TOUCH_MAX,
        hasTouch: width <= TOUCH_MAX,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url(surface));
      // React mount + the audit fetch the stub resolves immediately.
      // The list always renders; the sheet may legitimately be closed already at
      // `2xl`, which is the whole point of the assertion below. So both list
      // surfaces wait on the list, never on the overlay.
      await page.waitForFunction(
        (s) =>
          (s === "call"
            ? document.querySelector("[role='dialog']")
            : document.querySelector("#pool table, #pool [data-mobile-cards]")) !== null,
        surface,
        { timeout: 15000 },
      );
      await page.waitForTimeout(250);
      const probe = await page.evaluate(PROBE);
      results.push({ surface, width, errors, ...probe });
      await page.screenshot({ path: path.join(here, "shots", `${label}-${surface}-${width}.png`), fullPage: surface === "list" });
      await ctx.close();
    }
  }
  /**
   * THE ACTUAL REPORTED PATH: open the sheet on a phone, then cross `2xl`.
   *
   * Every measurement above is a fresh load at a fixed width, which exercises
   * the mount-time close and not the resize listener. Codex's P2 was
   * specifically a RESIZE -- a rep rotating a tablet or docking a laptop -- so
   * this drives that transition and reads the body back afterwards.
   */
  let resize = null;
  if (process.env.HARNESS_ENTRY !== "entry-baseline.tsx") {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(url("sheet"));
    await page.waitForSelector("[role='dialog'][aria-label='Filters']", { timeout: 15000 });
    const before = await page.evaluate(() => document.body.style.overflow);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(300);
    resize = await page.evaluate(() => ({
      sheetPresent: Boolean(document.querySelector("[role='dialog'][aria-label='Filters']")),
      railPresent: Boolean(document.querySelector("#pool aside")),
      bodyOverflow: document.body.style.overflow,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    }));
    resize.before = before;
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(here, `results-${label}.json`), JSON.stringify({ results, resize }, null, 2));

  let failures = 0;
  for (const r of results) {
    const touch = r.width <= TOUCH_MAX;
    console.log(`\n=== ${r.surface} @ ${r.width}px ${touch ? "(touch)" : ""} ===`);
    if (r.errors.length) { console.log("  PAGE ERRORS: " + r.errors.join(" | ")); failures++; }
    const b = r.boxes;
    const box = (k) => (b[k] ? `${b[k].w}px` : "not rendered");
    if (r.surface === "list" || r.surface === "sheet") {
      console.log(`  content box        ${box("content")}`);
      console.log(`  filter rail        ${box("rail")}`);
      console.log(`  pool results col   ${box("poolResults")}   table ${box("poolTable")}   cards ${box("poolCards")}`);
      console.log(`  mine results col   ${box("mineResults")}   table ${box("mineTable")}   cards ${box("mineCards")}`);
    }
    if (r.surface === "call" && r.dispositions) {
      const d = r.dispositions;
      console.log(`  call button        ${r.callButton ? `${r.callButton.w}x${r.callButton.h}${r.callButton.onScreen ? "" : "  OFF SCREEN"}` : "none"}`);
      console.log(`  talking points     ${r.callMain ? `${r.callMain.h}px tall, ${r.callMain.scrolls ? "scrolls" : "fits"}` : "none"}`);
      const off = d.filter((x) => !x.onScreen);
      const high = d.filter((x) => !x.inThumbHalf);
      console.log(`  dispositions       ${d.length} found, ${d.map((x) => `${x.w}x${x.h}`).join(" ")}  top ${Math.min(...d.map((x) => x.top))}`);
      if (d.length !== 4) { failures++; console.log(`      FAIL expected 4 disposition buttons, found ${d.length}`); }
      if (off.length) { failures++; console.log(`      FAIL off screen: ${off.map((x) => x.label).join(", ")}`); }
      // THUMB REACH IS ASSERTED ONLY ON THE STACKED LAYOUT (below `lg`), and
      // that is a scope, not a softening. At `lg` and above the log panel is a
      // full-height RIGHT COLUMN, so "the bottom of the screen" is not where
      // its buttons belong -- they are all on screen at once, which is what the
      // `onScreen` assertion above checks at every width. The rule being
      // protected is the phone one: a rep holding a phone low must not have to
      // scroll past the talking points to log the call they just made.
      if (r.width < 1024 && high.length) {
        failures++;
        console.log(`      FAIL above the thumb half (viewport 900, need top >= 450): ${high.map((x) => `${x.label}@${x.top}`).join(", ")}`);
      }
    }
    if (r.surface === "sheet") {
      // Below 1536 the sheet is the only way to the filters and must be there.
      // At 1536 and above the rail has taken over, so the sheet must have
      // CLOSED ITSELF -- not merely gone `display:none` while still holding the
      // body scroll lock, which is the Codex P2 this asserts against.
      const railWidth = r.width >= 1536;
      const wantOpen = !railWidth;
      const locked = r.bodyOverflow === "hidden";
      console.log(`  filter sheet       ${r.filterSheetOpen ? "open" : "closed"}, body overflow "${r.bodyOverflow}"`);
      if (r.filterSheetOpen !== wantOpen) {
        failures++;
        console.log(`      FAIL expected the sheet ${wantOpen ? "open" : "closed"} at ${r.width}px`);
      }
      if (!wantOpen && locked) {
        failures++;
        console.log(`      FAIL the sheet closed but left the page scroll-locked -- nothing on screen can release it`);
      }
    }
    const docOverflow = r.docScrollWidth - r.docClientWidth;
    console.log(`  page overflow      ${docOverflow > 0 ? `FAIL +${docOverflow}px` : "0px"}`);
    if (docOverflow > 0) failures++;
    if (r.overflowing.length) {
      failures++;
      console.log(`  clipping boxes     FAIL ${r.overflowing.length}`);
      for (const o of r.overflowing.slice(0, 6)) console.log(`      ${o.scrollWidth} inside ${o.clientWidth} -- ${o.el}`);
    } else console.log("  clipping boxes     none");
    if (r.clipped.length) {
      failures++;
      console.log(`  clipped controls   FAIL ${r.clipped.length}`);
      for (const c of r.clipped.slice(0, 6)) console.log(`      ${c.el} right ${c.elRight} > ${c.boxRight} of ${c.by}`);
    } else console.log("  clipped controls   none");
    if (r.wrappedPhones.length) {
      failures++;
      console.log(`  wrapped phones     FAIL ${r.wrappedPhones.map((p) => `${p.lines} lines: ${p.el}`).join(" | ")}`);
    } else console.log("  wrapped phones     none");
    if (touch) {
      if (r.smallTargets.length) {
        failures++;
        console.log(`  tap targets <${MIN_TAP}px   FAIL ${r.smallTargets.length} of ${r.targetCount}`);
        for (const t of r.smallTargets.slice(0, 12)) console.log(`      ${t.w}x${t.h}  ${t.el}`);
      } else console.log(`  tap targets        all ${r.targetCount} >= ${MIN_TAP}px`);
    } else {
      console.log(`  tap targets        ${r.targetCount} controls (not a touch width, not asserted)`);
    }
  }
  if (resize) {
    console.log(`\n=== resize 390 -> 1600 with the filter sheet OPEN ===`);
    console.log(`  before             body overflow "${resize.before}", sheet open`);
    console.log(`  after              sheet ${resize.sheetPresent ? "STILL MOUNTED" : "closed"}, rail ${resize.railPresent ? "shown" : "absent"}, body overflow "${resize.bodyOverflow}"`);
    if (resize.sheetPresent) { failures++; console.log("      FAIL the sheet survived the breakpoint it is supposed to hand over at"); }
    if (resize.bodyOverflow === "hidden") { failures++; console.log("      FAIL the page is still scroll-locked and no visible control can release it"); }
    if (!resize.railPresent) { failures++; console.log("      FAIL the rail did not take over, so the filters are now unreachable"); }
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL -- ${failures} failing assertions`}`);
  process.exit(failures === 0 ? 0 : 1);
}

fs.mkdirSync(path.join(here, "shots"), { recursive: true });
main().catch((e) => { console.error(e); process.exit(2); });
