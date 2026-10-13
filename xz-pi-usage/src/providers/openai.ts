import { snapshot } from "../http.js";
import type { ProviderAdapter, ProviderDeps, UsageContext, UsageSnapshot } from "../types.js";
import { fetchCodexUsage } from "./codex.js";

function matchingCodexProvider(deps: ProviderDeps): string | undefined {
  const companions = [...new Set(deps.companionProviderIds ?? [])];
  const suffix = deps.accountAliasSuffix?.trim();
  if (!suffix) return companions.find((providerId) => providerId === "openai-codex");

  const exact = `openai-codex-${suffix}`;
  return companions.find((providerId) => providerId === exact) ??
    companions.find((providerId) => providerId.endsWith(`-${suffix}`));
}

export async function fetchOpenAIUsage(
  ctx: UsageContext,
  providerId = "openai",
  deps: ProviderDeps = {},
): Promise<UsageSnapshot> {
  const now = deps.now?.() ?? Date.now();
  const name = deps.accountAliasSuffix ? `OpenAI ${deps.accountAliasSuffix}` : "OpenAI";
  const companionId = matchingCodexProvider(deps);
  if (!companionId) {
    return snapshot(providerId, name, true, now, {
      status: "unsupported",
      detail: "没有同名 Codex 账号可用于读取额度",
    });
  }

  const companion = await fetchCodexUsage(ctx, companionId, deps);
  // Reset credits belong to the Codex product, not this OpenAI provider's
  // model quota, so they must not leak into this provider's footer.
  const { resetCredits: _resetCredits, ...quota } = companion;
  return { ...quota, providerId, name };
}

export const openAIAdapter: ProviderAdapter = {
  id: "openai",
  name: "OpenAI",
  verified: true,
  matches: (providerId) => providerId === "openai" ||
    (providerId.startsWith("openai-") && !providerId.startsWith("openai-codex")),
  fetch: fetchOpenAIUsage,
};
