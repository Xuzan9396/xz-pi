import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createEditor, send, stubKeybindings, stubTheme, stubTui } from "./harness.js";
import { XzModalEditor } from "../src/modal-editor.js";
import {
  buildReferenceCatalog,
  classifyToolSource,
  createToolReferenceAutocompleteProvider,
  extractToolReferenceToken,
  ToolReferenceTracker,
  type CompletedToolReference,
} from "../src/tool-references.js";

const fallback: AutocompleteProvider = {
  async getSuggestions() {
    return null;
  },
  applyCompletion(lines, cursorLine, cursorCol) {
    return { lines, cursorLine, cursorCol };
  },
};

const candidate = {
  name: "mcp__context7_query_docs",
  description: "Query library documentation",
  kind: "tool" as const,
  source: "mcp" as const,
  sourceLabel: "context7_mcp",
  memberToolNames: ["mcp__context7_query_docs"],
};

const signal = new AbortController().signal;

test("dollar token triggers only at a token boundary", () => {
  assert.deepEqual(extractToolReferenceToken("use $cont"), { prefix: "$cont", query: "cont" });
  assert.deepEqual(extractToolReferenceToken("$"), { prefix: "$", query: "" });
  assert.equal(extractToolReferenceToken("cost$100"), undefined);
});

test("MCP tools are classified by name or source metadata", () => {
  assert.equal(classifyToolSource({ name: "mcp__github__search" }), "mcp");
  assert.equal(classifyToolSource({ name: "query", sourceInfo: { source: "my-mcp-package" } }), "mcp");
  assert.equal(classifyToolSource({ name: "read", sourceInfo: { source: "builtin" } }), "builtin");
  assert.equal(classifyToolSource({ name: "custom", sourceInfo: { source: "extension" } }), "extension");
});

test("catalog groups MCP and package references before individual tools", () => {
  const catalog = buildReferenceCatalog([
    {
      name: "mcp__context7_mcp__query_docs",
      description: "Query docs",
      sourceInfo: { source: "context7_mcp", path: "/extensions/context7-mcp.ts", origin: "top-level" },
    },
    {
      name: "web_search",
      description: "Search web",
      sourceInfo: { source: "npm:xz-pi-websearch@1.0.0", path: "/pkg/index.ts", origin: "package" },
    },
  ]);

  assert.deepEqual(catalog.map(({ kind, name }) => ({ kind, name })), [
    { kind: "mcp", name: "context7_mcp" },
    { kind: "package", name: "xz-pi-websearch" },
    { kind: "tool", name: "mcp__context7_mcp__query_docs" },
    { kind: "tool", name: "web_search" },
  ]);
  assert.deepEqual(catalog[0]?.memberToolNames, ["mcp__context7_mcp__query_docs"]);
});

test("native MCP namespace metadata uses the real server name", () => {
  const catalog = buildReferenceCatalog([{
    name: "github_get_me", description: "Get me", namespace: { name: "github" },
    sourceInfo: { source: "builtin:mcp", path: "github", origin: "top-level" },
  }]);
  assert.equal(catalog.find((value) => value.kind === "mcp")?.name, "github");
});

test("catalog includes enabled packages without tools and deduplicates package versions", async () => {
  const catalog = buildReferenceCatalog([], [
    "npm:xz-pi-vim", "npm:xz-pi-btw", "npm:xz-pi-vim@0.2.0", "npm:@scope/pkg@1.0.0", "npm:@scope/pkg",
  ]);
  assert.deepEqual(catalog.map(({ name, kind, memberToolNames }) => ({ name, kind, memberToolNames })), [
    { name: "xz-pi-vim", kind: "package", memberToolNames: [] },
    { name: "xz-pi-btw", kind: "package", memberToolNames: [] },
    { name: "@scope/pkg", kind: "package", memberToolNames: [] },
  ]);
  let completed: CompletedToolReference | undefined;
  const provider = createToolReferenceAutocompleteProvider(fallback, () => catalog, (value) => { completed = value; });
  const suggestions = await provider.getSuggestions(["$btw"], 0, 4, { signal });
  assert.equal(suggestions?.items[0]?.value, "xz-pi-btw");
  const result = provider.applyCompletion(["$btw"], 0, 4, suggestions!.items[0]!, suggestions!.prefix);
  assert.equal(result.lines[0], "xz-pi-btw ");
  assert.equal(completed?.reference.kind, "package");
  assert.deepEqual(completed?.reference.memberToolNames, []);
});

