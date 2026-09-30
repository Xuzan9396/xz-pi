import { clampPercent, clean, errorSnapshot, getJson, oauthToken, parseTimestamp, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageResetCredits, UsageSnapshot, UsageWindow } from "../types.js";

const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

export function isCodexProvider(providerId: string): boolean {
  return providerId === "openai-codex" || providerId.startsWith("openai-codex-");
}

export function codexDisplayName(providerId: string): string {
  if (providerId === "openai-codex") return "Codex";
  return `Codex ${clean(providerId.slice("openai-codex-".length), 24)}`;
}

export function codexAccountId(token: string): string | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, any>;
    const accountId = clean(payload["https://api.openai.com/auth"]?.chatgpt_account_id, 128);
    return accountId || undefined;
  } catch {
    return undefined;
  }
}

function windowLabel(seconds: number): string {
  if (seconds === FIVE_HOURS) return "5h";
  if (seconds === SEVEN_DAYS) return "7d";
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return "窗口";
}

function parseWindow(value: any): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const seconds = Number(value.limit_window_seconds);
  const resetAt = parseTimestamp(value.reset_at);
  return {
    label: windowLabel(seconds),
    usedPercent: clampPercent(value.used_percent),
    ...(resetAt ? { resetAt } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { windowMs: seconds * 1000 } : {}),
  };
}

async function fetchCodexResetCredits(
  usage: any,
  token: string,
  accountId: string | undefined,
): Promise<UsageResetCredits | undefined> {
  const available = Math.max(0, Math.trunc(Number(usage?.rate_limit_reset_credits?.available_count) || 0));
  if (available === 0) return undefined;
  try {
    const response = await getJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", token, {
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    }, 2_500);
    const expiresAt = (Array.isArray(response?.credits) ? response.credits : [])
      .filter((credit: any) => (credit?.status ?? "available") === "available")
      .map((credit: any) => parseTimestamp(credit?.expires_at ?? credit?.expiresAt))
      .filter((value: number | undefined): value is number => value !== undefined)
      .sort((a: number, b: number) => a - b)
      .slice(0, 20);
    return { available, expiresAt };
  } catch {
    return { available, expiresAt: [] };
  }
}

export async function fetchCodexUsage(
  ctx: UsageContext,
  providerId: string,
  deps: ProviderDeps = {},
): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  const name = codexDisplayName(providerId);
  try {
    const token = await oauthToken(ctx, providerId, deps.readCredential);
    const accountId = codexAccountId(token);
    const usage = await getJson(
      "https://chatgpt.com/backend-api/wham/usage",
      token,
      accountId ? { "ChatGPT-Account-Id": accountId } : {},
    );
    const windows = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]
      .map(parseWindow)
      .filter((window): window is UsageWindow => window !== undefined);
    const resetCredits = await fetchCodexResetCredits(usage, token, accountId);
    return snapshot(providerId, name, true, now, {
      plan: clean(usage?.plan_type, 40),
      windows,
      ...(resetCredits ? { resetCredits } : {}),
      ...(windows.length === 0 ? { status: "unsupported", detail: "无额度窗口" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, name, true, now, error);
  }
}

export const codexAdapter: ProviderAdapter = {
  id: "openai-codex",
  name: "Codex",
  verified: true,
  matches: isCodexProvider,
  fetch: fetchCodexUsage,
};
