import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { PModelSelectorComponent } from "../src/model-selector.js";

const physical = { provider: "openai-work", id: "gpt", name: "GPT work", api: "openai-responses", baseUrl: "", reasoning: true,
  input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>;
const tui = { requestRender() {} } as never;
const theme = { appearance: "dark", fg: (_: string, text: string) => text, bold: (text: string) => text,
  style: (text: string) => text } as never;
const keys = { matches: (data: string, action: string) => ({
  "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "esc",
  "tui.editor.cursorLeft": "left", "tui.editor.cursorRight": "right", "tui.input.tab": "tab", "app.models.save": "save",
}[action] === data) } as never;

function selector() {
  const changes: string[] = [], actions: unknown[] = [];
  const component = new PModelSelectorComponent(tui, theme, keys, action => actions.push(action), {
    allModels: [physical], scopedModels: [physical], globalScope: { modelIds: ["openai-work/gpt"], unrestricted: true, projectOverride: false, sessionDiffers: false },
    preferences: {}, current: { provider: "openai-work", id: "gpt" },
    defaults: { global: { provider: "openai-work", id: "gpt" } },
    readThinking: () => "high", projectTrusted: true,
  }, {
    async onToggleModelDefault(_model, layer) { changes.push(layer); return { global: { provider: "openai-work", id: "gpt" } }; },
    onPreferenceChange() {}, onClearProjectPreference() {},
  });
  return { component, changes, actions };
}

test("auth-only picker displays the physical provider and no internal pool labels", () => {
  const output = selector().component.render(120).join("\n");
  assert.match(output, /Global default: openai-work\/gpt/);
  assert.match(output, /Project default: inherits global/);
  assert.doesNotMatch(output, /xz-login-|account pool|Serving account/);
});

test("project defaults remain editable for authenticated physical providers", async () => {
  const { component, changes } = selector();
  component.handleInput("down"); component.handleInput("right"); component.handleInput("right"); component.handleInput("enter");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes, ["project"]);
});
