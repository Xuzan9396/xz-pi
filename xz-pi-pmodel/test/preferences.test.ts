import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearProjectOverride,
  getPreferencePaths,
  readPreferenceLayers,
  resolvePreferences,
  writePreferenceOverride,
} from "../src/preferences.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-preferences-"));
  return getPreferencePaths(join(root, "project"), join(root, "agent"));
}

test("project fields override global fields independently", () => {
  const paths = fixture();
  writePreferenceOverride(paths, "global", { field: "providerOrder", value: ["copilot", "anthropic"] });
  writePreferenceOverride(paths, "global", { field: "modelOrder", provider: "anthropic", value: ["opus", "retired"] });
  writePreferenceOverride(paths, "global", { field: "visibleModels", provider: "anthropic", value: ["opus"] });
  writePreferenceOverride(paths, "project", { field: "visibleModels", provider: "anthropic", value: ["sonnet"] });

  const layers = readPreferenceLayers(paths);
  const resolved = resolvePreferences(layers.global, layers.project);
  assert.deepEqual(resolved.providerOrder, ["copilot", "anthropic"]);
  assert.equal(resolved.sources.providerOrder, "global");
  assert.deepEqual(resolved.providers.anthropic?.modelOrder, ["opus", "retired"]);
  assert.equal(resolved.providers.anthropic?.sources.modelOrder, "global");
  assert.deepEqual(resolved.providers.anthropic?.visibleModels, ["sonnet"]);
  assert.equal(resolved.providers.anthropic?.sources.visibleModels, "project");
});

test("clearing a project override restores global inheritance", () => {
  const paths = fixture();
  writePreferenceOverride(paths, "global", { field: "visibleModels", provider: "anthropic", value: ["opus"] });
  writePreferenceOverride(paths, "project", { field: "visibleModels", provider: "anthropic", value: ["sonnet"] });
  clearProjectOverride(paths, { field: "visibleModels", provider: "anthropic" });

  const layers = readPreferenceLayers(paths);
  const resolved = resolvePreferences(layers.global, layers.project);
  assert.deepEqual(resolved.providers.anthropic?.visibleModels, ["opus"]);
  assert.equal(resolved.providers.anthropic?.sources.visibleModels, "global");
  assert.deepEqual(JSON.parse(readFileSync(paths.project, "utf8")), { version: 1 });
});

test("configured unavailable ids and explicit empty allowlists are preserved", () => {
  const paths = fixture();
  writePreferenceOverride(paths, "global", {
    field: "modelOrder",
    provider: "offline",
    value: ["missing", "missing", "future"],
  });
  writePreferenceOverride(paths, "global", { field: "visibleModels", provider: "offline", value: [] });
  const layers = readPreferenceLayers(paths);
  assert.deepEqual(layers.global.providers?.offline?.modelOrder, ["missing", "future"]);
  assert.deepEqual(layers.global.providers?.offline?.visibleModels, []);
});

test("malformed preferences are rejected instead of overwritten", () => {
  const paths = fixture();
  writePreferenceOverride(paths, "global", { field: "providerOrder", value: ["anthropic"] });
  writeFileSync(paths.global, "not json", "utf8");
  assert.throws(
    () => writePreferenceOverride(paths, "global", { field: "providerOrder", value: ["copilot"] }),
    /Cannot read pmodel preferences/,
  );
});
