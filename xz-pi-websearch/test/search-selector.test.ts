import test from "node:test";
import assert from "node:assert/strict";
import { SelectList } from "@earendil-works/pi-tui";
import {
  buildSearchSelectorItems,
  showRpcSearchSelector,
  showTuiSearchSelector,
} from "../search-selector.ts";
import type { SearchPreference, SearchRoute } from "../search-types.ts";

const routes: SearchRoute[] = [
  { provider: "openai-codex-personal", model: "gpt-5.6-terra-long-context", adapter: "responses", flavor: "codex", label: "openai-codex-personal / gpt-5.6-terra-long-context", verified: true },
  { provider: "github-copilot", model: "grok-4.7", adapter: "responses", flavor: "copilot", label: "github-copilot / grok-4.7", verified: true },
  { provider: "xai-oci", model: "xai.grok-4.7", adapter: "oci-responses", flavor: "xai", label: "xai-oci / xai.grok-4.7", verified: true },
];
const current: SearchPreference = { mode: "fixed", provider: "xai-oci", model: "xai.grok-4.7" };
const savedDefault: SearchPreference = { mode: "current-provider" };

test("renders full route labels without the SelectList 32-column abbreviation", () => {
  const items = buildSearchSelectorItems(routes, current, savedDefault);
  assert.ok(items.every((item) => item.description === undefined));
  const plain = (text: string) => text;
  const list = new SelectList(items, items.length, {
    selectedPrefix: plain,
    selectedText: plain,
    description: plain,
    scrollInfo: plain,
    noMatch: plain,
  });
  const rendered = list.render(120).join("\n");
  for (const item of items) assert.ok(rendered.includes(item.label), `missing full label: ${item.label}`);
});

test("marks current and default preferences independently", () => {
  const items = buildSearchSelectorItems(routes, current, savedDefault);
  assert.match(items[0]?.label ?? "", /Automatic/);
  assert.match(items[1]?.label ?? "", /Current model\/provider.*\(default\)/);
  assert.match(items.at(-1)?.label ?? "", /xai-oci.*\(current\)/);

  const same = buildSearchSelectorItems(routes, current, current).at(-1)?.label ?? "";
  assert.match(same, /\(current, default\)/);
});

async function driveTui(input: string) {
  const ctx = {
    ui: {
      custom: async (factory: (tui: never, theme: never, keybindings: never, done: (value: unknown) => void) => Promise<unknown> | unknown) => new Promise((resolve) => {
        void Promise.resolve(factory(
          { requestRender() {} } as never,
          { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
          {} as never,
          resolve,
        )).then((component) => (component as { handleInput?(data: string): void }).handleInput?.(input));
      }),
    },
  } as never;
  return showTuiSearchSelector(ctx, routes, current, savedDefault);
}

test("TUI enter uses the selected route only for the session", async () => {
  const result = await driveTui("\r");
  assert.deepEqual(result, { preference: current, saveDefault: false });
});

test("TUI ctrl+s saves the selected route as default and escape cancels", async () => {
  assert.deepEqual(await driveTui("\x13"), { preference: current, saveDefault: true });
  assert.equal(await driveTui("\x1b"), undefined);
});

test("RPC selector asks whether to save the selected route", async () => {
  const calls: string[] = [];
  const ctx = {
    ui: {
      select: async (_title: string, labels: string[]) => {
        calls.push("select");
        return labels.at(-1);
      },
      confirm: async () => {
        calls.push("confirm");
        return true;
      },
    },
  } as never;
  assert.deepEqual(await showRpcSearchSelector(ctx, routes, current, savedDefault), {
    preference: current,
    saveDefault: true,
  });
  assert.deepEqual(calls, ["select", "confirm"]);
});
