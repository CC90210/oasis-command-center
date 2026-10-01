#!/usr/bin/env node
/**
 * scripts/qa/crawl.mjs - the signed-in crawl of every Command Center page.
 *
 *   npm run qa:crawl -- --base http://127.0.0.1:3100 --db <local.db> --seed <seed.json> --out <dir>
 *
 * For four viewers (the OASIS founder owner, a second founder, a client
 * workspace owner and a sales rep) and two viewports (1440x900, 390x844) it
 * opens every route and records: the HTTP status, an error boundary (and its
 * text), uncaught exceptions, console errors, failed same-origin requests, the
 * time until <main> holds content, and layout defects (horizontal page scroll,
 * clipped text, overlapping fixed bars), plus persona names (Bravo, Maven,
 * Atlas, Aura, Hermes, Lex, Conaugh) visible to the client owner or the rep.
 * Writes <out>/qa-crawl.json and <out>/qa-crawl.md. The pure rules live in
 * scripts/qa/crawl-lib.mjs.
 *
 * Run it under `node --conditions=react-server --import tsx` (the npm script
 * does): it imports the app's OWN session code (lib/turso-auth.ts signSession,
 * lib/onboarding-claim.ts), the OS nav catalog (lib/os/nav.ts) and
 * middleware's isPublic, so the sessions, the route list and the public/private
 * split are the app's, never a copy.
 *
 * SAFETY. The server must be loopback (anything else is refused), sessions are
 * signed with the LOCAL secret in AUTH_SESSION_SECRET (the one the local server
 * was started with, never production's), and every browser request to another
 * host is aborted and counted. The server side is fenced by
 * scripts/qa/egress-guard.cjs.
 *
 * Exit code: 0 when the crawl ran (defects are findings, not a failure); 1 when
 * the harness itself could not work (server down, a session refused, no
 * Playwright).
 */
import { createClient } from "@libsql/client";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  countDefects,
  deadTabDefects,
  deriveRoutes,
  groupDefects,
  listPageFiles,
  PERSONA_NAMES,
  rankDefects,
  renderMarkdown,
  visitDefects,
} from "./crawl-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const opts = {
  base: arg("--base", process.env.QA_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, ""),
  db: arg("--db", process.env.QA_DB_PATH || ""),
  seed: arg("--seed", process.env.QA_SEED || ""),
  out: path.resolve(arg("--out", process.env.QA_OUT || "qa-crawl-report")),
  viewers: arg("--viewers", ""),
  viewports: arg("--viewports", "1440x900,390x844"),
  concurrency: Math.max(1, Number(arg("--concurrency", "2")) || 2),
  match: arg("--match", ""),
  slowMs: Number(arg("--slow-ms", "3000")) || 3000,
  readyTimeoutMs: Number(arg("--ready-timeout-ms", "20000")) || 20000,
  navTimeoutMs: Number(arg("--nav-timeout-ms", "60000")) || 60000,
  screenshots: arg("--screenshots", ""),
  egressLog: arg("--egress-log", process.env.EGRESS_LOG || ""),
};

function fail(message) {
  console.error(`qa:crawl: ${message}`);
  process.exit(1);
}

const baseUrl = new URL(opts.base);
if (!/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(baseUrl.hostname)) {
  fail(`--base must be a loopback address (got ${baseUrl.hostname}); this crawl never runs against a deployed site`);
}
if (!opts.db || /^(libsql|https?|wss?):/i.test(opts.db) || !existsSync(opts.db)) fail("--db must name the local database file the server reads");
if (!opts.seed || !existsSync(opts.seed)) fail("--seed must name the seed.json written by scripts/qa/seed.mjs");
const secret = process.env.AUTH_SESSION_SECRET || "";
if (secret.length < 32) fail("AUTH_SESSION_SECRET must be the LOCAL secret the server was started with (32+ characters)");

const appModule = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ---------------------------------------------------------------------------
// Inputs: seed, routes, sessions
// ---------------------------------------------------------------------------

