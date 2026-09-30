import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboard } from "../src/format.js";
import { codexAccountId, fetchCodexUsage } from "../src/providers/codex.js";
import type { UsageContext } from "../src/types.js";

function jwt(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${payload}.signature`;
}

function context(tokens: Record<string, string>): UsageContext {
  return {
    modelRegistry: {
      getProviderAuth: async (provider) => tokens[provider] ? { source: "OAuth", auth: { apiKey: tokens[provider] } } : undefined,
    },
  };
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("Codex aliases are fetched with separate account ids and quota windows", async () => {
  const seen: string[] = [];
  const now = Date.UTC(2026, 8, 28, 12);
  await withFetch(async (_url, init) => {
    const account = new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "none";
    seen.push(account);
    return Response.json({
      plan_type: account === "personal-account" ? "plus" : "pro",
      rate_limit: {
        primary_window: { limit_window_seconds: 18_000, used_percent: account === "personal-account" ? 93 : 12, reset_at: (now + 2 * 3_600_000) / 1000 },
        secondary_window: { limit_window_seconds: 604_800, used_percent: 41, reset_at: (now + 4 * 86_400_000) / 1000 },
      },
    });
  }, async () => {
    const ctx = context({ "openai-codex-personal": jwt("personal-account"), "openai-codex-work": jwt("work-account") });
    const personal = await fetchCodexUsage(ctx, "openai-codex-personal", { now: () => now });
    const work = await fetchCodexUsage(ctx, "openai-codex-work", { now: () => now });
    assert.deepEqual(seen, ["personal-account", "work-account"]);
    assert.equal(personal.name, "Codex personal");
    assert.equal(personal.windows[0]?.label, "5h");
    assert.equal(personal.windows[1]?.label, "7d");
    assert.match(formatDashboard([personal, work], now), /Codex personal \(plus\)\n  5h 7% · 2h 0m 后重置\n  week 59% · 4d 0h 后重置/);
    assert.match(formatDashboard([work], now), /Codex work \(pro\)\n  5h 88%/);
  });
});

test("Codex aliases fall back to their matching auth.json credentials", async () => {
  const token = jwt("work-account");
  let authorization = "";
  await withFetch(async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({
      plan_type: "pro",
      rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 13 } },
    });
  }, async () => {
    const unavailableContext: UsageContext = {
      modelRegistry: { getProviderAuth: async () => { throw new Error("provider alias is not registered"); } },
    };
    const result = await fetchCodexUsage(unavailableContext, "openai-codex-work", {
      now: () => 1,
      readCredential: async (providerId) => providerId === "openai-codex-work"
        ? { type: "oauth", access: token, refresh: "refresh-token", expires: 2 }
        : undefined,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.windows[0]?.usedPercent, 13);
    assert.equal(authorization, `Bearer ${token}`);
  });
});

test("Codex rate limit resets show each expiry separately", async () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const first = Date.UTC(2026, 9, 5, 10, 32);
  const second = Date.UTC(2026, 9, 23, 5, 12);
  const urls: string[] = [];
  await withFetch(async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("rate-limit-reset-credits")) {
      return Response.json({ credits: [
        { status: "available", expires_at: new Date(second).toISOString() },
        { status: "used", expires_at: new Date(first - 1).toISOString() },
        { status: "available", expires_at: new Date(first).toISOString() },
      ] });
    }
    return Response.json({
      rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 4, reset_at: first / 1000 } },
      rate_limit_reset_credits: { available_count: 2 },
    });
  }, async () => {
    const result = await fetchCodexUsage(context({ "openai-codex-personal": jwt("personal-account") }), "openai-codex-personal", { now: () => now });
    assert.deepEqual(result.resetCredits, { available: 2, expiresAt: [first, second] });
    assert.equal(urls.length, 2);
    const text = formatDashboard([result], now);
    assert.match(text, /Rate limit resets 2 available\n    1\. .+ · 6d 22h 后过期\n    2\. .+ · 24d 17h 后过期/);
  });
});

test("Codex maps expired and unconnected accounts without exposing tokens", async () => {
  assert.equal(codexAccountId("not-a-jwt"), undefined);
  const missing = await fetchCodexUsage(context({}), "openai-codex-work", { now: () => 1 });
  assert.equal(missing.status, "unconnected");
  await withFetch(async () => new Response('{"error":{"message":"Bearer secret-token","code":"token_revoked"}}', { status: 401 }), async () => {
    const expired = await fetchCodexUsage(context({ "openai-codex-personal": "secret-token" }), "openai-codex-personal", { now: () => 1 });
    assert.equal(expired.status, "expired");
    assert.equal(expired.detail, "登录令牌已撤销，请重新登录");
    assert.doesNotMatch(JSON.stringify(expired), /secret-token/);
  });
});
