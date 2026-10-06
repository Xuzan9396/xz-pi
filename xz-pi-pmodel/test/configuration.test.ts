import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { reconcileProjectConfiguration } from "../src/configuration.js";
import {
  cleanupProjectVisibility, clearProjectOverride, getPreferencePaths,
  migrateProjectOrdering, readPreferenceLayers, resolvePreferences, writePreferenceOverride,
} from "../src/preferences.js";
import {
  cleanupProjectDefaults, getPiSettingsPaths, readPiSettingsLayers,
  resolveModelDefault,
} from "../src/pi-settings.js";

function model(provider: string, id: string, reasoning = true): Model<any> {
  return { provider, id, name: id, reasoning, api: "openai-responses" } as Model<any>;
}
const catalog = [model("a", "one"), model("a", "two"), model("b", "plain", false)];

function fixture(t: { after: (run: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  const preferences = getPreferencePaths(cwd, agent);
  const settings = getPiSettingsPaths(cwd, agent);
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
  };
  return { root, cwd, agent, preferences, settings, write };
}

test("provider and model orders ignore legacy project overrides and always write globally", (t) => {
  const f = fixture(t);
  f.write(f.preferences.global, { version: 1, providerOrder: ["a", "b"], providers: { a: { modelOrder: ["one", "two"] } } });
  f.write(f.preferences.project, { version: 1, providerOrder: ["b", "a"], providers: { a: { modelOrder: ["two", "one"], visibleModels: ["two"] } } });
  let layers = readPreferenceLayers(f.preferences);
  let resolved = resolvePreferences(layers.global, layers.project);
  assert.deepEqual(resolved.providerOrder, ["a", "b"]);
  assert.deepEqual(resolved.providers.a?.modelOrder, ["one", "two"]);
  assert.equal(resolved.sources.providerOrder, "global");
  assert.equal(resolved.providers.a?.sources.modelOrder, "global");
  assert.deepEqual(resolved.providers.a?.visibleModels, ["two"]);
  const before = readFileSync(f.preferences.project, "utf8");
  writePreferenceOverride(f.preferences, "project", { field: "modelOrder", provider: "a", value: ["two", "one"] });
  assert.equal(readFileSync(f.preferences.project, "utf8"), before);
  layers = readPreferenceLayers(f.preferences);
  resolved = resolvePreferences(layers.global, layers.project);
  assert.deepEqual(resolved.providers.a?.modelOrder, ["two", "one"]);
});

test("missing global sorting is migrated once while visibility and unknown project fields are preserved", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, {
    version: 1, providerOrder: ["b", "a"], note: { keep: true },
    providers: { a: { modelOrder: ["two", "one"], visibleModels: ["one"], note: "keep" } },
  });
  const result = migrateProjectOrdering(f.preferences, { projectTrusted: true });
  assert.equal(result.migrated.length, 2);
  assert.equal(result.cleared.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.preferences.global, "utf8")), {
    version: 1, providerOrder: ["b", "a"], providers: { a: { modelOrder: ["two", "one"] } },
  });
  assert.deepEqual(JSON.parse(readFileSync(f.preferences.project, "utf8")), {
    version: 1, note: { keep: true }, providers: { a: { visibleModels: ["one"], note: "keep" } },
  });
  const globalBefore = readFileSync(f.preferences.global, "utf8");
  const projectBefore = readFileSync(f.preferences.project, "utf8");
  assert.deepEqual(migrateProjectOrdering(f.preferences, { projectTrusted: true }), { migrated: [], cleared: [] });
  assert.equal(readFileSync(f.preferences.global, "utf8"), globalBefore);
  assert.equal(readFileSync(f.preferences.project, "utf8"), projectBefore);
});

