import { clean, errorSnapshot, getJson, NotConnectedError, parseTimestamp, providerAuth, snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageCredits, UsageSnapshot, UsageWindow } from "../types.js";

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const PLAN_LABELS: Record<string, string> = {
  individual: "Pro",
  individual_pro: "Pro+",
  individual_max: "Max",
  individual_edu: "Edu",
  business: "Business",
  enterprise: "Enterprise",
};

export function copilotApiHost(enterpriseUrl: unknown): string {
  const raw = clean(enterpriseUrl, 200);
  if (!raw) return "api.github.com";
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    if (!host || host === "github.com" || host === "api.github.com") return "api.github.com";
    return host.startsWith("api.") ? host : `api.${host}`;
  } catch {
    return "api.github.com";
  }
}

function copilotPlan(user: any): string | undefined {
  if (user?.access_type_sku === "free_limited_copilot") return "Free";
  const plan = clean(user?.copilot_plan, 32);
  return PLAN_LABELS[plan] ?? (plan || undefined);
}

export async function fetchCopilotUsage(
  ctx: UsageContext,
  providerId = "github-copilot",
  deps: ProviderDeps = {},
): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  try {
    const session = await providerAuth(ctx, providerId, deps.readCredential);
    if (session?.source !== "OAuth") throw new NotConnectedError();
    const reader = deps.readCredential;
    if (!reader) throw new Error("login not readable");
    const credential = await reader(providerId) as Record<string, unknown> | undefined;
    const githubToken = typeof credential?.refresh === "string" ? credential.refresh.trim() : "";
    if (!githubToken) throw new Error("login not readable");

    const user = await getJson(
      `https://${copilotApiHost(credential?.enterpriseUrl)}/copilot_internal/user`,
      githubToken,
      COPILOT_HEADERS,
    );
    const resetAt = parseTimestamp(user?.quota_reset_date_utc ?? user?.quota_reset_date);
    const snapshots = user?.quota_snapshots && typeof user.quota_snapshots === "object" ? user.quota_snapshots : {};
    const credits: UsageCredits[] = [];
    const windows: UsageWindow[] = [];

    const premium = snapshots.premium_interactions;
    if (user?.token_based_billing === true && premium && typeof premium === "object") {
      const used = Number(premium.credits_used);
      const entitlement = Number(premium.entitlement);
      if (Number.isFinite(used) && used >= 0) {
        credits.push({
          label: "AI credits",
          used,
          ...(entitlement > 0 && premium.unlimited !== true ? { limit: entitlement } : {}),
          ...(resetAt ? { resetAt } : {}),
        });
      }
    } else {
      for (const [key, label] of [["premium_interactions", "Premium"], ["chat", "Chat"], ["completions", "Completions"]] as const) {
        const item = snapshots[key];
        if (!item || typeof item !== "object" || item.unlimited === true) continue;
        const remaining = Number(item.percent_remaining);
        if (!Number.isFinite(remaining)) continue;
        windows.push({ label, usedPercent: 100 - remaining, ...(resetAt ? { resetAt } : {}) });
      }
    }

    const plan = copilotPlan(user);
    return snapshot(providerId, "Copilot", true, now, {
      ...(plan ? { plan } : {}),
      credits,
      windows,
      ...(credits.length === 0 && windows.length === 0 ? { status: "unsupported", detail: "无额度数据" } : {}),
    });
  } catch (error) {
    return errorSnapshot(providerId, "Copilot", true, now, error);
  }
}

export const copilotAdapter: ProviderAdapter = {
  id: "github-copilot",
  name: "Copilot",
  verified: true,
  matches: (providerId) => providerId === "github-copilot",
  fetch: fetchCopilotUsage,
};
