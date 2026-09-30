import { anthropicAdapter } from "./anthropic.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { glmAdapter } from "./glm.js";
import { kimiAdapter } from "./kimi.js";
import { minimaxAdapter } from "./minimax.js";
import { xaiAdapter } from "./xai.js";
import type { ProviderAdapter } from "../types.js";

export const PROVIDERS: readonly ProviderAdapter[] = [
  codexAdapter,
  copilotAdapter,
  anthropicAdapter,
  kimiAdapter,
  xaiAdapter,
  glmAdapter,
  minimaxAdapter,
];

export const DEFAULT_PROVIDER_IDS = [
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

export function resolveProviderAdapter(providerId: string): ProviderAdapter | undefined {
  return PROVIDERS.find((adapter) => adapter.matches(providerId));
}

export function providerIdsFor(configuredProviderIds: readonly string[]): string[] {
  return [...new Set(configuredProviderIds)]
    .filter((providerId) => resolveProviderAdapter(providerId) !== undefined);
}
