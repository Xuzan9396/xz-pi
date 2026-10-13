import { join } from "node:path";
import { loadAliases } from "./account-aliases.js";
import { effectiveAuth } from "./credentials.js";
import { poolBase } from "./pool-contract.ts";
import { readPoolDocument } from "./pool-store.ts";

export function readAuthProviderIds(dir: string): string[] {
  return Object.keys(effectiveAuth(dir));
}

export function resolvePhysicalProvider(
  authIds: readonly string[],
  models: readonly { provider: string; id: string }[],
  base: string,
  modelId: string,
  preferred?: string,
  aliases: Record<string, { base: string }> = {},
): string | undefined {
  const usable = new Set(models.filter(model => model.id === modelId).map(model => model.provider));
  const belongs = (id: string) => id === base || aliases[id]?.base === base;
  if (preferred && authIds.includes(preferred) && usable.has(preferred) && belongs(preferred)) return preferred;
  return authIds.find(id => usable.has(id) && belongs(id));
}

export function resolveLegacyPoolReference(
  dir: string,
  provider: string,
  modelId: string,
  models: readonly { provider: string; id: string }[],
): { provider: string; id: string } | undefined {
  const base = poolBase(provider);
  if (!base) return undefined;
  const aliases = loadAliases(dir);
  const preferred = readPoolDocument(dir).preferred[base];
  const physical = resolvePhysicalProvider(readAuthProviderIds(dir), models, base, modelId, preferred, aliases);
  return physical ? { provider: physical, id: modelId } : undefined;
}

export function authPath(dir: string): string { return join(dir, "auth.json"); }
