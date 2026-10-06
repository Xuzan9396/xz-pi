import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { type ModelRuntime, resolveModelScopeWithDiagnostics, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getPiSettingsPaths } from "../src/pi-settings.js";
import {
  modelKey,
  readGlobalScopedModelsState,
  resolveGlobalScopedModelsState,
  resolveScopedPattern,
  toggleGlobalScopedModel,
} from "../src/scoped-models.js";

function model(provider: string, id: string, name = id): Model<any> {
  return {
    provider, id, name, api: "openai-responses", baseUrl: "https://example.test",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true, contextWindow: 128_000, maxTokens: 16_384,
  } as Model<any>;
}

const models = [model("a", "sonnet"), model("a", "opus"), model("b", "gpt")];

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-scope-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = getPiSettingsPaths(cwd, agentDir);
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
  };
  return { root, cwd, agentDir, paths, write };
}

test("enabledModels matching agrees with Pi's public resolver, including globs and thinking suffixes", async () => {
  const catalog = [
    ...models,
    model("b", "sonnet"),
    model("a", "sonnet-20260101"),
    model("a", "sonnet-20260202"),
    model("router", "org/folder/model:exacto"),
    model("router", "org/folder/model:high"),
    model("a", "literal*model"),
    model("a", "model1"),
    model("a", "model2"),
  ];
  const runtime = { getAvailable: async () => catalog } as unknown as ModelRuntime;
  for (const pattern of [
    "a/sonnet", " A / SONNET ", "sonnet", "sonnet-2026", "a/*:high",
    "*sonnet*", "a/model[12]:low", "*g?t", "literal*model",
    "router/org/folder/model:high", "router/org/folder/model:exacto:high",
    "router/org/folder/model:exacto:bad:high", "a/sonnet:bad", "a/opus:max",
    "missing/no-such-model", "missing/*", "a/*:invalid",
  ]) {
    const official = await resolveModelScopeWithDiagnostics([pattern], runtime);
    assert.deepEqual(
      resolveScopedPattern(pattern, catalog).map((match) => [modelKey(match.model), match.thinkingLevel]),
      official.scopedModels.map((match) => [modelKey(match.model), match.thinkingLevel]),
      pattern,
    );
  }
});

test("writes the official global enabledModels field and preserves defaults, project settings and preferences", async (t) => {
  const f = fixture(t);
  const initial = {
    enabledModels: ["a/sonnet"], defaultProvider: "a", defaultModel: "sonnet",
    defaultThinkingLevel: "high", modelThinkingLevels: { "a/sonnet": "xhigh" },
    packages: ["npm:xz-pi-pmodel"], custom: { untouched: true },
  };
  f.write(f.paths.global, initial);
  f.write(f.paths.project, { enabledModels: ["b/gpt"], defaultProvider: "b", defaultModel: "gpt" });
  const preferencePath = join(f.cwd, ".pi", "xz-pi-pmodel.json");
  f.write(preferencePath, { version: 1, providers: { a: { visibleModels: ["sonnet"] } } });
  const projectBefore = readFileSync(f.paths.project, "utf8");
  const preferencesBefore = readFileSync(preferencePath, "utf8");
  const official = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });

  const state = await toggleGlobalScopedModel(f.paths, models, [models[0]!], models[1]!);
  assert.deepEqual(state.modelIds, ["a/sonnet", "a/opus"]);
  assert.equal(state.projectOverride, true);
  assert.equal(state.sessionDiffers, true);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")), {
    ...initial, enabledModels: ["a/sonnet", "a/opus"],
  });
  assert.equal(readFileSync(f.paths.project, "utf8"), projectBefore);
  assert.equal(readFileSync(preferencePath, "utf8"), preferencesBefore);
  await official.reload();
  assert.deepEqual(official.getGlobalSettings().enabledModels, ["a/sonnet", "a/opus"]);
  assert.deepEqual(official.getEnabledModels(), ["b/gpt"]);
});