test("existing global fields win over migration and empty global orders remain explicit", (t) => {
  const f = fixture(t);
  f.write(f.preferences.global, { version: 1, providerOrder: [], providers: { a: { modelOrder: [] } }, custom: 42 });
  f.write(f.preferences.project, { version: 1, providerOrder: ["a"], providers: { a: { modelOrder: ["one"] } } });
  const before = readFileSync(f.preferences.global, "utf8");
  assert.equal(migrateProjectOrdering(f.preferences, { projectTrusted: true }).migrated.length, 0);
  assert.equal(readFileSync(f.preferences.global, "utf8"), before);
  assert.deepEqual(JSON.parse(readFileSync(f.preferences.project, "utf8")), { version: 1 });
});

test("another project's old sorting cannot overwrite the shared order", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providers: { a: { modelOrder: ["two", "one"] } } });
  migrateProjectOrdering(f.preferences, { projectTrusted: true });
  const other = getPreferencePaths(join(f.root, "other"), f.agent);
  f.write(other.project, { version: 1, providers: { a: { modelOrder: ["one", "two"] } } });
  migrateProjectOrdering(other, { projectTrusted: true });
  const layers = readPreferenceLayers(other);
  assert.deepEqual(resolvePreferences(layers.global, layers.project).providers.a?.modelOrder, ["two", "one"]);
  writePreferenceOverride(other, "project", { field: "modelOrder", provider: "a", value: ["one", "two"] });
  const first = readPreferenceLayers(f.preferences);
  assert.deepEqual(resolvePreferences(first.global, first.project).providers.a?.modelOrder, ["one", "two"]);
});

test("clearing a legacy project order never clears global sorting", (t) => {
  const f = fixture(t);
  f.write(f.preferences.global, { version: 1, providerOrder: ["a"], providers: { a: { modelOrder: ["one"] } } });
  f.write(f.preferences.project, { version: 1, providerOrder: ["b"], providers: { a: { modelOrder: ["two"] } } });
  const before = readFileSync(f.preferences.global, "utf8");
  clearProjectOverride(f.preferences, { field: "providerOrder" });
  clearProjectOverride(f.preferences, { field: "modelOrder", provider: "a" });
  assert.equal(readFileSync(f.preferences.global, "utf8"), before);
});

test("untrusted project data is neither migrated, read as overrides, nor rewritten", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providerOrder: ["a"] });
  f.write(f.settings.project, { defaultProvider: "a", defaultModel: "one" });
  const before = readFileSync(f.preferences.project, "utf8");
  assert.deepEqual(migrateProjectOrdering(f.preferences, { projectTrusted: false }), { migrated: [], cleared: [] });
  assert.equal(existsSync(f.preferences.global), false);
  assert.equal(readFileSync(f.preferences.project, "utf8"), before);
  assert.deepEqual(readPreferenceLayers(f.preferences, { projectTrusted: false }).project, { version: 1 });
  assert.deepEqual(readPiSettingsLayers(f.settings, { projectTrusted: false }).project, {});
  assert.ok(cleanupProjectVisibility(f.preferences, catalog, { projectTrusted: false }).skippedReason);
  assert.ok(cleanupProjectDefaults(f.settings, catalog, { projectTrusted: false }).skippedReason);
});

test("a stale project visible allowlist resets that provider to global rather than becoming empty", (t) => {
  const f = fixture(t);
  f.write(f.preferences.global, { version: 1, providers: { a: { visibleModels: ["two"] } } });
  f.write(f.preferences.project, { version: 1, providers: {
    a: { visibleModels: ["one", "deleted"], note: "keep" }, b: { visibleModels: [] },
  }, note: true });
  const globalBefore = readFileSync(f.preferences.global, "utf8");
  assert.deepEqual(cleanupProjectVisibility(f.preferences, catalog, { projectTrusted: true }).restoredProviders, ["a"]);
  const layers = readPreferenceLayers(f.preferences);
  assert.deepEqual(resolvePreferences(layers.global, layers.project).providers.a?.visibleModels, ["two"]);
  assert.deepEqual(layers.project.providers?.b?.visibleModels, []);
  assert.equal(readFileSync(f.preferences.global, "utf8"), globalBefore);
  assert.deepEqual(JSON.parse(readFileSync(f.preferences.project, "utf8")), {
    version: 1, providers: { a: { note: "keep" }, b: { visibleModels: [] } }, note: true,
  });
});

