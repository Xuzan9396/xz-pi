import { clampPercent, clean, errorSnapshot, getJson, oauthToken, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot } from "../types.js";

export async function fetchXaiUsage(ctx: UsageContext, providerId = "xai", deps: ProviderDeps = {}): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const billing = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", await oauthToken(ctx, providerId, deps.readCredential));
    const config = billing?.config ?? {};
    const value = Number(config.creditUsagePercent);
    const resetAt = parseTimestamp(config.currentPeriod?.end ?? config.billingPeriodEnd);
    const windows = Number.isFinite(value)
      ? [{ label: "7d credits", usedPercent: clampPercent(value), ...(resetAt ? { resetAt } : {}) }]
      : [];
    const plan = clean(billing?.subscription_tier_display, 32);
    return snapshot(providerId, "Grok", false, now, {
      ...(plan ? { plan } : {}),
      windows,
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "Grok", false, now, error);
  }
}

export const xaiAdapter: ProviderAdapter = {
  id: "xai",
  name: "Grok",
  verified: false,
  matches: (providerId) => providerId === "xai",
  fetch: fetchXaiUsage,
};