async function catalogParams() {
  // Values that come from the app's own catalogs rather than database rows.
  const { OS_DEPARTMENTS } = await appModule("lib/os/departments.ts");
  return { "/team/[dept]": OS_DEPARTMENTS.map((d) => ({ dept: d.slug })) };
}

async function mintSessions(viewers) {
  const { signSession } = await appModule("lib/turso-auth.ts");
  const { computeOnboardingState } = await appModule("lib/onboarding-claim.ts");
  const db = createClient({ url: `file:${path.resolve(opts.db)}` });
  const sessions = {};
  try {
    for (const v of viewers) {
      const rs = await db.execute({ sql: `SELECT email, session_version FROM "_supabase_auth_users" WHERE id = ?`, args: [v.authUserId] });
      const row = rs.rows[0];
      if (!row) fail(`viewer ${v.key}: auth user ${v.authUserId} is not in the local database`);
      // The same claim the login route stamps into the cookie (app/api/auth/turso-login).
      const { claim } = await computeOnboardingState(db, v.authUserId);
      sessions[v.key] = {
        claim,
        cookie: signSession({
          sub: v.authUserId,
          email: String(row.email),
          exp: Math.floor(Date.now() / 1000) + 8 * 3600,
          ver: Number(row.session_version ?? 0),
          ...(claim ? { onb: claim } : {}),
        }),
      };
    }
  } finally {
    db.close();
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// In the browser
// ---------------------------------------------------------------------------

/**
 * Records when <main> first holds real content: text outside the header,
 * footer and nav, with no loading skeleton (aria-busy) left in it. A page with
 * no <main> (the full-bleed ones) counts its body once the document has
 * parsed. Runs before any page script.
 */
const READY_PROBE = `(() => {
  const ready = () => {
    if (window.__qaMainReadyAt != null) return true;
    const main = document.querySelector("main") || (document.readyState !== "loading" ? document.body : null);
    if (!main || main.querySelector('[aria-busy="true"]')) return false;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.nodeValue || !t.nodeValue.trim()) continue;
      const el = t.parentElement;
      if (!el || el.closest("header, footer, nav, script, style")) continue;
      window.__qaMainReadyAt = performance.now();
      return true;
    }
    return false;
  };
  const tick = () => { if (!ready()) setTimeout(tick, 50); };
  tick();
})();`;

/** Everything measured on a loaded page. Self-contained: Playwright serialises it into the page. */
function measurePage({ personaNames, checkPersona }) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (el) => {
    if (!ids.has(el)) ids.set(el, nextId++);
    return ids.get(el);
  };
  const simpleClass = (c) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(c);
  const sel = (el) => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cur.id)) {
        parts.unshift(`${tag}#${cur.id}`);
        break;
      }
      let part = tag;
      const label = cur.getAttribute("aria-label");
      if (label && ["nav", "section", "aside", "form", "dialog"].includes(tag)) part += `[aria-label="${label.replace(/"/g, "'")}"]`;
      const cls = [...cur.classList].filter(simpleClass).slice(0, 3);
      if (cls.length) part += `.${cls.join(".")}`;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (["main", "aside", "header", "footer", "body"].includes(tag)) break;
      cur = parent;
    }
    return parts.join(" > ");
  };
  const regionOf = (el) => {
    if (el.closest("aside")) return "rail";
    if (el.closest('[role="dialog"], dialog')) return "dialog";
    const main = el.closest("main");
    if (main) {
      const header = el.closest("header");
      if (header && main.contains(header)) return header.querySelector('nav[aria-label="Breadcrumb"]') ? "content-header" : "page-header";
      if (el.closest("footer")) return "shell-footer";
      return "page";
    }
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.position === "fixed" && p.getBoundingClientRect().top <= 0) return "top-bar";
    }
    return "outside-main";
  };
  const shown = (el, cs) => {
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  };
  // Off to the side is off screen (a closed drawer); below the fold is still on the page.
  const onScreen = (r) => r.width >= 2 && r.height >= 2 && r.right > 0 && r.left < vw;
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const all = [...document.body.querySelectorAll("*")].filter((el) => el instanceof HTMLElement && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME"].includes(el.tagName));

  // Error boundary (app/error.tsx, app/global-error.tsx, app/schedule/error.tsx, Next fallbacks).
  let errorBoundary = null;
  const h1s = [...document.querySelectorAll("h1")];
  const ebH1 = h1s.find((h) => /^(Something went wrong|This page timed out)$/.test(textOf(h)));
  const bodyText = textOf(document.body);
  if (ebH1) {
    const card = ebH1.closest("div.rounded-2xl") || ebH1.parentElement?.parentElement || ebH1;
    errorBoundary = { selector: sel(card), text: textOf(card).slice(0, 400) };
  } else {
    const m = /(Application error: a (client|server)-side exception has occurred[^.]*\.?|The interactive calendar could not render[^.]*\.?|Internal Server Error)/.exec(bodyText);
    if (m) errorBoundary = { selector: "body", text: m[0].slice(0, 400) };
  }
  const notFound = h1s.some((h) => /^(Page not found|404)$/.test(textOf(h))) || /This page could not be found/.test(bodyText.slice(0, 500));

  // Clipped text candidates.
  const clipCandidates = [];
  for (const el of all) {
    const sw = el.scrollWidth;
    const cw = el.clientWidth;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    if (sw - cw <= 1 && sh - ch <= 1) continue;
    if (cw === 0 && ch === 0) continue;
    const cs = getComputedStyle(el);
    const clipX = (cs.overflowX === "hidden" || cs.overflowX === "clip") && sw - cw > 1;
    const clipY = (cs.overflowY === "hidden" || cs.overflowY === "clip") && sh - ch > 1;
    if (!clipX && !clipY) continue;
    if (!shown(el, cs)) continue;
    const box = el.getBoundingClientRect();
    if (!onScreen(box)) continue;
    const text = textOf(el);
    if (!text) continue;
    const left = box.left + el.clientLeft;
    const top = box.top + el.clientTop;
    const right = left + cw;
    const bottom = top + ch;
    let tx = 0;
    let ty = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = 0;
    while (walker.nextNode() && n < 300) {
      const t = walker.currentNode;
      if (!t.nodeValue || !t.nodeValue.trim()) continue;
      n += 1;
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (r.width === 0 && r.height === 0) continue;
        tx = Math.max(tx, r.right - right, left - r.left);
        ty = Math.max(ty, r.bottom - bottom, top - r.top);
      }
    }
    clipCandidates.push({
      selector: sel(el),
      region: regionOf(el),
      text: text.slice(0, 200),
      scrollWidth: sw,
      clientWidth: cw,
      scrollHeight: sh,
      clientHeight: ch,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      textOverflow: cs.textOverflow,
      lineClamp: cs.webkitLineClamp || cs.getPropertyValue("-webkit-line-clamp") || "none",
      textOverflowX: Math.round(tx * 10) / 10,
      textOverflowY: Math.round(ty * 10) / 10,
    });
  }

  // Horizontal page scroll and the elements that push past the right edge.
  const scroller = document.scrollingElement || document.documentElement;
  const hscroll = {
    scrollWidth: scroller.scrollWidth,
    clientWidth: vw,
    htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    offenders: [],
  };
  if (hscroll.scrollWidth > vw + 1) {
    const offenders = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      let contained = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === "fixed" || (p !== el && cs.overflowX !== "visible")) {
          contained = true;
          break;
        }
      }
      if (!contained) offenders.push(el);
    }
    const set = new Set(offenders);
    hscroll.offenders = offenders
      .filter((el) => !set.has(el.parentElement))
      .slice(0, 20)
      .map((el) => ({ selector: sel(el), region: regionOf(el), right: el.getBoundingClientRect().right, text: textOf(el).slice(0, 120) }));
  }

  // Fixed and sticky bars, at the top of the page.
  const bars = (at) => {
    const found = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (!shown(el, cs)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 400 || r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) continue;
      found.push({ el, id: idOf(el), selector: sel(el), region: regionOf(el), x: r.left, y: r.top, width: r.width, height: r.height, text: textOf(el).slice(0, 80), at });
    }
    return found.map((b) => ({
      id: b.id,
      selector: b.selector,
      region: b.region,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      text: b.text,
      at: b.at,
      ancestorIds: found.filter((o) => o.el !== b.el && o.el.contains(b.el)).map((o) => o.id),
    }));
  };
  const barsAtTop = bars("at the top");

  // The rail's links: the doors this viewer is shown.
  const rail = [...document.querySelectorAll("aside a[href]")]
    .map((a) => {
      try {
        const u = new URL(a.getAttribute("href"), location.href);
        return u.origin === location.origin ? u.pathname : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Persona names in visible text, attributes and the tab title.
  const personaHits = [];
  if (checkPersona && personaNames.length) {
    const re = new RegExp(`\\b(${personaNames.join("|")})\\b`);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && personaHits.length < 30) {
      const t = walker.currentNode;
      const m = t.nodeValue ? re.exec(t.nodeValue) : null;
      if (!m) continue;
      const el = t.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      if (!shown(el, getComputedStyle(el))) continue;
      const v = t.nodeValue;
      personaHits.push({ name: m[1], selector: sel(el), region: regionOf(el), snippet: v.slice(Math.max(0, m.index - 50), m.index + 70).replace(/\s+/g, " ").trim() });
    }
    for (const el of document.querySelectorAll("[title], [aria-label], [placeholder], img[alt]")) {
      if (personaHits.length >= 40) break;
      if (!shown(el, getComputedStyle(el))) continue;
      for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
        const value = el.getAttribute(attr);
        const m = value ? re.exec(value) : null;
        if (m) personaHits.push({ name: m[1], selector: `${sel(el)} @${attr}`, region: regionOf(el), snippet: value.slice(0, 120) });
      }
    }
    const tm = re.exec(document.title || "");
    if (tm) personaHits.push({ name: tm[1], selector: "title", region: "tab", snippet: document.title.slice(0, 120) });
  }

  return {
    title: document.title,
    h1: h1s.length ? textOf(h1s[0]).slice(0, 120) : "",
    readyAt: window.__qaMainReadyAt ?? null,
    viewportSize: { width: vw, height: vh },
    errorBoundary,
    notFound,
    clipCandidates,
    hscroll,
    bars: barsAtTop,
    rail: [...new Set(rail)],
    personaHits,
  };
}

