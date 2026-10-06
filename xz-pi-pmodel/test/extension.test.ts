import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createPModelExtension } from "../index.js";

function model(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: `${provider} ${id}`,
    api: "openai-responses",
    baseUrl: "https://example.test",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as Model<any>;
}

const actionKeys: Record<string, string> = {
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.editor.cursorLeft": "left",
  "tui.editor.cursorRight": "right",
  "tui.input.tab": "tab",
  "app.models.reorderUp": "alt-up",
  "app.models.reorderDown": "alt-down",
  "app.tools.expand": "hidden",
  "app.thinking.toggle": "thinking",
  "app.models.save": "save",
  "tui.select.confirm": "enter",
  "tui.select.cancel": "escape",
};
const keybindings = {
  matches: (data: string, action: string) => actionKeys[action] === data,
} as unknown as KeybindingsManager;
const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;

type HarnessOptions = {
  mode?: "tui" | "print";
  setModelResult?: boolean;
  unscoped?: boolean;
  globalSettings?: Record<string, unknown>;
  projectSettings?: Record<string, unknown>;
  catalogModels?: readonly Model<any>[];
  catalogError?: string;
  beforeInput?: (input: string) => void;
  projectTrusted?: boolean;
  availableModels?: readonly Model<any>[];
  onRefresh?: () => { aborted: boolean; errors: Map<string, Error> };
};

