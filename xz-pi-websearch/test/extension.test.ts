import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xzPiWebsearch from "../index.ts";
import type { OciSearchAdapter } from "../oci-search.ts";
import { SEARCH_SESSION_ENTRY } from "../search-session.ts";
import { readSearchDefault } from "../search-settings.ts";
import type { SearchPreference } from "../search-types.ts";

const unavailableOci: OciSearchAdapter = {
  route: { provider: "xai-oci", model: "xai.grok-4.7", adapter: "oci-responses", flavor: "xai", label: "xai-oci / xai.grok-4.7", verified: true },
  isAvailable: async () => false,
  run: async () => { throw new Error("not used"); },
  clearSessionCache() {},
};

test("keeps session search selection separate from the saved default", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const tools = new Map<string, { parameters: { properties?: Record<string, unknown> } }>();
  const events = new Map<string, (event: never, ctx: never) => Promise<void> | void>();
  const entries: Array<{ type: string; data: SearchPreference }> = [];
  const notifications: string[] = [];
  let branch: unknown[] = [];
  const selections: Array<{ preference: SearchPreference; saveDefault: boolean } | undefined> = [];
  const seen: Array<{ current: SearchPreference; savedDefault: SearchPreference }> = [];

  const pi = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    appendEntry: (type: string, data: SearchPreference) => entries.push({ type, data }),
    registerTool: (tool: { name: string; parameters: { properties?: Record<string, unknown> } }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, command),
    on: (name: string, handler: (event: never, ctx: never) => Promise<void> | void) => events.set(name, handler),
  } as never;

  const directory = await mkdtemp(join(tmpdir(), "xz-websearch-extension-"));
  const old = process.env.XZ_PI_WEBSEARCH_DIR;
  process.env.XZ_PI_WEBSEARCH_DIR = directory;

  xzPiWebsearch(pi, {
    ociSearch: unavailableOci,
    selectSearch: async (_ctx, _routes, current, savedDefault) => {
      seen.push({ current, savedDefault });
      return selections.shift();
    },
  });

  const models = [
    { provider: "github-copilot", id: "claude-opus-5.5", api: "anthropic-messages" },
    { provider: "github-copilot", id: "grok-4.7", api: "openai-responses" },
    { provider: "xai", id: "grok-5", api: "openai-responses" },
  ];
  const ctx = {
    hasUI: true,
    mode: "tui",
    signal: undefined,
    model: models[0],
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      getAll: () => models,
      hasConfiguredAuth: () => true,
    },
    ui: { notify: (message: string) => notifications.push(message) },
  } as never;

  try {
    assert.ok(tools.get("web_search")?.parameters.properties?.provider);
    assert.ok(tools.get("web_search")?.parameters.properties?.model);
    assert.ok(commands.has("xz-search"));

    await events.get("session_start")?.({ reason: "new" } as never, ctx);
    selections.push({ preference: { mode: "fixed", provider: "xai", model: "grok-5" }, saveDefault: false });
    await commands.get("xz-search")?.handler("", ctx);
    assert.deepEqual(seen.at(-1), {
      current: { mode: "current-provider" },
      savedDefault: { mode: "current-provider" },
    });
    assert.deepEqual(entries.at(-1), {
      type: SEARCH_SESSION_ENTRY,
      data: { mode: "fixed", provider: "xai", model: "grok-5" },
    });
    assert.deepEqual(await readSearchDefault(), { mode: "current-provider" });

    selections.push({ preference: { mode: "auto" }, saveDefault: true });
    await commands.get("xz-search")?.handler("", ctx);
    assert.deepEqual(await readSearchDefault(), { mode: "auto" });
    assert.match(notifications.join("\n"), /saved as the default/);

    branch = [{ type: "custom", customType: SEARCH_SESSION_ENTRY, data: { mode: "fixed", provider: "github-copilot", model: "grok-4.7" } }];
    await events.get("session_start")?.({ reason: "resume" } as never, ctx);
    selections.push(undefined);
    await commands.get("xz-search")?.handler("", ctx);
    assert.deepEqual(seen.at(-1)?.current, { mode: "fixed", provider: "github-copilot", model: "grok-4.7" });

    await events.get("session_start")?.({ reason: "new" } as never, ctx);
    selections.push(undefined);
    await commands.get("xz-search")?.handler("", ctx);
    assert.deepEqual(seen.at(-1)?.current, { mode: "auto" });

    const callsBefore = seen.length;
    await commands.get("xz-search")?.handler("unexpected", ctx);
    assert.equal(seen.length, callsBefore);
    assert.match(notifications.join("\n"), /does not accept arguments/);
  } finally {
    if (old === undefined) delete process.env.XZ_PI_WEBSEARCH_DIR;
    else process.env.XZ_PI_WEBSEARCH_DIR = old;
  }
});