test("adapter gateways remain packages/tools, not fake MCP servers", async () => {
  const catalog = buildReferenceCatalog([{
    name: "mcp",
    description: "MCP gateway",
    sourceInfo: { source: "npm:pi-mcp-adapter", path: "/pkg/index.ts", origin: "package" },
  }], ["npm:pi-mcp-adapter@1.0.0"]);
  assert.equal(catalog.filter((value) => value.kind === "package").length, 1);
  assert.deepEqual(catalog.find((value) => value.kind === "package")?.memberToolNames, ["mcp"]);
  let completed: CompletedToolReference | undefined;
  const provider = createToolReferenceAutocompleteProvider(fallback, () => catalog, (value) => { completed = value; });
  const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal });
  assert.equal(catalog.filter((value) => value.kind === "mcp").length, 0);
  for (const kind of ["package"] as const) {
    const item = suggestions!.items.find((value) => value.description?.startsWith(kind.toUpperCase()))!;
    provider.applyCompletion(["$"], 0, 1, item, "$");
    assert.equal(completed?.reference.kind, kind);
  }
});

test("adapter status includes enabled lazy servers and authoritative tool counts", async () => {
  const sourceInfo = { source: "npm:pi-mcp-adapter", path: "/pkg/index.ts", origin: "package" as const };
  const catalog = buildReferenceCatalog([
    { name: "mcp", description: "Gateway", sourceInfo },
    { name: "mcp__context7_mcp", description: "Namespace proxy", sourceInfo },
  ], ["npm:pi-mcp-adapter"], [
    { name: "context7_mcp", toolCount: 2, status: "cached", disabled: false },
    { name: "github_mcp", toolCount: 0, status: "not-connected", disabled: false },
    { name: "disabled_mcp", toolCount: 9, status: "disabled", disabled: true },
  ]);
  const servers = catalog.filter((value) => value.kind === "mcp");
  assert.deepEqual(servers.map((value) => value.name), ["context7_mcp", "github_mcp"]);
  assert.match(servers[0]!.description!, /2 tools/);
  assert.deepEqual(servers[0]!.memberToolNames, ["mcp__context7_mcp"]);
  assert.deepEqual(servers[1]!.memberToolNames, ["mcp"]);
  assert.match(servers[1]!.description!, /not-connected/);
  const provider = createToolReferenceAutocompleteProvider(fallback, () => catalog, () => {});
  const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal });
  assert.deepEqual(suggestions!.items.slice(0, 2).map((item) => item.label), ["◆ context7_mcp", "◆ github_mcp"]);
});

test("direct-loading the adapter keeps its gateway and associates standard direct tools", () => {
  const sourceInfo = { source: "/extensions/pi-mcp-adapter/index.ts", path: "/extensions/pi-mcp-adapter/index.ts", origin: "top-level" as const };
  const catalog = buildReferenceCatalog([
    { name: "mcp", description: "Gateway", sourceInfo },
    { name: "context7_mcp_query_docs", description: "Direct tool", sourceInfo },
    { name: "disabled_mcp_query", description: "Retired direct tool", sourceInfo },
  ], [], [
    { name: "context7_mcp", toolCount: 2, status: "connected", disabled: false },
    { name: "github_mcp", toolCount: 0, status: "not-connected", disabled: false },
    { name: "disabled_mcp", toolCount: 1, status: "disabled", disabled: true },
  ]);
  assert.deepEqual(catalog.find((value) => value.kind === "mcp" && value.name === "context7_mcp")?.memberToolNames, ["context7_mcp_query_docs"]);
  assert.deepEqual(catalog.find((value) => value.kind === "mcp" && value.name === "github_mcp")?.memberToolNames, ["mcp"]);
  assert.equal(catalog.some((value) => value.name === "disabled_mcp_query"), false);
});

test("disabled MCP servers and hidden retired tools do not leak into dollar references", () => {
  const sourceInfo = { source: "npm:pi-mcp-adapter", path: "/pkg/index.ts", origin: "package" as const };
  const tools = [
    { name: "mcp", description: "Gateway", sourceInfo },
    { name: "mcp__disabled_mcp", description: "Retired proxy", sourceInfo },
    { name: "retired_tool", description: "Hidden", exposure: "hidden", sourceInfo },
  ];
  const catalog = buildReferenceCatalog(tools, [], [{ name: "disabled_mcp", toolCount: 2, status: "disabled", disabled: true }]);
  assert.equal(catalog.some((value) => value.name === "disabled_mcp" || value.name === "mcp__disabled_mcp" || value.name === "retired_tool"), false);
});

