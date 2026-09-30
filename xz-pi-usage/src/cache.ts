import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { clampPercent, clean } from "./http.js";
import type { UsageCredits, UsageResetCredits, UsageSnapshot, UsageStatus, UsageWindow } from "./types.js";

export interface UsageCache {
  version: 2;
  updatedAt: number;
  snapshots: UsageSnapshot[];
}

const STATUSES = new Set<UsageStatus>([
  "ok",
  "unconnected",
  "expired",
  "denied",
  "rate_limited",
  "endpoint_changed",
  "network",
  "unsupported",
  "error",
]);

export function usageDataDir(): string {
  return process.env.XZ_PI_USAGE_DIR || join(getAgentDir(), "xz-pi-usage");
}

export function usageCachePath(): string {
  return join(usageDataDir(), "cache.json");
}

function finiteTimestamp(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function sanitizeWindow(value: any): UsageWindow | undefined {
  const label = clean(value?.label, 24);
  if (!label) return undefined;
  const resetAt = finiteTimestamp(value?.resetAt);
  const windowMs = finiteTimestamp(value?.windowMs);
  return {
    label,
    usedPercent: clampPercent(value?.usedPercent),
    ...(resetAt ? { resetAt } : {}),
    ...(windowMs ? { windowMs } : {}),
  };
}

function sanitizeCredits(value: any): UsageCredits | undefined {
  const label = clean(value?.label, 24);
  const used = Number(value?.used);
  if (!label || !Number.isFinite(used) || used < 0) return undefined;
  const limit = Number(value?.limit);
  const resetAt = finiteTimestamp(value?.resetAt);
  return {
    label,
    used,
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function sanitizeResetCredits(value: any): UsageResetCredits | undefined {
  const available = Math.trunc(Number(value?.available));
  if (!Number.isFinite(available) || available <= 0) return undefined;
  return {
    available: Math.min(available, 999),
    expiresAt: (Array.isArray(value?.expiresAt) ? value.expiresAt : [])
      .map(finiteTimestamp)
      .filter((item: number | undefined): item is number => item !== undefined)
      .slice(0, 20),
  };
}

export function sanitizeSnapshot(value: any): UsageSnapshot | undefined {
  const providerId = clean(value?.providerId, 64);
  const name = clean(value?.name, 40);
  const status = STATUSES.has(value?.status) ? value.status as UsageStatus : "error";
  const fetchedAt = finiteTimestamp(value?.fetchedAt);
  if (!providerId || !name || !fetchedAt) return undefined;
  const plan = clean(value?.plan, 40);
  const detail = clean(value?.detail, 80);
  const resetCredits = sanitizeResetCredits(value?.resetCredits);
  return {
    providerId,
    name,
    status,
    verified: value?.verified === true,
    windows: (Array.isArray(value?.windows) ? value.windows : []).map(sanitizeWindow).filter(Boolean).slice(0, 8) as UsageWindow[],
    credits: (Array.isArray(value?.credits) ? value.credits : []).map(sanitizeCredits).filter(Boolean).slice(0, 4) as UsageCredits[],
    fetchedAt,
    ...(plan ? { plan } : {}),
    ...(detail ? { detail } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

export async function readUsageCache(path = usageCachePath()): Promise<UsageCache | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const updatedAt = finiteTimestamp(value.updatedAt);
    if (value.version !== 2 || !updatedAt || !Array.isArray(value.snapshots)) return undefined;
    return {
      version: 2,
      updatedAt,
      snapshots: value.snapshots.map(sanitizeSnapshot).filter(Boolean) as UsageSnapshot[],
    };
  } catch {
    return undefined;
  }
}

export async function writeUsageCache(snapshots: readonly UsageSnapshot[], updatedAt = Date.now(), path = usageCachePath()): Promise<UsageCache> {
  const cache: UsageCache = {
    version: 2,
    updatedAt,
    snapshots: snapshots.map(sanitizeSnapshot).filter(Boolean) as UsageSnapshot[],
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
  return cache;
}
