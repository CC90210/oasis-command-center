/**
 * tests/model-registry.checks.ts - the model registry (lib/ai/model-registry.ts)
 * is consistent, every model list and default reads it, its prices are the
 * migration's, a saved model it knows is gone is replaced on the same provider
 * only, the owner's sentences say what really happens, a "not found" names the
 * model, and the saved-model mover (lib/ai/saved-model-moves.ts,
 * scripts/update-saved-models.ts) moves exactly what it should and undoes it
 * exactly.
 *
 * WHY (2026-10-08). OASIS's departments failed for nine days with "The AI model
 * this channel uses was not found": the one saved setting they read named
 * Google's gemini-2.5-pro, which Google now serves only to projects that used
 * it before. Five files each kept their own model list; none knew.
 *
 * Run by tests/ai-usage-ledger.test.ts (its `check`), which CI runs in
 * test:os: a new tests/*.test.ts would need a package.json group, and that
 * file is held by two other open tracks. Not a *.test.ts itself, so the suite
 * coverage gate does not count it twice.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createClient } from "@libsql/client";

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

const ROOT = process.cwd();
const DAY = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** INSERT ... VALUES rows of model_prices in a migration file, parsed (micro-USD per Mtok). */
function migrationPriceRows(file: string): Array<{ key: string; from: string; above: number; input: number; output: number; read: number | null; write: number | null; url: string }> {
  const sql = readFileSync(join(ROOT, "database", "turso", file), "utf8");
  const out: ReturnType<typeof migrationPriceRows> = [];
  const row = /\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(NULL|\d+),\s*(NULL|\d+),\s*'([^']+)',\s*'[^']+'\s*\)/g;
  for (const m of sql.matchAll(row)) {
    out.push({
      key: `${m[1]}/${m[2]}`,
      from: m[3].slice(0, 10),
      above: Number(m[4]),
      input: Number(m[5]),
      output: Number(m[6]),
      read: m[7] === "NULL" ? null : Number(m[7]),
      write: m[8] === "NULL" ? null : Number(m[8]),
      url: m[9],
    });
  }
  return out;
}

const micro = (usd: number | null) => (usd === null ? null : Math.round(usd * 1_000_000));

/** Every source file the app ships (the Worker's dirs), with comment lines stripped. */
function shippedSources(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (/(^|[\\/])(node_modules|\.next|\.open-next)([\\/]|$)/.test(full)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
        const code = readFileSync(full, "utf8")
          .split(/\r?\n/)
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join("\n");
        out.push({ rel: relative(ROOT, full).split(sep).join("/"), code });
      }
    }
  };
  for (const d of ["app", "lib", "components"]) walk(join(ROOT, d));
  return out;
}

