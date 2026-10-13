import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolFixture, feature } from "./pool-fixture.mjs";
import { registerOwnedAlias } from "../lib/accounts.js";

async function setup(t) {
  const f = createPoolFixture(t, { settings: { defaultProvider: "openai-work", defaultModel: "fixture-model" } });
  f.state.bootTime = Date.now(); f.state.explicitSelection = false;
  for (const [id, { base, suffix }] of Object.entries(f.state.aliases)) registerOwnedAlias(f.pi, f.state, base, f.providers.get(base), id, suffix);
  return f;
}

test("startup intent preserves CLI, reload, restore, fork and existing history", async () => {
  const { resolveStartupIntent } = await feature("startup-policy");
  const ctx = { sessionManager: { getBranch: () => [] } };
  assert.equal(resolveStartupIntent({ event: { reason: "startup" }, ctx, argv: [] }), "default");
  for (const argv of [["--model", "openai/work"], ["--provider", "openai"], ["--resume", "file"], ["--continue"]])
    assert.equal(resolveStartupIntent({ event: { reason: "startup" }, ctx, argv }), "preserve");
  for (const reason of ["reload", "resume", "fork"]) assert.equal(resolveStartupIntent({ event: { reason }, ctx, argv: [] }), "preserve");
  assert.equal(resolveStartupIntent({ event: { reason: "new" }, ctx, argv: [] }), "default");
});

test("physical default prefers trusted project then falls back to global", async t => {
  const f = await setup(t);
  mkdirSync(join(f.dir, ".pi"));
  writeFileSync(join(f.dir, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "openai-personal", defaultModel: "fixture-model" }));
  const { applyStartupPolicy } = await feature("startup-policy");
  await applyStartupPolicy(f.pi, f.dir, f.state, { reason: "startup" }, f.ctx, []);
  assert.equal(f.ctx.model.provider, "openai-personal");
  f.ctx.isProjectTrusted = () => false; f.ctx.model = f.registry.find("openai-personal", "fixture-model");
  await applyStartupPolicy(f.pi, f.dir, f.state, { reason: "new" }, f.ctx, []);
  assert.equal(f.ctx.model.provider, "openai-work");
  assert.ok([...f.virtual.keys()].every(key => !key.startsWith("xz-login-")));
});

test("deleted defaults warn and block input without selecting another provider", async t => {
  const f = await setup(t);
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ defaultProvider: "deleted", defaultModel: "fixture-model" }));
  const { applyStartupPolicy, guardStartupInput } = await feature("startup-policy");
  await applyStartupPolicy(f.pi, f.dir, f.state, { reason: "startup" }, f.ctx, []);
  assert.deepEqual(guardStartupInput(f.state, f.ctx), { action: "handled" });
  assert.equal(f.selected.length, 0);
  assert.ok(f.notices.some(([message, type]) => /Provider deleted has been deleted/.test(message) && type === "warning"));
});

test("explicit CLI selection and reload are never overwritten", async t => {
  const f = await setup(t); f.ctx.model = f.registry.find("openai-personal", "fixture-model");
  const { applyStartupPolicy } = await feature("startup-policy");
  await applyStartupPolicy(f.pi, f.dir, f.state, { reason: "startup" }, f.ctx, ["--model", "openai-personal/fixture-model"]);
  await applyStartupPolicy(f.pi, f.dir, f.state, { reason: "reload" }, f.ctx, []);
  assert.equal(f.selected.length, 0);
});