function harness(customInput: string[], options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "xz-pmodel-extension-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const models = [model("anthropic", "sonnet"), model("copilot", "gpt")];
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
  };
  write(join(agentDir, "settings.json"), options.globalSettings ?? { enabledModels: ["anthropic/sonnet"] });
  if (options.projectSettings) write(join(cwd, ".pi", "settings.json"), options.projectSettings);
  const rendered: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const selected: Model<any>[] = [];
  const thinking: string[] = [];
  let reloaded = 0;
  let commandName = "";
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let sessionStart: ((_event: unknown, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const registeredEvents: string[] = [];

  const pi = {
    on(event: string, handler: (_event: unknown, ctx: ExtensionCommandContext) => Promise<void>) {
      registeredEvents.push(event);
      if (event === "session_start") sessionStart = handler;
      return () => {};
    },
    registerCommand(name: string, config: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commandName = name;
      command = config.handler;
    },
    getSettings: () => ({ defaultProvider: "copilot", defaultModel: "gpt" }),
    getThinkingLevel: () => "high",
    setThinkingLevel: (level: string) => thinking.push(level),
    async setModel(value: Model<any>) {
      selected.push(value);
      return options.setModelResult ?? true;
    },
  } as unknown as ExtensionAPI;
  createPModelExtension()(pi);

  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print",
    cwd,
    model: models[0],
    scopedModels: options.unscoped ? [] : [{ model: models[0] }],
    modelRegistry: {
      getAvailable: () => options.availableModels ?? models,
      getAll: () => options.catalogModels ?? models,
      getError: () => options.catalogError,
      async refresh() { return options.onRefresh?.() ?? { aborted: false, errors: new Map() }; },
    },
    isProjectTrusted: () => options.projectTrusted ?? true,
    ui: {
      notify(message: string, type?: string) { notifications.push({ message, ...(type ? { type } : {}) }); },
      async custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: unknown) => void) => {
        handleInput(data: string): void;
        render(width: number): string[];
      }) {
        let done: (value: unknown) => void;
        const result = new Promise((resolve) => { done = resolve; });
        const component = factory(tui, theme, keybindings, (value) => done(value));
        for (const input of customInput) {
          options.beforeInput?.(input);
          component.handleInput(input);
          await new Promise<void>((resolve) => setImmediate(resolve));
          rendered.push(component.render(160).join("\n"));
        }
        return await result;
      },
    },
    async reload() { reloaded += 1; },
  } as unknown as ExtensionCommandContext;

  return {
    root, cwd, agentDir, commandName, command: command!, ctx, notifications, selected, thinking, rendered,
    registeredEvents,
    async start() {
      assert.ok(sessionStart);
      await sessionStart({ type: "session_start" }, ctx);
    },
    get reloaded() { return reloaded; },
    restore() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("v5.1 contract removes custom thinking APIs and layer shortcuts and updates docs", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const selector = readFileSync(new URL("../src/model-selector.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/pi-settings.ts", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /setThinkingLevel|resolveModelThinkingLevel|setModelThinkingDefault|clearProjectThinkingDefault|select-thinking/);
  assert.doesNotMatch(selector, /openThinking|set-thinking-default|resolveThinking|ctrl\+g|Ctrl\+G|Ctrl\+T/);
  assert.doesNotMatch(settings, /resolveModelThinkingLevel|setModelThinkingDefault|clearProjectThinkingDefault|supportsThinkingLevel/);
  assert.doesNotMatch(docs, /Ctrl\+T.*Open supported|Ctrl\+G.*Toggle|switches models and supported thinking levels/);
});

test("extension registers only /pmodel and selects through the public model API", async () => {
  const h = harness(["down", "enter"]);
  try {
    assert.equal(h.commandName, "pmodel");
    assert.deepEqual(h.registeredEvents, ["session_start"]);
    await h.command("", h.ctx);
    assert.equal(h.selected[0]?.provider, "anthropic");
    assert.equal(h.selected[0]?.id, "sonnet");
    assert.equal(h.reloaded, 0);
  } finally {
    h.restore();
  }
});

test("legacy thinking shortcut does not set a level and ordinary model selection still works", async () => {
  const h = harness(["thinking", "down", "enter"]);
  try {
    await h.command("", h.ctx);
    assert.equal(h.selected[0]?.id, "sonnet");
    assert.equal(h.thinking.length, 0);
  } finally {
    h.restore();
  }
});

test("v5.1 visibility writes selected global scope without touching project visibility", async () => {
  const h = harness(["hidden", "left", "enter", "hidden", "down", "\u0018", "escape"]);
  try {
    await h.command("", h.ctx);
    const global = JSON.parse(readFileSync(join(h.agentDir, "xz-pi-pmodel.json"), "utf8"));
    const project = JSON.parse(readFileSync(join(h.cwd, ".pi", "xz-pi-pmodel.json"), "utf8"));
    assert.deepEqual(global.providers.anthropic.visibleModels, []);
    assert.equal(project.providers, undefined);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
  } finally { h.restore(); }
});

test("v5.1 thinking migration preserves native globals and never invokes thinking setter", async () => {
  const h = harness(["escape"], {
    globalSettings: { defaultProvider: "copilot", defaultModel: "gpt", defaultThinkingLevel: "low" },
    projectSettings: { defaultProvider: "anthropic", defaultModel: "sonnet", modelThinkingLevels: { "anthropic/sonnet": "medium" }, custom: true },
  });
  try {
    await h.command("", h.ctx);
    const project = JSON.parse(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal("modelThinkingLevels" in project, false);
    assert.equal(project.defaultModel, "sonnet");
    assert.equal(project.custom, true);
    assert.equal(h.reloaded, 1);
    assert.deepEqual(h.thinking, []);
    assert.ok(h.rendered.some((text) => /Pi thinking: high.*read-only/.test(text)));
  } finally { h.restore(); }
});

test("v5.1 inline saves both defaults without switching model/thinking and reloads once on close", async () => {
  const h = harness(["down", "right", " ", "right", "enter", "escape"], {
    globalSettings: { enabledModels: ["anthropic/sonnet", "copilot/gpt"], defaultProvider: "copilot", defaultModel: "gpt", modelThinkingLevels: { "copilot/gpt": "low" } },
    projectSettings: { custom: { keep: true } },
  });
  try {
    await h.command("", h.ctx);
    const global = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8"));
    const project = JSON.parse(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal(global.defaultModel, "sonnet");
    assert.equal(project.defaultModel, "sonnet");
    assert.deepEqual(project.custom, { keep: true });
    assert.deepEqual(global.modelThinkingLevels, { "copilot/gpt": "low" });
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 1);
  } finally { h.restore(); }
});

test("v5.1 inline earlier saved defaults still reload when a later model action fails", async () => {
  const options: HarnessOptions = { catalogModels: [model("anthropic", "sonnet"), model("copilot", "gpt")] };
  options.beforeInput = (input) => {
    if (input === "enter") options.catalogModels = [model("copilot", "gpt")];
  };
  const h = harness(["down", "right", " ", "left", "enter"], options);
  try {
    await h.command("", h.ctx);
    assert.equal(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")).defaultModel, "sonnet");
    assert.deepEqual(h.selected, []);
    assert.ok(h.notifications.some((notice) => /removed while the picker was open/.test(notice.message)));
    assert.equal(h.reloaded, 1);
  } finally { h.restore(); }
});

test("saving a project default preserves project settings and reloads", async () => {
  const h = harness(["down", "right", "right", "enter", "escape"]);
  try {
    await h.command("", h.ctx);
    const settings = JSON.parse(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "anthropic");
    assert.equal(settings.defaultModel, "sonnet");
    assert.equal(h.reloaded, 1);
  } finally {
    h.restore();
  }
});

test("non-TUI mode is rejected without opening custom UI", async () => {
  const h = harness([], { mode: "print" });
  try {
    await h.command("", h.ctx);
    assert.match(h.notifications[0]?.message ?? "", /requires TUI/);
    assert.equal(h.selected.length, 0);
  } finally {
    h.restore();
  }
});

test("authentication failure reports an error and does not change thinking", async () => {
  const h = harness(["down", "thinking", "enter"], { setModelResult: false });
  try {
    await h.command("", h.ctx);
    assert.match(h.notifications.at(-1)?.message ?? "", /No configured authentication/);
    assert.equal(h.thinking.length, 0);
  } finally {
    h.restore();
  }
});

test("all Enter persists global scoped membership without model/thinking/default changes or reload", async () => {
  const initial = {
    enabledModels: ["anthropic/sonnet"], defaultProvider: "anthropic", defaultModel: "sonnet",
    modelThinkingLevels: { "anthropic/sonnet": "high" }, custom: { keep: true },
  };
  const h = harness(["tab", "down", "enter", "escape"], {
    globalSettings: initial,
    projectSettings: { enabledModels: ["anthropic/sonnet"], defaultProvider: "copilot", defaultModel: "gpt" },
  });
  try {
    const projectPath = join(h.cwd, ".pi", "settings.json");
    const before = readFileSync(projectPath, "utf8");
    await h.command("gpt", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), {
      ...initial, enabledModels: ["anthropic/sonnet", "copilot/gpt"],
    });
    assert.equal(readFileSync(projectPath, "utf8"), before);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 0);
    assert.match(h.notifications.at(-1)?.message ?? "", /Restart Pi.*reload is not enough/);
    assert.match(h.notifications.at(-1)?.message ?? "", /Project enabledModels/);
    assert.ok(h.rendered.some((text) => /✓ .*gpt/.test(text)));
    assert.equal(h.ctx.scopedModels.length, 1);
  } finally {
    h.restore();
  }
});

test("all removal and forbidden shortcuts cannot alter defaults, preferences or the current model", async () => {
  const initial = { enabledModels: ["anthropic/sonnet", "copilot/gpt"], defaultProvider: "anthropic", defaultModel: "sonnet" };
  const h = harness(["tab", "down", "enter", "save", "thinking", "hidden", "alt-down", "\u0007", "\u0018", "\u0012", "escape"], {
    globalSettings: initial,
  });
  try {
    await h.command("sonnet", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), {
      ...initial, enabledModels: ["copilot/gpt"],
    });
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 0);
  } finally {
    h.restore();
  }
});

