import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { carrierSlot, discoverFamilies, resolveAccountId, setAccountAliases } from "../lib/slots.js";

beforeEach(() => setAccountAliases({}));

describe("named account identity", () => {
  it("resolves only explicitly mapped aliases", () => {
    setAccountAliases({ "openai-work": { base: "openai", suffix: "work" } });
    assert.deepEqual(resolveAccountId("openai-work"), { base: "openai", suffix: "work", alias: true, n: 2 });
    assert.deepEqual(resolveAccountId("openai-account-2"), { base: "openai-account-2", suffix: null, alias: false, n: 1 });
    assert.deepEqual(resolveAccountId("openai"), { base: "openai", suffix: null, alias: false, n: 1 });
    assert.equal(resolveAccountId(null), null);
  });

  it("discovers families from the alias map, never from name shape", () => {
    const aliases = {
      "openai-personal": { base: "openai", suffix: "personal" },
      "openai-work": { base: "openai", suffix: "work" },
      "anthropic-team": { base: "anthropic", suffix: "team" },
    };
    assert.deepEqual(discoverFamilies({ openai: {}, "openai-account-2": {} }, aliases), [
      { base: "anthropic", slots: ["anthropic-team"] },
      { base: "openai", slots: ["openai", "openai-personal", "openai-work"] },
    ]);
  });

  it("keeps aliases available before login so restart can restore /login", () => {
    const aliases = { "cursor-work": { base: "cursor", suffix: "work" } };
    assert.deepEqual(discoverFamilies({}, aliases), [{ base: "cursor", slots: ["cursor-work"] }]);
  });
});

describe("carrier", () => {
  it("selects the first configured account and falls back deterministically", () => {
    const slots = ["openai", "openai-personal", "openai-work"];
    assert.equal(carrierSlot(slots, id => id === "openai-work"), "openai-work");
    assert.equal(carrierSlot(slots, () => false), "openai");
    assert.equal(carrierSlot(slots), "openai");
    assert.equal(carrierSlot([]), null);
  });
});
