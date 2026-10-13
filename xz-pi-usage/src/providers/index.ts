import { anthropicAdapter } from "./anthropic.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { glmAdapter } from "./glm.js";
import { kimiAdapter } from "./kimi.js";
import { minimaxAdapter } from "./minimax.js";
import { openAIAdapter } from "./openai.js";
import { xaiAdapter } from "./xai.js";
import { baseProviderId, type AccountAliases } from "../account-aliases.js";
import type { ProviderAdapter } from "../types.js";

export const PROVIDERS: readonly ProviderAdapter[] = [
  codexAdapter,
  openAIAdapter,
  copilotAdapter,
  anthropicAdapter,
  kimiAdapter,
  xaiAdapter,
  glmAdapter,
  minimaxAdapter,
];

export const DEFAULT_PROVIDER_IDS = [
  "openai",
  "openai-codex-personal",
  "openai-codex-work",
  "openai-codex",
  "github-copilot",
  "anthropic",
  "kimi-coding",
  "xai",
  "zai",
  "zai-coding-cn",
  "minimax",
  "minimax-cn",
] as const;

export function resolveProviderAdapter(providerId: string, aliases: AccountAliases = {}): ProviderAdapter | undefined {
  const base = baseProviderId(providerId, aliases);
  return PROVIDERS.find((adapter) => adapter.matches(base));
}

export function providerIdsFor(configuredProviderIds: readonly string[]): string[] {
  return [...new Set(configuredProviderIds.filter((providerId) => providerId.trim() !== ""))];
}