test("unrestricted all view can use Tab to reach model selection in scoped mode", async () => {
  const h = harness(["tab", "down", "enter"], { unscoped: true, globalSettings: {} });
  try {
    await h.command("", h.ctx);
    assert.equal(h.selected[0]?.id, "sonnet");
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), {});
  } finally {
    h.restore();
  }
});

test("last scoped removal is rejected without a success message or any API changes", async () => {
  const h = harness(["tab", "down", "enter", "escape"]);
  try {
    await h.command("sonnet", h.ctx);
    assert.match(h.notifications.at(-1)?.message ?? "", /last available scoped model/);
    assert.equal(h.notifications.at(-1)?.type, "error");
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")).enabledModels, ["anthropic/sonnet"]);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 0);
  } finally {
    h.restore();
  }
});

test("session_start cleans global stale references once without changing project/default/model/thinking state", async () => {
  const initial = {
    enabledModels: ["anthropic/sonnet", "deleted/model"], defaultProvider: "anthropic",
    defaultModel: "sonnet", modelThinkingLevels: { "deleted/model": "high" }, custom: { keep: true },
  };
  const h = harness([], {
    globalSettings: initial,
    projectSettings: { enabledModels: ["deleted/model"], defaultProvider: "copilot", defaultModel: "gpt" },
  });
  try {
    const projectBefore = readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8");
    await h.start();
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), {
      ...initial, enabledModels: ["anthropic/sonnet"],
    });
    assert.equal(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"), projectBefore);
    assert.match(h.notifications[0]?.message ?? "", /Cleaned global enabledModels.*deleted\/model/);
    await h.start();
    assert.equal(h.notifications.length, 1);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 0);
    assert.equal(h.ctx.scopedModels.length, 1);
  } finally {
    h.restore();
  }
});

