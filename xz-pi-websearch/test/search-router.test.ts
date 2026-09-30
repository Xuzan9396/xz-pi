import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticRouteCandidates,
  discoverSearchRoutes,
  resolveSearchRoute,
  selectAutomaticRoute,
} from "../search-router.ts";
import type { SearchRoute } from "../search-types.ts";

const models = [
  { provider: "openai-codex-personal", id: "gpt-6-sol", api: "openai-codex-responses" },
  { provider: "openai-codex-work", id: "gpt-6-terra", api: "openai-codex-responses" },
  { provider: "github-copilot", id: "claude-opus-5.5", api: "anthropic-messages" },
  { provider: "github-copilot", id: "grok-4.7", api: "openai-responses" },
  { provider: "github-copilot", id: "gpt-5.4", api: "openai-responses" },
  { provider: "xai", id: "grok-5", api: "openai-responses" },
  { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" },
] as never[];

const authenticated = new Set([
  "openai-codex-personal/gpt-6-sol",
  "openai-codex-work/gpt-6-terra",
  "github-copilot/claude-opus-5.5",
  "github-copilot/grok-4.7",
  "github-copilot/gpt-5.4",
  "xai/grok-5",
]);

const routes = discoverSearchRoutes(models, (model) => authenticated.has(`${model.provider}/${model.id}`));

test("discovers only authenticated and search-capable provider/model routes", () => {
  assert.deepEqual(routes.map((route) => `${route.provider}/${route.model}`), [
    "openai-codex-personal/gpt-6-sol",
    "openai-codex-work/gpt-6-terra",
    "github-copilot/grok-4.7",
    "github-copilot/gpt-5.4",
    "xai/grok-5",
  ]);
});

test("auto selection follows the current model then provider search model", () => {
  assert.equal(selectAutomaticRoute(routes, models[1])?.provider, "openai-codex-work");
  assert.deepEqual(selectAutomaticRoute(routes, models[2]), routes.find((route) => route.provider === "github-copilot"));
});

test("orders OCI after native xAI and before Anthropic", () => {
  const extra = [
    { provider: "xai-oci", model: "xai.grok-4.7", adapter: "oci-responses", flavor: "xai", label: "OCI", verified: true },
    { provider: "anthropic", model: "claude-opus-5-5", adapter: "anthropic", label: "Anthropic", verified: false },
  ] as SearchRoute[];
  const providers = automaticRouteCandidates([...routes, ...extra]).map((route) => route.provider);
  assert.ok(providers.indexOf("xai") < providers.indexOf("xai-oci"));
  assert.ok(providers.indexOf("xai-oci") < providers.indexOf("anthropic"));
});

test("missing preference defaults to current-provider instead of automatic", () => {
  const unsupported = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" } as never;
  assert.throws(() => resolveSearchRoute({}, routes, unsupported), /Run \/xz-search/);
  assert.equal(resolveSearchRoute({}, routes, unsupported, { mode: "auto" }).provider, "openai-codex-personal");
});

test("current-provider preference stays within the current provider", () => {
  const copilotClaude = models[2];
  assert.equal(
    resolveSearchRoute({}, routes, copilotClaude, { mode: "current-provider" }).provider,
    "github-copilot",
  );
  assert.equal(
    resolveSearchRoute({}, routes, models[3], { mode: "current-provider" }).model,
    "grok-4.7",
  );
  assert.throws(
    () => resolveSearchRoute({}, routes, { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" } as never, { mode: "current-provider" }),
    /current provider anthropic has no available search route/,
  );
});

test("explicit tool route overrides saved preferences", () => {
  assert.equal(
    resolveSearchRoute({ provider: "openai-codex-work" }, routes, models[2], { mode: "fixed", provider: "openai-codex-personal", model: "gpt-6-sol" }).provider,
    "openai-codex-work",
  );
  assert.equal(
    resolveSearchRoute({ provider: "github-copilot", model: "gpt-5.4" }, routes, models[2], { mode: "current-provider" }).model,
    "gpt-5.4",
  );
  assert.throws(() => resolveSearchRoute({ model: "grok-4.7" }, routes, models[2], { mode: "auto" }), /model requires provider/);
});