test("adding models or temporarily lacking authentication does not invalidate a project visibility list", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providers: { a: { visibleModels: ["one"] } } });
  const before = readFileSync(f.preferences.project, "utf8");
  assert.deepEqual(cleanupProjectVisibility(f.preferences, [...catalog, model("a", "new")], { projectTrusted: true }).restoredProviders, []);
  assert.equal(readFileSync(f.preferences.project, "utf8"), before);
});

test("missing project default model falls back without continuously modifying Pi thinking fields", (t) => {
  const f = fixture(t);
  f.write(f.settings.global, { defaultProvider: "a", defaultModel: "one", modelThinkingLevels: { "a/one": "medium" }, custom: true });
  f.write(f.settings.project, {
    defaultProvider: "gone", defaultModel: "deleted", defaultThinkingLevel: "high",
    modelThinkingLevels: { "gone/deleted": "high", "a/two": "low" },
    enabledModels: ["gone/deleted"], custom: { keep: true },
  });
  const globalBefore = readFileSync(f.settings.global, "utf8");
  const result = cleanupProjectDefaults(f.settings, catalog, { projectTrusted: true });
  assert.equal(result.modelDefaultCleared, true);
  assert.equal("thinkingModelsCleared" in result, false);
  const layers = readPiSettingsLayers(f.settings);
  assert.deepEqual(resolveModelDefault(layers.global, layers.project), { provider: "a", id: "one", source: "global" });
  assert.deepEqual(layers.global.modelThinkingLevels, { "a/one": "medium" });
  assert.deepEqual(layers.project.modelThinkingLevels, { "gone/deleted": "high", "a/two": "low" });
  assert.deepEqual(layers.project.enabledModels, ["gone/deleted"]);
  assert.deepEqual(layers.project.custom, { keep: true });
  assert.equal(readFileSync(f.settings.global, "utf8"), globalBefore);
});

test("partially inherited project defaults conflicting with a changed global provider reset both model fields", (t) => {
  const f = fixture(t);
  f.write(f.settings.global, { defaultProvider: "b", defaultModel: "plain" });
  f.write(f.settings.project, { defaultProvider: "a" });
  assert.equal(cleanupProjectDefaults(f.settings, catalog, { projectTrusted: true }).modelDefaultCleared, true);
  const layers = readPiSettingsLayers(f.settings);
  assert.deepEqual(resolveModelDefault(layers.global, layers.project), { provider: "b", id: "plain", source: "global" });
});

test("ordinary model cleanup preserves unsupported and future native thinking fields", (t) => {
  const f = fixture(t);
  f.write(f.settings.global, { defaultProvider: "b", defaultModel: "plain", modelThinkingLevels: { "b/plain": "off" } });
  f.write(f.settings.project, {
    defaultProvider: "b", defaultModel: "plain", defaultThinkingLevel: "high",
    modelThinkingLevels: { "b/plain": "high", "a/one": "medium", "a/two": "invalid" }, custom: "keep",
  });
  const result = cleanupProjectDefaults(f.settings, catalog, { projectTrusted: true });
  assert.equal(result.modelDefaultCleared, false);
  assert.equal("generalThinkingCleared" in result, false);
  const layers = readPiSettingsLayers(f.settings);
  assert.equal(layers.project.defaultThinkingLevel, "high");
  assert.deepEqual(layers.project.modelThinkingLevels, { "b/plain": "high", "a/one": "medium", "a/two": "invalid" });
  assert.equal(layers.project.custom, "keep");
});

