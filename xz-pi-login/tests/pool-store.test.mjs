import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function feature(name) {
  const url = new URL(`../lib/${name}.ts`, import.meta.url);
  assert.ok(existsSync(url), `v10 feature missing: ${name}`);
  return import(url.href);
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "xz-pool-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("T1: legacy pool identities are parsed only for reverse migration", async () => {
  const { poolBase } = await feature("pool-contract");
  assert.equal(poolBase("xz-login-openai-codex"), "openai-codex");
  assert.equal(poolBase("openai-work"), undefined);
});

test("T1: private atomic mutations retain concurrent updates without copying auth", async t => {
  const { readPoolDocument, mutatePoolDocument, poolsPath } = await feature("pool-store");
  const dir = directory(t);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-only-secret" } }));
  const original = readFileSync(join(dir, "auth.json"), "utf8");
  assert.equal(existsSync(poolsPath(dir)), false);
  assert.equal(readPoolDocument(dir).version, 1);
  assert.equal(existsSync(poolsPath(dir)), false, "reading must not create storage");
  await Promise.all(Array.from({ length: 8 }, (_, i) => mutatePoolDocument(dir, draft => {
    draft.preferred[`vendor-${i}`] = `vendor-${i}-work`;
  })));
  const value = readPoolDocument(dir);
  assert.equal(Object.keys(value.preferred).length, 8);
  assert.equal(value.revision, 8);
  assert.equal(statSync(poolsPath(dir)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), original);
  assert.doesNotMatch(readFileSync(poolsPath(dir), "utf8"), /fixture-only-secret|api_key|access|refresh/);
});

test("T1: malformed or secret-bearing metadata is rejected without overwrite", async t => {
  const { readPoolDocument, mutatePoolDocument, poolsPath } = await feature("pool-store");
  const dir = directory(t);
  await mutatePoolDocument(dir, draft => { draft.preferred.openai = "openai-work"; });
  const before = readFileSync(poolsPath(dir), "utf8");
  await assert.rejects(mutatePoolDocument(dir, draft => { draft.access = "fixture-only-secret"; }), /Invalid pool/);
  assert.equal(readFileSync(poolsPath(dir), "utf8"), before);
  writeFileSync(poolsPath(dir), '{"version":99}');
  assert.throws(() => readPoolDocument(dir), /Invalid pool/);
  await assert.rejects(mutatePoolDocument(dir, draft => { draft.preferred.openai = "new"; }), /Invalid pool/);
  assert.equal(readFileSync(poolsPath(dir), "utf8"), '{"version":99}');
});
