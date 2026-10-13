import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolFixture, feature } from "./pool-fixture.mjs";
import { registerOwnedAlias } from "../lib/accounts.js";
import { loadAliases } from "../lib/account-aliases.js";
import { readPoolDocument } from "../lib/pool-store.ts";

async function setup(t) {
  const f = createPoolFixture(t, { settings: { defaultProvider: "openai-work", defaultModel: "fixture-model",
    enabledModels: ["openai-work/fixture-model", "openai-personal/fixture-model", "external/model"] } });
  writeFileSync(join(f.dir, "models.json"), JSON.stringify({ providers: {
    openai: { name: "base" }, "openai-work": { name: "work", modelOverrides: { fixture: { name: "Work" } } },
    "openai-personal": { name: "personal" },
  }, keep: true }));
  writeFileSync(join(f.dir, "xz-pi-pmodel.json"), JSON.stringify({ version: 1,
    providerOrder: ["openai-work", "openai-personal"], providers: { "openai-work": { visibleModels: ["fixture-model"] }, "openai-personal": {} } }));
  for (const [id, { base, suffix }] of Object.entries(f.state.aliases)) registerOwnedAlias(f.pi, f.state, base, f.providers.get(base), id, suffix);
  f.ctx.modelRegistry.getModelRuntime = () => ({ logout: async (id) => {
    const auth = f.ownAuth(); delete auth[id]; writeFileSync(join(f.dir, "auth.json"), JSON.stringify(auth));
  } });
  return f;
}
const json = path => JSON.parse(readFileSync(path, "utf8"));

test("T8: deletion removes exactly one credential/provider/alias/reference and keeps base and sibling", async t => {
  const f = await setup(t);
  const { removeManagedAccount } = await feature("account-removal");
  const result = await removeManagedAccount(f.pi, f.dir, f.state, "openai-work", f.ctx);
  assert.equal(result.complete, true);
  assert.equal(Object.hasOwn(f.ownAuth(), "openai-work"), false);
  assert.equal(Object.hasOwn(f.ownAuth(), "openai-personal"), true);
  const models = json(join(f.dir, "models.json"));
  assert.equal(Object.hasOwn(models.providers, "openai-work"), false);
  assert.deepEqual(models.providers.openai, { name: "base" });
  assert.deepEqual(models.providers["openai-personal"], { name: "personal" });
  assert.equal(loadAliases(f.dir)["openai-work"], undefined);
  assert.ok(loadAliases(f.dir)["openai-personal"]);
  const settings = json(join(f.dir, "settings.json"));
  assert.deepEqual(settings.enabledModels, ["openai-personal/fixture-model", "external/model"]);
  assert.equal(settings.defaultProvider, undefined);
  assert.equal(settings.defaultModel, undefined);
  const prefs = json(join(f.dir, "xz-pi-pmodel.json"));
  assert.deepEqual(prefs.providerOrder, ["openai-personal"]);
  assert.equal(prefs.providers["openai-work"], undefined);
  assert.ok(f.providers.has("openai"));
  assert.ok(f.providers.has("openai-personal"));
  assert.equal(f.providers.has("openai-work"), false);
  assert.equal(readPoolDocument(f.dir).removals["openai-work"], undefined);
});

test("T8: active direct account is removed without automatic switching; busy account is postponed", async t => {
  const f = await setup(t);
  const { removeManagedAccount } = await feature("account-removal");
  f.ctx.model = f.registry.find("openai-work", "fixture-model");
  await removeManagedAccount(f.pi, f.dir, f.state, "openai-work", f.ctx);
  assert.deepEqual(f.selected, []);
  assert.ok(f.notices.some(([message, type]) => /Provider openai-work has been deleted/.test(message) && type === "warning"));

  const second = await setup(t);
  second.ctx.model = second.registry.find("openai-work", "fixture-model");
  second.ctx.isIdle = () => false;
  await assert.rejects(removeManagedAccount(second.pi, second.dir, second.state, "openai-work", second.ctx), /working.*postponed/i);
  assert.ok(second.ownAuth()["openai-work"]);
  assert.ok(loadAliases(second.dir)["openai-work"]);
  assert.equal(readPoolDocument(second.dir).removals["openai-work"], undefined);
});

test("T8: credential-first interruption resumes forward without restoring the token", async t => {
  const f = await setup(t);
  const { removeManagedAccount, resumeAccountRemoval } = await feature("account-removal");
  const path = join(f.dir, "models.json");
  f.ctx.modelRegistry.getModelRuntime = () => ({ logout: async id => {
    const auth = f.ownAuth(); delete auth[id]; writeFileSync(join(f.dir, "auth.json"), JSON.stringify(auth));
    writeFileSync(path, "invalid-after-logout");
    throw new Error("fixture refresh failure");
  } });
  await assert.rejects(removeManagedAccount(f.pi, f.dir, f.state, "openai-work", f.ctx), /models/i);
  assert.equal(Object.hasOwn(f.ownAuth(), "openai-work"), false);
  assert.ok(loadAliases(f.dir)["openai-work"]);
  assert.equal(readPoolDocument(f.dir).removals["openai-work"].phase, "credential-removed");
  writeFileSync(path, JSON.stringify({ providers: { openai: { name: "base" }, "openai-work": { name: "work", modelOverrides: { fixture: { name: "Work" } } }, "openai-personal": { name: "personal" } } }));
  await resumeAccountRemoval(f.pi, f.dir, f.state, "openai-work", f.ctx);
  assert.equal(Object.hasOwn(f.ownAuth(), "openai-work"), false);
  assert.equal(loadAliases(f.dir)["openai-work"], undefined);
  assert.equal(readPoolDocument(f.dir).removals["openai-work"], undefined);
});

test("T8: concurrent target Provider changes are retained instead of deleting an unconfirmed value", async t => {
  const f = await setup(t);
  const { beginAccountRemoval, resumeAccountRemoval } = await feature("account-removal");
  await beginAccountRemoval(f.dir, f.state, "openai-work");
  const models = json(join(f.dir, "models.json"));
  models.providers["openai-work"].baseUrl = "https://changed.invalid";
  writeFileSync(join(f.dir, "models.json"), JSON.stringify(models));
  await assert.rejects(resumeAccountRemoval(f.pi, f.dir, f.state, "openai-work", f.ctx), /changed concurrently/);
  assert.ok(json(join(f.dir, "models.json")).providers["openai-work"]);
});

test("T8: deleting the final account leaves no logical model or automatic replacement", async t => {
  const f = await setup(t);
  const { removeManagedAccount } = await feature("account-removal");
  await removeManagedAccount(f.pi, f.dir, f.state, "openai-work", f.ctx);
  await removeManagedAccount(f.pi, f.dir, f.state, "openai-personal", f.ctx);
  assert.equal(f.ctx.model.provider, "openai");
  assert.deepEqual([...f.virtual.keys()], []);
  assert.equal(json(join(f.dir, "settings.json")).defaultProvider, undefined);
});
