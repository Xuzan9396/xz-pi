import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutatePoolDocument, poolsPath } from "../lib/pool-store.ts";

const modules = ["pool-contract.ts", "pool-store.ts", "auth-catalog.ts",
  "pool-migration.ts", "startup-policy.ts", "account-removal.ts"];

test("T14: pool persistence and protocol source contain no credential payload or personal-path dependency", async t => {
  const dir = mkdtempSync(join(tmpdir(), "xz-pool-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-work": { type: "oauth", access: "fixture-access-secret", refresh: "fixture-refresh-secret" } }));
  await mutatePoolDocument(dir, draft => {
    draft.preferred.openai = "openai-work";
    draft.cooldowns["openai-work"] = Date.now() + 1000;
    draft.removals["openai-work"] = { operationId: "fixture-operation", base: "openai", suffix: "work", phase: "prepared",
      authHash: "a".repeat(64), aliasHash: "b".repeat(64) };
  });
  const persisted = readFileSync(poolsPath(dir), "utf8");
  assert.doesNotMatch(persisted, /fixture-(?:access|refresh)-secret|"access"|"refresh"|"apiKey"|"key"/);
  for (const name of modules) {
    const source = readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\/Users\/|\.pi\/agent\/auth\.json/);
    for (const [index, line] of source.split("\n").entries()) assert.ok(!/[ \t]+$/.test(line), `${name}:${index + 1} trailing whitespace`);
  }
});

test("T14: changed package sources have no merge markers or trailing whitespace", () => {
  const urls = [
    new URL("../../xz-pi-pmodel/src/auth-providers.ts", import.meta.url),
    new URL("../../xz-pi-usage/index.ts", import.meta.url),
    new URL("../README.md", import.meta.url), new URL("../ARCHITECTURE.md", import.meta.url),
  ];
  for (const url of urls) {
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(source, /^(?:<<<<<<<|=======|>>>>>>>) /m);
    for (const [index, line] of source.split("\n").entries()) assert.ok(!/[ \t]+$/.test(line), `${url.pathname}:${index + 1} trailing whitespace`);
  }
});