test("startup cleanup uses the full catalog rather than the authentication-filtered available list", async () => {
  const h = harness([], {
    globalSettings: { enabledModels: ["offline/large", "deleted/model"] },
    catalogModels: [model("anthropic", "sonnet"), model("copilot", "gpt"), model("offline", "large")],
  });
  try {
    await h.start();
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")).enabledModels, ["offline/large"]);
    assert.ok(!h.ctx.modelRegistry.getAvailable().some((model) => model.provider === "offline"));
  } finally {
    h.restore();
  }
});

test("startup skips empty/error catalogs and preserves their references", async () => {
  for (const options of [{ catalogModels: [] }, { catalogError: "Bad models.json" }]) {
    const initial = { enabledModels: ["deleted/model"] };
    const h = harness([], { ...options, globalSettings: initial });
    try {
      await h.start();
      assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), initial);
      assert.match(h.notifications[0]?.message ?? "", /cleanup skipped/);
      assert.deepEqual(h.selected, []);
    } finally {
      h.restore();
    }
  }
});

test("opening pmodel cleans stale references before building its global scoped checklist", async () => {
  const h = harness(["tab", "escape"], {
    globalSettings: { enabledModels: ["anthropic/sonnet", "deleted/model"] },
  });
  try {
    await h.command("", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")).enabledModels, ["anthropic/sonnet"]);
    assert.match(h.notifications[0]?.message ?? "", /Cleaned global enabledModels/);
    assert.ok(h.rendered.some((rendered) => /saved global scoped \(1\/2\)/.test(rendered)));
    assert.deepEqual(h.selected, []);
  } finally {
    h.restore();
  }
});

test("saving all membership cleans references added while the selector was open", async () => {
  const h = harness(["tab", "down", "enter", "escape"], {
    beforeInput(input) {
      if (input === "enter") {
        writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({
          enabledModels: ["anthropic/sonnet", "deleted/model"], custom: true,
        }), "utf8");
      }
    },
  });
  try {
    await h.command("gpt", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")), {
      enabledModels: ["anthropic/sonnet", "copilot/gpt"], custom: true,
    });
    assert.ok(h.notifications.some((notice) => /Cleaned global enabledModels/.test(notice.message)));
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
    assert.equal(h.reloaded, 0);
  } finally {
    h.restore();
  }
});

