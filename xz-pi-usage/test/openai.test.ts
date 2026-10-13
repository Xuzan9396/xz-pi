import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenAIUsage } from "../src/providers/openai.js";
import { resolveProviderAdapter } from "../src/providers/index.js";
import type { UsageContext } from "../src/types.js";

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

const workToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-work" } });
const xuzanToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-xuzan" } });

function context(): UsageContext {
  return {
    modelRegistry: {
      getProviderAuth: async (providerId) => {
        if (providerId === "openai-codex-work") return { source: "OAuth", auth: { apiKey: workToken } };
        if (providerId === "openai-codex-xuzan") return { source: "OAuth", auth: { apiKey: xuzanToken } };
        return undefined;
      },
    },
  };
}

test("OpenAI aliases keep their adapter while Codex aliases use the Codex adapter", () => {
  const aliases = {
    "openai-xuzan": { base: "openai", suffix: "xuzan" },
    "openai-codex-team": { base: "openai-codex", suffix: "team" },
  };
  assert.equal(resolveProviderAdapter("openai-xuzan", aliases)?.id, "openai");
  assert.equal(resolveProviderAdapter("openai-personal")?.id, "openai");
  assert.equal(resolveProviderAdapter("openai-codex-work")?.id, "openai-codex");
  assert.equal(resolveProviderAdapter("openai-codex-team", aliases)?.id, "openai-codex");
});

test("OpenAI aliases display quota from the same-named Codex account only", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ authorization: string | null; accountId: string | null }> = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      accountId: headers.get("chatgpt-account-id"),
    });
    return Response.json({
      plan_type: "prolite",
      rate_limit: {
        secondary_window: { used_percent: 28, limit_window_seconds: 604_800, reset_at: 2_000 },
      },
      rate_limit_reset_credits: { available_count: 3 },
    });
  };
  try {
    const result = await fetchOpenAIUsage(context(), "openai-xuzan", {
      now: () => 1,
      accountAliasSuffix: "xuzan",
      companionProviderIds: ["openai-codex-work", "openai-codex-xuzan"],
    });
    assert.equal(result.providerId, "openai-xuzan");
    assert.equal(result.name, "OpenAI xuzan");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
      { label: "7d", usedPercent: 28 },
    ]);
    assert.equal(result.resetCredits, undefined);
    assert.deepEqual(calls, [{
      authorization: `Bearer ${xuzanToken}`,
      accountId: "account-xuzan",
    }, {
      authorization: `Bearer ${xuzanToken}`,
      accountId: "account-xuzan",
    }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI usage stays hidden without a same-named Codex account", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  try {
    const result = await fetchOpenAIUsage(context(), "openai-xuzan", {
      now: () => 1,
      accountAliasSuffix: "xuzan",
      companionProviderIds: ["openai-codex-work"],
    });
    assert.equal(result.status, "unsupported");
    assert.equal(result.detail, "没有同名 Codex 账号可用于读取额度");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
