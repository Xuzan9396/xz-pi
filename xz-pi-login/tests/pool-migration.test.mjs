import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolFixture, feature } from "./pool-fixture.mjs";
import { registerOwnedAlias } from "../lib/accounts.js";
import { mutatePoolDocument } from "../lib/pool-store.ts";

const json = path => JSON.parse(readFileSync(path, "utf8"));
async function setup(t) {
  const f = createPoolFixture(t, { settings: { defaultProvider: "xz-login-openai", defaultModel: "fixture-model",
    enabledModels: ["xz-login-openai/fixture-model:high", "unknown/model", "openai-*/future*"] } });
  for (const [id, { base, suffix }] of Object.entries(f.state.aliases)) registerOwnedAlias(f.pi, f.state, base, f.providers.get(base), id, suffix);
  await mutatePoolDocument(f.dir, draft => { draft.preferred.openai = "openai-work"; });
  return f;
}

test("physical default migration restores logical settings and exact scopes to the preferred auth provider", async t => {
  const f = await setup(t);
  const authBefore = readFileSync(join(f.dir, "auth.json"), "utf8");
  const { applyPoolMigration } = await feature("pool-migration");
  const result = await applyPoolMigration(f.dir, f.state, f.ctx);
  assert.equal(result.changed, true);
  assert.deepEqual(json(join(f.dir, "settings.json")), { defaultProvider: "openai-work", defaultModel: "fixture-model",
    enabledModels: ["openai-work/fixture-model:high", "unknown/model", "openai-*/future*"] });
  assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), authBefore);
});

test("physical default migration falls back in auth order when the preferred account lacks the model", async t => {
  const f = await setup(t);
  f.registry.getAvailable = () => [f.registry.find("openai-personal", "fixture-model")];
  const { applyPoolMigration } = await feature("pool-migration");
  await applyPoolMigration(f.dir, f.state, f.ctx);
  assert.equal(json(join(f.dir, "settings.json")).defaultProvider, "openai-personal");
});

test("physical migration updates the current trusted project but never scans another project", async t => {
  const f = await setup(t);
  mkdirSync(join(f.dir, ".pi"));
  writeFileSync(join(f.dir, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "xz-login-openai", defaultModel: "fixture-model" }));
  const other = join(f.dir, "other", ".pi"); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "settings.json"), JSON.stringify({ defaultProvider: "xz-login-openai", defaultModel: "fixture-model" }));
  const { applyPoolMigration } = await feature("pool-migration");
  await applyPoolMigration(f.dir, f.state, f.ctx);
  assert.equal(json(join(f.dir, ".pi", "settings.json")).defaultProvider, "openai-work");
  assert.equal(json(join(other, "settings.json")).defaultProvider, "xz-login-openai");
});