export async function modelRegistryChecks(check: Check): Promise<void> {
  const reg = await import("../lib/ai/model-registry");
  const { PROVIDER_REGISTRY, PROVIDER_MODELS, providerForModel } = await import("../lib/providers");
  const { PROBE_MODEL } = await import("../lib/agents/provider-probe");
  const outcome = await import("../lib/os/channel/outcome");
  const { MODEL_REGISTRY, REGISTRY_PROVIDERS } = reg;
  const NOW = DAY("2026-10-08");

  console.log("model registry");

  await check("every listed model has a status, and every model that is not current has a replacement on the same provider", () => {
    for (const p of REGISTRY_PROVIDERS) {
      const ids = new Set<string>();
      for (const m of MODEL_REGISTRY[p].models) {
        assert.ok(!ids.has(m.id), `${p}: ${m.id} is listed twice`);
        ids.add(m.id);
        assert.ok((reg.MODEL_STATUSES as readonly string[]).includes(m.status), `${p}/${m.id}: unknown status ${m.status}`);
        assert.ok(m.label.trim(), `${p}/${m.id}: no label`);
        assert.match(m.source, /^https:\/\//, `${p}/${m.id}: no source page`);
        if (m.endsOn !== null) assert.match(m.endsOn, /^\d{4}-\d{2}-\d{2}$/, `${p}/${m.id}: endsOn is not a day`);
        if (m.status !== "current") {
          assert.ok(m.replacement, `${p}/${m.id} is ${m.status} but names no replacement`);
          assert.ok(MODEL_REGISTRY[p].models.some((x) => x.id === m.replacement), `${p}/${m.id}: its replacement ${m.replacement} is not a ${p} model`);
        }
        if (m.status === "deprecated") assert.ok(m.endsOn, `${p}/${m.id}: deprecated with no end date`);
        if (m.status === "retired") assert.ok(m.endsOn, `${p}/${m.id}: retired with no date`);
      }
    }
  });

  await check("every gone or ending model's replacement chain ends, on the same provider, at a model that lasts past the horizon", () => {
    for (const p of REGISTRY_PROVIDERS) {
      for (const m of MODEL_REGISTRY[p].models) {
        const ending = reg.endsWithin(p, m.id, reg.REGISTRY_HORIZON_DAYS, NOW);
        if (!ending) continue;
        const next = reg.usableReplacement(p, m.id, NOW, reg.REGISTRY_HORIZON_DAYS);
        assert.ok(next, `${p}/${m.id} (${ending.reason}) has no lasting replacement`);
        assert.equal(reg.endsWithin(p, next!.id, reg.REGISTRY_HORIZON_DAYS, NOW), null, `${p}/${m.id} -> ${next!.id}, which ends soon too`);
        assert.ok(next!.tools, `${p}/${m.id} -> ${next!.id}, whose tool calls do not work through this app`);
      }
    }
  });

  await check("the offered models: each answers, lasts past the horizon, takes tool calls through this app, and has a price; one default per provider", () => {
    for (const p of REGISTRY_PROVIDERS) {
      const offered = reg.offeredModels(p);
      assert.ok(offered.length >= 3, `${p} offers ${offered.length} models`);
      for (const m of offered) {
        assert.equal(reg.endsWithin(p, m.id, reg.REGISTRY_HORIZON_DAYS, NOW), null, `${p}/${m.id} is offered but gone or ending`);
        assert.ok(m.tools && m.streaming, `${p}/${m.id} is offered but its tool calls or streaming do not work here`);
        assert.ok(m.prices.length > 0, `${p}/${m.id} is offered with no price`);
      }
      for (const tier of ["fast", "balanced", "deep"] as const) {
        assert.equal(offered.filter((m) => m.tier === tier).length, 1, `${p}: exactly one ${tier} pick`);
      }
      assert.equal(reg.defaultModelFor(p), offered.find((m) => m.tier === "balanced")!.id, `${p}: the default is the balanced pick`);
      // OpenAI's newest models take tool calls only through its Responses API.
      for (const m of MODEL_REGISTRY[p].models) if (!m.tools) assert.equal(m.offered, false, `${p}/${m.id} cannot take tool calls here but is offered`);
    }
    for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]) {
      assert.equal(reg.modelInfo("openai", id)?.offered, false, `${id} needs the Responses API for tools: not offered`);
    }
  });

  await check("a new Anthropic or OpenRouter connection starts on Claude Sonnet 4.6, never on a 5.x Claude model this app has not run (PR #555 review)", () => {
    assert.deepEqual(Object.fromEntries(REGISTRY_PROVIDERS.map((p) => [p, reg.defaultModelFor(p)])), {
      anthropic: "claude-sonnet-4-6",
      openai: "gpt-5.6-terra",
      google: "gemini-3.8-flash",
      openrouter: "anthropic/claude-sonnet-4.6",
    });
    // The key test with no model named runs on the default: it answers one token without thinking first.
    assert.equal(MODEL_REGISTRY.anthropic.probeModel, "claude-sonnet-4-6");
    // The 5.x models stay on offer for an owner who picks one, but none is the default.
    for (const [p, id] of [
      ["anthropic", "claude-sonnet-5-5"],
      ["anthropic", "claude-opus-5-5"],
      ["anthropic", "claude-fable-5-1"],
      ["anthropic", "claude-haiku-5-5"],
      ["openrouter", "anthropic/claude-sonnet-5.5"],
      ["openrouter", "anthropic/claude-opus-5.5"],
      ["openrouter", "anthropic/claude-fable-5.1"],
      ["openrouter", "anthropic/claude-haiku-5.5"],
    ] as const) {
      assert.equal(reg.modelInfo(p, id)?.offered, true, `${p}/${id} is no longer offered`);
      assert.notEqual(reg.defaultModelFor(p), id, `${p}/${id} is the default`);
    }
  });

  await check("every model list and default reads the registry: the pickers, the save check, /model, the probe, the pairing defaults", () => {
    for (const p of REGISTRY_PROVIDERS) {
      const entry = PROVIDER_REGISTRY.find((e) => e.value === p)!;
      assert.deepEqual(entry.models, reg.offeredModels(p).map((m) => ({ id: m.id, label: reg.pickerLabel(m) })), `${p}: PROVIDER_REGISTRY.models is not the registry's list`);
      assert.deepEqual(PROVIDER_MODELS[p], reg.offeredModels(p).map((m) => m.id));
      assert.equal(entry.models[0].id, reg.defaultModelFor(p), `${p}: the first picker entry is the connect default`);
      assert.equal(PROBE_MODEL[p], MODEL_REGISTRY[p].probeModel, `${p}: the probe model is not the registry's`);
      assert.equal(reg.modelVerdict(p, PROBE_MODEL[p], NOW).kind, "usable", `${p}: the probe model ${PROBE_MODEL[p]} does not answer`);
      for (const m of entry.models) assert.equal(providerForModel(m.id), p, `/model ${m.id} resolves to another provider`);
    }
    // The Google key test was gemini-2.5-flash: a new project's good key failed its own test.
    assert.equal(PROBE_MODEL.google, "gemini-3.5-flash-lite");
    const pair = readFileSync(join(ROOT, "app/api/auth/pair/route.ts"), "utf8");
    assert.match(pair, /google: defaultModelFor\("google"\)/, "the pairing route's defaults are the registry's");
    assert.doesNotMatch(pair, /gemini-2\.5-pro/);
  });

  await check("no shipped source names a model the registry does not know, or one it knows is gone (except where listed, with the reason)", () => {
    // lib/operator-credentials.ts cannot be opened by an agent session (a
    // file-protection hook keeps files named like credentials closed): its
    // four platform defaults are swapped at call time by streamChat and the
    // tool loops, and the four-line change is in the PR for Bravo. This
    // allowance fails the check once it is no longer needed, so the change
    // and the deletion of this line land together.
    const allowed: Record<string, string[]> = {
      "lib/operator-credentials.ts": ["anthropic/claude-sonnet-4", "gemini-2.5-pro"],
    };
    const usedAllowances = new Set<string>();
    const MODEL_LITERAL =
      /["'`]((?:anthropic|openai|google|meta-llama)\/[a-z0-9][a-z0-9.:_-]*|claude-[a-z0-9][a-z0-9.-]*|gpt-[0-9][a-z0-9.-]*|gemini-[0-9][a-z0-9.-]*)["'`]/g;
    const problems: string[] = [];
    let seen = 0;
    for (const { rel, code } of shippedSources()) {
      if (rel === "lib/ai/model-registry.ts") continue;
      for (const m of code.matchAll(MODEL_LITERAL)) {
        const id = m[1];
        seen += 1;
        const known = REGISTRY_PROVIDERS.find((p) => reg.modelInfo(p, id));
        const verdict = known ? reg.modelVerdict(known, id, NOW).kind : "unknown";
        if (verdict === "usable") continue;
        if ((allowed[rel] ?? []).includes(id)) {
          usedAllowances.add(`${rel}: ${id}`);
          continue;
        }
        problems.push(`${rel}: "${id}" is ${verdict === "unknown" ? "not in the registry" : "gone"}`);
      }
    }
    assert.ok(seen >= 5, `only ${seen} model literals found: the scan is not reaching the sources`);
    assert.deepEqual(problems, []);
    const stale = Object.entries(allowed).flatMap(([rel, ids]) => ids.map((id) => `${rel}: ${id}`)).filter((a) => !usedAllowances.has(a));
    assert.deepEqual(stale, [], "an allowance above is no longer needed: delete it");
  });

  await check("the price rows (bravo__192 + bravo__204) are exactly the registry's prices, and every model the app offers or tests on has one", () => {
    const rows = [...migrationPriceRows("bravo__192_ai_usage.sql"), ...migrationPriceRows("bravo__204_model_prices_current.sql")];
    assert.ok(rows.length >= 35, `only ${rows.length} price rows parsed`);
    const fromDb = new Map<string, string[]>();
    for (const r of rows) {
      assert.match(r.url, /^https:\/\//);
      const known = reg.modelInfo(r.key.split("/")[0], r.key.slice(r.key.indexOf("/") + 1));
      assert.ok(known, `a price for ${r.key}, which the registry does not know`);
      fromDb.set(r.key, [...(fromDb.get(r.key) ?? []), JSON.stringify([r.from, r.above, r.input, r.output, r.read, r.write])]);
    }
    for (const p of REGISTRY_PROVIDERS) {
      for (const m of MODEL_REGISTRY[p].models) {
        const key = `${p}/${m.id}`;
        const want = m.prices.map((x) => JSON.stringify([x.from, x.promptTokensAbove, micro(x.input), micro(x.output), micro(x.cacheRead), micro(x.cacheWrite)])).sort();
        assert.deepEqual((fromDb.get(key) ?? []).sort(), want, `${key}: the migration's rows and the registry's prices differ`);
      }
      for (const m of reg.offeredModels(p)) assert.ok(fromDb.has(`${p}/${m.id}`), `${p}/${m.id} is offered with no price row`);
      assert.ok(fromDb.has(`${p}/${MODEL_REGISTRY[p].probeModel}`), `${p}: the probe model has no price row`);
    }
    // The dated change Google prints: Gemini 3.8 Flash doubles on 2027-01-01.
    assert.deepEqual(fromDb.get("google/gemini-3.8-flash")?.map((s) => JSON.parse(s)[0]).sort(), ["2026-10-08", "2027-01-01"]);
    // Additive only: no statement in bravo__204 but INSERT OR IGNORE.
    const sql = readFileSync(join(ROOT, "database/turso/bravo__204_model_prices_current.sql"), "utf8");
    const statements = sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    assert.ok(statements.length >= 4 && statements.every((s) => /^INSERT OR IGNORE INTO model_prices\b/.test(s)), "bravo__204 does something besides add price rows");
  });

  await check("a saved model the registry knows is gone is sent as its replacement on the SAME provider, with the reason recorded; anything else is sent as saved", () => {
    const swap = reg.resolveModelForCall("google", "gemini-2.5-pro", NOW);
    assert.deepEqual(
      { model: swap.model, provider: swap.swap?.provider, reason: swap.swap?.reason, fallback: swap.swap?.fallbackReason },
      { model: "gemini-3.8-flash", provider: "google", reason: "access_limited", fallback: "model_access_limited:gemini-2.5-pro" },
    );
    assert.equal(reg.resolveModelForCall("anthropic", "claude-3-5-sonnet-20241022", NOW).model, "claude-sonnet-5-5");
    assert.equal(reg.resolveModelForCall("openai", "gpt-5.2-codex", NOW).model, "gpt-5.6-terra");
    // Unchanged: a current model, a legacy one that still answers, one the
    // registry does not know (never guessed), a local model, and an ending one
    // before its day.
    for (const [p, id] of [
      ["google", "gemini-3.8-flash"],
      ["anthropic", "claude-sonnet-4-6"],
      ["openrouter", "anthropic/claude-sonnet-4"],
      ["ollama", "llama3.3"],
      ["openrouter", "google/gemini-2.5-pro"],
    ] as const) {
      assert.deepEqual(reg.resolveModelForCall(p, id, NOW), { model: id, swap: null }, `${p}/${id} was swapped`);
    }
    // OpenRouter's expiration_date: sent as saved through 2026-10-19, replaced from 2026-10-20.
    assert.equal(reg.resolveModelForCall("openrouter", "google/gemini-2.5-pro", DAY("2026-10-19")).model, "google/gemini-2.5-pro");
    const expired = reg.resolveModelForCall("openrouter", "google/gemini-2.5-pro", DAY("2026-10-20"));
    assert.deepEqual([expired.model, expired.swap?.reason], ["google/gemini-3.8-flash", "expired"]);
    // Never another provider: every swap the registry can make stays on its provider.
    for (const p of REGISTRY_PROVIDERS) {
      for (const m of MODEL_REGISTRY[p].models) {
        const r = reg.resolveModelForCall(p, m.id, DAY("2028-01-01"));
        if (r.swap) assert.ok(MODEL_REGISTRY[p].models.some((x) => x.id === r.model), `${p}/${m.id} swapped off ${p}`);
      }
    }
  });

  await check("a swapped call's meter records why, on every call it opens; resolving again changes nothing", async () => {
    const begun: Array<Record<string, unknown>> = [];
    const meter = {
      context: Object.freeze({ tenantId: "t", surface: "agents.chat", authKind: "api_key", billingMode: "byo_key" }),
      totals: () => ({ calls: 0, costMicroUsd: 0, unknownCostCalls: 0 }),
      begin: async (c: Record<string, unknown>) => {
        begun.push(c);
        return { finish: async () => undefined };
      },
    } as unknown as import("../lib/ai/usage").ModelCallMeter;
    const first = reg.resolveCall("google", "gemini-2.5-pro", meter, NOW);
    const again = reg.resolveCall("google", first.model, first.meter, NOW);
    assert.equal(again.swap, null, "a resolved model was resolved again");
    await again.meter.begin({ provider: "google", model: again.model, maxOutputTokens: 1, promptBytes: 1 });
    await again.meter.begin({ provider: "google", model: again.model, maxOutputTokens: 1, promptBytes: 1 });
    assert.deepEqual(begun.map((c) => c.fallbackReason), ["model_access_limited:gemini-2.5-pro", "model_access_limited:gemini-2.5-pro"]);
    assert.equal(reg.resolveCall("google", "gemini-3.8-flash", meter, NOW).meter, meter, "an unswapped call got another meter");
  });

  await check("the owner's sentences say what really happens, and Settings lists the saved value as itself", () => {
    const note = (p: string, id: string, now = NOW) => reg.modelNote(p, id, { audience: "departments", now })?.sentence ?? null;
    assert.equal(note("google", "gemini-2.5-pro"), "Google no longer offers Gemini 2.5 Pro to new accounts; your departments now use Gemini 3.8 Flash.");
    assert.equal(note("anthropic", "claude-3-5-sonnet-20241022"), "Anthropic retired Claude Sonnet 3.5 on 2025-10-28; your departments now use Claude Sonnet 5.5.");
    assert.equal(
      note("openrouter", "google/gemini-2.5-pro"),
      "OpenRouter stops offering Gemini 2.5 Pro on 2026-10-20. Pick a newer model, or your departments will move to Gemini 3.8 Flash then.",
    );
    assert.equal(note("google", "gemini-3.8-flash"), null, "a current model needs no note");
    // The Anthropic default (offered) needs none; an older model the pickers no longer offer gets one.
    assert.equal(note("anthropic", "claude-sonnet-4-6"), null, "the default model got a note");
    assert.equal(note("anthropic", "claude-opus-4-7"), "Claude Opus 4.7 is an older model that still works. Claude Opus 5.5 is its current replacement.");
    assert.match(String(note("openrouter", "anthropic/claude-sonnet-4")), /^anthropic\/claude-sonnet-4 is not on our list of OpenRouter models, so we can't say whether OpenRouter still offers it\./);
    assert.match(String(note("openai", "gpt-6.1-sol")), /tool calls need OpenAI's newer Responses API/);
    assert.equal(reg.modelNote("anthropic", "claude-mythos-5-1", { audience: "agent", now: NOW })?.sentence, "Anthropic offers Claude Mythos 5.1 only to verified accounts; this agent now uses Claude Fable 5.1.");
    // The picker: the saved value first, as itself, then the offered models.
    const choices = reg.modelChoices("google", "gemini-2.5-pro", NOW);
    assert.deepEqual(choices[0], { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (saved, no longer offered)", offered: false });
    assert.deepEqual(choices.slice(1).map((c) => c.id), reg.offeredModels("google").map((m) => m.id));
    assert.equal(reg.modelChoices("google", "gemini-3.8-flash", NOW).length, reg.offeredModels("google").length, "an offered saved value is listed once");
    assert.deepEqual(reg.modelChoices("openrouter", "anthropic/claude-sonnet-4", NOW)[0], { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4 (saved, not on our list)", offered: false });
    // A save can never put a gone or ending model back; an unknown one is the caller's call.
    const refused = reg.saveCheck("google", "gemini-2.5-pro", NOW);
    assert.deepEqual(refused, { ok: false, message: "Google no longer offers Gemini 2.5 Pro to new accounts. Pick Gemini 3.8 Flash or another listed model." });
    assert.equal(reg.saveCheck("openrouter", "google/gemini-2.5-pro", NOW).ok, false, "a model ending in 12 days was saveable");
    assert.deepEqual(reg.saveCheck("anthropic", "claude-sonnet-4-6", NOW), { ok: true, known: true });
    assert.deepEqual(reg.saveCheck("openrouter", "some-vendor/new-model", NOW), { ok: true, known: false });
    // Nor a model whose tool calls do not work through this app (PR #555 review):
    // it answers a key test, so this check is what keeps a direct request from saving it.
    assert.deepEqual(reg.saveCheck("openai", "gpt-6.1-sol", NOW), {
      ok: false,
      message: "GPT-6.1 Sol answers chats, but its tool calls need OpenAI's newer Responses API, which this app does not use yet. Pick GPT-5.6 Terra or another listed model.",
    });
    assert.deepEqual(reg.saveCheck("openrouter", "openai/gpt-6-luna", NOW), {
      ok: false,
      message: "GPT-6 Luna answers chats, but its tool calls through OpenRouter are not verified yet, so this app does not offer it. Pick Claude Sonnet 4.6 or another listed model.",
    });
    for (const p of REGISTRY_PROVIDERS) {
      for (const m of MODEL_REGISTRY[p].models) {
        if (!m.tools && m.status !== "retired") assert.equal(reg.saveCheck(p, m.id, NOW).ok, false, `${p}/${m.id} has no tool calls here but can be saved`);
      }
    }
  });

  await check("a provider's 'not found' names the model and says retired or not offered to this account; billing and a bad key stay their own", () => {
    // The shapes the providers answer with (researched 2026-10-08).
    assert.equal(outcome.classifyStreamError('google_404:{"error":{"code":404,"message":"This model models/gemini-2.5-pro is no longer available to new users.","status":"NOT_FOUND"}}'), "provider_404");
    assert.equal(outcome.classifyStreamError('openrouter_400:{"error":{"message":"google/gemini-2.5-flash is not a valid model ID","code":400}}'), "provider_404");
    assert.equal(outcome.classifyStreamError('anthropic_400:{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), "provider_400_credit");
    assert.equal(outcome.classifyStreamError('google_400:{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'), "provider_401");
    assert.equal(outcome.classifyStreamError('openai_401:{"error":{"code":"invalid_api_key"}}'), "provider_401");
    // A body naming both a balance and a model: the balance wins (it is about the account).
    assert.equal(outcome.classifyProviderStatus(400, "credit balance too low; x is not a valid model ID"), "provider_400_credit");
    assert.equal(outcome.classifyProviderStatus(400, "Unsupported parameter: temperature"), "provider_400", "a request-shape 400 is not a model problem");

    const named = outcome.failureCopy("provider_404", { canManageAi: true, model: reg.modelFactsForCopy("google", "gemini-2.5-pro") });
    assert.equal(
      named.sentence,
      "The AI model Gemini 2.5 Pro (gemini-2.5-pro) was not found: Google has retired it or does not offer it to this AI account. Pick another model in AI settings, such as Gemini 3.8 Flash.",
    );
    assert.equal(named.short, "the AI model Gemini 2.5 Pro (gemini-2.5-pro) was not found");
    assert.deepEqual(named.fix, { href: "/settings/ai", label: "Open AI settings" });
    const unknownModel = outcome.failureCopy("provider_404", { canManageAi: false, model: reg.modelFactsForCopy("openrouter", "anthropic/claude-sonnet-4") });
    assert.equal(
      unknownModel.sentence,
      "The AI model anthropic/claude-sonnet-4 was not found: OpenRouter has retired it or does not offer it to this AI account. Pick another model in AI settings, such as Claude Sonnet 4.6. An owner or admin can fix this in Settings.",
    );
    assert.equal(unknownModel.fix, null);
    // With no model known, the sentence still says why and what to do.
    assert.equal(
      outcome.failureCopy("provider_404", { canManageAi: true }).sentence,
      "The AI model this channel uses was not found: the provider has retired it or does not offer it to this AI account. Pick another model in AI settings.",
    );
    // A model is only ever named on a "not found": billing and key words never change.
    const facts = reg.modelFactsForCopy("google", "gemini-2.5-pro");
    for (const code of ["provider_401", "provider_402", "provider_400_credit", "provider_403", "provider_429"]) {
      assert.deepEqual(outcome.failureCopy(code, { canManageAi: true, model: facts }), outcome.failureCopy(code, { canManageAi: true }), code);
      assert.doesNotMatch(outcome.failureCopy(code, { canManageAi: true }).sentence, /not found|retired/, code);
    }
    assert.notEqual(outcome.failureCopy("provider_401", { canManageAi: true }).short, outcome.failureCopy("provider_400_credit", { canManageAi: true }).short);
  });

  await check("the saved-model mover: moves gone and ending rows on their provider, leaves the rest, refuses to overwrite a change, and undoes exactly", async () => {
    const { planMoves, applyMoves, revertMoves, readSavedRows } = await import("../lib/ai/saved-model-moves");
    const file = join(mkdtempSync(join(tmpdir(), "saved-model-moves-")), "moves.db");
    const db = createClient({ url: `file:${file}` });
    await db.execute(`CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, agent_key TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`);
    const A = "a0000000-0000-4000-8000-00000000000a";
    const B = "b0000000-0000-4000-8000-00000000000b";
    const seed: Array<[string, string, string | null, string, string, string]> = [
      ["r-or-pro", B, "u-1", "bravo", "openrouter", "google/gemini-2.5-pro"],
      ["r-g-pro", A, null, "bravo", "google", "gemini-2.5-pro"],
      ["r-retired", A, null, "sdr", "anthropic", "claude-3-5-sonnet-20241022"],
      ["r-codex", A, null, "maven", "openai", "gpt-5.3-codex"],
      ["r-legacy", A, null, "atlas", "anthropic", "claude-sonnet-4-6"],
      ["r-current", A, null, "aura", "google", "gemini-3.8-flash"],
      ["r-unknown-1", B, null, "sdr", "openrouter", "anthropic/claude-sonnet-4"],
      ["r-unknown-2", B, null, "bravo", "openrouter", "anthropic/claude-sonnet-4"],
      ["r-local", A, "u-2", "bravo", "ollama", "llama3.3"],
    ];
    for (const [id, t, u, k, p, m] of seed) {
      await db.execute({
        sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'cipher-unchanged', '2026-08-01T00:00:00.000Z')",
        args: [id, t, u, k, p, m],
      });
    }
    const snapshot = async () =>
      (await db.execute("SELECT id, provider, model, encrypted_api_key, updated_at FROM agent_model_config ORDER BY id")).rows.map((r) => [r.id, r.provider, r.model, r.encrypted_api_key, r.updated_at].join(" "));
    const before = await snapshot();

    const plan = planMoves(await readSavedRows(db), NOW);
    assert.deepEqual(
      plan.moves.map((m) => `${m.id}: ${m.provider} ${m.from} -> ${m.to} (${m.reason}, ${m.scope})`).sort(),
      [
        "r-g-pro: google gemini-2.5-pro -> gemini-3.8-flash (access_limited, workspace)",
        "r-or-pro: openrouter google/gemini-2.5-pro -> google/gemini-3.8-flash (ending, personal)",
        "r-retired: anthropic claude-3-5-sonnet-20241022 -> claude-sonnet-5-5 (retired, workspace)",
      ],
    );
    assert.deepEqual(plan.unknown, [{ provider: "openrouter", model: "anthropic/claude-sonnet-4", rows: 2 }]);
    assert.deepEqual(plan.stuck, []);
    assert.deepEqual(await snapshot(), before, "planning changed a row");
    // GPT-5.3 Codex shuts down 2027-04-01: inside the horizon it moves too.
    assert.deepEqual(
      planMoves(await readSavedRows(db), DAY("2027-03-20")).moves.filter((m) => m.id === "r-codex").map((m) => m.to),
      ["gpt-5.6-terra"],
    );

    // Someone changes one planned row between the plan and the move: it is left alone.
    await db.execute("UPDATE agent_model_config SET model = 'gemini-3.5-flash-lite' WHERE id = 'r-g-pro'");
    const log = await applyMoves(db, plan, new Date("2026-10-09T01:00:00.000Z"));
    assert.deepEqual(log.entries.map((e) => [e.id, e.applied]).sort(), [["r-g-pro", false], ["r-or-pro", true], ["r-retired", true]]);
    const after = await snapshot();
    assert.ok(after.includes("r-or-pro openrouter google/gemini-3.8-flash cipher-unchanged 2026-10-09T01:00:00.000Z"), after.join("\n"));
    assert.ok(after.includes("r-retired anthropic claude-sonnet-5-5 cipher-unchanged 2026-10-09T01:00:00.000Z"));
    assert.ok(after.includes("r-g-pro google gemini-3.5-flash-lite cipher-unchanged 2026-08-01T00:00:00.000Z"), "a row changed since the plan was overwritten");
    for (const id of ["r-codex", "r-legacy", "r-current", "r-unknown-1", "r-unknown-2", "r-local"]) {
      assert.equal(after.find((l) => l.startsWith(`${id} `)), before.find((l) => l.startsWith(`${id} `)), `${id} was touched`);
    }

    // The undo: exact, and only on rows still as the move left them.
    await db.execute("UPDATE agent_model_config SET model = 'claude-haiku-5-5' WHERE id = 'r-retired'");
    assert.deepEqual((await revertMoves(db, log)).sort((a, b) => a.id.localeCompare(b.id)), [{ id: "r-or-pro", restored: true }, { id: "r-retired", restored: false }]);
    const reverted = await snapshot();
    assert.equal(reverted.find((l) => l.startsWith("r-or-pro ")), before.find((l) => l.startsWith("r-or-pro ")), "the undo was not exact");
    assert.ok(reverted.includes("r-retired anthropic claude-haiku-5-5 cipher-unchanged 2026-10-09T01:00:00.000Z"), "the undo overwrote a later change");

    // The script itself, end to end on the same file: a dry run changes
    // nothing, --apply moves exactly the plan the dry run showed and writes
    // its undo log, --revert puts it back.
    await db.execute("UPDATE agent_model_config SET model = 'gemini-2.5-pro', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'r-g-pro'");
    // --apply judges the registry at the real time (it refuses --now). The one
    // seeded row whose fate depends on the date (GPT-5.3 Codex enters the
    // 14-day horizon on 2027-03-18) is dropped, so this part gives the same
    // answer on any day CI runs it.
    await db.execute("DELETE FROM agent_model_config WHERE id = 'r-codex'");
    const fresh = await snapshot();
    const nodeOptions = (process.env.NODE_OPTIONS || "").split(/\s+/).filter((t) => t && !/^(--conditions|-C)(=|$)/.test(t) && t !== "react-server").join(" ");
    const runRaw = (...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TURSO_DB_PATH: file, NODE_OPTIONS: nodeOptions };
      delete env.TURSO_DATABASE_URL;
      delete env.TURSO_DB_URL;
      return spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/update-saved-models.ts", "--json", ...args], {
        encoding: "utf8",
        env,
        timeout: 120_000,
      });
    };
    const run = (...args: string[]) => {
      const r = runRaw(...args);
      assert.equal(r.status, 0, `the script exited ${r.status}:\n${r.stderr}`);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    };
    // A rehearsal at a named instant still works for a dry run.
    const rehearsal = run("--now", "2026-10-08T12:00:00.000Z");
    assert.equal(rehearsal.mode, "dry_run");
    const dry = run();
    assert.equal(dry.mode, "dry_run");
    assert.deepEqual((dry.moves as Array<{ id: string }>).map((m) => m.id).sort(), ["r-g-pro", "r-or-pro"]);
    assert.match(String(dry.planId), /^[0-9a-f]{16}$/);
    assert.deepEqual(await snapshot(), fresh, "the dry run changed a row");
    const logFile = join(mkdtempSync(join(tmpdir(), "saved-model-moves-log-")), "undo.json");
    // What was reviewed is what moves (PR #555 review): --apply without the
    // dry run's plan id, on a pretend date, or with a plan id that no longer
    // matches the rows, moves nothing.
    const refusals = [
      { args: ["--apply", "--log", logFile], says: /--apply needs --expect/ },
      { args: ["--apply", "--now", "2027-06-01T00:00:00.000Z", "--expect", String(dry.planId), "--log", logFile], says: /--now is for a dry run only/ },
      { args: ["--apply", "--expect", "0000000000000000", "--log", logFile], says: /changed since the dry run/ },
    ];
    for (const r of refusals) {
      const refused = runRaw(...r.args);
      assert.notEqual(refused.status, 0, `${r.args.join(" ")} was not refused`);
      assert.match(refused.stderr, r.says);
      assert.deepEqual(await snapshot(), fresh, `${r.args.join(" ")} changed a row`);
    }
    const applied = run("--apply", "--expect", String(dry.planId), "--log", logFile);
    assert.equal(applied.mode, "apply");
    assert.equal(applied.planId, dry.planId);
    assert.ok((await snapshot()).includes("r-g-pro google gemini-3.8-flash cipher-unchanged " + String(applied.appliedAt)));
    const undo = JSON.parse(readFileSync(logFile, "utf8")) as { entries: Array<{ id: string; applied: boolean }> };
    assert.deepEqual(undo.entries.filter((e) => e.applied).map((e) => e.id).sort(), ["r-g-pro", "r-or-pro"]);
    const reverting = run("--revert", logFile);
    assert.deepEqual(reverting.results, [{ id: "r-g-pro", restored: true }, { id: "r-or-pro", restored: true }]);
    assert.deepEqual(await snapshot(), fresh, "--revert did not put the rows back exactly");
    db.close();
  });
}
