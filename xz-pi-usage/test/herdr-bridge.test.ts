import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createXzPiUsage } from "../index.js";
import { writeUsageCache, type UsageCache } from "../src/cache.js";
import { createHerdrBridge } from "../src/herdr-bridge.js";

const cache = (providerId = "github-copilot") => ({
  version: 2 as const, updatedAt: Date.now(), snapshots: [
    { providerId, name: "Copilot", status: "ok" as const, verified: true,
      fetchedAt: Date.now(), windows: [], credits: [{ label: "AI credits", used: 1634 }] },
  ],
});
const ctx = (provider: string, id: string) => ({ model: { provider, id } });

async function response(dir: string, id: string) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(readFileSync(join(dir, `result-${id}.json`), "utf8")); }
    catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw new Error("bridge did not respond");
}

test("loading xz-pi-usage alone activates its bridge in a Herdr pane", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bundled-bridge-"));
  const saved = Object.fromEntries(["HERDR_PANE_ID", "HERDRX_PI_BRIDGE_DIR", "HERDR_BIN_PATH",
    "XZ_PI_USAGE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_PANE_ID: "test:p1", HERDRX_PI_BRIDGE_DIR: dir,
    HERDR_BIN_PATH: "/usr/bin/true", XZ_PI_USAGE_DIR: dir, PI_CODING_AGENT_DIR: dir });
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await writeUsageCache(cache().snapshots);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    events: { on() {}, emit() {} }, registerEntryRenderer() {}, registerCommand() {},
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  createXzPiUsage()(pi); // only the package's listed index.ts is installed
  const session = { hasUI: false, model: { provider: "github-copilot", id: "grok-4.7" },
    modelRegistry: { getProviderAuth: async () => undefined } } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({}, session);
  assert.equal(JSON.parse(readFileSync(join(dir, "pane-test%3Ap1.json"), "utf8")).model, "grok-4.7");
  session.model!.id = "gpt-5.6";
  await handlers.get("model_select")?.({}, session);
  assert.equal(JSON.parse(readFileSync(join(dir, "pane-test%3Ap1.json"), "utf8")).model, "gpt-5.6");
  await handlers.get("session_shutdown")?.({}, session);
  assert.ok(!readdirSync(dir).some((name) => name.startsWith("pane-")));
});

test("the usage extension automatically publishes Herdr pane model and compact credit metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-bridge-"));
  const reports: string[][] = [];
  const data: UsageCache = cache();
  data.snapshots.push({ providerId: "openai-codex-work", name: "Codex work", status: "ok", verified: true,
    fetchedAt: Date.now(), windows: [{ label: "7d", usedPercent: 4 }], credits: [] });
  const bridge = createHerdrBridge({
    env: { HERDR_PANE_ID: "w1:p1", HERDRX_PI_BRIDGE_DIR: dir },
    readCache: async () => data,
    report: (args: string[]) => { reports.push(args); },
    refresh: async () => {},
  });
  await bridge.start(ctx("github-copilot", "grok-4.7"));
  const state = JSON.parse(readFileSync(join(dir, "pane-w1%3Ap1.json"), "utf8"));
  assert.equal(state.providerId, "github-copilot");
  assert.equal(state.model, "grok-4.7");
  assert.ok(reports[0]?.includes("usage_credits=◆ 1.6K已用"));
  assert.ok(reports[0]?.includes("usage_provider=github-copilot"));
  await bridge.modelSelect(ctx("openai-codex-work", "gpt-6"));
  assert.ok(reports[1]?.includes("--clear-token"));
  assert.ok(reports[1]?.includes("usage_provider=openai-codex-work"));
  assert.ok(reports[1]?.includes("usage_model_name=gpt-6"));
  assert.ok(reports[1]?.includes("usage_wk=wk 96%"));
  assert.ok(!reports[1]?.includes("usage_credits=◆ 1.6K已用"));
  bridge.stop();
  assert.ok(!readdirSync(dir).some((name) => name.startsWith("pane-")));
});

test("one installed usage extension claims a refresh request once, without a separate bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-refresh-"));
  const id = "same-request";
  writeFileSync(join(dir, `request-${id}.json`), JSON.stringify({ id, createdAt: Date.now() }));
  let calls = 0;
  const options = { env: { HERDR_PANE_ID: "w1:p1", HERDRX_PI_BRIDGE_DIR: dir },
    readCache: async () => cache(), report: () => {}, refresh: async () => { calls += 1; } };
  const first = createHerdrBridge(options);
  const second = createHerdrBridge(options);
  await first.start(ctx("github-copilot", "gpt-5"));
  await second.start(ctx("github-copilot", "gpt-5"));
  assert.deepEqual(await response(dir, id), { status: "ok" });
  assert.equal(calls, 1);
  first.stop();
  second.stop();
});

test("bundled bridge reports a provider refresh failure without marking it successful", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-failure-"));
  const id = "failed-request";
  writeFileSync(join(dir, `request-${id}.json`), JSON.stringify({ id, createdAt: Date.now() }));
  const bridge = createHerdrBridge({ env: { HERDR_PANE_ID: "w1:p1", HERDRX_PI_BRIDGE_DIR: dir },
    readCache: async () => cache(), report: () => {}, refresh: async () => { throw new Error("secret"); } });
  await bridge.start(ctx("github-copilot", "gpt-5"));
  assert.deepEqual(await response(dir, id), { status: "error", error: "Unable to refresh usage" });
  bridge.stop();
});

test("outside a Herdr pane the bridge has no side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inert-bridge-"));
  const bridge = createHerdrBridge({ env: { HERDRX_PI_BRIDGE_DIR: dir },
    readCache: async () => cache(), report: () => { throw new Error("unexpected report"); },
    refresh: async () => { throw new Error("unexpected refresh"); } });
  await bridge.start(ctx("github-copilot", "gpt-5"));
  assert.deepEqual(readdirSync(dir), []);
  bridge.stop();
});