/** Fixed and sticky bars after scrolling down, where a sticky header can slide under a fixed one. */
function measureScrolledBars() {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = [];
  const els = [...document.body.querySelectorAll("*")].filter((el) => el instanceof HTMLElement);
  const found = [];
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 400 || r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) continue;
    found.push({ el, r });
  }
  const sel = (el) => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cur.id)) {
        parts.unshift(`${tag}#${cur.id}`);
        break;
      }
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(c)).slice(0, 3);
      parts.unshift(cls.length ? `${tag}.${cls.join(".")}` : tag);
      if (["main", "aside", "header", "footer", "body"].includes(tag)) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  found.forEach((f, i) => {
    const ancestorIds = [];
    found.forEach((o, j) => {
      if (j !== i && o.el.contains(f.el)) ancestorIds.push(100000 + j);
    });
    out.push({
      id: 100000 + i,
      selector: sel(f.el),
      region: f.el.closest("aside") ? "rail" : f.el.closest("main") ? "page" : "top-bar",
      x: f.r.left,
      y: f.r.top,
      width: f.r.width,
      height: f.r.height,
      text: (f.el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      at: "after scrolling",
      ancestorIds,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    fail("Playwright is not installed. Install it for this run only: npm i --no-save playwright@1.58.2 && npx playwright install chromium");
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  mkdirSync(opts.out, { recursive: true });
  const seed = JSON.parse(readFileSync(opts.seed, "utf8"));
  const wanted = opts.viewers ? new Set(opts.viewers.split(",").map((s) => s.trim())) : null;
  const viewers = (seed.viewers || []).filter((v) => !wanted || wanted.has(v.key));
  if (viewers.length === 0) fail("no viewers to crawl (check --viewers against seed.json)");
  const viewports = opts.viewports.split(",").map((s) => {
    const [w, h] = s.trim().split("x").map(Number);
    if (!w || !h) fail(`bad viewport "${s}" (use WIDTHxHEIGHT)`);
    return { key: `${w}x${h}`, width: w, height: h };
  });

  // Routes: the OS nav catalog + every app page, public pages skipped by middleware's own rule.
  const { OS_NAV_CATALOG } = await appModule("lib/os/nav.ts");
  const { isPublic } = await appModule("middleware.ts");
  const derived = deriveRoutes({
    navHrefs: OS_NAV_CATALOG.map((e) => e.href),
    pageFiles: listPageFiles(ROOT),
    paramValues: { ...(seed.params || {}), ...(await catalogParams()) },
    isPublic,
  });
  let routes = derived.routes;
  if (opts.match) {
    const re = new RegExp(opts.match);
    routes = routes.filter((r) => re.test(r.path));
  }
  console.log(`qa:crawl: ${routes.length} routes, ${viewers.length} viewers, ${viewports.length} viewports (${derived.skippedPublic.length} public skipped, ${derived.unexpanded.length} dynamic patterns without a seeded value)`);

  const sessions = await mintSessions(viewers);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  const visits = [];
  const defects = [];
  const rails = Object.fromEntries(viewers.map((v) => [v.key, new Set()]));
  const browserEgress = {};
  const notes = [];
  try {
    for (const viewer of viewers) {
      for (const vp of viewports) {
        const phone = vp.width < 600;
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          baseURL: opts.base,
          isMobile: phone,
          hasTouch: phone,
          deviceScaleFactor: 1,
          acceptDownloads: false,
        });
        await ctx.addCookies([{ name: "oasis_session", value: sessions[viewer.key].cookie, url: opts.base }]);
        await ctx.addInitScript(READY_PROBE);
        // Nothing leaves the machine from the browser either.
        await ctx.route(
          (url) => url.host !== baseUrl.host && /^(https?|wss?):$/.test(url.protocol),
          (route) => {
            const host = new URL(route.request().url()).host;
            browserEgress[host] = (browserEgress[host] ?? 0) + 1;
            return route.abort("blockedbyclient");
          },
        );
        if (typeof ctx.routeWebSocket === "function") {
          await ctx.routeWebSocket((url) => url.host !== baseUrl.host, (ws) => {
            const host = new URL(ws.url()).host;
            browserEgress[host] = (browserEgress[host] ?? 0) + 1;
            ws.close();
          });
        }

        // Signed in? The session is the whole point; a refused one makes every row meaningless.
        // /settings, not "/": a signed-out "/" is rewritten to the marketing home in place.
        const probe = await visitRoute(ctx, viewer, vp, { path: "/settings", pattern: "/settings" }, true);
        if (probe.navigationError) {
          await ctx.close();
          fail(`viewer ${viewer.key}: the server did not answer /settings (${probe.navigationError})`);
        }
        if (probe.finalPath.startsWith("/login")) {
          await ctx.close();
          fail(`viewer ${viewer.key}: the server refused the minted session (/settings -> ${probe.finalPath}). Is AUTH_SESSION_SECRET the one the server was started with?`);
        }
        if (probe.finalPath.startsWith("/onboarding")) notes.push(`${viewer.key} (${vp.key}) is held at ${probe.finalPath} by the onboarding gate`);

        const queue = [...routes];
        const worker = async () => {
          for (let r = queue.shift(); r; r = queue.shift()) {
            const v = await visitRoute(ctx, viewer, vp, r, false);
            visits.push(v);
            for (const href of v.rail || []) rails[viewer.key].add(href);
            const found = visitDefects(v, { slowMs: opts.slowMs, checkPersona: viewer.checkPersona === true });
            defects.push(...found);
            console.log(
              `${viewer.key.padEnd(14)} ${vp.key.padEnd(8)} ${String(v.status ?? "ERR").padEnd(4)} ${r.path.padEnd(44)} ` +
                `${v.finalPath !== r.path ? `-> ${v.finalPath} ` : ""}${v.mainReadyMs == null ? "never" : `${Math.round(v.mainReadyMs)}ms`}` +
                `${found.length ? `  defects:${found.length}` : ""}`,
            );
          }
        };
        await Promise.all(Array.from({ length: opts.concurrency }, worker));
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  defects.push(...deadTabDefects(visits, rails));
  const viewerKeys = viewers.map((v) => v.key);
  const ranked = rankDefects(defects, viewerKeys);
  const groups = groupDefects(ranked);
  const counts = countDefects(ranked, viewerKeys);

  // Server-side egress the guard refused (scripts/qa/egress-guard.cjs writes one JSON line each).
  const serverHosts = {};
  if (opts.egressLog && existsSync(opts.egressLog)) {
    for (const line of readFileSync(opts.egressLog, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        serverHosts[e.host] = (serverHosts[e.host] ?? 0) + 1;
      } catch {
        // a torn last line while the server was still writing; ignore it
      }
    }
  }

  const desktop = viewports[0].key;
  const access = routes.map((r) => {
    const cells = {};
    for (const v of viewers) {
      const visit = visits.find((x) => x.route === r.path && x.viewer === v.key && x.viewport === desktop);
      if (!visit) continue;
      const mark = rails[v.key].has(r.path) ? "*" : "";
      cells[v.key] = visit.navigationError
        ? `ERR${mark}`
        : visit.finalPath !== r.path
          ? `${visit.status ?? ""} -> ${visit.finalPath}${mark}`
          : `${visit.notFound && visit.status === 200 ? "404 (page)" : visit.status}${mark}`;
    }
    return { route: r.path, cells };
  });

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      baseUrl: opts.base,
      server: process.env.QA_SERVER_LABEL || "next start",
      commit: process.env.GITHUB_SHA || process.env.QA_COMMIT || "",
      runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "",
      viewers: viewers.map((v) => ({ key: v.key, label: v.label, checkPersona: v.checkPersona === true, onboardingClaim: sessions[v.key].claim ?? null })),
      viewports: viewports.map((v) => v.key),
      routes: routes.length,
      visits: visits.length,
      durationMs: Date.now() - t0,
      slowMs: opts.slowMs,
      skippedPublic: derived.skippedPublic,
      unexpanded: derived.unexpanded,
      personaNames: PERSONA_NAMES,
      egress: { serverHosts, browserHosts: browserEgress },
      rails: Object.fromEntries(Object.entries(rails).map(([k, s]) => [k, [...s].sort()])),
      notes,
    },
    counts,
    groups: groups.map((g) => ({ ...g, sample: g.sample })),
    defects: ranked,
    access,
    visits: visits.map((v) => ({
      route: v.route,
      pattern: v.pattern,
      viewer: v.viewer,
      viewport: v.viewport,
      status: v.status,
      finalPath: v.finalPath,
      notFound: v.notFound,
      mainReadyMs: v.mainReadyMs,
      navigationError: v.navigationError || null,
      errorBoundary: v.errorBoundary ? v.errorBoundary.text : null,
      title: v.title,
      h1: v.h1,
    })),
  };
  writeFileSync(path.join(opts.out, "qa-crawl.json"), JSON.stringify(report, null, 1));
  writeFileSync(path.join(opts.out, "qa-crawl.md"), renderMarkdown(report));
  console.log(`qa:crawl: ${visits.length} visits, ${ranked.length} defects in ${Math.round((Date.now() - t0) / 1000)}s -> ${opts.out}`);
  for (const [type, n] of Object.entries(counts.byType)) console.log(`  ${type.padEnd(18)} ${n}`);
}

async function visitRoute(ctx, viewer, vp, route, probeOnly) {
  const page = await ctx.newPage();
  const rec = {
    route: route.path,
    pattern: route.pattern,
    viewer: viewer.key,
    viewport: vp.key,
    status: null,
    finalPath: route.path,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    navigationError: null,
  };
  let closing = false;
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Resource failures are reported once, as failed requests; blocked egress is counted separately.
    if (/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(text)) return;
    if (rec.consoleErrors.length < 15) rec.consoleErrors.push(text.slice(0, 400));
  });
  page.on("pageerror", (err) => {
    if (rec.pageErrors.length < 10) rec.pageErrors.push(String((err && err.message) || err).slice(0, 400));
  });
  page.on("response", (resp) => {
    let u;
    try {
      u = new URL(resp.url());
    } catch {
      return;
    }
    if (u.host !== baseUrl.host || resp.status() < 400) return;
    const req = resp.request();
    let ownNavigation = false;
    try {
      ownNavigation = req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {
      ownNavigation = false; // a worker's request has no frame
    }
    if (ownNavigation) return; // the page's own status is reported as the page's status
    if (rec.failedRequests.length < 30) {
      rec.failedRequests.push({ url: `${u.origin}${u.pathname}${u.search}`, method: req.method(), status: resp.status(), resourceType: `${req.resourceType()}${u.searchParams.has("_rsc") ? " (RSC)" : ""}` });
    }
  });
  page.on("requestfailed", (req) => {
    if (closing) return;
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (u.host !== baseUrl.host) return;
    const why = (req.failure() && req.failure().errorText) || "failed";
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(why)) return; // navigation-cancelled prefetches, our own blocks
    if (rec.failedRequests.length < 30) rec.failedRequests.push({ url: `${u.origin}${u.pathname}${u.search}`, method: req.method(), error: why, resourceType: req.resourceType() });
  });

  try {
    let resp = null;
    try {
      resp = await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs });
      rec.status = resp ? resp.status() : null;
    } catch (err) {
      rec.navigationError = String((err && err.message) || err).split("\n")[0].slice(0, 300);
    }
    rec.finalPath = (() => {
      try {
        const u = new URL(page.url());
        return u.pathname;
      } catch {
        return route.path;
      }
    })();
    if (probeOnly || rec.navigationError) return rec;
    rec.signedOut = rec.finalPath.startsWith("/login");
    await page.waitForFunction(() => window.__qaMainReadyAt != null, null, { timeout: opts.readyTimeoutMs, polling: 100 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
    const m = await page.evaluate(measurePage, { personaNames: [...PERSONA_NAMES], checkPersona: viewer.checkPersona === true });
    Object.assign(rec, {
      title: m.title,
      h1: m.h1,
      mainReadyMs: m.readyAt,
      viewportSize: m.viewportSize,
      errorBoundary: m.errorBoundary,
      notFound: m.notFound,
      clipCandidates: m.clipCandidates,
      hscroll: m.hscroll,
      bars: m.bars,
      rail: m.rail,
      personaHits: m.personaHits,
    });
    // Bars again after scrolling down a screen and a half: a sticky header slides under a fixed one only then.
    const scrolled = await page.evaluate(() => {
      const max = (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight;
      if (max < 40) return false;
      window.scrollTo(0, Math.min(max, Math.round(window.innerHeight * 1.5)));
      return true;
    });
    if (scrolled) {
      await page.waitForTimeout(200);
      rec.bars = [...rec.bars, ...(await page.evaluate(measureScrolledBars))];
    }
    if (opts.screenshots) {
      const dir = path.join(opts.screenshots, viewer.key, vp.key);
      mkdirSync(dir, { recursive: true });
      const name = (route.path === "/" ? "root" : route.path.replace(/^\//, "").replace(/[^A-Za-z0-9_-]+/g, "_")).slice(0, 90);
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true, timeout: 30000 }).catch(() => {});
    }
  } catch (err) {
    rec.navigationError = rec.navigationError || `measurement failed: ${String((err && err.message) || err).split("\n")[0].slice(0, 300)}`;
  } finally {
    closing = true;
    await page.close().catch(() => {});
  }
  return rec;
}

main().catch((err) => {
  console.error(err);
  try {
    appendFileSync(path.join(opts.out, "qa-crawl.error.txt"), `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch {
    // the console line above is the report of record
  }
  process.exit(1);
});
