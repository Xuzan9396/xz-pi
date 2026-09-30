import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createXzPiUsage, formatFooter } from "../index.js";
import { formatDashboard } from "../src/format.js";
import { writeUsageCache } from "../src/cache.js";
import type { UsageSnapshot } from "../src/types.js";

const snapshots: UsageSnapshot[] = [
  {
    providerId: "openai-codex-personal",
    name: "Codex personal",
    status: "ok",
    verified: true,
    windows: [{ label: "5h", usedPercent: 93, resetAt: Date.now() + 7_200_000 }],
    credits: [],
    fetchedAt: Date.now(),
  },
  {
    providerId: "github-copilot",
    name: "Copilot",
    status: "ok",
    verified: true,
    windows: [],
    credits: [{ label: "AI credits", used: 172 }],
    fetchedAt: Date.now(),
  },
];

test("footer shows only the selected provider and never falls back to Copilot", () => {
  const codex = formatFooter(snapshots, "openai-codex-personal") ?? "";
  assert.match(codex, /^◎p 5h7% 2h0m$/);
  assert.doesNotMatch(codex, /Copilot/);
  assert.equal(formatFooter(snapshots, "github-copilot"), "◆ 172已用");
  assert.equal(formatFooter(snapshots, "anthropic"), undefined);
  assert.equal(formatFooter(snapshots, undefined), undefined);
});

test("footer abbreviates weekly remaining quota, reset time, and reset credits", () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const weekly: UsageSnapshot = {
    providerId: "openai-codex-personal", name: "Codex personal", status: "ok", verified: true,
    windows: [{ label: "7d", usedPercent: 5, resetAt: now + 6 * 86_400_000 }],
    credits: [], resetCredits: { available: 3, expiresAt: [] }, fetchedAt: now,
  };
  assert.equal(formatFooter([weekly], weekly.providerId, now), "◎p wk95% 6d0h · ↻3");
  assert.equal(formatFooter([{ ...weekly, providerId: "openai-codex-work", name: "Codex work" }], "openai-codex-work", now), "◎w wk95% 6d0h · ↻3");
  assert.equal(formatFooter([{ ...weekly, windows: [{ label: "7d", usedPercent: 100, resetAt: now }] }], weekly.providerId, now), "◎p wk0% 0m · ↻3");
  assert.equal(formatFooter([{ ...weekly, windows: [{ label: "5h", usedPercent: 0 }] }], weekly.providerId, now), "◎p 5h100% · ↻3");
  assert.equal(formatFooter([{ ...weekly, status: "network" }], weekly.providerId, now), undefined);
  const copilot: UsageSnapshot = {
    providerId: "github-copilot", name: "Copilot", status: "ok", verified: true,
    windows: [], credits: [{ label: "AI credits", used: 172, limit: 500, resetAt: now + 3 * 86_400_000 }],
    fetchedAt: now,
  };
  assert.equal(formatFooter([copilot], copilot.providerId, now), "◆ 172/500已用 · ↻3d0h");
  assert.equal(formatFooter([{ ...copilot, credits: [{ label: "AI credits", used: 1634, resetAt: now + 3 * 86_400_000 }] }],
    copilot.providerId, now), "◆ 1.6K已用 · ↻3d0h");
});

test("footer uses distinct symbols for supported providers", () => {
  const expected = new Map([
    ["openai-codex", "◎"], ["github-copilot", "◆"], ["anthropic", "✦"],
    ["kimi-coding", "☾"], ["xai", "𝕏"], ["zai", "◇"],
    ["zai-coding-cn", "◇"], ["minimax", "▣"], ["minimax-cn", "▣"],
  ]);
  for (const [providerId, symbol] of expected) {
    const item: UsageSnapshot = {
      providerId, name: providerId, status: "ok", verified: true,
      windows: [{ label: "5h", usedPercent: 25 }], credits: [], fetchedAt: 1,
    };
    assert.equal(formatFooter([item], providerId, 1), `${symbol} 5h75%`);
  }
});

