import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { feature } from "./pool-fixture.mjs";

test("auth catalog reads provider keys in auth.json order without exposing credential values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xz-auth-catalog-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-work": { type: "oauth", access: "secret" }, copilot: { type: "oauth" } }));
  const { readAuthProviderIds } = await feature("auth-catalog");
  assert.deepEqual(readAuthProviderIds(dir), ["openai-work", "copilot"]);
});

test("auth catalog restores a legacy pool reference to preferred then auth-order account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xz-auth-catalog-"));
  mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-personal": {}, "openai-work": {} }));
  writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({ version: 1, accounts: {
    "openai-personal": { base: "openai", suffix: "personal" }, "openai-work": { base: "openai", suffix: "work" },
  } }));
  writeFileSync(join(dir, "config", "xz-pi-login", "pools.json"), JSON.stringify({ version: 1, revision: 0,
    preferred: { openai: "openai-work" }, catalog: {}, cooldowns: {}, removals: {} }));
  const api = await feature("auth-catalog");
  const models = [{ provider: "openai-personal", id: "gpt" }, { provider: "openai-work", id: "gpt" }];
  assert.deepEqual(api.resolveLegacyPoolReference(dir, "xz-login-openai", "gpt", models), { provider: "openai-work", id: "gpt" });
  models.pop();
  assert.deepEqual(api.resolveLegacyPoolReference(dir, "xz-login-openai", "gpt", models), { provider: "openai-personal", id: "gpt" });
  assert.equal(api.resolveLegacyPoolReference(dir, "xz-login-openai", "missing", models), undefined);
});
