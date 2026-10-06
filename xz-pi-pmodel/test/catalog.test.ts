import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { buildProviderGroups, resolveModelScope } from "../src/catalog.js";
import { matchesModelQuery, tokenizeQuery } from "../src/search.js";

function model(provider: string, id: string, name = id): Model<any> {
  return {
    provider,
    id,
    name,
    api: "openai-responses",
    baseUrl: "https://example.test",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as Model<any>;
}

test("search uses case-insensitive multi-keyword substring matching", () => {
  const sonnet = model("Anthropic", "claude-sonnet-5", "Claude Sonnet 5");
  assert.deepEqual(tokenizeQuery("  CLAUDE   anthropic "), ["claude", "anthropic"]);
  assert.equal(matchesModelQuery(sonnet, "sonnet anthro"), true);
  assert.equal(matchesModelQuery(sonnet, "anthropic/claude-sonnet"), true);
  assert.equal(matchesModelQuery(sonnet, "atsn"), false);
  assert.equal(matchesModelQuery(sonnet, "current", { current: true }), true);
  assert.equal(matchesModelQuery(sonnet, "default", { default: true }), true);
});

test("scope keeps official order and falls back to all without scoped models", () => {
  const all = [model("b", "two"), model("a", "one"), model("a", "three")];
  assert.deepEqual(resolveModelScope(all, [all[2]!], "scoped").map((item) => item.id), ["three"]);
  assert.deepEqual(resolveModelScope(all, [], "scoped").map((item) => item.id), ["two", "one", "three"]);
});

test("v5.1 defaults catalog marks and searches both defaults even with a project override", () => {
  const state = { global: { provider: "a", id: "one" }, project: { provider: "a", id: "two" }, effective: { provider: "a", id: "two", source: "project" as const } };
  const groups = buildProviderGroups([model("a", "one"), model("a", "two")], [], "scoped", {}, { defaults: state });
  const one = groups[0]!.models.find((entry) => entry.id === "one")!;
  const two = groups[0]!.models.find((entry) => entry.id === "two")!;
  assert.equal(one.globalDefault, true);
  assert.equal(one.projectDefault, false);
  assert.equal(two.projectDefault, true);
  assert.ok(one.searchFields.includes("default"));
  assert.ok(two.searchFields.includes("default"));
});

test("catalog groups, orders, hides, and retains unavailable configured ids", () => {
  const groups = buildProviderGroups(
    [model("anthropic", "sonnet"), model("anthropic", "opus"), model("copilot", "gpt")],
    [],
    "all",
    {
      providerOrder: ["copilot", "anthropic", "offline"],
      providers: {
        anthropic: { modelOrder: ["opus", "retired", "sonnet"], visibleModels: ["sonnet"] },
        offline: { modelOrder: ["missing"], visibleModels: ["missing"] },
      },
    },
    { current: { provider: "anthropic", id: "sonnet" }, defaults: { global: { provider: "copilot", id: "gpt" } } },
  );

  assert.deepEqual(groups.map((group) => group.provider), ["copilot", "anthropic", "offline"]);
  const anthropic = groups[1]!;
  assert.deepEqual(anthropic.models.map((item) => item.id), ["opus", "retired", "sonnet"]);
  assert.deepEqual(anthropic.visibleModels.map((item) => item.id), ["sonnet"]);
  assert.equal(anthropic.models[1]!.available, false);
  assert.equal(anthropic.models[2]!.current, true);
  assert.equal(groups[0]!.models[0]!.default, true);
  assert.equal(groups[2]!.hiddenModels[0]!.id, "missing");
});