test("removing one glob member preserves other globs, unavailable IDs, order and thinking levels", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/*:high", "b/*:low", "missing/old", "a/SONNET:medium"] });
  const state = await toggleGlobalScopedModel(f.paths, models, [], models[0]!);
  assert.deepEqual(state.modelIds, ["a/opus", "b/gpt"]);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")).enabledModels, [
    "a/opus:high", "b/*:low", "missing/old",
  ]);
});

test("unset, empty and entirely unresolved scopes behave like Pi's unrestricted scope", async (t) => {
  for (const enabledModels of [undefined, [], ["missing/old"]]) {
    const f = fixture(t);
    f.write(f.paths.global, enabledModels ? { enabledModels } : {});
    const initial = readGlobalScopedModelsState(f.paths, models, []);
    assert.equal(initial.unrestricted, true);
    assert.deepEqual(initial.modelIds, models.map(modelKey));
    const state = await toggleGlobalScopedModel(f.paths, models, [], models[0]!);
    assert.equal(state.unrestricted, false);
    assert.deepEqual(state.modelIds, ["a/opus", "b/gpt"]);
    assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")).enabledModels, [
      ...(enabledModels ?? []), "a/opus", "b/gpt",
    ]);
    assert.equal(existsSync(join(f.agentDir, "xz-pi-pmodel.json")), false);
    assert.equal(existsSync(f.paths.project), false);
  }
});

test("unchecking the last available member cannot silently restore all models", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/sonnet:high", "missing/old"] });
  const before = readFileSync(f.paths.global, "utf8");
  await assert.rejects(toggleGlobalScopedModel(f.paths, models, [models[0]!], models[0]!), /last available scoped model/);
  assert.equal(readFileSync(f.paths.global, "utf8"), before);
});

test("external official changes are re-read before every toggle", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/sonnet"] });
  const official = SettingsManager.create(f.cwd, f.agentDir);
  official.setEnabledModels(["a/sonnet", "b/gpt"]);
  await official.flush();
  const state = await toggleGlobalScopedModel(f.paths, models, [], models[1]!);
  assert.deepEqual(state.modelIds, ["a/sonnet", "b/gpt", "a/opus"]);
});

test("malformed scopes, malformed JSON and unavailable models are rejected without overwriting settings", async (t) => {
  const f = fixture(t);
  for (const value of [{ enabledModels: [123] }, { enabledModels: null }]) {
    f.write(f.paths.global, value);
    const before = readFileSync(f.paths.global, "utf8");
    await assert.rejects(toggleGlobalScopedModel(f.paths, models, [], models[1]!), /enabledModels/);
    assert.equal(readFileSync(f.paths.global, "utf8"), before);
  }
  writeFileSync(f.paths.global, "not JSON", "utf8");
  await assert.rejects(toggleGlobalScopedModel(f.paths, models, [], models[1]!), /Cannot read Pi settings/);
  assert.equal(readFileSync(f.paths.global, "utf8"), "not JSON");
  f.write(f.paths.global, { enabledModels: ["a/sonnet"] });
  await assert.rejects(toggleGlobalScopedModel(f.paths, models, [], { provider: "a", id: "unavailable" }), /unavailable/);
});

test("official settings write failures propagate instead of reporting a successful save", { skip: process.getuid?.() === 0 }, async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/sonnet"] });
  const before = readFileSync(f.paths.global, "utf8");
  chmodSync(f.paths.global, 0o400);
  try {
    await assert.rejects(toggleGlobalScopedModel(f.paths, models, [], models[1]!));
    assert.equal(readFileSync(f.paths.global, "utf8"), before);
  } finally {
    chmodSync(f.paths.global, 0o600);
  }
});

test("membership compares the saved global scope with the session without applying untrusted project overrides", () => {
  const global = { enabledModels: ["a/sonnet"] };
  const project = { enabledModels: ["b/gpt"] };
  assert.deepEqual(resolveGlobalScopedModelsState(global, project, models, [models[0]!], false), {
    modelIds: ["a/sonnet"], unrestricted: false, projectOverride: false, sessionDiffers: false,
  });
  assert.equal(resolveGlobalScopedModelsState(global, project, models, [models[2]!]).sessionDiffers, true);
});
