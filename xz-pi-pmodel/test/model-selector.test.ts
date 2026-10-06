import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { colorToHex, stripTerminalSequences, styleText, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { PModelSelectorComponent, type SelectorAction } from "../src/model-selector.js";
import type { PreferenceOverride } from "../src/preferences.js";
import type { ModelDefaultState } from "../src/pi-settings.js";
import { modelKey, type GlobalScopedModelsState } from "../src/scoped-models.js";

function model(provider: string, id: string, reasoning = true): Model<any> {
  return {
    provider,
    id,
    name: `${provider} ${id}`,
    api: "openai-responses",
    baseUrl: "https://example.test",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning,
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as Model<any>;
}

const tui = { requestRender() {} } as unknown as TUI;
const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
} as unknown as Theme;
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

function createSelector(options: {
  inline?: boolean;
  failPreferences?: boolean;
  readThinking?: () => "off" | "high";
  onToggleModelDefault?: (model: Model<any>, layer: "global" | "project") => Promise<ModelDefaultState>;
  currentId?: string;
  projectTrusted?: boolean;
  defaultId?: string;
  defaultSource?: "project" | "global";
  theme?: Theme;
  globalScope?: GlobalScopedModelsState;
  preferences?: { providers: Record<string, { visibleModels: string[] }> };
  onToggleGlobalScope?: (model: Model<any>) => GlobalScopedModelsState | Promise<GlobalScopedModelsState>;
} = {}) {
  const sonnet = model("anthropic", "sonnet");
  const opus = model("anthropic", "opus");
  const gpt = model("copilot", "gpt");
  const actions: SelectorAction[] = [];
  const preferenceChanges: Array<{ layer: string; override: PreferenceOverride }> = [];
  const scopeChanges: Model<any>[] = [];
  const errors: unknown[] = [];
  const projectClears: unknown[] = [];
  const defaultChanges: Array<{ model: Model<any>; layer: "global" | "project" }> = [];
  const defaultRef = { provider: options.defaultId ? "anthropic" : "copilot", id: options.defaultId ?? "gpt" };
  let defaults: ModelDefaultState = options.defaultSource === "project"
    ? { global: { provider: "copilot", id: "gpt" }, project: defaultRef, effective: { ...defaultRef, source: "project" } }
    : { global: defaultRef, effective: { ...defaultRef, source: "global" } };
  let globalScope = options.globalScope ?? {
    modelIds: ["anthropic/sonnet", "copilot/gpt"], unrestricted: false, projectOverride: false, sessionDiffers: false,
  };
  const selector = new PModelSelectorComponent(
    tui,
    options.theme ?? theme,
    keybindings,
    (action) => actions.push(action),
    {
      allModels: [sonnet, opus, gpt],
      scopedModels: [sonnet, gpt],
      globalScope,
      preferences: options.preferences ?? {},
      current: { provider: "anthropic", id: options.currentId ?? "sonnet" },
      defaults,
      readThinking: options.readThinking ?? (() => "high"),
      projectTrusted: options.projectTrusted ?? true,
    },
    {
      async onToggleModelDefault(model: Model<any>, layer: "global" | "project") {
          defaultChanges.push({ model, layer });
          if (options.onToggleModelDefault) return options.onToggleModelDefault(model, layer);
          if (layer === "project" && defaults.project?.provider === model.provider && defaults.project.id === model.id) {
            delete defaults.project;
          } else defaults[layer] = { provider: model.provider, id: model.id };
          const effective = defaults.project ?? defaults.global;
          defaults = { ...defaults, ...(effective ? { effective: { ...effective, source: defaults.project ? "project" as const : "global" as const } } : {}) };
        return defaults;
      },
      onToggleGlobalScope(model) {
        scopeChanges.push(model);
        if (options.onToggleGlobalScope) return options.onToggleGlobalScope(model);
        const ids = new Set(globalScope.modelIds);
        if (ids.has(modelKey(model))) ids.delete(modelKey(model));
        else ids.add(modelKey(model));
        globalScope = { ...globalScope, modelIds: [...ids], sessionDiffers: true };
        return globalScope;
      },
      onError(error) { errors.push(error); },
      onPreferenceChange(layer, override) {
        if (options.failPreferences) throw new Error("read-only preferences");
        preferenceChanges.push({ layer, override });
      },
      onClearProjectPreference(override) {
        if (options.failPreferences) throw new Error("read-only preferences");
        projectClears.push(override);
      },
    },
  );
  return { selector, actions, preferenceChanges, scopeChanges, defaultChanges, projectClears, errors, sonnet, opus, gpt };
}

test("selector starts scoped, groups providers, folds non-current groups, and toggles scope", () => {
  const { selector } = createSelector();
  assert.equal(selector.getScope(), "scoped");
  assert.deepEqual(selector.getRows().map((row) => `${row.kind}:${row.provider}`), [
    "provider:anthropic",
    "model:anthropic",
    "provider:copilot",
  ]);
  selector.handleInput("tab");
  assert.equal(selector.getScope(), "all");
  assert.match(selector.render(100).join("\n"), /anthropic/);
});

test("selector emits provider ordering and explicit visible-list changes", async () => {
  const { selector, preferenceChanges } = createSelector();
  selector.handleInput("alt-down");
  await settle();
  assert.deepEqual(preferenceChanges[0], {
    layer: "global",
    override: { field: "providerOrder", value: ["copilot", "anthropic"] },
  });

  const fresh = createSelector();
  fresh.selector.handleInput("down");
  fresh.selector.handleInput("\u0018");
  await settle();
  assert.deepEqual(fresh.preferenceChanges[0], {
    layer: "project",
    override: { field: "visibleModels", provider: "anthropic", value: [] },
  });
  fresh.selector.handleInput("hidden");
  assert.equal(fresh.selector.isShowingHidden(), true);
});

test("thinking shortcut is ignored from a provider row and has no submenu", () => {
  const { selector, actions } = createSelector();
  selector.handleInput("thinking");
  assert.match(selector.render(100).join("\n"), /Pi thinking: high.*read-only/);
  assert.doesNotMatch(selector.render(100).join("\n"), /Thinking: anthropic|Enter apply/);
  assert.deepEqual(actions, []);
});

test("a scrolled model slice keeps its provider context visible", () => {
  const models = Array.from({ length: 15 }, (_, index) => model("anthropic", `model-${index + 1}`));
  const selector = new PModelSelectorComponent(
    tui,
    theme,
    keybindings,
    () => {},
    {
      allModels: models,
      scopedModels: [],
      globalScope: { modelIds: models.map(modelKey), unrestricted: true, projectOverride: false, sessionDiffers: false },
      preferences: {},
      current: { provider: "anthropic", id: "model-1" },
      defaults: {},
      readThinking: () => "medium",
      projectTrusted: true,
    },
    {
      async onToggleModelDefault() { throw new Error("Scrolling test never saves defaults"); },
      onToggleGlobalScope: () => ({ modelIds: [], unrestricted: false, projectOverride: false, sessionDiffers: true }),
      onPreferenceChange() {}, onClearProjectPreference() {},
    },
  );
  for (let index = 0; index < 12; index++) selector.handleInput("down");
  const rendered = selector.render(100).join("\n");
  assert.match(rendered, /anthropic \(continued\)/);
  assert.match(rendered, /model-/);
});

test("default columns are independent from visibility scope and respect project trust", async () => {
  const trusted = createSelector();
  trusted.selector.handleInput("down"); trusted.selector.handleInput("right"); trusted.selector.handleInput("enter");
  await settle();
  assert.equal(trusted.defaultChanges[0]!.layer, "global");
  assert.deepEqual(trusted.actions, []);
  const untrusted = createSelector({ projectTrusted: false });
  untrusted.selector.handleInput("down"); untrusted.selector.handleInput("right"); untrusted.selector.handleInput("right"); untrusted.selector.handleInput("enter");
  await settle();
  assert.equal(untrusted.defaultChanges.length, 0);
  assert.match(untrusted.selector.render(160).join("\n"), /trust/);
  assert.equal(untrusted.selector.getEditLayer(), "global");
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("v5.1 visibility synchronous storage errors are reported without throwing out of the picker", async () => {
  const hide = createSelector({ failPreferences: true });
  hide.selector.handleInput("down"); hide.selector.handleInput("\u0018");
  await settle();
  assert.equal(hide.errors.length, 1);
  assert.deepEqual(hide.preferenceChanges, []);
  assert.match(hide.selector.render(120).join("\n"), /read-only preferences/);
  const reset = createSelector({ failPreferences: true });
  reset.selector.handleInput("\u0012"); reset.selector.handleInput("enter");
  await settle();
  assert.equal(reset.errors.length, 1);
  assert.deepEqual(reset.projectClears, []);
  assert.match(reset.selector.render(120).join("\n"), /read-only preferences/);
});

test("v5.1 visibility scope is directly selectable and independent from default columns", async () => {
  const h = createSelector({ inline: true });
  h.selector.handleInput("hidden");
  assert.match(h.selector.render(160).join("\n"), /Visibility:.*global.*project/);
  h.selector.handleInput("left"); h.selector.handleInput("enter"); h.selector.handleInput("hidden");
  h.selector.handleInput("down"); h.selector.handleInput("\u0018");
  await settle();
  assert.equal(h.preferenceChanges[0]!.layer, "global");
  assert.equal(h.defaultChanges.length, 0);
  assert.doesNotMatch(h.selector.render(160).join("\n"), /Layer:|Ctrl\+G/);
  const untrusted = createSelector({ inline: true, projectTrusted: false });
  untrusted.selector.handleInput("hidden"); untrusted.selector.handleInput("right"); untrusted.selector.handleInput("enter");
  assert.equal(untrusted.selector.getEditLayer(), "global");
});

test("v5.1 thinking shows live Pi level only and exposes no setting submenu", () => {
  const h = createSelector({ inline: true });
  assert.match(h.selector.render(160).join("\n"), /Pi thinking: high.*read-only/);
  h.selector.handleInput("thinking");
  assert.doesNotMatch(h.selector.render(160).join("\n"), /Thinking: anthropic|Enter apply|thinking:medium/);
  assert.deepEqual(h.actions, []);
});

test("v5.1 inline checkboxes support Space and Enter and keep the picker open", async () => {
  const h = createSelector({ inline: true });
  h.selector.handleInput("down");
  h.selector.handleInput("right");
  h.selector.handleInput(" ");
  await settle();
  assert.equal(h.defaultChanges.length, 1);
  assert.equal(h.defaultChanges[0]!.layer, "global");
  assert.match(h.selector.render(160).join("\n"), /Global default: anthropic\/sonnet/);
  h.selector.handleInput("right");
  h.selector.handleInput("enter");
  await settle();
  assert.equal(h.defaultChanges[1]!.layer, "project");
  assert.match(h.selector.render(160).join("\n"), /Project default: anthropic\/sonnet/);
  h.selector.handleInput("enter");
  await settle();
  assert.match(h.selector.render(160).join("\n"), /Project default: inherits global/);
  assert.deepEqual(h.actions, []);
});

test("v5.1 inline reset submenu owns Space instead of changing a background default", async () => {
  const h = createSelector();
  h.selector.handleInput("down"); h.selector.handleInput("right"); h.selector.handleInput("\u0012");
  h.selector.handleInput(" ");
  await settle();
  assert.deepEqual(h.defaultChanges, []);
  assert.deepEqual(h.projectClears, [{ field: "visibleModels", provider: "anthropic" }]);
  assert.match(h.selector.render(120).join("\n"), /Global default: copilot\/gpt/);
});

test("v5.1 inline terminal render preserves controls at multiple widths", () => {
  const h = createSelector({ defaultId: "sonnet", defaultSource: "project" });
  h.selector.handleInput("down"); h.selector.handleInput("down"); h.selector.handleInput("enter");
  const samples: string[] = ["Formal-test model render, not a screenshot of the user's live Pi session."];
  for (const width of [34, 60, 100]) {
    const lines = h.selector.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const text = stripTerminalSequences(lines.join("\n"));
    assert.match(text, /Global default:/);
    assert.match(text, /Project default:/);
    assert.match(text, /\[x\] (G|global)/);
    assert.match(text, /\[x\] (P|project)/);
    samples.push(`\n--- width ${width} ---\n` + text.split("\n").map((line) => line.trimEnd()).join("\n"));
  }
  if (process.env.PMODEL_RENDER_OUTPUT) writeFileSync(process.env.PMODEL_RENDER_OUTPUT, samples.join("\n") + "\n");
});

test("v5.1 inline pending and failed default writes cannot fake checks or accept duplicate input", async () => {
  let finish!: (state: ModelDefaultState) => void;
  const h = createSelector({ inline: true, onToggleModelDefault: () => new Promise((resolve) => { finish = resolve; }) });
  h.selector.handleInput("down"); h.selector.handleInput("right"); h.selector.handleInput("enter");
  h.selector.handleInput("enter"); h.selector.handleInput("escape");
  assert.equal(h.defaultChanges.length, 1);
  assert.deepEqual(h.actions, []);
  assert.match(h.selector.render(160).join("\n"), /Global default: copilot\/gpt/);
  finish({ global: { provider: "anthropic", id: "sonnet" } });
  await settle();
  assert.match(h.selector.render(160).join("\n"), /Global default: anthropic\/sonnet/);
  const bad = createSelector({ inline: true, onToggleModelDefault: async () => { throw new Error("read-only settings"); } });
  bad.selector.handleInput("down"); bad.selector.handleInput("right"); bad.selector.handleInput("enter");
  await settle();
  assert.match(bad.selector.render(160).join("\n"), /Global default: copilot\/gpt/);
  assert.match(bad.selector.render(160).join("\n"), /read-only settings/);
});

test("v5.1 inline search keeps spaces and all view cannot edit defaults", async () => {
  const h = createSelector({ inline: true });
  for (const key of "sonnet anthropic") h.selector.handleInput(key);
  assert.equal(h.defaultChanges.length, 0);
  assert.equal(h.selector.getRows().filter((row) => row.kind === "model").length, 1);
  const all = createSelector({ inline: true });
  all.selector.handleInput("tab"); all.selector.handleInput("down"); all.selector.handleInput("right"); all.selector.handleInput("enter");
  await settle();
  assert.equal(all.defaultChanges.length, 0);
});

test("all Enter checks/unchecks global scoped membership and never selects the current model", async () => {
  const h = createSelector();
  h.selector.handleInput("tab");
  h.selector.handleInput("down"); // opus is available but not scoped
  const opusRow = h.selector.getRows()[1];
  assert.equal(opusRow?.kind === "model" ? opusRow.entry.id : "", "opus");
  assert.match(h.selector.render(160).find((line) => line.includes("opus")) ?? "", /○/);
  h.selector.handleInput("enter");
  await settle();
  assert.deepEqual(h.scopeChanges, [h.opus]);
  assert.ok(h.selector.getGlobalScopedModelIds().includes("anthropic/opus"));
  assert.match(h.selector.render(160).find((line) => line.includes("opus")) ?? "", /✓/);
  assert.match(h.selector.render(160).join("\n"), /Restart Pi.*reload is not enough/);
  h.selector.handleInput("enter");
  await settle();
  assert.ok(!h.selector.getGlobalScopedModelIds().includes("anthropic/opus"));
  assert.match(h.selector.render(160).find((line) => line.includes("opus")) ?? "", /○/);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.preferenceChanges, []);
  h.selector.handleInput("tab");
  assert.equal(h.selector.getScope(), "scoped");
  assert.ok(!h.selector.getRows().some((row) => row.kind === "model" && row.entry.id === "opus"));
});

test("all disables every default, thinking, visibility, layer, reset and reorder action", () => {
  const h = createSelector();
  h.selector.handleInput("tab");
  h.selector.handleInput("down");
  const rowsBefore = h.selector.getRows().map((row) => row.kind === "provider" ? row.provider : row.entry.fullId);
  for (const key of ["thinking", "save", "hidden", "alt-up", "alt-down", "\u0007", "\u0018", "\u0012"]) {
    h.selector.handleInput(key);
  }
  assert.equal(h.selector.getEditLayer(), "project");
  assert.equal(h.selector.isShowingHidden(), false);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.preferenceChanges, []);
  assert.deepEqual(h.scopeChanges, []);
  assert.deepEqual(h.selector.getRows().map((row) => row.kind === "provider" ? row.provider : row.entry.fullId), rowsBefore);
  const rendered = h.selector.render(160).join("\n");
  assert.match(rendered, /all only checks\/unchecks/);
  assert.doesNotMatch(rendered, /Layer: project|Thinking:|Enter apply|Clear project override/);
});

test("all includes models hidden by picker preferences while unavailable IDs remain non-actionable", () => {
  const h = createSelector({ preferences: { providers: { anthropic: { visibleModels: ["sonnet", "missing"] } } } });
  h.selector.handleInput("tab");
  const ids = h.selector.getRows().flatMap((row) => row.kind === "model" ? [row.entry.id] : []);
  assert.ok(ids.includes("opus"));
  assert.ok(ids.includes("sonnet"));
  assert.ok(!ids.includes("missing"));
  assert.match(h.selector.render(160).join("\n"), /hidden in scoped picker/);
});

test("current status is independent of all's scoped checkmark", () => {
  const h = createSelector({
    globalScope: { modelIds: ["anthropic/opus", "copilot/gpt"], unrestricted: false, projectOverride: true, sessionDiffers: true },
  });
  h.selector.handleInput("tab");
  const rendered = h.selector.render(160);
  const current = rendered.find((line) => line.includes("current") && line.includes("sonnet")) ?? "";
  assert.match(current, /○.*current/);
  assert.doesNotMatch(current, /✓/);
  assert.match(rendered.join("\n"), /Project enabledModels overrides global scope/);
  assert.match(rendered.join("\n"), /differs from this session/);
});

test("failed scoped saves retain the old checkmark and show the error", async () => {
  const h = createSelector({ onToggleGlobalScope: async () => { throw new Error("settings are read-only"); } });
  h.selector.handleInput("tab");
  h.selector.handleInput("down");
  h.selector.handleInput("enter");
  await settle();
  assert.ok(!h.selector.getGlobalScopedModelIds().includes("anthropic/opus"));
  assert.match(h.selector.render(160).find((line) => line.includes("opus")) ?? "", /○/);
  assert.match(h.selector.render(160).join("\n"), /settings are read-only/);
  assert.doesNotMatch(h.selector.render(160).join("\n"), /Global scope saved/);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.actions, []);
});

