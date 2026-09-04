import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInlineSlashAutocompleteProvider, extractInlineSlashToken } from "../src/slash-autocomplete.js";

const fallback: AutocompleteProvider = {
  async getSuggestions() {
    return { items: [{ value: "fallback", label: "fallback" }], prefix: "fallback" };
  },
  applyCompletion(lines, cursorLine, cursorCol) {
    return { lines, cursorLine, cursorCol };
  },
  shouldTriggerFileCompletion() {
    return false;
  },
};

const signal = new AbortController().signal;

test("inline slash token requires horizontal whitespace before slash", () => {
  assert.deepEqual(extractInlineSlashToken("请帮我 /rel"), { prefix: "/rel", query: "rel" });
  assert.deepEqual(extractInlineSlashToken("second line\t/"), { prefix: "/", query: "" });
  assert.equal(extractInlineSlashToken("/rel"), undefined);
  assert.equal(extractInlineSlashToken("https://example.com/rel"), undefined);
  assert.equal(extractInlineSlashToken("path /foo/bar"), undefined);
});

test("provider fuzzy-matches commands after an inline slash", async () => {
  let delegatedLine = "";
  const piProvider: AutocompleteProvider = {
    ...fallback,
    async getSuggestions(lines) {
      delegatedLine = lines[0] ?? "";
      return { items: [{ value: "reload", label: "reload" }], prefix: "/rld" };
    },
  };
  const provider = createInlineSlashAutocompleteProvider(piProvider);
  const text = "please /rld";
  const suggestions = await provider.getSuggestions([text], 0, text.length, { signal });

  assert.equal(delegatedLine, "/rld");
  assert.equal(suggestions?.prefix, "/rld");
  assert.equal(suggestions?.items[0]?.value, "reload");
});

test("provider keeps the slash when applying an inline command", () => {
  const provider = createInlineSlashAutocompleteProvider(fallback);
  const text = "please /rel now";
  const result = provider.applyCompletion([text], 0, "please /rel".length, { value: "reload", label: "reload" }, "/rel");

  assert.deepEqual(result, {
    lines: ["please /reload  now"],
    cursorLine: 0,
    cursorCol: "please /reload ".length,
  });
});

test("provider delegates non-inline contexts", async () => {
  const provider = createInlineSlashAutocompleteProvider(fallback);
  const suggestions = await provider.getSuggestions(["/rel"], 0, 4, { signal });
  assert.equal(suggestions?.items[0]?.value, "fallback");
  assert.equal(provider.shouldTriggerFileCompletion?.(["plain"], 0, 5), false);
});
