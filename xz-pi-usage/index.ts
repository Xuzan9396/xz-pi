import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readUsageCache } from "./src/cache.js";
import { formatDashboard, formatReset, readAuthProviderOrder } from "./src/format.js";
import { clean } from "./src/http.js";
import { createHerdrBridge } from "./src/herdr-bridge.js";
import { REFRESH_INTERVAL_MS, refreshUsage } from "./src/refresh.js";
import type { UsageSnapshot } from "./src/types.js";

const STATUS_ID = "1-xz-usage";

interface TimerApi {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

function footerProvider(providerId: string, name: string): string {
  if (providerId === "openai-codex-personal") return "◎p";
  if (providerId === "openai-codex-work") return "◎w";
  if (providerId === "openai-codex") return "◎";
  if (providerId.startsWith("openai-codex-")) return `◎${clean(providerId.slice("openai-codex-".length), 24)}`;
  if (providerId === "github-copilot") return "◆";
  if (providerId === "anthropic") return "✦";
  if (providerId === "kimi-coding") return "☾";
  if (providerId === "xai") return "𝕏";
  if (providerId === "zai" || providerId === "zai-coding-cn") return "◇";
  if (providerId === "minimax" || providerId === "minimax-cn") return "▣";
  return clean(name, 40);
}

function compactCount(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return rounded.toLocaleString("en-US");
}

function footerReset(resetAt: number | undefined, now: number): string {
  const reset = formatReset(resetAt, now);
  return reset ? ` ${reset === "即将重置" ? "0m" : reset.replace(" 后重置", "").replace(/ /g, "")}` : "";
}

export function formatFooter(snapshots: readonly UsageSnapshot[], currentProvider: string | undefined, now = Date.now()): string | undefined {
  const current = snapshots.find((item) => item.providerId === currentProvider && item.status === "ok");
  if (!current) return undefined;
  const values = [
    ...current.windows.map((window) => {
      const label = clean(window.label, 24).replace(/^7d(?=\s|$)/, "wk");
      return `${label}${Math.round(100 - window.usedPercent)}%${footerReset(window.resetAt, now)}`;
    }),
    ...current.credits.map((credits) => {
      if (current.providerId === "github-copilot" && credits.label === "AI credits") {
        const amount = `${compactCount(credits.used)}${credits.limit ? `/${compactCount(credits.limit)}` : ""}`;
        const reset = footerReset(credits.resetAt, now);
        return `${amount}已用${reset ? ` · ↻${reset.trim()}` : ""}`;
      }
      const used = Math.round(credits.used).toLocaleString("en-US");
      const limit = credits.limit && credits.limit > 0 ? `/${Math.round(credits.limit).toLocaleString("en-US")}` : "";
      const label = credits.label === "AI credits" ? "AI" : clean(credits.label, 24);
      return `${label}${used}${limit}用${footerReset(credits.resetAt, now)}`;
    }),
    ...(current.resetCredits ? [`↻${current.resetCredits.available}`] : []),
  ];
  return values.length ? `${footerProvider(current.providerId, current.name)} ${values.join(" · ")}` : undefined;
}

export function createXzPiUsage(timers: TimerApi = { setInterval, clearInterval }) {
  return function xzPiUsage(pi: ExtensionAPI): void {
    let activeContext: ExtensionContext | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let snapshots: UsageSnapshot[] = [];
    let generation = 0;
    let lifecycle = 0;
    const bridge = createHerdrBridge({ refresh: async () => {
      if (!activeContext) throw new Error("No active Pi session");
      await refresh(activeContext, true);
    } });

    function render(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;
      const text = formatFooter(snapshots, ctx.model?.provider);
      ctx.ui.setStatus(STATUS_ID, text ? ctx.ui.theme.fg("muted", text) : undefined);
    }

    async function refresh(ctx: ExtensionContext, force = false): Promise<UsageSnapshot[]> {
      const current = ++generation;
      const providerIds = await readAuthProviderOrder();
      const cache = await refreshUsage(ctx, {
        force,
        providerIds,
        readCredential: readStoredCredential,
      });
      if (current === generation && ctx === activeContext) {
        snapshots = cache.snapshots;
        render(ctx);
      }
      return cache.snapshots;
    }

    function stopTimer(): void {
      if (interval) timers.clearInterval(interval);
      interval = undefined;
    }

    // Generic inter-extension API: callers request a refresh and receive a
    // correlated result. No caller-specific pane, transport, or UI state lives here.
    pi.events.on("xz-pi-usage:refresh-request", (data) => {
      const request = data as { id?: unknown; force?: unknown } | null;
      if (typeof request?.id !== "string" || !request.id || !activeContext) return;
      const ctx = activeContext;
      const current = lifecycle;
      void refresh(ctx, request.force === true).then(
        () => {
          if (activeContext === ctx && lifecycle === current) {
            pi.events.emit("xz-pi-usage:refresh-result", { id: request.id, status: "ok" });
          }
        },
        () => {
          if (activeContext === ctx && lifecycle === current) {
            pi.events.emit("xz-pi-usage:refresh-result", { id: request.id, status: "error", error: "Unable to refresh usage" });
          }
        },
      );
    });

    pi.registerEntryRenderer<{ snapshots: UsageSnapshot[]; authOrder: string[] }>("xz-usage", (entry) => (
      new Text(formatDashboard(entry.data?.snapshots ?? [], Date.now(), entry.data?.authOrder), 0, 0)
    ));

    pi.registerCommand("xz-usage", {
      description: "Show subscription quota windows and reset times (--refresh to force)",
      handler: async (args, ctx) => {
        const flags = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (flags.some((flag) => flag !== "--refresh")) {
          ctx.ui.notify("Usage: /xz-usage [--refresh]", "warning");
          return;
        }
        activeContext = ctx;
        const result = await refresh(ctx, flags.includes("--refresh"));
        pi.appendEntry("xz-usage", { snapshots: result, authOrder: await readAuthProviderOrder() });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      lifecycle += 1;
      activeContext = ctx;
      snapshots = (await readUsageCache())?.snapshots ?? [];
      render(ctx);
      stopTimer();
      interval = timers.setInterval(() => {
        if (activeContext) void refresh(activeContext).catch(() => {});
      }, REFRESH_INTERVAL_MS);
      interval.unref?.();
      void refresh(ctx).catch(() => {});
      await bridge.start(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
      activeContext = ctx;
      render(ctx);
      void refresh(ctx).catch(() => {});
      await bridge.modelSelect(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      bridge.stop();
      lifecycle += 1;
      generation += 1;
      stopTimer();
      activeContext = undefined;
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    });
  };
}

export default createXzPiUsage();
