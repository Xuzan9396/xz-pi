import { baseProviderId, type AccountAliases } from "./account-aliases.js";
import { readUsageCache, writeUsageCache, type UsageCache } from "./cache.js";
import { snapshot } from "./http.js";
import { withUsageLock } from "./lock.js";
import { providerIdsFor, resolveProviderAdapter } from "./providers/index.js";
import type { ProviderDeps, UsageContext, UsageSnapshot } from "./types.js";

export const REFRESH_INTERVAL_MS = 5 * 60_000;

export interface RefreshOptions extends ProviderDeps {
  force?: boolean;
  providerIds?: readonly string[];
  aliases?: AccountAliases;
  now?: () => number;
  fetchSnapshot?: (ctx: UsageContext, providerId: string, deps: ProviderDeps) => Promise<UsageSnapshot>;
}

let inFlight: Promise<UsageCache> | undefined;

export function isFresh(cache: UsageCache | undefined, now = Date.now()): cache is UsageCache {
  return cache !== undefined && now - cache.updatedAt < REFRESH_INTERVAL_MS;
}

async function defaultFetch(ctx: UsageContext, providerId: string, deps: ProviderDeps): Promise<UsageSnapshot> {
  const adapter = resolveProviderAdapter(deps.baseProviderId ?? providerId);
  if (!adapter) {
    return snapshot(providerId, providerId, true, deps.now?.() ?? Date.now(), {
      status: "unsupported",
      detail: "暂无可用的订阅额度查询接口",
    });
  }
  const result = await adapter.fetch(ctx, providerId, deps);
  return deps.accountAliasSuffix
    ? { ...result, name: `${adapter.name} ${deps.accountAliasSuffix}` }
    : result;
}

function hasProviderSet(cache: UsageCache, providerIds: readonly string[]): boolean {
  const cachedIds = new Set(cache.snapshots.map((snapshot) => snapshot.providerId));
  return cachedIds.size === providerIds.length && providerIds.every((providerId) => cachedIds.has(providerId));
}

async function refreshLocked(ctx: UsageContext, options: RefreshOptions, providerIds: readonly string[]): Promise<UsageCache> {
  const now = options.now ?? Date.now;
  return withUsageLock(async () => {
    const cached = await readUsageCache();
    if (!options.force && isFresh(cached, now()) && hasProviderSet(cached, providerIds)) return cached;
    const fetchSnapshot = options.fetchSnapshot ?? defaultFetch;
    const companionProviderIds = providerIds.filter((providerId) =>
      resolveProviderAdapter(providerId, options.aliases)?.id === "openai-codex");
    const snapshots: UsageSnapshot[] = [];
    for (const providerId of providerIds) {
      snapshots.push(await fetchSnapshot(ctx, providerId, {
        now,
        baseProviderId: baseProviderId(providerId, options.aliases),
        companionProviderIds,
        ...(options.aliases?.[providerId]?.suffix ? { accountAliasSuffix: options.aliases[providerId].suffix } : {}),
        ...(options.readCredential ? { readCredential: options.readCredential } : {}),
      }));
    }
    return writeUsageCache(snapshots, now());
  });
}

export async function refreshUsage(ctx: UsageContext, options: RefreshOptions = {}): Promise<UsageCache> {
  const providerIds = providerIdsFor(options.providerIds ?? []);
  const cached = await readUsageCache();
  if (!options.force && isFresh(cached, options.now?.() ?? Date.now()) && hasProviderSet(cached, providerIds)) return cached;
  if (inFlight) return inFlight;
  inFlight = refreshLocked(ctx, options, providerIds);
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}
