import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import xzPiVim from "../index.js";
import { MCP_STATUS_EVENT, parseMcpReferenceSnapshot } from "../src/mcp-references.js";
import { stubTui, stubTheme, stubKeybindings } from "./harness.js";
import type { XzModalEditor } from "../src/modal-editor.js";

const servers = [
  { name: "context7_mcp", toolCount: 2, status: "cached", disabled: false },
  { name: "github_mcp", toolCount: 0, status: "not-connected", disabled: false },
  { name: "disabled_mcp", toolCount: 10, status: "disabled", disabled: true },
];
const fallback: AutocompleteProvider = {
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

test("status parser copies only safe fields, rejects malformed snapshots and accepts shutdown", () => {
  const parsed = parseMcpReferenceSnapshot({ version: 1, servers });
  assert.deepEqual(parsed, servers);
  assert.notEqual(parsed![0], servers[0]);
  assert.equal(parseMcpReferenceSnapshot({ version: 2, servers }), undefined);
  assert.equal(parseMcpReferenceSnapshot({ version: 1, servers: [{ name: "broken" }] }), undefined);
  assert.equal(parseMcpReferenceSnapshot({ version: 1, servers: [{ ...servers[0], toolCount: NaN }] }), undefined);
  assert.deepEqual(parseMcpReferenceSnapshot({ version: 1, servers: [] }), []);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xz-vim-mcp-status-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const agent = join(root, "agent");
  mkdirSync(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  const events = new EventEmitter();
  const handlers = new Map<string, (...args: any[]) => any>();
  const wrappers: Array<(provider: AutocompleteProvider) => AutocompleteProvider> = [];
  const activation: string[][] = [];
  let editorFactory: (...args: any[]) => XzModalEditor;
  const sourceInfo = { source: "npm:pi-mcp-adapter", path: "/adapter/index.ts", origin: "package" as const };
  const pi = {
    events,
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    getAllTools: () => [
      { name: "mcp", description: "Gateway", sourceInfo },
      { name: "mcp__context7_mcp", description: "Namespace", sourceInfo },
    ],
    getCommands: () => [],
    getActiveTools: () => ["read"],
    setActiveTools: (tools: string[]) => { activation.push(tools); },
  } as unknown as ExtensionAPI;
  xzPiVim(pi);
  const ctx = {
    cwd: root,
    isProjectTrusted: () => false,
    ui: {
      addAutocompleteProvider: (wrapper: (provider: AutocompleteProvider) => AutocompleteProvider) => { wrappers.push(wrapper); },
      setEditorComponent: (factory: (...args: any[]) => XzModalEditor) => { editorFactory = factory; },
      notify() {},
    },
    shutdown() {},
  };
  return {
    events, handlers, wrappers, activation,
    start() { handlers.get("session_start")!({ reason: "startup" }, ctx); },
    editor() { return editorFactory!(stubTui, stubTheme, stubKeybindings); },
    close() {
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function names(provider: AutocompleteProvider) {
  const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal });
  return suggestions?.items.filter((item) => item.description?.startsWith("MCP")).map((item) => item.value) ?? [];
}

test("extension listens before startup and updates lazy MCP references without connecting servers", async () => {
  const f = fixture();
  try {
    // Adapter can publish before Vim's session_start, depending on load order.
    f.events.emit(MCP_STATUS_EVENT, { version: 1, servers });
    f.start();
    const provider = f.wrappers.at(-1)!(fallback);
    assert.deepEqual(await names(provider), ["context7_mcp", "github_mcp"]);
    f.events.emit(MCP_STATUS_EVENT, { version: 2, servers: [] });
    assert.deepEqual(await names(provider), ["context7_mcp", "github_mcp"]);
    f.events.emit(MCP_STATUS_EVENT, { version: 1, servers: servers.map((server) => ({ ...server, disabled: server.name !== "github_mcp" })) });
    assert.deepEqual(await names(provider), ["github_mcp"]);
    f.events.emit(MCP_STATUS_EVENT, { version: 1, servers: [] });
    assert.deepEqual(await names(provider), []);
    assert.deepEqual(f.activation, []);
  } finally { f.close(); }
});

for (const disableBeforeSubmit of [false, true]) {
  test(`server tags activate the real gateway only if still enabled (disabled=${disableBeforeSubmit})`, async () => {
    const f = fixture();
    try {
      f.start();
      f.events.emit(MCP_STATUS_EVENT, { version: 1, servers });
      const editor = f.editor();
      const provider = f.wrappers.at(-1)!(fallback);
      const suggestions = await provider.getSuggestions(["$git"], 0, 4, { signal: new AbortController().signal });
      const item = suggestions!.items.find((value) => value.value === "github_mcp")!;
      const completed = provider.applyCompletion(["$git"], 0, 4, item, "$git");
      editor.setText(completed.lines.join("\n"));
      editor.handleInput("\x1b[D"); // Apply the completion tag after host editor replacement.
      const tracked = (editor as unknown as { referenceTracker: { getAll(): readonly unknown[] } }).referenceTracker;
      assert.equal(tracked.getAll().length, 1, "completion must be tracked before submission");
      if (disableBeforeSubmit) f.events.emit(MCP_STATUS_EVENT, {
        version: 1, servers: servers.map((server) => ({ ...server, disabled: true })),
      });
      let text = "";
      editor.onSubmit = (value) => { text = value; };
      editor.handleInput("\r");
      assert.equal(text, "github_mcp", "host submits the tag without the trailing completion space");
      f.handlers.get("input")!({ source: "interactive", text });
      if (disableBeforeSubmit) assert.deepEqual(f.activation, []);
      else assert.deepEqual(f.activation, [["read", "mcp"]]);
    } finally { f.close(); }
  });
}
