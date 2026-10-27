/**
 * tests/custom-keys.test.ts - what a custom key is saved as, and what it is for.
 *
 * CC, 2026-10-26: adding a custom key should be dynamic. Pins
 * lib/os/custom-keys.ts, the Custom keys vault's pure half:
 *
 *   1. A typed name is saved in UPPER_SNAKE_CASE, the vault's own pattern is the
 *      store's, and a name that cannot be saved says why. A secret typed or
 *      pasted where a name goes is refused: names are stored in the clear.
 *   2. A pasted block reads the way a .env file is written, and the route
 *      parses a paste with the same function. A pasted name is saved as written.
 *   3. A key's app comes from its name (the longest phrase wins, then the one
 *      that comes first in the name) or, when the name says nothing, its
 *      value's start (the longest prefix wins). The agents suggested are its
 *      card's suggestion, its departments plus the Chief of Staff, or every
 *      agent for an AI model.
 *   4. What a save sends: the owner's choice as `agents`; untouched, the
 *      suggestion as `suggested_agents`, which only the route may apply (it
 *      knows whether the key is new; tests/agent-access.test.ts runs it). A pick
 *      made for a saved key never carries to another name.
 *   5. The Custom keys card's line on Settings > Connections.
 *
 * Run: node --conditions=react-server --import tsx tests/custom-keys.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_WORDS,
  KNOWN_APPS,
  VAULT_KEY_NAME,
  agentsShown,
  agentsToSend,
  customKeysLine,
  draftApplies,
  keyNameProblem,
  looksLikeSecret,
  normalizeVaultKeyName,
  parseDotenvLines,
  pastedNameProblem,
  recognizeCustomKey,
  unreadablePasteLines,
} from "../lib/os/custom-keys";
import { CONNECTOR_CATALOG, connectorBySlug } from "../lib/os/connectors";
import { connectorDefaultAccess, type AgentChoice } from "../lib/os/agent-access";
import { OS_DEPARTMENTS } from "../lib/os/departments";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// Key-shaped values are joined at run time, so no secret scanner reads one in this file.
const shaped = (...parts: string[]) => parts.join("");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

console.log("custom keys:");

check("a typed name is saved in UPPER_SNAKE_CASE; one that cannot be saved says why", () => {
  assert.equal(normalizeVaultKeyName(" hubspot api-key "), "HUBSPOT_API_KEY");
  assert.equal(normalizeVaultKeyName("my.key/v2"), "MY_KEY_V2");
  assert.equal(normalizeVaultKeyName("__x__"), "X");
  assert.equal(normalizeVaultKeyName("___"), "");
  assert.equal(normalizeVaultKeyName("a".repeat(80)).length, 64);
  assert.equal(keyNameProblem(""), null, "an empty box is not an error yet");
  assert.equal(keyNameProblem("pipedrive api token"), null);
  assert.equal(keyNameProblem("1PASSWORD_TOKEN"), "Start the name with a letter.");
  assert.equal(keyNameProblem("!!!"), "Use letters, numbers and underscores.");
  for (const typed of ["pipedrive api token", "x", "a".repeat(80), "Zapier-Webhook.URL"]) {
    assert.ok(VAULT_KEY_NAME.test(normalizeVaultKeyName(typed)), `${typed} saves as a valid name`);
  }
  // The vault's pattern is the store's: the route refuses what the store would.
  assert.equal(VAULT_KEY_NAME.source, "^[A-Z][A-Z0-9_]{0,63}$");
  assert.match(read("lib/tenant-integration-store.ts"), /VAULT_KEY_PATTERN = \/\^\[A-Z\]\[A-Z0-9_\]\{0,63\}\$\//);
});

check("a secret where a name goes is refused, so it is never stored or listed as a name", () => {
  const secrets = [
    shaped("sk-", "ant-", "api03-", "abcdef"),
    shaped("Zm9vYmFy", "YmF6cXV4", "MTIzNDU2Nzg5"),
    shaped("a3f9c2e1b4d5a6f7", "e8d9c0b1a2f3e4d5", "c6b7a8f9"),
  ];
  for (const s of secrets) {
    assert.equal(looksLikeSecret(s), true, `${s.slice(0, 6)}... reads as a secret`);
    assert.match(keyNameProblem(s) ?? "", /looks like the secret itself/);
    assert.match(pastedNameProblem(s, "x") ?? "", /secret without a name/);
  }
  for (const n of ["HUBSPOT_PRIVATE_APP_TOKEN", "GA4_MEASUREMENT_ID", "N8N_API_KEY", "pipedrive api token", "googleAnalytics4MeasurementId"]) {
    assert.equal(looksLikeSecret(n), false, `${n} is a name`);
  }
  // A bare secret whose "=" padding read as KEY=value.
  const [line] = parseDotenvLines(shaped("Zm9vYmFy", "YmF6==="));
  assert.equal(line.value, "==");
  assert.match(pastedNameProblem(line.key, line.value) ?? "", /secret without a name/);
  // A pasted name is saved as written: never reshaped into a valid one.
  assert.match(pastedNameProblem("my-key", "x") ?? "", /letters, numbers and underscores/);
  assert.equal(pastedNameProblem("my_key", "x"), null, "case is the route's to fix");
  assert.match(pastedNameProblem("K".repeat(65), "x") ?? "", /64/);
  // The route refuses them too, and echoes nothing of them.
  const route = read("app/api/credentials/custom/route.ts");
  assert.match(route, /if \(looksLikeSecret\(entry\.key\)\) \{\s*results\.push\(\{ key: "\(a secret without a name\)"/);
  assert.match(route, /if \(!value \|\| \/\^=\+\$\/\.test\(value\)\)/);
});

check("a paste reads like a .env file, and the route parses it the same way", () => {
  const text = "# comment\nexport A=1\nB=\"two words\"\nC='x'\n\nnot a line\n=nokey\nD=a=b\n";
  assert.deepEqual(parseDotenvLines(text), [
    { key: "A", value: "1" },
    { key: "B", value: "two words" },
    { key: "C", value: "x" },
    { key: "D", value: "a=b" },
  ]);
  assert.equal(unreadablePasteLines(text), 2, "'not a line' and '=nokey'");
  assert.equal(unreadablePasteLines("A=1\r\nB=2"), 0);
  const route = read("app/api/credentials/custom/route.ts");
  assert.match(route, /pending = parseDotenvLines\(body\.dotenv\)/);
  assert.doesNotMatch(route, /function parseDotenv\(/, "one parser, not two that can drift");
  // One size limit too: the vault says "too long" exactly where the route refuses.
  assert.match(route, /const MAX_VALUE_LEN = VAULT_MAX_VALUE_LENGTH;/);
  assert.match(read("components/settings/CustomCredentialsVault.tsx"), /value\.length > VAULT_MAX_VALUE_LENGTH/);
});

check("a key's app comes from its name: whole words, the longest phrase, then the first in the name", () => {
  assert.deepEqual(recognizeCustomKey("HUBSPOT_PRIVATE_APP_TOKEN"), {
    app: "HubSpot",
    access: ["chief_of_staff", "sales", "marketing"],
    from: "name",
    usualName: "HUBSPOT_PRIVATE_APP_TOKEN",
  });
  assert.equal(recognizeCustomKey("google ads developer token")?.app, "Google Ads");
  assert.equal(recognizeCustomKey("ZOOMINFO_API_KEY")?.app, "ZoomInfo", "not Zoom: words are whole");
  assert.equal(recognizeCustomKey("LINEAR_TEAMS_ID")?.app, "Linear", "the app named first in the name");
  assert.equal(recognizeCustomKey("TEAMS_WEBHOOK_URL")?.card, "microsoft-teams");
  assert.equal(recognizeCustomKey("META_LLAMA_API_KEY")?.app, "Llama", "a model key, not the Facebook card");
  assert.equal(recognizeCustomKey("META_ACCESS_TOKEN")?.card, "meta");
  assert.equal(recognizeCustomKey("OPENAI_API_KEY")?.access, "all", "an AI model is for every agent");
  assert.equal(recognizeCustomKey("pipedrive api token")?.app, "Pipedrive", "typed in plain words");
  // Too broad to guess, so not guessed (review of OCC #748).
  for (const n of ["GOOGLE_API_KEY", "AMAZON_SELLER_ID", "APOLLO_GRAPH_REF", "PDF_RENDER_API_KEY", "USER_SEGMENT_ID", "MY_RANDOM_KEY"]) {
    assert.equal(recognizeCustomKey(n), null, `${n} is not guessed`);
  }
  const stripe = recognizeCustomKey("STRIPE_WEBHOOK_SECRET");
  assert.equal(stripe?.card, "stripe", "an app with its own card says so");
  assert.deepEqual(stripe?.access, connectorDefaultAccess(connectorBySlug("stripe")));
});

check("when the name says nothing, the value's start does: the longest prefix wins", () => {
  assert.equal(recognizeCustomKey("", shaped("sk-", "ant-", "abc123"))?.app, "Anthropic");
  assert.equal(recognizeCustomKey("", shaped("sk-", "or-", "v1-abc"))?.app, "OpenRouter");
  assert.equal(recognizeCustomKey("", shaped("sk-", "proj-", "abc"))?.app, "OpenAI");
  assert.equal(recognizeCustomKey("", shaped("sk-", "ant-", "abc"))?.usualName, "ANTHROPIC_API_KEY");
  assert.equal(recognizeCustomKey("", "https://hooks.zapier.com/hooks/catch/1/2")?.app, "Zapier");
  assert.equal(recognizeCustomKey("MY_KEY", shaped("x", "oxb-", "1-2"))?.app, "Slack");
  assert.equal(recognizeCustomKey("MY_KEY", shaped("x", "oxb-", "1-2"))?.from, "value");
  assert.equal(recognizeCustomKey("SLACK_WEBHOOK_URL", shaped("sk-", "ant-", "abc"))?.app, "Slack", "the name wins");
  // Prefixes several vendors share are not guessed.
  assert.equal(recognizeCustomKey("", shaped("sk-", "abc123def456")), null, "DeepSeek and others use sk- too");
  assert.equal(recognizeCustomKey("", shaped("wh", "sec_", "abc123")), null, "Clerk, Svix and Resend use it too");
  assert.equal(recognizeCustomKey("", "sk-"), null, "a prefix alone is not a key");
  assert.equal(recognizeCustomKey("", "plain value"), null);
});

check("the table: every card is known by its words, with its card's suggestion; no word names two apps", () => {
  for (const def of CONNECTOR_CATALOG) assert.ok(CARD_WORDS[def.slug], `${def.slug} has words`);
  const departments = new Set(OS_DEPARTMENTS.map((d) => d.key));
  for (const [slug, w] of Object.entries(CARD_WORDS)) {
    const def = connectorBySlug(slug);
    assert.ok(def, `${slug} is a card in the catalog`);
    for (const word of w.words) {
      const hint = recognizeCustomKey(word);
      assert.equal(hint?.card, slug, `${word} is ${slug}`);
      assert.deepEqual(hint?.access, connectorDefaultAccess(def), `${word}: the card's own suggestion`);
    }
  }
  // Every phrase names its own app, so a word added later cannot take another
  // app's longer phrase (GOOGLE for Workspace must not take GOOGLE_ADS).
  for (const app of KNOWN_APPS) {
    for (const word of app.words) assert.equal(recognizeCustomKey(`${word}_API_KEY`)?.app, app.name, `${word}_API_KEY is ${app.name}`);
  }
  const owner = new Map<string, string>();
  for (const app of KNOWN_APPS) {
    if (app.departments !== "all") for (const d of app.departments) assert.ok(departments.has(d), `${app.name}: ${d} is a department`);
    for (const word of app.words) {
      assert.ok(VAULT_KEY_NAME.test(word), `${word} is written as a key name is`);
      assert.equal(owner.get(word), undefined, `${word} names ${owner.get(word)} and ${app.name}`);
      owner.set(word, app.name);
    }
  }
  assert.ok(KNOWN_APPS.length > CONNECTOR_CATALOG.length, "apps without a card are known too");
});

check("what a save sends: a choice as agents, a suggestion as a suggestion, nothing otherwise", () => {
  const hint = recognizeCustomKey("HUBSPOT_PRIVATE_APP_TOKEN");
  assert.deepEqual(agentsToSend({ touched: true, draft: ["finance"], hint }), { agents: ["finance"] });
  assert.deepEqual(agentsToSend({ touched: true, draft: [], hint: null }), { agents: [] }, "even no agents");
  assert.deepEqual(agentsToSend({ touched: false, draft: "all", hint }), { suggested_agents: hint?.access }, "only the route knows if the key is new");
  assert.deepEqual(agentsToSend({ touched: false, draft: "all", hint: null }), {}, "a saved key keeps its agents; a new one is for all");
  assert.deepEqual(agentsShown({ saved: true, existing: ["sales"], hint }), ["sales"]);
  assert.deepEqual(agentsShown({ saved: true, existing: null, hint }), [], "unreadable is refused to all: shown as no agents");
  assert.deepEqual(agentsShown({ saved: false, existing: null, hint }), hint?.access);
  assert.equal(agentsShown({ saved: false, existing: null, hint: null }), "all");
});

check("a pick made for a saved key stays with it; one made for a new key carries to new names", () => {
  assert.equal(draftApplies(null, "ANY", false), false, "nothing picked");
  assert.equal(draftApplies({ key: "", saved: false }, "PIPEDRIVE_TOKEN", false), true, "picked first, named after");
  assert.equal(draftApplies({ key: "ZAPIER_HOOK", saved: false }, "ZAPIER_WEBHOOK_URL", false), true, "a typo fixed");
  assert.equal(draftApplies({ key: "ZAPIER_WEBHOOK_URL", saved: false }, "HUBSPOT_PRIVATE_APP_TOKEN", true), false, "never onto a saved key");
  assert.equal(draftApplies({ key: "HUBSPOT_PRIVATE_APP_TOKEN", saved: true }, "HUBSPOT_PRIVATE_APP_TOKEN", true), true);
  assert.equal(draftApplies({ key: "HUBSPOT_PRIVATE_APP_TOKEN", saved: true }, "OPENAI_API_KEY", true), false, "nor from one saved key to another");
  assert.equal(draftApplies({ key: "HUBSPOT_PRIVATE_APP_TOKEN", saved: true }, "NEW_KEY", false), false);

  // The vault sends what these say, for one key and for every key of a paste.
  const vault = read("components/settings/CustomCredentialsVault.tsx");
  assert.match(vault, /const touched = draftApplies\(draftScope, keyName, !!existing\);/);
  assert.match(vault, /const toSend = agentsToSend\(\{ touched, draft, hint \}\);/);
  assert.match(vault, /body: JSON\.stringify\(\{ key: keyName, value, \.\.\.toSend \}\)/);
  assert.match(vault, /entries: pasteReady\.map\(\(p\) => \(\{ key: p\.sendKey, value: p\.value, \.\.\.p\.send \}\)\)/);
  assert.match(vault, /setEditAgents\(row\.agents_unreadable \? \[\] : row\.agents \?\? "all"\)/, "saving it unchanged must not widen it");
  // Nothing is saved while the keys or their agents cannot be read; the list is read on each opening.
  assert.match(vault, /const canSave = !blockedBy && /);
  assert.match(vault, /: agentsError\s*\? "Which agents may use these keys could not be read, so nothing can be saved yet\."/);
  assert.match(vault, /if \(active\) void fetchRows\(\);/);
  // One column: the viewport-wide grid put the Save button past the drawer's edge.
  assert.doesNotMatch(vault, /sm:grid-cols/);
  // A key for an app with its own card opens that card; the drawer passes whether it is open.
  assert.match(read("components/os/connections/ConnectionsHub.tsx"), /<CustomCredentialsVault onOpenApp=\{openFromCustom\} active=\{customOpen\} \/>/);
});

check("the Custom keys card's line: how many keys, and who uses them", () => {
  const founder: AgentChoice[] = [
    { key: "chief_of_staff", label: "Bravo (Chief of Staff)", agent: "Bravo" },
    { key: "sales", label: "SDR (Sales)", agent: "SDR" },
    { key: "marketing", label: "Maven (Marketing)", agent: "Maven" },
    { key: "client_success", label: "Customer Support (Client Success)", agent: "Customer Support" },
    { key: "finance", label: "Atlas (Finance)", agent: "Atlas" },
    { key: "operations", label: "Operations" },
  ];
  assert.equal(customKeysLine([], founder), "No keys yet");
  assert.equal(customKeysLine([{ agents: "all" }, { agents: ["sales"] }], founder), "2 keys, used by all agents");
  assert.equal(customKeysLine([{ agents: ["sales"] }, { agents: ["marketing", "chief_of_staff"] }], founder), "2 keys, used by Bravo, SDR and Maven");
  assert.equal(customKeysLine([{ agents: ["operations"] }], founder), "1 key, used by Operations");
  assert.equal(customKeysLine([{ agents: null }, { agents: ["finance"] }], founder), "2 keys, used by Atlas");
  assert.equal(customKeysLine([{ agents: [] }]), "1 key, used by no agents");
  assert.equal(customKeysLine([{ agents: ["finance"] }]), "1 key, used by Finance", "a workspace that names no agent reads departments");
});

console.log(failures ? `custom keys: ${failures} failure(s)` : "custom keys: all passed");
process.exit(failures ? 1 : 0);