test("pending scoped writes serialize input and update only after persistence succeeds", async () => {
  let finish: ((state: GlobalScopedModelsState) => void) | undefined;
  const h = createSelector({
    onToggleGlobalScope: () => new Promise((resolve) => { finish = resolve; }),
  });
  h.selector.handleInput("tab");
  h.selector.handleInput("down");
  h.selector.handleInput("enter");
  h.selector.handleInput("enter");
  h.selector.handleInput("escape");
  assert.equal(h.scopeChanges.length, 1);
  assert.deepEqual(h.actions, []);
  assert.match(h.selector.render(160).join("\n"), /Saving global scoped selection/);
  assert.ok(!h.selector.getGlobalScopedModelIds().includes("anthropic/opus"));
  finish!({ modelIds: ["anthropic/opus", "anthropic/sonnet", "copilot/gpt"], unrestricted: false, projectOverride: false, sessionDiffers: true });
  await settle();
  assert.ok(h.selector.getGlobalScopedModelIds().includes("anthropic/opus"));
});

test("current and project/global default badges use different bold colors, including selected rows and narrow widths", () => {
  for (const appearance of ["dark", "light"] as const) {
    for (const source of ["project", "global"] as const) {
      const styles: Array<{ label: string; options: ThemeStyle }> = [];
      const coloredTheme = {
        ...theme,
        appearance,
        style(label: string, options: ThemeStyle) {
          styles.push({ label, options });
          const fg = options.fg;
          assert.ok(fg && typeof fg === "object");
          return styleText(label, { fg, bold: options.bold === true }, "truecolor");
        },
      } as unknown as Theme;
      const h = createSelector({ defaultId: "sonnet", defaultSource: source, theme: coloredTheme });
      h.selector.handleInput("down");
      const lines = h.selector.render(34);
      const rendered = lines.join("\n");
      assert.match(stripTerminalSequences(rendered), /●.*\[x\]/);
      assert.ok(lines.every((line) => visibleWidth(line) <= 34));
      const currentStyle = styles.find((item) => item.label === "● ")!.options;
      const defaultStyle = styles.find((item) => item.label === (source === "global" ? "[x] G" : "[x] P"))!.options;
      assert.equal(currentStyle.bold, true);
      assert.equal(defaultStyle.bold, true);
      const currentFg = currentStyle.fg;
      const defaultFg = defaultStyle.fg;
      assert.ok(currentFg && typeof currentFg === "object");
      assert.ok(defaultFg && typeof defaultFg === "object");
      assert.notEqual(colorToHex(currentFg), colorToHex(defaultFg));
      assert.equal(colorToHex(currentFg), appearance === "dark" ? "#58a6ff" : "#0969da");
      assert.equal(colorToHex(defaultFg), source === "project"
        ? appearance === "dark" ? "#f2cc60" : "#825e00"
        : appearance === "dark" ? "#7ee787" : "#1a7f37");
    }
  }
});