test("non-TUI session startup can clean global references without using terminal UI", async () => {
  const h = harness([], { mode: "print", globalSettings: { enabledModels: ["anthropic/sonnet", "deleted/model"] } });
  try {
    await h.start();
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8")).enabledModels, ["anthropic/sonnet"]);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.selected, []);
  } finally {
    h.restore();
  }
});

test("startup cleanup failure is reported without aborting the session or poisoning later cleanups", async () => {
  const h = harness([]);
  try {
    const path = join(h.agentDir, "settings.json");
    writeFileSync(path, "invalid JSON", "utf8");
    await h.start();
    assert.match(h.notifications[0]?.message ?? "", /cleanup failed.*Cannot read Pi settings/);
    assert.equal(h.notifications[0]?.type, "warning");
    assert.equal(readFileSync(path, "utf8"), "invalid JSON");
    writeFileSync(path, JSON.stringify({ enabledModels: ["anthropic/sonnet", "deleted/model"] }), "utf8");
    await h.start();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).enabledModels, ["anthropic/sonnet"]);
    assert.match(h.notifications.at(-1)?.message ?? "", /Cleaned global enabledModels/);
  } finally {
    h.restore();
  }
});

test("reordering in project default layer writes the shared global preference file only", async () => {
  const h = harness(["tab", "alt-down", "escape"], { unscoped: true });
  try {
    await h.command("", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "xz-pi-pmodel.json"), "utf8")).providerOrder, ["copilot", "anthropic"]);
    const projectPreferences = JSON.parse(readFileSync(join(h.cwd, ".pi", "xz-pi-pmodel.json"), "utf8"));
    assert.equal(projectPreferences.providerOrder, undefined);
    assert.equal(projectPreferences.providers, undefined);
    assert.equal(projectPreferences.migrations.projectThinkingDefaultsRemoved, true);
    assert.ok(h.rendered.some((rendered) => /Sort: global/.test(rendered)));
    assert.ok(h.rendered.every((rendered) => !/Layer:|Ctrl\+G/.test(rendered)));
    assert.deepEqual(h.selected, []);
  } finally {
    h.restore();
  }
});

test("startup migrates legacy sorting and restores stale local visibility while retaining valid project defaults", async () => {
  const h = harness([], { projectSettings: { defaultProvider: "anthropic", defaultModel: "sonnet" } });
  try {
    const preferences = join(h.cwd, ".pi", "xz-pi-pmodel.json");
    writeFileSync(preferences, JSON.stringify({
      version: 1, providers: { anthropic: { modelOrder: ["sonnet"], visibleModels: ["deleted"] } },
    }), "utf8");
    const before = readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8");
    await h.start();
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "xz-pi-pmodel.json"), "utf8")), {
      version: 1, providers: { anthropic: { modelOrder: ["sonnet"] } },
    });
    assert.deepEqual(JSON.parse(readFileSync(preferences, "utf8")), { version: 1, migrations: { projectThinkingDefaultsRemoved: true } });
    assert.equal(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"), before);
    assert.equal(h.reloaded, 0);
    assert.deepEqual(h.selected, []);
  } finally {
    h.restore();
  }
});

test("invalid project defaults inherit global badges and sync official settings only after the command closes", async () => {
  const h = harness(["tab", "escape"], {
    globalSettings: { enabledModels: ["anthropic/sonnet"], defaultProvider: "copilot", defaultModel: "gpt" },
    projectSettings: { defaultProvider: "deleted", defaultModel: "model", modelThinkingLevels: { "deleted/model": "high" } },
  });
  try {
    await h.start();
    assert.equal(h.reloaded, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8")), {});
    await h.command("gpt", h.ctx);
    assert.ok(h.rendered.some((rendered) => /global default.*gpt/.test(rendered)));
    assert.equal(h.reloaded, 1);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.thinking, []);
  } finally {
    h.restore();
  }
});

