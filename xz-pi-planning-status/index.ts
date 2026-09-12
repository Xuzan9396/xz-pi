import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveXzCommand } from "./src/command.js";
import { readGlobalEnabled, writeGlobalEnabled } from "./src/config.js";
import { parseLatestCurrentPlan, type CurrentPlan } from "./src/planning.js";

// Footer statuses are sorted by key. This key keeps the plan before MCP's "mcp" status.
const STATUS_ID = "0-xz-planning-status";
const STATE_RELATIVE_PATH = join(".xz_planning", "STATE.md");
const WATCH_DEBOUNCE_MS = 80;

export default function xzPiPlanningStatus(pi: ExtensionAPI): void {
  let enabled = readGlobalEnabled();
  let currentPlan: CurrentPlan | null = null;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshGeneration = 0;
  let activeContext: ExtensionContext | null = null;

  function closeWatcher(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    watcher?.close();
    watcher = null;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !enabled || !currentPlan) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    const prefix = ctx.ui.theme.fg("accent", ctx.ui.theme.bold("当前计划："));
    const version = ctx.ui.theme.fg("warning", currentPlan.version);
    const requirement = ctx.ui.theme.fg("muted", ` · ${currentPlan.requirement}`);
    ctx.ui.setStatus(STATUS_ID, prefix + version + requirement);
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    const generation = ++refreshGeneration;
    let nextPlan: CurrentPlan | null = null;
    try {
      const markdown = await readFile(join(ctx.cwd, STATE_RELATIVE_PATH), "utf8");
      nextPlan = parseLatestCurrentPlan(markdown);
    } catch {
      // Missing and unreadable files intentionally produce an empty display.
    }
    if (generation !== refreshGeneration || ctx !== activeContext) return;
    currentPlan = nextPlan;
    updateStatus(ctx);
  }

  function scheduleRefresh(ctx: ExtensionContext, restartWatcher = false): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh(ctx);
      if (restartWatcher && ctx === activeContext && enabled) startWatcher(ctx);
    }, WATCH_DEBOUNCE_MS);
  }

  function startWatcher(ctx: ExtensionContext): void {
    closeWatcher();
    const planningDirectory = join(ctx.cwd, ".xz_planning");

    try {
      const watchPlanningDirectory = existsSync(planningDirectory) && statSync(planningDirectory).isDirectory();
      const watchPath = watchPlanningDirectory ? planningDirectory : ctx.cwd;
      const nextWatcher = watch(watchPath, (_eventType, filename) => {
        const changedName = filename === null ? "" : filename.toString();
        if (watchPlanningDirectory) {
          if (changedName === "" || changedName === "STATE.md") scheduleRefresh(ctx);
        } else if (changedName === "" || changedName === ".xz_planning") {
          scheduleRefresh(ctx, true);
        }
      });
      watcher = nextWatcher;
      nextWatcher.on("error", () => {
        nextWatcher.close();
        if (watcher === nextWatcher) watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  pi.registerCommand("xz", {
    description: "Toggle the global XZ current-plan display (on, off, status)",
    handler: async (args, ctx) => {
      const result = resolveXzCommand(args, enabled);
      if (result.kind === "invalid") {
        ctx.ui.notify("Usage: /xz [on|off|status]", "warning");
        return;
      }
      if (result.kind === "status") {
        const detail = enabled && currentPlan ? `：${currentPlan.version} · ${currentPlan.requirement}` : "";
        ctx.ui.notify(`XZ 当前计划展示已${enabled ? "开启" : "关闭"}${detail}`, "info");
        return;
      }

      try {
        writeGlobalEnabled(result.enabled);
      } catch (error: unknown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      enabled = result.enabled;
      // Command handlers receive a fresh context object. Make it active before
      // refreshing so /xz on does not discard its own result as stale.
      activeContext = ctx;
      if (enabled) {
        await refresh(ctx);
        if (ctx === activeContext) startWatcher(ctx);
      } else {
        closeWatcher();
        currentPlan = null;
        updateStatus(ctx);
      }
      ctx.ui.notify(`XZ 当前计划展示已${enabled ? "开启" : "关闭"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    enabled = readGlobalEnabled();
    currentPlan = null;
    closeWatcher();
    if (!enabled) {
      updateStatus(ctx);
      return;
    }
    await refresh(ctx);
    if (ctx === activeContext) startWatcher(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refreshGeneration++;
    closeWatcher();
    ctx.ui.setStatus(STATUS_ID, undefined);
    activeContext = null;
    currentPlan = null;
  });
}
