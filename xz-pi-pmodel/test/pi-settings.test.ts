import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import {
  clearProjectModelDefault,
  getPiSettingsPaths,
  readPiSettingsLayers,
  resolveModelDefault,
  setModelDefault,
} from "../src/pi-settings.js";

import * as defaultsApi from "../src/pi-settings.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-pi-settings-"));
  return getPiSettingsPaths(join(root, "project"), join(root, "agent"));
}

test("project model default overrides global and can return to inheritance", () => {
  const paths = fixture();
  setModelDefault(paths, "global", "anthropic", "sonnet");
  setModelDefault(paths, "project", "copilot", "gpt", { projectTrusted: true });

  let layers = readPiSettingsLayers(paths);
  assert.deepEqual(resolveModelDefault(layers.global, layers.project), {
    provider: "copilot", id: "gpt", source: "project",
  });

  clearProjectModelDefault(paths, { projectTrusted: true });
  layers = readPiSettingsLayers(paths);
  assert.deepEqual(resolveModelDefault(layers.global, layers.project), {
    provider: "anthropic", id: "sonnet", source: "global",
  });
});

test("native thinking fields are opaque and preserved by model default updates", () => {
  const paths = fixture();
  setModelDefault(paths, "global", "a", "one");
  setModelDefault(paths, "project", "b", "two", { projectTrusted: true });
  const raw = { defaultThinkingLevel: "future-level", modelThinkingLevels: { "a/one": "future-level" }, custom: true };
  writeFileSync(paths.global, JSON.stringify(raw));
  writeFileSync(paths.project, JSON.stringify(raw));
  setModelDefault(paths, "global", "a", "three");
  clearProjectModelDefault(paths, { projectTrusted: true });
  const layers = readPiSettingsLayers(paths);
  assert.equal(layers.global.defaultThinkingLevel, "future-level");
  assert.deepEqual(layers.global.modelThinkingLevels, raw.modelThinkingLevels);
  assert.deepEqual(layers.project, raw);
});

test("settings patches preserve unknown fields and require project trust", () => {
  const paths = fixture();
  setModelDefault(paths, "global", "anthropic", "sonnet");
  const global = JSON.parse(readFileSync(paths.global, "utf8"));
  global.packages = ["npm:xz-pi-pmodel"];
  writeFileSync(paths.global, JSON.stringify(global), "utf8");
  setModelDefault(paths, "global", "anthropic", "opus");
  assert.deepEqual(JSON.parse(readFileSync(paths.global, "utf8")).packages, ["npm:xz-pi-pmodel"]);

  assert.throws(
    () => setModelDefault(paths, "project", "copilot", "gpt"),
    /project trust/,
  );
});

test("v5.1 defaults keep global and project independent and toggle only their own fields", async () => {
  const api = defaultsApi;
  assert.equal(typeof api.resolveModelDefaultState, "function");
  assert.equal(typeof api.toggleModelDefault, "function");
  const paths = fixture();
  setModelDefault(paths, "global", "a", "one");
  setModelDefault(paths, "project", "b", "two", { projectTrusted: true });
  const global = JSON.parse(readFileSync(paths.global, "utf8"));
  global.modelThinkingLevels = { "a/one": "high" };
  global.custom = { keep: true };
  writeFileSync(paths.global, JSON.stringify(global));
  let state = api.resolveModelDefaultState(global, readPiSettingsLayers(paths).project);
  assert.deepEqual(state.global, { provider: "a", id: "one" });
  assert.deepEqual(state.project, { provider: "b", id: "two" });
  assert.equal(state.effective?.source, "project");
  const projectBefore = readFileSync(paths.project, "utf8");
  const saved = await api.toggleModelDefault(paths, "global", { provider: "a", id: "one" });
  assert.equal(saved.changed, false);
  assert.equal(readFileSync(paths.project, "utf8"), projectBefore);
  await api.toggleModelDefault(paths, "global", { provider: "a", id: "three" });
  assert.equal(readFileSync(paths.project, "utf8"), projectBefore);
  assert.deepEqual(JSON.parse(readFileSync(paths.global, "utf8")).modelThinkingLevels, global.modelThinkingLevels);
  assert.deepEqual(JSON.parse(readFileSync(paths.global, "utf8")).custom, global.custom);
  await api.toggleModelDefault(paths, "project", { provider: "b", id: "two" }, { projectTrusted: true });
  state = api.resolveModelDefaultState(...(() => {
    const layers = readPiSettingsLayers(paths);
    return [layers.global, layers.project] as const;
  })());
  assert.equal(state.project, undefined);
  assert.deepEqual(state.effective, { provider: "a", id: "three", source: "global" });
  await assert.rejects(api.toggleModelDefault(paths, "project", { provider: "b", id: "two" }), /trust/);
});

test("v5.1 defaults match native merged settings after global replacement and project cancellation", async () => {
  const paths = fixture();
  setModelDefault(paths, "global", "a", "one");
  setModelDefault(paths, "project", "b", "two", { projectTrusted: true });
  const native = () => SettingsManager.create(dirname(dirname(paths.project)), dirname(paths.global), { projectTrusted: true });
  assert.equal(native().getDefaultProvider(), "b");
  assert.equal(native().getDefaultModel(), "two");
  await defaultsApi.toggleModelDefault(paths, "global", { provider: "a", id: "three" }, { projectTrusted: true });
  assert.equal(native().getDefaultModel(), "two");
  await defaultsApi.toggleModelDefault(paths, "project", { provider: "b", id: "two" }, { projectTrusted: true });
  assert.equal(native().getDefaultProvider(), "a");
  assert.equal(native().getDefaultModel(), "three");
});

test("malformed Pi settings are rejected rather than replaced", () => {
  const paths = fixture();
  setModelDefault(paths, "global", "anthropic", "sonnet");
  writeFileSync(paths.global, "not json", "utf8");
  assert.throws(() => setModelDefault(paths, "global", "copilot", "gpt"), /Cannot read Pi settings/);
});
