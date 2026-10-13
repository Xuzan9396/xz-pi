import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TTL_MS,
  normalizeConfig,
  configPath,
  loadConfig,
  saveConfig,
} from "../lib/config.js";

describe("config", () => {
  it("defaults to enabled passive observation", () => {
    const expected = {
      enabled: true, cooldownMs: DEFAULT_COOLDOWN_MS, ttlMs: DEFAULT_TTL_MS,
      ttlByFamily: {}, debugLog: true,
    };
    for (const raw of [null, undefined, 42, "nope"]) assert.deepEqual(normalizeConfig(raw), expected);
    assert.equal(normalizeConfig({ fastMode: true }).fastMode, undefined, "retired preferences are ignored");
  });

  it("ignores every legacy strategy without offering a routing default", () => {
    for (const strategy of ["failover", "round-robin", "balanced", "random"]) {
      assert.equal(Object.hasOwn(normalizeConfig({ strategy }), "strategy"), false);
    }
  });

  it("keeps sane windows and flags", () => {
    assert.equal(normalizeConfig({ cooldownMs: 60000 }).cooldownMs, 60000);
    assert.equal(normalizeConfig({ cooldownMs: -5 }).cooldownMs, DEFAULT_COOLDOWN_MS);
    assert.equal(normalizeConfig({ ttlMs: 60000 }).ttlMs, 60000);
    assert.equal(normalizeConfig({ ttlMs: 0 }).ttlMs, DEFAULT_TTL_MS);
    assert.equal(normalizeConfig({ enabled: false }).enabled, false);
    assert.equal(normalizeConfig({ debugLog: false }).debugLog, false);
  });

  it("normalizes per-family TTL overrides", () => {
    assert.deepEqual(
      normalizeConfig({ ttlByFamily: { "openai-codex": 600000 } }).ttlByFamily,
      { "openai-codex": 600000 },
    );
    assert.deepEqual(
      normalizeConfig({ ttlByFamily: { "openai-codex": -5, "": 1000 } }).ttlByFamily,
      {},
    );
    assert.deepEqual(normalizeConfig({ ttlByFamily: "nope" }).ttlByFamily, {});
  });

  it("rejects array TTL maps instead of indexing them as families", () => {
    // Arrays are objects: without the shape check, ["0"] becomes a family.
    assert.deepEqual(normalizeConfig({ ttlByFamily: [600000] }).ttlByFamily, {});
    assert.deepEqual(normalizeConfig({ ttlByFamily: [] }).ttlByFamily, {});
  });

  it("floors fractional windows and disables only on exact false", () => {
    assert.equal(normalizeConfig({ cooldownMs: 60000.9 }).cooldownMs, 60000);
    assert.equal(normalizeConfig({ enabled: 0 }).enabled, true);
    assert.equal(normalizeConfig({ enabled: "" }).enabled, true);
    assert.equal(normalizeConfig({ debugLog: 0 }).debugLog, true);
  });

  it("rejects sub-millisecond windows instead of normalizing them to zero", () => {
    const config = normalizeConfig({ cooldownMs: 0.5, ttlMs: 0.5, ttlByFamily: { cursor: 0.5, anthropic: 1.9 } });

    assert.equal(config.cooldownMs, DEFAULT_COOLDOWN_MS);
    assert.equal(config.ttlMs, DEFAULT_TTL_MS);
    assert.deepEqual(config.ttlByFamily, { anthropic: 1 });
  });

  it("ignores retired switch announcements regardless of their value", () => {
    for (const announceSwitches of [true, false, "yes", 1]) {
      assert.equal(Object.hasOwn(normalizeConfig({ announceSwitches }), "announceSwitches"), false);
    }
  });
});

it("T4 retired automatic preferences are ignored without migrating configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "xz-login-retired-config-"));
  try {
    mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
    for (const strategy of ["balanced", "failover", "round-robin"]) {
      const original = JSON.stringify({ strategy, announceSwitches: true, enabled: true, debugLog: false,
        showUsage: false, ttlMs: 12345, cooldownMs: 67890, userExtension: { retained: true } }, null, 2);
      writeFileSync(configPath(dir), original);
      const config = loadConfig(dir);
      assert.equal(Object.hasOwn(config, "strategy"), false);
      assert.equal(Object.hasOwn(config, "announceSwitches"), false);
      assert.equal(config.enabled, true);
      assert.equal(config.debugLog, false);
      assert.equal(config.ttlMs, 12345);
      assert.equal(config.cooldownMs, 67890);
      assert.equal(readFileSync(configPath(dir), "utf8"), original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("round-trips reserved JSON family names with atomic writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rotator-config-keys-"));
  const ttlByFamily = JSON.parse('{"constructor":1234.9,"__proto__":2345.8,"toString":3456.7,"openai-codex":4567.6}');
  const expected = Object.fromEntries(Object.entries(ttlByFamily).map(([name, ms]) => [name, Math.floor(ms)]));
  saveConfig(dir, { ttlByFamily });
  assert.deepEqual(loadConfig(dir).ttlByFamily, expected, "saving one valid family must not erase other TTL overrides");
  saveConfig(dir, { ...loadConfig(dir), debugLog: false, strategy: "failover" });
  const saved = JSON.parse(readFileSync(configPath(dir), "utf8"));
  assert.equal(saved.debugLog, false);
  assert.equal(Object.hasOwn(saved, "strategy"), false);
  assert.deepEqual(loadConfig(dir).ttlByFamily, expected);
  assert.deepEqual(readdirSync(join(dir, "config", "xz-pi-login")), ["config.json"], "atomic writes leave no temp droppings");
});
