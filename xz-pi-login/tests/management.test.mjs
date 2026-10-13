import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountUsage, removeAccount } from "../lib/management.js";
import { setAccountAliases } from "../lib/slots.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xz-pi-login-management-"));
  const auth = {
    "openai-codex": { type: "oauth", access: "fixture-base", accountId: "base" },
    "openai-codex-work": { type: "oauth", access: "fixture-work", accountId: "work" },
  };
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const family = { base: "openai-codex", slots: ["openai-codex", "openai-codex-work"], cooldowns: new Map(), drained: new Map(), sessions: new Map() };
  const state = { mode: "standalone", families: new Map([["openai-codex", family]]), config: { cooldownMs: 60000 } };
  return { dir, auth, family, state };
}

beforeEach(() => setAccountAliases({ "openai-codex-work": { base: "openai-codex", suffix: "work" } }));

it("removeAccount refuses the active named provider", async () => {
  const f = fixture();
  assert.throws(() => removeAccount(f.dir, "openai-codex-work", { model: { provider: "openai-codex-work" } }), /active/);
  assert.ok(JSON.parse(readFileSync(join(f.dir, "auth.json"), "utf8"))["openai-codex-work"]);
});

it("removeAccount fallback deletes exactly the requested credential", async () => {
  const f = fixture();
  const remaining = await removeAccount(f.dir, "openai-codex-work", {
    model: { provider: "openai-codex" }, modelRegistry: { refresh: async () => ({}) },
  });
  assert.equal(remaining["openai-codex-work"], undefined);
  assert.deepEqual(remaining["openai-codex"], f.auth["openai-codex"]);
});

it("usage resolution applies the base provider family to a named alias", async () => {
  const f = fixture();
  const requests = [];
  const usage = createAccountUsage(f.dir, f.state, { fetchImpl: async (url, options) => {
    requests.push({ url, auth: new Headers(options.headers).get("authorization") });
    return new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 });
  } });
  const text = await usage.describe(["openai-codex-work"], true);
  assert.match(text, /openai-codex-work/);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(row => !String(row.auth).includes("undefined")));
});
