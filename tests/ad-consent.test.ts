/**
 * The Google Ads tag must stay OFF until a visitor chooses "Allow" (Quebec
 * Law 25). Before 2026-10-15 it loaded on every marketing page with no choice
 * and set a DoubleClick cookie on page load. These assertions drive the
 * consent module with fakes, and pin the component and layout wiring that
 * decides WHEN it runs.
 *
 * Run: node --conditions=react-server --import tsx tests/ad-consent.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AD_CONSENT_STORAGE_KEY,
  GOOGLE_TAG_SRC,
  installGoogleAdsTag,
  parseAdConsent,
  readAdConsent,
  recordAdDenial,
  withdrawGoogleAdsConsent,
  writeAdConsent,
  type TagDocument,
  type TagWindow,
} from "../lib/marketing/ad-consent";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}
const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

function fakeDocument(cookie = "") {
  const appended: { id: string; src: string; async: boolean }[] = [];
  // Reads return the starting jar; writes are recorded (a browser would apply them).
  const writes: string[] = [];
  const doc: TagDocument & { appended: typeof appended; writes: string[] } = {
    appended,
    writes,
    getElementById: (id: string) => appended.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: "", src: "", async: false }),
    head: { appendChild: (node: unknown) => appended.push(node as (typeof appended)[number]) },
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      writes.push(v);
    },
  };
  return doc;
}

const calls = (win: TagWindow) => (win.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>));

// 1. Only an exact stored choice counts; anything else means "not asked yet".
assert.equal(parseAdConsent("granted"), "granted");
assert.equal(parseAdConsent("denied"), "denied");
for (const junk of [null, undefined, "", "yes", "GRANTED", 1, true]) {
  assert.equal(parseAdConsent(junk), null, `${String(junk)} must not count as a choice`);
}

// 2. Read/write round-trip under the versioned key; blocked storage never throws
//    and never reads as consent.
{
  const s = fakeStorage();
  assert.equal(readAdConsent(s), null);
  assert.equal(writeAdConsent(s, "granted"), true);
  assert.equal(s.data.get(AD_CONSENT_STORAGE_KEY), "granted");
  assert.equal(readAdConsent(s), "granted");
  assert.equal(readAdConsent(throwingStorage), null, "blocked storage reads as not asked, never as consent");
  assert.equal(writeAdConsent(throwingStorage, "granted"), false, "a failed save is reported, not thrown");
  assert.equal(readAdConsent(null), null);
  assert.equal(writeAdConsent(undefined, "denied"), false);
}

// 2b. Recording "No thanks" never leaves an old grant readable (Codex P2,
//     2026-10-15): if saving "denied" fails, the stored grant is deleted; if
//     even that fails, the caller is told so it does not reload into the grant.
{
  const ok = fakeStorage({ [AD_CONSENT_STORAGE_KEY]: "granted" });
  assert.equal(recordAdDenial({ ...ok, removeItem: (k: string) => void ok.data.delete(k) }), "saved");
  assert.equal(readAdConsent(ok), "denied");

  const full = new Map([[AD_CONSENT_STORAGE_KEY, "granted"]]);
  const quota = {
    getItem: (k: string) => full.get(k) ?? null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: (k: string) => void full.delete(k),
  };
  assert.equal(recordAdDenial(quota), "cleared", "a failed save deletes the old grant");
  assert.equal(readAdConsent(quota), null, "the old grant is gone: next load asks again, tag stays off");

  const locked = { ...throwingStorage, removeItem: () => { throw new Error("SecurityError"); } };
  assert.equal(recordAdDenial(locked), "failed");
  assert.equal(recordAdDenial(null), "failed");
}

// 3. Installing the tag: one script, the right tag id, consent declared before config.
{
  const win: TagWindow = {};
  const doc = fakeDocument();
  installGoogleAdsTag(win, doc);
  assert.equal(doc.appended.length, 1);
  assert.equal(doc.appended[0].src, GOOGLE_TAG_SRC);
  assert.equal(GOOGLE_TAG_SRC, "https://www.googletagmanager.com/gtag/js?id=AW-18509362419");
  assert.equal(doc.appended[0].async, true);
  assert.equal(typeof win.gtag, "function");
  const c = calls(win);
  assert.deepEqual(c[0][0], "consent");
  assert.deepEqual(c[0][1], "default");
  assert.equal((c[0][2] as Record<string, string>).ad_storage, "granted");
  assert.equal((c[0][2] as Record<string, string>).analytics_storage, "denied", "no analytics was consented to");
  assert.deepEqual(c[2], ["config", "AW-18509362419"]);
  // gtag.js reads real `arguments` objects, not arrays.
  assert.equal(Object.prototype.toString.call(win.dataLayer![0]), "[object Arguments]");

  installGoogleAdsTag(win, doc);
  assert.equal(doc.appended.length, 1, "a second install adds no second script");
  const again = calls(win);
  assert.equal(again.length, 4, "a second install queues only a consent update: no second js/config");
  assert.deepEqual(again[3].slice(0, 2), ["consent", "update"]);
}

// 4. Withdrawal: an already-loaded tag is told to stop, _gcl_* cookies are
//    expired on every domain form, other cookies are left alone.
{
  const win: TagWindow = {};
  const doc = fakeDocument("_gcl_au=1.1.123; oasis_session=abc; _gcl_aw=GCL.9");
  installGoogleAdsTag(win, doc);
  withdrawGoogleAdsConsent(win, doc, "oasisai.work");
  const last = calls(win).at(-1)!;
  assert.deepEqual(last.slice(0, 2), ["consent", "update"]);
  for (const k of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
    assert.equal((last[2] as Record<string, string>)[k], "denied", `${k} denied on withdrawal`);
  }
  for (const name of ["_gcl_au", "_gcl_aw"]) {
    assert.ok(doc.writes.some((w) => w.startsWith(`${name}=;`) && w.includes("Domain=.oasisai.work") && w.includes("Max-Age=0")), `${name} expired`);
  }
  assert.ok(!doc.writes.some((w) => w.startsWith("oasis_session=")), "the session cookie is not touched");

  // On www.oasisai.work gtag sets _gcl_* on the top domain (cookie_domain
  // "auto"), so withdrawal must expire them on every parent domain too, and
  // never aim at the bare TLD.
  const sub = fakeDocument("_gcl_au=1.1.123");
  withdrawGoogleAdsConsent({}, sub, "www.oasisai.work");
  assert.ok(
    sub.writes.some((w) => w.startsWith("_gcl_au=;") && w.includes("Domain=.oasisai.work") && w.includes("Max-Age=0")),
    "_gcl_au set on .oasisai.work is expired when withdrawing from www",
  );
  assert.ok(!sub.writes.some((w) => /Domain=\.?work(;|$)/.test(w)), "never targets the bare TLD");

  // Allow -> No thanks -> Allow on one page (Codex P2, 2026-10-15): the script
  // is already there, so the second Allow must still put Google back to granted.
  {
    const w: TagWindow = {};
    const d = fakeDocument();
    installGoogleAdsTag(w, d);
    withdrawGoogleAdsConsent(w, d, "oasisai.work");
    installGoogleAdsTag(w, d);
    assert.equal(d.appended.length, 1, "re-allowing adds no second script");
    const final = calls(w).at(-1)!;
    assert.deepEqual(final.slice(0, 2), ["consent", "update"], "re-allowing sends a consent update");
    assert.equal((final[2] as Record<string, string>).ad_storage, "granted", "re-allowing ends granted, not stuck denied");
  }

  // Withdrawal before the tag ever loaded must not create a gtag.
  const fresh: TagWindow = {};
  withdrawGoogleAdsConsent(fresh, fakeDocument(""), "oasisai.work");
  assert.equal(fresh.gtag, undefined);
  assert.equal(fresh.dataLayer, undefined);
}

// 5. Wiring: the tag is never loaded from the root layout again, and the
//    component installs it only from the "granted" paths.
{
  const layout = read("app/layout.tsx");
  assert.doesNotMatch(layout, /googletagmanager\.com/, "the root layout must not load the Google tag unconditionally");
  assert.doesNotMatch(layout, /gtag\(/, "the root layout must not configure gtag");

  const marketingLayout = read("app/(marketing)/layout.tsx");
  assert.match(marketingLayout, /<AdConsent \/>/, "every marketing page mounts the consent banner");

  const component = read("components/marketing/AdConsent.tsx");
  const installs = [...component.matchAll(/installGoogleAdsTag\(/g)].length;
  assert.equal(installs, 2, "installGoogleAdsTag runs from exactly two places: a stored Allow, and the Allow button");
  assert.match(component, /readAdConsent\(storage\(\)\) === "granted"[\s\S]{0,80}installGoogleAdsTag/, "a stored choice installs the tag only when it is exactly granted");
  assert.match(component, /function allow\(\)[\s\S]{0,200}installGoogleAdsTag/, "the Allow button installs the tag");
  assert.doesNotMatch(component, /function decline\(\)[\s\S]{0,300}installGoogleAdsTag/, "No thanks never installs the tag");
  // Codex P1 (2026-10-15): a loaded tag in "denied" mode can still send
  // cookieless pings, so withdrawing reloads the page into a tag-free state.
  assert.match(
    component,
    /function decline\(\)[\s\S]{0,400}if \(loaded\.current\) \{[\s\S]{0,200}withdrawGoogleAdsConsent\([\s\S]{0,600}window\.location\.reload\(\)/,
    "No thanks after the tag loaded withdraws, then reloads so no Google code keeps running",
  );
  // ...but only when the denial was recorded: reloading onto a stale stored
  // grant would reinstall the tag the visitor just refused.
  assert.match(component, /const recorded = recordAdDenial\(storage\(\)\)/, "No thanks records the denial through recordAdDenial");
  assert.match(component, /if \(recorded !== "failed"\) \{[\s\S]{0,80}window\.location\.reload\(\)/, "the reload is skipped when the denial could not be recorded");
  assert.doesNotMatch(component, /function decline\(\)[\s\S]{0,200}writeAdConsent\(/, "decline does not use the plain write, which can leave an old grant");

  // The purchase conversion never fires once the visitor said No thanks, even
  // if a gtag function is still on the page.
  const conversion = read("components/marketing/PurchaseConversion.tsx");
  assert.match(
    conversion,
    /const send = \(\) => \{[\s\S]{0,200}readAdConsent\([\s\S]{0,60}=== "denied"\) return;/,
    "PurchaseConversion refuses to send when the stored choice is denied",
  );
  // Equal-weight choices: refusing must be as easy as accepting.
  const buttonClasses = [...component.matchAll(/<button[\s\S]*?className=\{([A-Z_]+)\}/g)].map((m) => m[1]);
  assert.deepEqual(buttonClasses, ["CHOICE_BUTTON", "CHOICE_BUTTON"], "Allow and No thanks share one style");

  const footer = read("components/marketing/MarketingFooter.tsx");
  assert.match(footer, /<AdConsentSettingsButton \/>/, "the choice can be changed from every marketing page's footer");
}

console.log("ad-consent: all assertions passed");
