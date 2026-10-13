import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nativeBuiltinModule from "@earendil-works/pi-ai/providers/all";
import { aliasDef, builtinBase } from "../lib/clone.js";
import { providerBase, registerOwnedAlias } from "../lib/accounts.js";
import { setAccountAliases } from "../lib/slots.js";

function fakeBase() {
  return {
    id: "openai", name: "OpenAI", baseUrl: "https://example.invalid",
    auth: { oauth: { login: () => {}, refresh: () => {} } },
    getModels: () => [{ id: "gpt-fixture" }], stream: () => {},
  };
}

beforeEach(() => setAccountAliases({
  "openai-work": { base: "openai", suffix: "work" },
  "anthropic-team": { base: "anthropic", suffix: "team" },
}));

describe("named native provider clones", () => {
  it("rekeys models and uses the chosen alias as the display label", () => {
    const base = fakeBase();
    const alias = aliasDef(base, "openai-work", "work");
    assert.equal(alias.id, "openai-work");
    assert.equal(alias.name, "OpenAI (work)");
    assert.deepEqual(alias.getModels(), [{ id: "gpt-fixture", provider: "openai-work" }]);
    assert.equal(alias.auth, base.auth);
    assert.equal(base.name, "OpenAI");
  });

  it("each sibling publishes chat and non-chat catalogs with its own identity", () => {
    const base = { ...fakeBase(), getAllModels: () => [{ id: "image", type: "image" }], refreshModels: () => {} };
    const alias = aliasDef(base, "openai-work", "work");
    const sibling = aliasDef(base, "openai-personal", "personal");
    assert.deepEqual(alias.getModels(), [{ id: "gpt-fixture", provider: "openai-work" }]);
    assert.deepEqual(alias.getAllModels(), [{ id: "image", type: "image", provider: "openai-work" }]);
    assert.deepEqual(sibling.getModels(), [{ id: "gpt-fixture", provider: "openai-personal" }]);
    assert.deepEqual(base.getModels(), [{ id: "gpt-fixture" }]);
    assert.equal(alias.auth, base.auth);
    assert.ok(alias.refreshModels instanceof Function);
  });

  it("registerOwnedAlias uses the complete native Provider overload", () => {
    const calls = [];
    const state = { ownedAliases: new Set() };
    registerOwnedAlias({ registerProvider: value => calls.push(value) }, state, "openai", fakeBase(), "openai-work", "work");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "openai-work");
    assert.ok(state.ownedAliases.has("openai-work"));
    assert.equal(state.nativeAliases.get("openai-work").definition, calls[0]);
  });

  it("builtinBase returns fresh host definitions", () => {
    const first = builtinBase(nativeBuiltinModule, "openai");
    const second = builtinBase(nativeBuiltinModule, "openai");
    assert.ok(first && second);
    assert.notEqual(first, second);
    assert.equal(builtinBase(nativeBuiltinModule, "not-a-provider"), null);
  });

  it("keeps Pi's live builtin identity while canonicalizing its wire provider", async () => {
    let wireProvider;
    const live = {
      ...fakeBase(),
      stream: model => {
        wireProvider = model.provider;
        return {
          async *[Symbol.asyncIterator]() {},
          async result() { return { provider: model.provider }; },
        };
      },
    };
    const builtins = { builtinProviders: () => [fakeBase()] };
    const selected = providerBase("openai", { getProvider: () => live }, builtins, {});
    const alias = aliasDef(selected, "openai-work", "work");
    const result = await alias.stream({ provider: "openai-work", id: "gpt-fixture" }, { messages: [] }).result();

    assert.equal(selected, live);
    assert.equal(wireProvider, "openai");
    assert.equal(result.provider, "openai-work");
  });

  it("saved catalog metadata follows explicitly mapped family aliases", () => {
    const native = { ...fakeBase(), getModels: () => [{ id: "current", api: "openai-completions", provider: "openai" }] };
    const builtins = { builtinProviders: () => [native] };
    const state = { savedModelProviders: { "openai-work": { models: [{ id: "next", name: "Saved next" }] } } };
    const models = providerBase("openai", {}, builtins, state).getModels();
    assert.deepEqual(models.map(model => model.id), ["current", "next"]);
    assert.equal(models[1].provider, "openai");
  });
});