test("extension shows cached status, refreshes every five minutes, and clears on shutdown", async (t) => {
  process.env.XZ_PI_USAGE_DIR = mkdtempSync(join(tmpdir(), "xz-pi-usage-extension-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPaneID = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID; // never publish to the test runner's actual Herdr pane
  process.env.PI_CODING_AGENT_DIR = process.env.XZ_PI_USAGE_DIR;
  t.after(() => {
    if (previousPaneID === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPaneID;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  writeFileSync(join(process.env.XZ_PI_USAGE_DIR, "auth.json"), JSON.stringify({ "github-copilot": {}, "openai-codex-personal": {} }));
  await writeUsageCache(snapshots, Date.now());
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (data: unknown) => void>();
  const results: unknown[] = [];
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let entry: { snapshots: UsageSnapshot[]; authOrder: string[] } | undefined;
  const pi = {
    events: {
      on: (name: string, handler: (data: unknown) => void) => { events.set(name, handler); },
      emit: (name: string, data: unknown) => {
        if (name === "xz-pi-usage:refresh-result") results.push(data);
        events.get(name)?.(data);
      },
    },
    registerEntryRenderer() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      command = options.handler;
    },
    appendEntry(_name: string, data: { snapshots: UsageSnapshot[]; authOrder: string[] }) {
      entry = data;
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const statuses: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai-codex-personal" },
    modelRegistry: { getProviderAuth: async () => undefined },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  } as unknown as ExtensionContext;
  let intervalMs = 0;
  let cleared = false;
  const token = { unref() {} } as ReturnType<typeof setInterval>;
  createXzPiUsage({
    setInterval: ((_callback: () => void, ms?: number) => {
      intervalMs = ms ?? 0;
      return token;
    }) as typeof setInterval,
    clearInterval: ((value: ReturnType<typeof setInterval>) => {
      cleared = value === token;
    }) as typeof clearInterval,
  })(pi);

  await handlers.get("session_start")?.({}, ctx);
  assert.equal(intervalMs, 300_000);
  assert.match(statuses[0] ?? "", /^◎p 5h7%/);
  assert.doesNotMatch(statuses[0] ?? "", /Copilot/);
  ctx.model!.provider = "github-copilot";
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(statuses.at(-1), "◆ 172已用");
  ctx.model!.provider = "anthropic";
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(statuses.at(-1), undefined);
  await command?.("", ctx);
  assert.deepEqual(entry?.snapshots, snapshots);
  assert.deepEqual(entry?.authOrder, ["github-copilot", "openai-codex-personal"]);
  const dashboard = formatDashboard(entry?.snapshots ?? [], Date.now(), entry?.authOrder);
  assert.ok(dashboard.indexOf("\nCopilot\n") < dashboard.indexOf("\nCodex personal\n"));
  events.get("xz-pi-usage:refresh-request")?.({ id: "success", force: true });
  for (let i = 0; i < 100 && results.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(results[0], { id: "success", status: "ok" });
  const originalDir = process.env.XZ_PI_USAGE_DIR;
  const blocked = join(originalDir!, "not-a-directory");
  writeFileSync(blocked, "occupied");
  process.env.XZ_PI_USAGE_DIR = blocked;
  events.get("xz-pi-usage:refresh-request")?.({ id: "failure", force: true });
  for (let i = 0; i < 100 && results.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  process.env.XZ_PI_USAGE_DIR = originalDir;
  assert.deepEqual(results[1], { id: "failure", status: "error", error: "Unable to refresh usage" });
  await handlers.get("session_shutdown")?.({}, ctx);
  events.get("xz-pi-usage:refresh-request")?.({ id: "after-shutdown", force: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(results.length, 2);
  assert.equal(cleared, true);
  assert.equal(statuses.at(-1), undefined);
});
