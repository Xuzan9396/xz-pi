import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUsageCache, usageCachePath } from "../src/cache.js";
import { refreshUsage } from "../src/refresh.js";
import type { UsageContext } from "../src/types.js";

const ctx: UsageContext = { modelRegistry: { getProviderAuth: async () => undefined } };

test("old cache format is ignored so new fields are fetched", async () => {
  process.env.XZ_PI_USAGE_DIR = mkdtempSync(join(tmpdir(), "xz-pi-usage-old-cache-"));
  writeFileSync(usageCachePath(), JSON.stringify({ version: 1, updatedAt: Date.now(), snapshots: [] }));
  assert.equal(await readUsageCache(), undefined);
});

test("cache refresh runs one provider sweep and stores only sanitized snapshot data", async () => {
  process.env.XZ_PI_USAGE_DIR = mkdtempSync(join(tmpdir(), "xz-pi-usage-cache-"));
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const seen: string[] = [];
  const providerIds = ["openai-codex-personal", "github-copilot"];
  const fetchSnapshot = async (_ctx: UsageContext, providerId: string) => {
    calls += 1;
    seen.push(providerId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return {
      providerId,
      name: providerId,
      status: "ok" as const,
      verified: true,
      windows: [{ label: "5h", usedPercent: 12, resetAt: 2 }],
      credits: [],
      resetCredits: { available: 1, expiresAt: [3] },
      fetchedAt: 1,
      token: "secret-token",
      login: "private-login",
    };
  };

  const [first, second] = await Promise.all([
    refreshUsage(ctx, { providerIds, now: () => 1_000, fetchSnapshot }),
    refreshUsage(ctx, { providerIds, now: () => 1_000, fetchSnapshot }),
  ]);
  assert.equal(first, second);
  assert.equal(calls, 2);
  assert.deepEqual(seen, providerIds);
  assert.equal(maxActive, 1);
  assert.equal((statSync(usageCachePath()).mode & 0o777), 0o600);
  assert.doesNotMatch(readFileSync(usageCachePath(), "utf8"), /secret-token|private-login/);

  await refreshUsage(ctx, { providerIds, now: () => 2_000, fetchSnapshot });
  assert.equal(calls, 2);
  await refreshUsage(ctx, { providerIds, now: () => 2_000, fetchSnapshot, force: true });
  assert.equal(calls, 4);
  assert.equal((await readUsageCache())?.snapshots.length, 2);
  assert.deepEqual((await readUsageCache())?.snapshots[0]?.resetCredits, { available: 1, expiresAt: [3] });

  await refreshUsage(ctx, { providerIds: ["openai-codex-personal"], now: () => 3_000, fetchSnapshot });
  assert.equal(calls, 5);
  assert.deepEqual((await readUsageCache())?.snapshots.map((item) => item.providerId), ["openai-codex-personal"]);
});
