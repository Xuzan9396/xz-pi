import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { enabledPackageSources, readEnabledPackageSources } from "../src/package-references.js";

const disabled = (source: string) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });

test("packages are included when either scope is enabled, not only when both are", () => {
  assert.deepEqual(enabledPackageSources([
    "npm:global-only",
    "npm:both",
    "npm:global-on",
    disabled("npm:project-on"),
    disabled("npm:both-off"),
  ], [
    "npm:project-only",
    "npm:both",
    disabled("npm:global-on"),
    "npm:project-on",
    disabled("npm:both-off"),
  ]), ["npm:global-only", "npm:both", "npm:global-on", "npm:project-only", "npm:project-on"]);
});

test("partial resource filters and autoload overrides match package selector state", () => {
  assert.deepEqual(enabledPackageSources([
    { source: "npm:skills-only", extensions: [] },
    { source: "npm:explicit", autoload: false, extensions: ["+index.ts"] },
    { source: "npm:override", autoload: false },
    disabled("npm:off"),
  ], []), ["npm:skills-only", "npm:explicit", "npm:override"]);
});

test("reads separate settings scopes and ignores untrusted project packages", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vim-packages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:global"] }));
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
    packages: [disabled("npm:global"), "npm:project"],
  }));
  assert.deepEqual(readEnabledPackageSources(cwd, true, agentDir), ["npm:global", "npm:project"]);
  assert.deepEqual(readEnabledPackageSources(cwd, false, agentDir), ["npm:global"]);

  // A reload reads newly enabled/disabled packages, rather than a permanent cache.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  assert.deepEqual(readEnabledPackageSources(cwd, true, agentDir), ["npm:project"]);
});
