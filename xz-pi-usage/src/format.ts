import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { clean } from "./http.js";
import { DEFAULT_PROVIDER_IDS } from "./providers/index.js";
import type { UsageCredits, UsageResetCredits, UsageSnapshot, UsageWindow } from "./types.js";

export function formatReset(resetAt: number | undefined, now = Date.now()): string {
  if (!resetAt) return "";
  const minutes = Math.max(0, Math.round((resetAt - now) / 60_000));
  if (minutes === 0) return "即将重置";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h 后重置`;
  if (hours > 0) return `${hours}h ${mins}m 后重置`;
  return `${mins}m 后重置`;
}

export function formatWindow(window: UsageWindow, now = Date.now()): string {
  const reset = formatReset(window.resetAt, now);
  const label = clean(window.label, 24).replace(/^7d(?=\s|$)/, "week");
  const remainingPercent = Math.round(100 - window.usedPercent);
  return `${label} ${remainingPercent}%${reset ? ` · ${reset}` : ""}`;
}

export function formatCredits(credits: UsageCredits, now = Date.now()): string {
  const used = Math.round(credits.used).toLocaleString("en-US");
  const limit = credits.limit && credits.limit > 0 ? `/${Math.round(credits.limit).toLocaleString("en-US")}` : "";
  const reset = formatReset(credits.resetAt, now);
  return `${clean(credits.label, 24)} ${used}${limit} used${reset ? ` · ${reset}` : ""}`;
}

export function formatExpiry(expiresAt: number, now = Date.now()): string {
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(expiresAt));
  return `${date} · ${formatReset(expiresAt, now).replace(" 后重置", " 后过期")}`;
}

export function formatResetCredits(resetCredits: UsageResetCredits, now = Date.now()): string[] {
  const lines = [`Rate limit resets ${resetCredits.available} available`];
  resetCredits.expiresAt.forEach((expiresAt, index) => lines.push(`  ${index + 1}. ${formatExpiry(expiresAt, now)}`));
  return lines;
}

export async function readAuthProviderOrder(path = join(getAgentDir(), "auth.json")): Promise<string[]> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
  } catch {
    return [];
  }
}

export function formatDashboard(snapshots: readonly UsageSnapshot[], now = Date.now(), authOrder: readonly string[] = []): string {
  const lines = ["XZ 订阅用量"];
  const providerOrder = new Map<string, number>();
  for (const id of [...authOrder, ...DEFAULT_PROVIDER_IDS]) {
    if (!providerOrder.has(id)) providerOrder.set(id, providerOrder.size);
  }
  const ordered = [...snapshots].sort((a, b) => {
    const rankA = providerOrder.get(a.providerId) ?? Infinity;
    const rankB = providerOrder.get(b.providerId) ?? Infinity;
    if (rankA !== rankB) return rankA - rankB;
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });
  for (const item of ordered) {
    if (item.status === "unconnected") continue;
    const plan = item.plan ? ` (${clean(item.plan, 40)})` : "";
    const verified = item.verified ? "" : " · 未验证";
    lines.push(`${clean(item.name, 40)}${plan}${verified}`);
    if (item.status !== "ok") {
      lines.push(`  ${clean(item.detail, 80) || "不可用"}`);
      continue;
    }
    for (const window of item.windows) lines.push(`  ${formatWindow(window, now)}`);
    for (const credits of item.credits) lines.push(`  ${formatCredits(credits, now)}`);
    if (item.resetCredits) lines.push(...formatResetCredits(item.resetCredits, now).map((line) => `  ${line}`));
  }
  if (lines.length === 1) lines.push("未找到已连接且支持额度查询的订阅");
  return lines.join("\n");
}
