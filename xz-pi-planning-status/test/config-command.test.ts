import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveXzCommand } from "../src/command.js";
import { getGlobalConfigPath, readGlobalEnabled, writeGlobalEnabled } from "../src/config.js";

test("global setting defaults to enabled and persists changes", () => {
  const home = mkdtempSync(join(tmpdir(), "xz-planning-status-"));
  assert.equal(readGlobalEnabled(home), true);

  writeGlobalEnabled(false, home);
  assert.equal(readGlobalEnabled(home), false);
  writeGlobalEnabled(true, home);
  assert.equal(readGlobalEnabled(home), true);
});

test("malformed global setting falls back to enabled", () => {
  const home = mkdtempSync(join(tmpdir(), "xz-planning-status-invalid-"));
  writeGlobalEnabled(false, home);
  writeFileSync(getGlobalConfigPath(home)!, "not json");
  assert.equal(readGlobalEnabled(home), true);
});

test("/xz command supports toggle and explicit actions", () => {
  assert.deepEqual(resolveXzCommand("", true), { kind: "set", enabled: false });
  assert.deepEqual(resolveXzCommand("ON", false), { kind: "set", enabled: true });
  assert.deepEqual(resolveXzCommand("off", true), { kind: "set", enabled: false });
  assert.deepEqual(resolveXzCommand("status", true), { kind: "status" });
  assert.deepEqual(resolveXzCommand("other", true), { kind: "invalid" });
});
