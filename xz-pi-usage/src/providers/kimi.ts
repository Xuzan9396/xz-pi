import { clean, errorSnapshot, getJson, oauthToken, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot, UsageWindow } from "../types.js";

function percent(used: unknown, limit: unknown): number {
  const u = Number(used);
  const l = Number(limit);
  return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? Math.max(0, Math.min(100, (u / l) * 100)) : 0;
}

export async function fetchKimiUsage(ctx: UsageContext, providerId = "kimi-coding", deps: ProviderDeps = {}): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const usage = await getJson("https://api.kimi.com/coding/v1/usages", await oauthToken(ctx, providerId, deps.readCredential));
    const windows: UsageWindow[] = [];
    const five = (Array.isArray(usage?.limits) ? usage.limits : []).find((item: any) => item?.window?.timeUnit === "TIME_UNIT_MINUTE");
    if (five?.detail) {
      const resetAt = parseTimestamp(five.detail.resetTime);
      windows.push({ label: "5h", usedPercent: percent(five.detail.used, five.detail.limit), ...(resetAt ? { resetAt } : {}) });
    }
    if (usage?.usage?.limit) {
      const resetAt = parseTimestamp(usage.usage.resetTime);
      windows.push({ label: "7d", usedPercent: percent(usage.usage.used, usage.usage.limit), ...(resetAt ? { resetAt } : {}) });
    }
    const plan = clean(String(usage?.user?.membership?.level ?? "").replace(/^LEVEL_/i, ""), 32).toLowerCase();
    return snapshot(providerId, "Kimi", false, now, {
      ...(plan ? { plan } : {}),
      windows,
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "Kimi", false, now, error);
  }
}

export const kimiAdapter: ProviderAdapter = {
  id: "kimi-coding",
  name: "Kimi",
  verified: false,
  matches: (providerId) => providerId === "kimi-coding",
  fetch: fetchKimiUsage,
};
