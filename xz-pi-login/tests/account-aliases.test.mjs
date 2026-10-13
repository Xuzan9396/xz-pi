import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  addAlias, aliasesPath, createAliasId, listAliases, loadAliases,
  normalizeSuffix, removeAlias,
} from "../lib/account-aliases.js";

function fixture() {
  return mkdtempSync(join(tmpdir(), "xz-pi-login-aliases-"));
}

function runChild(dir, base, suffix) {
  const moduleUrl = new URL("../lib/account-aliases.js", import.meta.url).href;
  const source = `import { addAlias } from ${JSON.stringify(moduleUrl)}; await addAlias(${JSON.stringify(dir)}, ${JSON.stringify(base)}, ${JSON.stringify(suffix)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

describe("account alias storage", () => {
  it("normalizes safe suffixes and rejects unsafe command text", () => {
    assert.equal(normalizeSuffix(" Work_1 "), "work_1");
    assert.equal(normalizeSuffix("team-prod"), "team-prod");
    for (const value of ["", "-work", "中文", "work space", "x".repeat(33), "work;rm"]) assert.equal(normalizeSuffix(value), null);
    assert.equal(createAliasId("openai", "work"), "openai-work");
  });

  it("round-trips aliases with atomic, private storage", async () => {
    const dir = fixture();
    await addAlias(dir, "openai", "work");
    await addAlias(dir, "anthropic", "team");
    assert.deepEqual(loadAliases(dir), {
      "openai-work": { base: "openai", suffix: "work" },
      "anthropic-team": { base: "anthropic", suffix: "team" },
    });
    await removeAlias(dir, "openai-work");
    assert.deepEqual(listAliases(dir), [{ id: "anthropic-team", base: "anthropic", suffix: "team" }]);
    const path = aliasesPath(dir);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
    assert.deepEqual(readdirSync(join(dir, "config", "xz-pi-login")), ["accounts.json"]);
  });

  it("rejects duplicate ids inside the lock", async () => {
    const dir = fixture();
    await addAlias(dir, "openai", "work");
    await assert.rejects(() => addAlias(dir, "openai", "work"), /alias_exists/);
    assert.deepEqual(Object.keys(loadAliases(dir)), ["openai-work"]);
  });

  it("preserves concurrent additions from separate processes", async () => {
    const dir = fixture();
    await Promise.all([runChild(dir, "openai", "work"), runChild(dir, "openai", "personal")]);
    assert.deepEqual(Object.keys(loadAliases(dir)).sort(), ["openai-personal", "openai-work"]);
  });
});
