import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { getPiSettingsPaths } from "../src/pi-settings.js";
import { cleanupGlobalScopedModels } from "../src/scoped-models.js";

function model(provider: string, id: string): Model<any> {
  return { provider, id, name: id } as Model<any>;
}
const catalog = [model("a", "sonnet"), model("b", "gpt")];

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = getPiSettingsPaths(join(root, "project"), join(root, "agent"));
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), "utf8");
  };
  return { root, paths, write };
}

test("cleanup removes the reported deleted models from global enabledModels only", async (t) => {
  const f = fixture(t);
  const deleted = ["guomopojia/gpt-5.6-sol", "guomopojia/codex-mini-latest"];
  const initial = {
    enabledModels: ["a/sonnet", deleted[0], "guomopojia/gpt-5.5:high", deleted[1]],
    defaultProvider: "guomopojia", defaultModel: "gpt-5.6-sol", defaultThinkingLevel: "high",
    modelThinkingLevels: { "guomopojia/gpt-5.6-sol": "xhigh" }, packages: ["npm:xz-pi-pmodel"],
    custom: { untouched: true },
  };
  f.write(f.paths.global, initial);
  f.write(f.paths.project, { enabledModels: deleted, defaultProvider: "project", defaultModel: "keep" });
  const preferencesPath = join(dirname(f.paths.global), "xz-pi-pmodel.json");
  f.write(preferencesPath, { version: 1, providers: { guomopojia: { visibleModels: ["gpt-5.6-sol"] } } });
  const projectBefore = readFileSync(f.paths.project, "utf8");
  const preferencesBefore = readFileSync(preferencesPath, "utf8");
  const result = await cleanupGlobalScopedModels(f.paths, [...catalog, model("guomopojia", "gpt-5.5")]);
  assert.deepEqual(result, { removedPatterns: deleted });
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")), {
    ...initial, enabledModels: ["a/sonnet", "guomopojia/gpt-5.5:high"],
  });
  assert.equal(readFileSync(f.paths.project, "utf8"), projectBefore);
  assert.equal(readFileSync(preferencesPath, "utf8"), preferencesBefore);
});

test("complete catalog models are retained even when their provider lacks authentication", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["offline/large:high", "deleted/model", "a/sonnet"] });
  const result = await cleanupGlobalScopedModels(f.paths, [...catalog, model("offline", "large")]);
  assert.deepEqual(result.removedPatterns, ["deleted/model"]);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")).enabledModels, ["offline/large:high", "a/sonnet"]);
});

test("cleanup preserves unmatched globs, braces, extglobs, bare aliases and incomplete references", async (t) => {
  const f = fixture(t);
  const enabledModels = [
    "future/*:high", "future/[ab]", "future/g?t", "future/{a,b}", "future/+(a|b)",
    "future/@(a|b)", "future/!(a|b)", "*sonnet*", "future-bare-alias", "/bare", "provider/ ",
  ];
  f.write(f.paths.global, { enabledModels });
  const before = readFileSync(f.paths.global, "utf8");
  assert.deepEqual(await cleanupGlobalScopedModels(f.paths, catalog), { removedPatterns: [] });
  assert.equal(readFileSync(f.paths.global, "utf8"), before);
});

test("case-insensitive references, literal slash/colon IDs and thinking suffixes remain valid", async (t) => {
  const f = fixture(t);
  const enabledModels = [
    " A / SONNET ", "a/sonnet:bad:high", "router/org/model:high",
    "org/model:high", "router/org/model:high:low", "router/org/deleted:exacto:high",
  ];
  f.write(f.paths.global, { enabledModels });
  const result = await cleanupGlobalScopedModels(f.paths, [...catalog, model("router", "org/model:high")]);
  assert.deepEqual(result.removedPatterns, ["router/org/deleted:exacto:high"]);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")).enabledModels, enabledModels.slice(0, -1));
});

test("empty or failed catalogs skip cleanup without treating a failed load as deletion", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["deleted/model"] });
  const before = readFileSync(f.paths.global, "utf8");
  const empty = await cleanupGlobalScopedModels(f.paths, []);
  const failed = await cleanupGlobalScopedModels(f.paths, catalog, { catalogError: "Cannot load models.json" });
  assert.deepEqual(empty.removedPatterns, []);
  assert.match(empty.skippedReason ?? "", /catalog is empty/);
  assert.deepEqual(failed.removedPatterns, []);
  assert.match(failed.skippedReason ?? "", /catalog has errors/);
  assert.equal(readFileSync(f.paths.global, "utf8"), before);
});

test("removing all stale references clears only enabledModels and does not read malformed project settings", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["deleted/one", "deleted/two:high"], defaultModel: "keep", custom: null });
  f.write(f.paths.project, {});
  writeFileSync(f.paths.project, "not JSON", "utf8");
  assert.deepEqual((await cleanupGlobalScopedModels(f.paths, catalog)).removedPatterns, ["deleted/one", "deleted/two:high"]);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.global, "utf8")), { defaultModel: "keep", custom: null });
  assert.equal(readFileSync(f.paths.project, "utf8"), "not JSON");
});

test("cleanup is idempotent and repeated calls preserve the already-cleaned file", async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/sonnet", "deleted/model"], custom: 1 });
  await cleanupGlobalScopedModels(f.paths, catalog);
  const before = readFileSync(f.paths.global, "utf8");
  assert.deepEqual(await cleanupGlobalScopedModels(f.paths, catalog), { removedPatterns: [] });
  assert.equal(readFileSync(f.paths.global, "utf8"), before);
});

test("unset, empty and valid-only scopes are not rewritten or unnecessarily created", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await cleanupGlobalScopedModels(f.paths, catalog), { removedPatterns: [] });
  assert.equal(existsSync(f.paths.global), false);
  for (const enabledModels of [undefined, [], ["a/sonnet"]]) {
    f.write(f.paths.global, { ...(enabledModels ? { enabledModels } : {}), custom: true });
    const before = readFileSync(f.paths.global, "utf8");
    assert.deepEqual(await cleanupGlobalScopedModels(f.paths, catalog), { removedPatterns: [] });
    assert.equal(readFileSync(f.paths.global, "utf8"), before);
  }
});

test("malformed JSON and malformed enabledModels are not overwritten", async (t) => {
  const f = fixture(t);
  for (const enabledModels of [null, ["a/sonnet", 42]]) {
    f.write(f.paths.global, { enabledModels });
    const before = readFileSync(f.paths.global, "utf8");
    await assert.rejects(cleanupGlobalScopedModels(f.paths, catalog), /enabledModels/);
    assert.equal(readFileSync(f.paths.global, "utf8"), before);
  }
  writeFileSync(f.paths.global, "invalid JSON", "utf8");
  await assert.rejects(cleanupGlobalScopedModels(f.paths, catalog), /Cannot read Pi settings/);
  assert.equal(readFileSync(f.paths.global, "utf8"), "invalid JSON");
});

test("cleanup write failures propagate without claiming removed references were persisted", { skip: process.getuid?.() === 0 }, async (t) => {
  const f = fixture(t);
  f.write(f.paths.global, { enabledModels: ["a/sonnet", "deleted/model"] });
  const before = readFileSync(f.paths.global, "utf8");
  chmodSync(f.paths.global, 0o400);
  try {
    await assert.rejects(cleanupGlobalScopedModels(f.paths, catalog));
    assert.equal(readFileSync(f.paths.global, "utf8"), before);
  } finally {
    chmodSync(f.paths.global, 0o600);
  }
});
