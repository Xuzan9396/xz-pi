import { apiKey, clampPercent, errorSnapshot, getJson, HttpStatusError, NotConnectedError, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot, UsageWindow } from "../types.js";

const HOSTS: Record<string, string> = {
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
};

export async function fetchMinimaxUsage(ctx: UsageContext, providerId = "minimax", deps: ProviderDeps = {}): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const host = HOSTS[providerId];
    if (!host) throw new Error("unsupported provider");
    const key = await apiKey(ctx, providerId, deps.readCredential);
    if (key.startsWith("sk-api-")) throw new NotConnectedError();
    const response = await getJson(`${host}/v1/token_plan/remains`, key);
    const code = Number(response?.base_resp?.status_code ?? 0);
    if (code === 1004 || code === 2049) throw new HttpStatusError(401);
    if (code !== 0) throw new Error("provider status");
    const entries = Array.isArray(response?.model_remains) ? response.model_remains : [];
    const primary = entries.find((item: any) => /^(general|MiniMax-M)/i.test(String(item?.model_name ?? ""))) ?? entries[0];
    const windows: UsageWindow[] = [];
    if (primary) {
      const remaining = Number(primary.current_interval_remaining_percent);
      const resetAt = parseTimestamp(primary.end_time);
      if (Number.isFinite(remaining)) windows.push({ label: "5h", usedPercent: clampPercent(100 - remaining), ...(resetAt ? { resetAt } : {}) });
      const weekly = Number(primary.current_weekly_remaining_percent);
      const weeklyReset = parseTimestamp(primary.weekly_end_time);
      if (Number.isFinite(weekly)) windows.push({ label: "7d", usedPercent: clampPercent(100 - weekly), ...(weeklyReset ? { resetAt: weeklyReset } : {}) });
    }
    return snapshot(providerId, "MiniMax", false, now, {
      plan: "token plan",
      windows,
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "MiniMax", false, now, error);
  }
}

export const minimaxAdapter: ProviderAdapter = {
  id: "minimax",
  name: "MiniMax",
  verified: false,
  matches: (providerId) => providerId === "minimax" || providerId === "minimax-cn",
  fetch: fetchMinimaxUsage,
};