test("dollar suggestions prioritize MCP, then packages, then tools", async () => {
  const candidates = [
    { ...candidate, name: "read", kind: "tool" as const, source: "builtin" as const, memberToolNames: ["read"] },
    { ...candidate, name: "xz-pi-websearch", kind: "package" as const, source: "extension" as const, memberToolNames: ["web_search"] },
    { ...candidate, name: "context7_mcp", kind: "mcp" as const, memberToolNames: [candidate.name] },
  ];
  const provider = createToolReferenceAutocompleteProvider(fallback, () => candidates, () => {});
  const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal });
  assert.deepEqual(suggestions?.items.map((item) => item.label), [
    "◆ context7_mcp",
    "◇ xz-pi-websearch",
    "· read",
  ]);
});

test("tool completion removes dollar and records a tag", async () => {
  let completed: CompletedToolReference | undefined;
  const provider = createToolReferenceAutocompleteProvider(fallback, () => [candidate], (value) => {
    completed = value;
  });
  const text = "use $context";
  const suggestions = await provider.getSuggestions([text], 0, text.length, { signal });
  assert.equal(suggestions?.items[0]?.value, candidate.name);

  const result = provider.applyCompletion([text], 0, text.length, suggestions!.items[0]!, suggestions!.prefix);
  assert.equal(result.lines[0], `use ${candidate.name} `);
  assert.equal(completed?.reference.name, candidate.name);
  assert.equal(completed?.reference.start, 4);
  assert.equal(completed?.text, `use ${candidate.name} `);
});

test("tracker shifts tags, expands intersecting deletion, and captures submission", () => {
  const tracker = new ToolReferenceTracker();
  tracker.add({ ...candidate, start: 4, end: 8, name: "tool" });
  tracker.reconcile("use tool", "please use tool");
  assert.deepEqual(tracker.getAll().map(({ start, end }) => ({ start, end })), [{ start: 11, end: 15 }]);
  assert.deepEqual(tracker.expandRange({ start: 12, end: 13 }), { start: 11, end: 15 });
  tracker.reconcile("please use tool", "");
  assert.equal(tracker.consumeSubmitted("please use tool")[0]?.name, "tool");
});

test("tracker preserves tags when the host trims submitted completion whitespace", () => {
  const tracker = new ToolReferenceTracker();
  tracker.add({ ...candidate, name: "github_mcp", kind: "mcp", start: 2, end: 12 });
  tracker.reconcile("  github_mcp ", "");
  const references = tracker.consumeSubmitted("github_mcp");
  assert.equal(references.length, 1);
  assert.equal(references[0]?.start, 0);
  assert.equal(references[0]?.end, 10);
  assert.equal(tracker.consumeSubmitted("github_mcp").length, 0);
});

test("render highlights an MCP tag without changing editor text", () => {
  const tracker = new ToolReferenceTracker();
  const theme = {
    ...stubTheme,
    fg: (_name: string, text: string) => `\x1b[31m${text}\x1b[0m`,
    bg: (_name: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  } as ConstructorParameters<typeof XzModalEditor>[1];
  const editor = new XzModalEditor(stubTui, theme, stubKeybindings, { referenceTracker: tracker });
  for (const character of "use tool") editor.handleInput(character);
  tracker.add({ ...candidate, name: "tool", kind: "mcp", start: 4, end: 8 });

  assert.ok(editor.render(80).some((line) => line.includes("\x1b[44m\x1b[31mtool")));
  assert.equal(editor.getText(), "use tool");
});

test("submitting from normal mode preserves referenced tags for input handling", () => {
  const tracker = new ToolReferenceTracker();
  const editor = createEditor("use tool", { referenceTracker: tracker });
  tracker.add({ ...candidate, name: "tool", start: 4, end: 8 });
  let submitted = "";
  editor.onSubmit = (text) => {
    submitted = text;
  };

  editor.handleInput("\r");
  assert.equal(submitted, "use tool");
  assert.equal(tracker.consumeSubmitted(submitted)[0]?.name, "tool");
});

test("backspace after a tag deletes the whole tag", () => {
  const tracker = new ToolReferenceTracker();
  const editor = createEditor("use tool", { referenceTracker: tracker });
  tracker.add({ ...candidate, name: "tool", start: 4, end: 8 });

  send(editor, ["w", "e", "a", "\x7f"]);
  assert.equal(editor.getText(), "use ");
  assert.equal(tracker.getAll().length, 0);
});

test("normal x inside a tag deletes the whole tag and undo restores it", () => {
  const tracker = new ToolReferenceTracker();
  const editor = createEditor("use tool now", { referenceTracker: tracker });
  tracker.add({ ...candidate, name: "tool", start: 4, end: 8 });

  send(editor, ["w", "x"]);
  assert.equal(editor.getText(), "use  now");
  assert.equal(tracker.getAll().length, 0);

  editor.handleInput("u");
  assert.equal(editor.getText(), "use tool now");
  assert.equal(tracker.getAll()[0]?.name, "tool");
});
