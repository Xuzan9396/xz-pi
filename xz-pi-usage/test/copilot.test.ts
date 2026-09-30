import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboard } from "../src/format.js";
import { copilotApiHost, fetchCopilotUsage } from "../src/providers/copilot.js";
import type { UsageContext } from "../src/types.js";

const ctx: UsageContext = {
  modelRegistry: {
    getProviderAuth: async () => { throw new Error("provider alias is not registered"); },
  },
};

test("Copilot token billing shows AI credits used without inventing a percent", async () => {
  const original = globalThis.fetch;
  let url = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({
      copilot_plan: "business",
      access_type_sku: "copilot_for_business_seat_quota",
      token_based_billing: true,
      quota_reset_date_utc: "2026-10-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 153 },
      },
    });
  };
  try {
    const now = Date.UTC(2026, 8, 28);
    const result = await fetchCopilotUsage(ctx, "github-copilot", {
      now: () => now,
      readCredential: async () => ({
        type: "oauth",
        access: "copilot-session",
        refresh: "github-secret-token",
        expires: now + 3_600_000,
      }),
    });
    assert.equal(url, "https://api.github.com/copilot_internal/user");
    assert.equal(authorization, "Bearer github-secret-token");
    assert.deepEqual(result.credits, [{ label: "AI credits", used: 153, resetAt: Date.parse("2026-10-01T00:00:00Z") }]);
    assert.deepEqual(result.windows, []);
    const text = formatDashboard([result], now);
    assert.match(text, /Copilot \(Business\)\n  AI credits 153 used · 3d 0h 后重置/);
    assert.doesNotMatch(text, /%/);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Copilot enterprise host stays on GitHub API subdomains", () => {
  assert.equal(copilotApiHost(undefined), "api.github.com");
  assert.equal(copilotApiHost("https://github.com"), "api.github.com");
  assert.equal(copilotApiHost("ghe.example.com"), "api.ghe.example.com");
});