test("valid project model and thinking defaults survive new catalog additions and override global", (t) => {
  const f = fixture(t);
  f.write(f.settings.global, { defaultProvider: "b", defaultModel: "plain", modelThinkingLevels: { "a/one": "low" } });
  f.write(f.settings.project, { defaultProvider: "a", defaultModel: "one", modelThinkingLevels: { "a/one": "medium" } });
  const before = readFileSync(f.settings.project, "utf8");
  const result = cleanupProjectDefaults(f.settings, [...catalog, model("a", "new")], { projectTrusted: true });
  assert.equal(result.modelDefaultCleared, false);
  assert.equal("thinkingModelsCleared" in result, false);
  assert.equal(readFileSync(f.settings.project, "utf8"), before);
  const layers = readPiSettingsLayers(f.settings);
  assert.deepEqual(resolveModelDefault(layers.global, layers.project), { provider: "a", id: "one", source: "project" });
  assert.deepEqual(layers.project.modelThinkingLevels, { "a/one": "medium" });
});

test("empty or failed catalogs never trigger project visibility/default cleanup", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providers: { gone: { visibleModels: ["deleted"] } } });
  f.write(f.settings.project, { defaultProvider: "gone", defaultModel: "deleted", modelThinkingLevels: { "gone/deleted": "high" } });
  const prefsBefore = readFileSync(f.preferences.project, "utf8");
  const settingsBefore = readFileSync(f.settings.project, "utf8");
  for (const options of [{ projectTrusted: true, catalogError: "broken" }, { projectTrusted: true }]) {
    const models = options.catalogError ? catalog : [];
    assert.ok(cleanupProjectVisibility(f.preferences, models, options).skippedReason);
    assert.ok(cleanupProjectDefaults(f.settings, models, options).skippedReason);
  }
  assert.equal(readFileSync(f.preferences.project, "utf8"), prefsBefore);
  assert.equal(readFileSync(f.settings.project, "utf8"), settingsBefore);
});

test("malformed configuration is rejected before rewriting its file", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1 });
  writeFileSync(f.preferences.project, "not json", "utf8");
  assert.throws(() => migrateProjectOrdering(f.preferences, { projectTrusted: true }), /Cannot read pmodel/);
  assert.equal(existsSync(f.preferences.global), false);
  f.write(f.settings.project, {});
  writeFileSync(f.settings.project, "not json", "utf8");
  const before = readFileSync(f.settings.project, "utf8");
  assert.throws(() => cleanupProjectDefaults(f.settings, catalog, { projectTrusted: true }), /Cannot read Pi settings/);
  assert.equal(readFileSync(f.settings.project, "utf8"), before);
});

test("v5.1 thinking migration removes only legacy project fields once without touching globals", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, custom: "keep", providers: { a: { visibleModels: ["one"] } } });
  f.write(f.settings.global, { defaultProvider: "a", defaultModel: "one", defaultThinkingLevel: "low", modelThinkingLevels: { "a/one": "high", bad: "future-value" } });
  f.write(f.settings.project, { defaultProvider: "a", defaultModel: "one", defaultThinkingLevel: "obsolete", modelThinkingLevels: ["obsolete"], enabledModels: ["a/one:high"], custom: { keep: true } });
  const globalBefore = readFileSync(f.settings.global, "utf8");
  const result = reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true });
  assert.equal(result.thinkingMigration.changed, true);
  const project = JSON.parse(readFileSync(f.settings.project, "utf8"));
  assert.equal("defaultThinkingLevel" in project, false);
  assert.equal("modelThinkingLevels" in project, false);
  assert.equal(project.defaultModel, "one");
  assert.deepEqual(project.enabledModels, ["a/one:high"]);
  assert.deepEqual(project.custom, { keep: true });
  assert.equal(readFileSync(f.settings.global, "utf8"), globalBefore);
  const preferences = JSON.parse(readFileSync(f.preferences.project, "utf8"));
  assert.equal(preferences.migrations.projectThinkingDefaultsRemoved, true);
  assert.equal(preferences.custom, "keep");
  project.modelThinkingLevels = { "a/one": "medium" };
  f.write(f.settings.project, project);
  const after = readFileSync(f.settings.project, "utf8");
  const second = reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true });
  assert.equal(second.thinkingMigration.changed, false);
  assert.equal(readFileSync(f.settings.project, "utf8"), after);
});

