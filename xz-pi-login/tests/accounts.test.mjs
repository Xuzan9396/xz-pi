import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { familyCarrier, nativeFamilyNames } from "../lib/accounts.js";
import { setAccountAliases } from "../lib/slots.js";
import * as builtins from "@earendil-works/pi-ai/providers/all";

beforeEach(() => setAccountAliases({
  "demo-work": { base: "demo", suffix: "work" },
  "demo-personal": { base: "demo", suffix: "personal" },
}));

describe("account discovery helpers", () => {
  it("prefers live configured auth for the visible catalog", () => {
    const slots = ["demo", "demo-personal", "demo-work"];
    const registry = {
      getProvider: () => ({ id: "fixture" }),
      getProviderAuthStatus: id => ({ configured: id === "demo-work" }),
    };
    assert.equal(familyCarrier(slots, { demo: {} }, registry), "demo-work");
    assert.equal(familyCarrier(slots, { demo: {} }, undefined), "demo");
  });

  it("builds provider choices from Pi builtins, native registry and factories", () => {
    const native = { id: "community-native", getModels: () => [] };
    const registry = {
      getRegisteredProviderIds: () => ["community-native", "legacy-provider", "demo-work"],
      getRegisteredNativeProvider: id => id === "community-native" ? native : undefined,
      getRegisteredProviderConfig: id => id === "legacy-provider" ? {} : undefined,
    };
    const state = { builtins, aliases: { "demo-work": { base: "demo", suffix: "work" } }, accountFactories: new Map([["factory-provider", native]]), nativeAliases: new Map(), ownedAliases: new Set() };
    const names = nativeFamilyNames(registry, undefined, state);
    assert.ok(names.includes("openai"));
    assert.ok(names.includes("community-native"));
    assert.ok(names.includes("factory-provider"));
    assert.equal(names.includes("legacy-provider"), false);
    assert.equal(names.includes("demo-work"), false);
  });
});
