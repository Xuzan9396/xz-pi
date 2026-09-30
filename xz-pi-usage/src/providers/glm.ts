import { apiKey, clampPercent, clean, errorSnapshot, getJson, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot, UsageWindow } from "../types.js";

const ENDPOINTS: Record<string, { url: string; authorization: (key: string) => string }> = {
  zai: { url: "https://api.z.ai/api/monitor/usage/quota/limit", authorization: (key) => `Bearer ${key}` },
  "zai-coding-cn": { url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", authorization: (key) => key },
};

export async function fetchGlmUsage(ctx: UsageContext, providerId = "zai", deps: ProviderDeps = {}): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const endpoint = ENDPOINTS[providerId];
    if (!endpoint) throw new Error("unsupported provider");
    const key = await apiKey(ctx, providerId, deps.readCredential);
    const response = await getJson(endpoint.url, key, { Authorization: endpoint.authorization(key), "Accept-Language": "en-US,en" });
    const data = response?.data ?? response;
    const windows: UsageWindow[] = [];
    for (const limit of (Array.isArray(data?.limits) ? data.limits : []).slice(0, 6)) {
      if (!["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(String(limit?.type))) continue;
      const resetAt = parseTimestamp(limit.nextResetTime);
      windows.push({
        label: String(limit.type).replace("_LIMIT", "").toLowerCase(),
        usedPercent: clampPercent(limit.percentage),
        ...(resetAt ? { resetAt } : {}),
      });
    }
    const plan = clean(data?.level, 32);
    return snapshot(providerId, "GLM", false, now, {
      ...(plan ? { plan } : {}),
      windows,
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "GLM", false, now, error);
  }
}

export const glmAdapter: ProviderAdapter = {
  id: "zai",
  name: "GLM",
  verified: false,
  matches: (providerId) => providerId === "zai" || providerId === "zai-coding-cn",
  fetch: fetchGlmUsage,
};
