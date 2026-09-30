import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatDashboard, readAuthProviderOrder } from "../src/format.js";
import { fetchAnthropicUsage } from "../src/providers/anthropic.js";
import { providerIdsFor, resolveProviderAdapter } from "../src/providers/index.js";
import type { UsageContext, UsageSnapshot } from "../src/types.js";

const ctx: UsageContext = {
  modelRegistry: {
    getProviderAuth: async (provider) => provider === "anthropic" ? { source: "OAuth", auth: { apiKey: "token" } } : undefined,
  },
};

test("providers registry resolves aliases and marks unverified adapters", async () => {
  assert.equal(resolveProviderAdapter("openai-codex-personal")?.verified, true);
  assert.equal(resolveProviderAdapter("github-copilot")?.verified, true);
  assert.equal(resolveProviderAdapter("anthropic")?.verified, false);
  assert.deepEqual(
    providerIdsFor(["openai-codex-work", "unsupported", "github-copilot", "openai-codex-work"]),
    ["openai-codex-work", "github-copilot"],
  );

  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ five_hour: { utilization: 22, resets_at: "2026-09-28T15:00:00Z" } });
  try {
    const result = await fetchAnthropicUsage(ctx, "anthropic", { now: () => Date.UTC(2026, 8, 28, 12) });
    assert.equal(result.verified, false);
    assert.match(formatDashboard([result], Date.UTC(2026, 8, 28, 12)), /Claude · 未验证\n  5h 78%/);
  } finally {
    globalThis.fetch = original;
  }
});

test("dashboard follows auth.json key order regardless of current model or cache order", async () => {
  const makeSnapshot = (providerId: string, name: string): UsageSnapshot => ({
    providerId, name, status: "ok", verified: true, windows: [], credits: [], fetchedAt: 1,
  });
  const snapshots = [
    makeSnapshot("github-copilot", "Copilot"),
    makeSnapshot("zai", "GLM"),
    makeSnapshot("openai-codex-work", "Codex work"),
    makeSnapshot("openai-codex-personal", "Codex personal"),
    makeSnapshot("anthropic", "Claude"),
  ];
  const authPath = join(mkdtempSync(join(tmpdir(), "xz-usage-auth-order-")), "auth.json");
  writeFileSync(authPath, JSON.stringify({ "github-copilot": {}, "openai-codex-work": {}, "openai-codex-personal": {} }));
  const authOrder = await readAuthProviderOrder(authPath);
  assert.deepEqual(authOrder, ["github-copilot", "openai-codex-work", "openai-codex-personal"]);
  // Auth-listed providers come first; unlisted providers and new IDs remain deterministic.
  const unknown = [makeSnapshot("other-z", "Other Z"), makeSnapshot("other-a", "Other A")];
  const first = formatDashboard([...snapshots, ...unknown], 1, authOrder);
  const second = formatDashboard([...unknown].reverse().concat([...snapshots].reverse()), 1, authOrder);
  assert.equal(first, second);
  assert.ok(first.startsWith("XZ 订阅用量\nCopilot\nCodex work\nCodex personal\nClaude\nGLM"));
  assert.ok(first.indexOf("Other A") < first.indexOf("Other Z"));
  writeFileSync(authPath, JSON.stringify({ "other-z": {}, "openai-codex-personal": {}, "github-copilot": {} }));
  const updatedOrder = await readAuthProviderOrder(authPath);
  assert.ok(formatDashboard([...snapshots, ...unknown], 1, updatedOrder).startsWith("XZ 订阅用量\nOther Z\nCodex personal\nCopilot"));
  assert.deepEqual(await readAuthProviderOrder(join(authPath, "missing")), []);
  assert.deepEqual(snapshots.map((item) => item.providerId), ["github-copilot", "zai", "openai-codex-work", "openai-codex-personal", "anthropic"]);
});

test("providers failures degrade to categorized states", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const result = await fetchAnthropicUsage(ctx, "anthropic", { now: () => 1 });
    assert.equal(result.status, "endpoint_changed");
    assert.equal(result.detail, "接口变化");
  } finally {
    globalThis.fetch = original;
  }
});
