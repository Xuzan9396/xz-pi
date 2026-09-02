import test from "node:test";
import assert from "node:assert/strict";
import { extractAnswer, extractSources, parseResponse } from "../openai-search.ts";

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
