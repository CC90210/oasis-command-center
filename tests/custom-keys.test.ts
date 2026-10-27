/**
 * tests/custom-keys.test.ts - what a custom key is saved as, and what it is for.
 *
 * CC, 2026-10-26: adding a custom key should be dynamic. Pins
 * lib/os/custom-keys.ts, the Custom keys vault's pure half:
 *
 *   1. A typed name is saved in UPPER_SNAKE_CASE, the vault's own pattern is the
 *      store's, and a name that cannot be saved says why.
 *   2. A pasted block reads the way a .env file is written, and the route
 *      parses a paste with the same function.
 *   3. A key's app comes from its name (the longest phrase wins, whole words
 *      only) or, when the name says nothing, its value's start (the longest
 *      prefix wins). The agents suggested are its card's suggestion, its
 *      departments plus the Chief of Staff, or every agent for an AI model.
 *   4. What a save sends: the owner's choice; nothing for a new value of a
 *      saved key (it keeps its agents); a new key's suggestion; nothing (all
 *      agents) when there is none. The vault and the paste both send that.
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
  keyNameProblem,
  normalizeVaultKeyName,
  parseDotenvLines,
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
});

check("a key's app comes from its name: whole words, the longest phrase wins", () => {
  const hubspot = recognizeCustomKey("HUBSPOT_PRIVATE_APP_TOKEN");
  assert.deepEqual(hubspot, {
    app: "HubSpot",
    access: ["chief_of_staff", "sales", "marketing"],
    from: "name",
    usualName: "HUBSPOT_PRIVATE_APP_TOKEN",
  });
  assert.equal(recognizeCustomKey("google ads developer token")?.app, "Google Ads");
  assert.equal(recognizeCustomKey("GOOGLE_API_KEY"), null, "Google alone is too broad to guess");
  assert.equal(recognizeCustomKey("ZOOMINFO_API_KEY")?.app, "ZoomInfo", "not Zoom: words are whole");
  assert.equal(recognizeCustomKey("OPENAI_API_KEY")?.access, "all", "an AI model is for every agent");
  assert.equal(recognizeCustomKey("pipedrive api token")?.app, "Pipedrive", "typed in plain words");
  assert.equal(recognizeCustomKey("MY_RANDOM_KEY"), null);
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
  assert.equal(recognizeCustomKey("", "sk-"), null, "a prefix alone is not a key");
  assert.equal(recognizeCustomKey("", "plain value"), null);
  assert.equal(recognizeCustomKey("SLACK_WEBHOOK_URL", shaped("sk-", "ant-", "abc"))?.app, "Slack", "the name wins");
});

check("the table: every card's words name it with its card's suggestion; no word names two apps", () => {
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
  // Two apps named at equal length: the first listed, a card before the rest.
  assert.equal(recognizeCustomKey("AWS_SES_SMTP_PASSWORD")?.card, "smtp");
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

check("what a save sends, and what the picker shows before the owner touches it", () => {
  const hint = recognizeCustomKey("HUBSPOT_PRIVATE_APP_TOKEN");
  assert.deepEqual(agentsToSend({ exists: false, touched: true, draft: ["finance"], hint }), ["finance"], "the owner's choice");
  assert.deepEqual(agentsToSend({ exists: true, touched: true, draft: [], hint }), [], "even no agents, on a saved key");
  assert.equal(agentsToSend({ exists: true, touched: false, draft: "all", hint }), undefined, "a new value keeps the key's agents");
  assert.deepEqual(agentsToSend({ exists: false, touched: false, draft: "all", hint }), hint?.access, "a new key takes its suggestion");
  assert.equal(agentsToSend({ exists: false, touched: false, draft: "all", hint: null }), undefined, "no suggestion: all agents, the default");
  assert.deepEqual(agentsShown({ existing: ["sales"], hint }), ["sales"]);
  assert.deepEqual(agentsShown({ existing: "all", unreadable: true, hint }), [], "an unreadable choice starts from no agents");
  assert.deepEqual(agentsShown({ existing: undefined, hint }), hint?.access);
  assert.equal(agentsShown({ existing: undefined, hint: null }), "all");

  // The vault sends exactly that, for one key and for every key of a paste.
  const vault = read("components/settings/CustomCredentialsVault.tsx");
  assert.match(vault, /const toSend = agentsToSend\(\{ exists: !!existing, touched, draft, hint \}\);/);
  assert.match(vault, /body: JSON\.stringify\(\{ key: keyName, value, \.\.\.\(toSend !== undefined \? \{ agents: toSend \} : \{\}\) \}\)/);
  assert.match(vault, /const send = agentsToSend\(\{ exists: !!row, touched: chosen !== undefined, draft: chosen \?\? "all", hint: lineHint \}\);/);
  assert.match(vault, /\.\.\.\(p\.send !== undefined \? \{ agents: p\.send \} : \{\}\)/);
  assert.match(vault, /setEditAgents\(row\.agents_unreadable \? \[\] : row\.agents \?\? "all"\)/, "saving it unchanged must not widen it");
  // One column: the viewport-wide grid put the Save button past the drawer's edge.
  assert.doesNotMatch(vault, /sm:grid-cols/);
  // A key for an app with its own card opens that card.
  assert.match(read("components/os/connections/ConnectionsHub.tsx"), /<CustomCredentialsVault onOpenApp=\{openFromCustom\} \/>/);
});

check("the Custom keys card's line: how many keys, and who uses them", () => {
  const founder: AgentChoice[] = [
    { key: "chief_of_staff", label: "Bravo (Chief of Staff)", agent: "Bravo" },
    { key: "sales", label: "SDR (Sales)", agent: "SDR" },
    { key: "marketing", label: "Maven (Marketing)", agent: "Maven" },
    { key: "client_success", label: "Customer Support (Client Success)", agent: "Customer Support" },
    { key: "finance", label: "Atlas (Finance)", agent: "Atlas" },
    { key: "operations", label: "Bravo (Operations)", agent: "Bravo" },
  ];
  assert.equal(customKeysLine([], founder), "No keys yet");
  assert.equal(customKeysLine([{ agents: "all" }, { agents: ["sales"] }], founder), "2 keys, used by all agents");
  assert.equal(customKeysLine([{ agents: ["sales"] }, { agents: ["operations", "marketing", "chief_of_staff"] }], founder), "2 keys, used by Bravo, SDR and Maven");
  assert.equal(customKeysLine([{ agents: null }, { agents: ["finance"] }], founder), "2 keys, used by Atlas");
  assert.equal(customKeysLine([{ agents: [] }]), "1 key, used by no agents");
  assert.equal(customKeysLine([{ agents: ["finance"] }]), "1 key, used by Finance", "a workspace that names no agent reads departments");
});

console.log(failures ? `custom keys: ${failures} failure(s)` : "custom keys: all passed");
process.exit(failures ? 1 : 0);
