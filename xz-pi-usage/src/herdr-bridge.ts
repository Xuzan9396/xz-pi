// Optional Herdr pane adapter bundled with xz-pi-usage. It uses Herdr's
// public CLI and a small file protocol, but imports no Herdr plugin code.
// Outside a Herdr-managed pane it does not start timers or write files.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageCache } from "./cache.js";
import { readUsageCache } from "./cache.js";

type BridgeContext = { model?: { provider: string; id: string } | undefined };
type Reporter = (args: string[]) => void;

const TOKEN_TTL_MS = 15 * 60_000;
const MAX_CACHE_AGE_MS = 60 * 60_000;
const TOKENS = ["usage", "usage_5h", "usage_wk", "usage_model", "usage_model_name", "usage_credits",
  "usage_reset", "usage_plan", "usage_provider", ...["5h", "wk"].flatMap((kind) =>
    ["ok", "low", "crit"].map((grade) => `usage_${kind}_${grade}`))];

function bridgeDir(env: NodeJS.ProcessEnv): string {
  return env.HERDRX_PI_BRIDGE_DIR || join(env.HERDR_PLUGIN_CONFIG_DIR ||
    join(homedir(), ".config", "herdr", "plugins", "config", "herdr%58"), "pi-bridge");
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function defaultReport(args: string[]): void {
  const result = spawnSync(process.env.HERDR_BIN_PATH ?? "herdr", args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || "Herdr metadata report failed");
}

function metadata(model: BridgeContext["model"], cache: UsageCache | undefined, now: number): Record<string, string | null> {
  const values: Record<string, string | null> = Object.fromEntries(TOKENS.map((key) => [key, null]));
  if (!model?.provider || !model.id) return values;
  values.usage_provider = model.provider;
  values.usage_model_name = model.id;
  if (!cache || now < cache.updatedAt || now - cache.updatedAt >= MAX_CACHE_AGE_MS) return values;
  const provider = cache.snapshots.find((item) => item.providerId === model.provider && item.status === "ok");
  if (!provider) return values;
  values.usage_plan = provider.plan ?? null;
  const remaining = (used: number) => Math.max(0, Math.min(100, Math.round(100 - used)));
  const parts: string[] = [];
  for (const window of provider.windows) {
    const kind = window.label === "7d" ? "wk" : window.label;
    const percent = remaining(window.usedPercent);
    parts.push(`${kind} ${percent}%`);
    if (kind !== "wk" && kind !== "5h") continue;
    const text = `${kind} ${percent}%`;
    values[`usage_${kind}`] = text;
    values[`usage_${kind}_${percent < 10 ? "crit" : percent < 25 ? "low" : "ok"}`] = text;
  }
  for (const credit of provider.credits) {
    parts.push(`${credit.label === "AI credits" ? "AI" : credit.label} ${Math.round(credit.used)}${credit.limit ? `/${credit.limit}` : ""} used`);
    if (model.provider === "github-copilot" && credit.label === "AI credits") {
      values.usage_credits = `◆ ${compactCount(credit.used)}${credit.limit ? `/${compactCount(credit.limit)}` : ""}已用`;
    }
  }
  values.usage = parts.join(" · ") || null;
  const lowest = [...provider.windows].sort((a, b) => remaining(a.usedPercent) - remaining(b.usedPercent))[0];
  if (lowest?.resetAt) {
    const date = new Date(lowest.resetAt);
    if (!Number.isNaN(date.valueOf())) {
      const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      const today = new Date(now);
      const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
      values.usage_reset = `${lowest.label === "7d" ? "wk" : lowest.label} ↻ ${sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`}`;
    }
  }
  return values;
}

export interface BridgeOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readCache?: () => Promise<UsageCache | undefined>;
  report?: Reporter;
  refresh: () => Promise<unknown>;
}

export function createHerdrBridge({ env = process.env, now = Date.now, readCache = readUsageCache,
  report = defaultReport, refresh }: BridgeOptions) {
  const paneID = env.HERDR_PANE_ID;
  const dir = bridgeDir(env);
  const owner = randomUUID();
  const statePath = paneID ? join(dir, `pane-${encodeURIComponent(paneID)}.json`) : "";
  let active: BridgeContext | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let selected: string | undefined;
  let generation = 0;

  function publishState(ctx: BridgeContext): void {
    if (!paneID) return;
    if (!ctx.model?.provider || !ctx.model.id) {
      clearState();
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = `${statePath}.${owner}.tmp`;
    writeFileSync(path, JSON.stringify({ providerId: ctx.model.provider, model: ctx.model.id, owner, updatedAt: now() }), { mode: 0o600 });
    renameSync(path, statePath);
  }

  function clearState(): void {
    if (!paneID) return;
    try {
      if (JSON.parse(readFileSync(statePath, "utf8")).owner === owner) unlinkSync(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function reportRows(model: BridgeContext["model"], revision: number): Promise<void> {
    if (!paneID) return;
    try {
      const cache = await readCache();
      if (revision !== generation || !active) return;
      const args = ["pane", "report-metadata", paneID, "--source", "herdrX-usage", "--ttl-ms", String(TOKEN_TTL_MS)];
      for (const [name, value] of Object.entries(metadata(model, cache, now()))) {
        args.push(...(value === null ? ["--clear-token", name] : ["--token", `${name}=${value}`]));
      }
      report(args);
    } catch (error) {
      // Herdr may not be running yet; its scheduled tick repairs missed rows.
      console.error(`xz-pi-usage: Herdr metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function publish(ctx: BridgeContext): Promise<void> {
    if (!paneID) return;
    publishState(ctx);
    const key = ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}\0${ctx.model.id}` : undefined;
    if (key === selected) return; // heartbeat only updates the timestamp
    selected = key;
    await reportRows(ctx.model, ++generation);
  }

  function finish(id: string, outcome: { status: "ok" | "error"; error?: string }): void {
    if (pending !== id) return;
    pending = undefined;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    const path = join(dir, `result-${id}.json`);
    const tmp = `${path}.${owner}.tmp`;
    writeFileSync(tmp, JSON.stringify(outcome), { mode: 0o600 });
    renameSync(tmp, path);
  }

  function check(): void {
    if (!paneID || !active || pending) return;
    let files: string[];
    try { files = readdirSync(dir).filter((name) => name.startsWith("request-") && name.endsWith(".json")).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of files) {
      let id: string;
      try {
        const request = JSON.parse(readFileSync(join(dir, name), "utf8")) as { id: string; createdAt: number };
        if (now() < request.createdAt || now() - request.createdAt > 60_000) continue;
        mkdirSync(join(dir, `claim-${request.id}`), { mode: 0o700 });
        id = request.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
      pending = id;
      timeout = setTimeout(() => finish(id, { status: "error", error: "Pi usage refresh timed out" }), 40_000);
      timeout.unref?.();
      void refresh().then(async () => {
        finish(id, { status: "ok" });
        await reportRows(active?.model, generation);
      }, () => finish(id, { status: "error", error: "Unable to refresh usage" }));
      return;
    }
  }

  return {
    async start(ctx: BridgeContext): Promise<void> {
      if (!paneID) return;
      active = ctx;
      await publish(ctx);
      if (heartbeat) clearInterval(heartbeat);
      if (poll) clearInterval(poll);
      heartbeat = setInterval(() => { if (active) void publish(active).catch(() => {}); }, 30_000);
      poll = setInterval(() => { try { check(); } catch (error) { console.error(`xz-pi-usage: Herdr request: ${String(error)}`); } }, 1_000);
      heartbeat.unref?.();
      poll.unref?.();
      check();
    },
    async modelSelect(ctx: BridgeContext): Promise<void> {
      if (!paneID) return;
      active = ctx;
      await publish(ctx);
    },
    stop(): void {
      if (!paneID) return;
      if (pending) finish(pending, { status: "error", error: "Pi session closed" });
      active = undefined;
      generation += 1;
      if (heartbeat) clearInterval(heartbeat);
      if (poll) clearInterval(poll);
      heartbeat = undefined;
      poll = undefined;
      clearState();
    },
  };
}
