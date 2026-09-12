import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import xzPiPlanningStatus from "../index.js";

test("/xz on refreshes and displays the plan with its command context", async () => {
  const root = mkdtempSync(join(tmpdir(), "xz-planning-extension-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".xz_planning"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "xz-planning-status.json"), '{"enabled":false}\n');
  writeFileSync(
    join(cwd, ".xz_planning", "STATE.md"),
    "## 当前进度\n| 版本 | 需求 |\n| --- | --- |\n| 2 | 修复开启展示 |\n",
  );

  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  let sessionShutdown: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  const pi = {
    registerCommand(_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (name === "session_start") sessionStart = handler as typeof sessionStart;
      if (name === "session_shutdown") sessionShutdown = handler as typeof sessionShutdown;
    },
  } as unknown as ExtensionAPI;

  const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
  const makeContext = () =>
    ({
      cwd,
      hasUI: true,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        setStatus: (key: string, text: string | undefined) => statusUpdates.push({ key, text }),
        notify: () => {},
      },
    }) as unknown as ExtensionContext;

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let activeContext: ExtensionContext | undefined;
  try {
    xzPiPlanningStatus(pi);
    const startupContext = makeContext();
    activeContext = makeContext();
    await sessionStart?.({}, startupContext);
    await commandHandler?.("on", activeContext);

    assert.deepEqual(statusUpdates.at(-1), {
      key: "0-xz-planning-status",
      text: "当前计划：2 · 修复开启展示",
    });
  } finally {
    if (activeContext) sessionShutdown?.({}, activeContext);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
