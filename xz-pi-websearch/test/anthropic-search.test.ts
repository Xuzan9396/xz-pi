import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnthropicSearchTool,
  isAnthropicSearchModel,
  parseAnthropicResponse,
  runAnthropicSearch,
} from "../anthropic-search.ts";
import type { SearchRoute } from "../search-types.ts";

const responseBody = {
  content: [
    { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "current UTC date" } },
    { type: "web_search_tool_result", tool_use_id: "srv_1", content: [
      { type: "web_search_result", url: "https://example.com/a", title: "A", page_age: "today" },
    ] },
    { type: "text", text: "Grounded answer", citations: [
      { type: "web_search_result_location", url: "https://example.com/a", title: "A" },
      { type: "web_search_result_location", url: "https://example.com/b", title: "B" },
    ] },
  ],
};

const route: SearchRoute = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  adapter: "anthropic",
  label: "anthropic / claude-opus-5-5",
  verified: false,
};

test("recognizes Anthropic Messages models and builds strict filters", () => {
  assert.equal(isAnthropicSearchModel({ provider: "anthropic", id: "configured-future-model", api: "anthropic-messages" } as never), true);
  assert.equal(isAnthropicSearchModel({ provider: "github-copilot", id: "claude-opus-5.5", api: "anthropic-messages" } as never), false);
  assert.deepEqual(buildAnthropicSearchTool({ query: "q", domainFilter: ["example.com"] }), {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 5,
    allowed_domains: ["example.com"],
  });
  assert.throws(
    () => buildAnthropicSearchTool({ query: "q", domainFilter: ["example.com", "-blocked.com"] }),
    /cannot combine allowed and blocked domains/,
  );
});

test("normalizes Anthropic text, tool use, results, and citations", () => {
  assert.deepEqual(parseAnthropicResponse(responseBody, 5), {
    answer: "Grounded answer",
    sources: [
      { title: "A", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ],
    sawSearch: true,
  });
});

test("sends an authenticated Anthropic Messages search request", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const model = {
    provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.test", headers: {},
  };
  const ctx = {
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
      isUsingOAuth: () => false,
    },
  } as never;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await runAnthropicSearch({ query: "q" }, route, ctx, undefined, fetchImpl);
  assert.equal(result.provider, "anthropic");
  assert.equal(request?.url, "https://api.anthropic.test/v1/messages");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("x-api-key"), "test-key");
  const body = JSON.parse(String(request?.init?.body)) as { tools: Array<{ type: string }> };
  assert.equal(body.tools[0]?.type, "web_search_20250305");
});
