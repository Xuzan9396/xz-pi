import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsesSearchTool,
  extractAnswer,
  extractSources,
  isResponsesSearchModel,
  parseResponse,
  searchModelCandidates,
} from "../openai-search.ts";
import type { SearchRoute } from "../search-types.ts";

const output = [
  { type: "web_search_call", action: { sources: [{ url: "https://example.com/a", title: "A" }] } },
  { type: "message", content: [{ type: "output_text", text: "Grounded answer [A](https://example.com/a)", annotations: [
    { type: "url_citation", url: "https://example.com/a?utm_source=openai", title: "A" },
    { type: "url_citation", url: "https://example.com/b", title: "B" },
  ] }] },
];

test("extracts answer and de-duplicated sources", () => {
  assert.match(extractAnswer(output), /Grounded answer/);
  assert.deepEqual(extractSources(output, 5), [
    { title: "A", url: "https://example.com/a" },
    { title: "B", url: "https://example.com/b" },
  ]);
});

test("search follows the current route before dynamically configured Responses providers", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-6-terra", api: "openai-codex-responses" },
    { provider: "openai-codex-personal", id: "gpt-6-sol", api: "openai-codex-responses" },
    { provider: "openai-codex-work", id: "gpt-6-terra", api: "openai-codex-responses" },
    { provider: "github-copilot", id: "gpt-6-sol", api: "openai-responses" },
    { provider: "openai", id: "gpt-6-terra", api: "openai-responses" },
  ] as never[];
  const current = models[1];
  assert.deepEqual(
    searchModelCandidates(models, current).slice(0, 4).map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`),
    ["openai-codex-personal/gpt-6-sol", "openai-codex/gpt-6-terra", "openai-codex-work/gpt-6-terra", "github-copilot/gpt-6-sol"],
  );
});

test("recognizes only supported Responses search models", () => {
  assert.equal(isResponsesSearchModel({ provider: "github-copilot", id: "grok-4.7", api: "openai-responses" } as never), true);
  assert.equal(isResponsesSearchModel({ provider: "github-copilot", id: "gpt-5.4", api: "openai-responses" } as never), true);
  assert.equal(isResponsesSearchModel({ provider: "github-copilot", id: "claude-opus-5.5", api: "anthropic-messages" } as never), false);
  assert.equal(isResponsesSearchModel({ provider: "xai", id: "grok-5", api: "openai-responses" } as never), true);
});

test("enforces provider-specific domain filters", () => {
  const xai = { provider: "xai", model: "grok-4.7", adapter: "responses", flavor: "xai" } as SearchRoute;
  assert.throws(
    () => buildResponsesSearchTool({ query: "q", domainFilter: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"] }, xai),
    /at most 5 domains/,
  );
  assert.throws(
    () => buildResponsesSearchTool({ query: "q", domainFilter: ["a.com", "-b.com"] }, xai),
    /cannot combine allowed and excluded domains/,
  );

  const codex = { provider: "openai-codex-personal", model: "gpt-6-sol", adapter: "responses", flavor: "codex" } as SearchRoute;
  assert.deepEqual(buildResponsesSearchTool({ query: "q", domainFilter: ["a.com", "-b.com"] }, codex), {
    type: "web_search",
    filters: { allowed_domains: ["a.com"], blocked_domains: ["b.com"] },
  });
});

test("parses JSON and SSE responses", async () => {
  const json = await parseResponse(new Response(JSON.stringify({ output })));
  assert.equal(json.sawSearch, true);
  assert.equal(json.output.length, 2);

  const sse = [
    `data: ${JSON.stringify({ type: "response.output_item.done", item: output[0] })}`,
    `data: ${JSON.stringify({ type: "response.output_item.done", item: output[1] })}`,
    "data: [DONE]",
  ].join("\n\n");
  const streamed = await parseResponse(new Response(sse));
  assert.equal(streamed.sawSearch, true);
  assert.equal(extractAnswer(streamed.output).startsWith("Grounded answer"), true);
});
