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