test("v5.1 thinking migration refuses untrusted or malformed settings and never makes empty settings", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1 });
  f.write(f.settings.project, { defaultThinkingLevel: "high", custom: true });
  const before = readFileSync(f.settings.project, "utf8");
  reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: false });
  assert.equal(readFileSync(f.settings.project, "utf8"), before);
  f.write(f.preferences.project, { version: 1, migrations: "invalid" });
  assert.throws(() => reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true }), /migration/);
  assert.equal(readFileSync(f.settings.project, "utf8"), before);
  f.write(f.preferences.project, { version: 1 });
  writeFileSync(f.settings.project, "not json");
  assert.throws(() => reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true }), /Cannot read/);
  assert.equal(readFileSync(f.settings.project, "utf8"), "not json");
  const empty = fixture(t);
  reconcileProjectConfiguration(empty.preferences, empty.settings, catalog, { projectTrusted: true });
  assert.equal(existsSync(empty.settings.project), false);
});

test("combined reconciliation migrates only sorting and resets conflicts without scanning other projects", (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providers: { a: { modelOrder: ["two", "one"], visibleModels: ["deleted"] } } });
  f.write(f.settings.global, { defaultProvider: "a", defaultModel: "one" });
  f.write(f.settings.project, { defaultProvider: "gone", defaultModel: "deleted" });
  const other = getPiSettingsPaths(join(f.root, "unopened"), f.agent);
  f.write(other.project, { defaultProvider: "gone", defaultModel: "deleted" });
  const otherBefore = readFileSync(other.project, "utf8");
  const result = reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true });
  assert.equal(result.ordering.migrated.length, 1);
  assert.deepEqual(result.visibility.restoredProviders, ["a"]);
  assert.equal(result.defaults.modelDefaultCleared, true);
  assert.equal(readFileSync(other.project, "utf8"), otherBefore);
  assert.deepEqual(reconcileProjectConfiguration(f.preferences, f.settings, catalog, { projectTrusted: true }).ordering, { migrated: [], cleared: [] });
});

test("malformed global preferences cannot discard valid legacy project sorting", (t) => {
  const f = fixture(t);
  f.write(f.preferences.global, { version: 1 });
  f.write(f.preferences.project, { version: 1, providerOrder: ["a", "b"] });
  writeFileSync(f.preferences.global, "invalid global preferences", "utf8");
  const before = readFileSync(f.preferences.project, "utf8");
  assert.throws(() => migrateProjectOrdering(f.preferences, { projectTrusted: true }), /Cannot read pmodel/);
  assert.equal(readFileSync(f.preferences.project, "utf8"), before);
  assert.equal(readFileSync(f.preferences.global, "utf8"), "invalid global preferences");
});

test("project migration write failure preserves the copied global order and can be retried", { skip: process.getuid?.() === 0 }, (t) => {
  const f = fixture(t);
  f.write(f.preferences.project, { version: 1, providerOrder: ["b", "a"] });
  const before = readFileSync(f.preferences.project, "utf8");
  chmodSync(f.preferences.project, 0o400);
  try {
    assert.throws(() => migrateProjectOrdering(f.preferences, { projectTrusted: true }));
    assert.deepEqual(JSON.parse(readFileSync(f.preferences.global, "utf8")).providerOrder, ["b", "a"]);
    assert.equal(readFileSync(f.preferences.project, "utf8"), before);
  } finally {
    chmodSync(f.preferences.project, 0o600);
  }
  const globalBefore = readFileSync(f.preferences.global, "utf8");
  const retry = migrateProjectOrdering(f.preferences, { projectTrusted: true });
  assert.equal(retry.migrated.length, 0);
  assert.equal(retry.cleared.length, 1);
  assert.equal(readFileSync(f.preferences.global, "utf8"), globalBefore);
  assert.deepEqual(JSON.parse(readFileSync(f.preferences.project, "utf8")), { version: 1 });
});