test("folded provider headers keep current/default status visible without changing scoped membership", () => {
  const h = createSelector();
  assert.match(h.selector.render(120).find((line) => line.includes("▸ copilot")) ?? "", /global default/);
  h.selector.handleInput("left");
  assert.match(h.selector.render(120).find((line) => line.includes("anthropic")) ?? "", /current/);
  h.selector.handleInput("tab");
  h.selector.handleInput("enter"); // expand provider, not bulk-check
  assert.deepEqual(h.scopeChanges, []);
  assert.deepEqual(h.actions, []);
  assert.equal(h.selector.getGlobalScopedModelIds().length, 2);
});

test("live thinking metadata follows Pi and is never an editable project default", () => {
  let level: "high" | "off" = "high";
  const h = createSelector({ inline: true, readThinking: () => level });
  assert.match(h.selector.render(120).join("\n"), /Pi thinking: high.*read-only/);
  level = "off";
  assert.match(h.selector.render(120).join("\n"), /Pi thinking: off.*read-only/);
  h.selector.handleInput("thinking");
  assert.doesNotMatch(h.selector.render(120).join("\n"), /Enter apply|thinking:medium/);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.defaultChanges, []);
});

test("scoped makes global sorting explicit and project reset no longer offers ordering", () => {
  const h = createSelector();
  assert.match(h.selector.render(160).join("\n"), /Sort: global/);
  assert.doesNotMatch(h.selector.render(160).join("\n"), /Layer:|Ctrl\+G/);
  assert.match(h.selector.render(160).join("\n"), /reorder \(global\)/);
  h.selector.handleInput("\u0012");
  const menu = h.selector.render(160).join("\n");
  assert.match(menu, /Visible models: anthropic|Project model default/);
  assert.doesNotMatch(menu, /Provider order|Model order:/);
});