test("removed project defaults do not reappear through the stale pi.getSettings snapshot", async () => {
  const h = harness(["tab", "escape"], {
    projectSettings: { defaultProvider: "deleted", defaultModel: "model" },
  });
  try {
    await h.command("gpt", h.ctx);
    assert.ok(h.rendered.every((rendered) => !/global default/.test(rendered)));
    assert.equal(h.reloaded, 1);
  } finally {
    h.restore();
  }
});

test("untrusted project preferences/defaults cannot override globals or be automatically modified", async () => {
  const h = harness(["tab", "escape"], {
    projectTrusted: false,
    globalSettings: { defaultProvider: "copilot", defaultModel: "gpt" },
    projectSettings: { defaultProvider: "deleted", defaultModel: "model" },
  });
  try {
    const preferences = join(h.cwd, ".pi", "xz-pi-pmodel.json");
    writeFileSync(preferences, "invalid project preferences", "utf8");
    const before = readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8");
    await h.start();
    await h.command("gpt", h.ctx);
    assert.equal(readFileSync(preferences, "utf8"), "invalid project preferences");
    assert.equal(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8"), before);
    assert.ok(h.rendered.some((rendered) => /global default.*gpt/.test(rendered)));
    assert.equal(h.reloaded, 0);
  } finally {
    h.restore();
  }
});

test("failed catalog refresh retains project defaults instead of treating missing models as deletion", async () => {
  const h = harness(["escape"], {
    projectSettings: { defaultProvider: "deleted", defaultModel: "model" },
    onRefresh: () => ({ aborted: false, errors: new Map([["provider", new Error("offline")]]) }),
  });
  try {
    const path = join(h.cwd, ".pi", "settings.json");
    const before = readFileSync(path, "utf8");
    await h.command("", h.ctx);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(h.reloaded, 0);
    assert.ok(h.notifications.some((notice) => /cleanup skipped/.test(notice.message)));
  } finally {
    h.restore();
  }
});

test("a model removed while the picker is open cannot be saved back as a project default", async () => {
  const options: HarnessOptions = {
    catalogModels: [model("anthropic", "sonnet"), model("copilot", "gpt")],
    globalSettings: { enabledModels: ["anthropic/sonnet", "copilot/gpt"] },
  };
  options.beforeInput = (input) => {
    if (input === "enter") {
      options.catalogModels = [model("copilot", "gpt")];
      options.availableModels = options.catalogModels;
    }
  };
  const h = harness(["down", "right", "right", "enter", "escape"], options);
  try {
    await h.command("", h.ctx);
    assert.match(h.notifications.at(-1)?.message ?? "", /removed while the picker was open/);
    assert.ok(!existsSync(join(h.cwd, ".pi", "settings.json")));
    assert.deepEqual(h.selected, []);
  } finally {
    h.restore();
  }
});

test("changed model capability is handed to Pi without a custom thinking-setting action", async () => {
  const options: HarnessOptions = {
    catalogModels: [model("anthropic", "sonnet"), model("copilot", "gpt")],
    projectSettings: { modelThinkingLevels: { "anthropic/sonnet": "high" } },
  };
  options.beforeInput = (input) => {
    if (input === "enter") {
      options.catalogModels = [{ ...model("anthropic", "sonnet"), reasoning: false }, model("copilot", "gpt")];
      options.availableModels = options.catalogModels;
    }
  };
  const h = harness(["down", "thinking", "enter"], options);
  try {
    await h.command("", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(h.cwd, ".pi", "settings.json"), "utf8")), {});
    assert.equal(h.selected[0]?.reasoning, false);
    assert.deepEqual(h.thinking, []);
  } finally {
    h.restore();
  }
});



