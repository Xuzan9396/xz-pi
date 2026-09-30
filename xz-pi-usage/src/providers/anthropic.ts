import { clampPercent, errorSnapshot, getJson, oauthToken, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot, UsageWindow } from "../types.js";

export async function fetchAnthropicUsage(ctx: UsageContext, providerId = "anthropic", deps: ProviderDeps = {}): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const token = await oauthToken(ctx, providerId, deps.readCredential);
    const usage = await getJson("https://api.anthropic.com/api/oauth/usage", token, { "anthropic-beta": "oauth-2025-04-20" });
    const windows: UsageWindow[] = [];
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
      const item = usage?.[key];
      if (!item) continue;
      const resetAt = parseTimestamp(item.resets_at);
      windows.push({ label, usedPercent: clampPercent(item.utilization), ...(resetAt ? { resetAt } : {}) });
    }
    return snapshot(providerId, "Claude", false, now, {
      windows,
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "Claude", false, now, error);
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  name: "Claude",
  verified: false,
  matches: (providerId) => providerId === "anthropic",
  fetch: fetchAnthropicUsage,
};
