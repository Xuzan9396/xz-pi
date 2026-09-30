import test from "node:test";
import assert from "node:assert/strict";
import {
  createOciSearchAdapter,
  OCI_SEARCH_MODEL,
  OCI_SEARCH_PROVIDER,
  OCI_SEARCH_URL,
  type OciSecurityRunner,
} from "../oci-search.ts";

const completedOutput = [
  { type: "web_search_call", action: { sources: [{ url: "https://example.com/a", title: "A" }] } },
  { type: "message", content: [{ type: "output_text", text: "Grounded answer", annotations: [] }] },
];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function hangingSecurity(): OciSecurityRunner {
  return async (_args, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
}

test("discovers the fixed OCI route without reading the password", async () => {
  const calls: string[][] = [];
  const adapter = createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: async (args) => {
      calls.push([...args]);
      return "metadata ignored";
    },
  });

  assert.equal(await adapter.isAvailable(), true);
  assert.equal(await adapter.isAvailable(), true);
  assert.deepEqual(calls, [["find-generic-password", "-a", "fixture-user", "-s", "pi-xai-oci-api-key"]]);
  assert.equal(adapter.route.provider, OCI_SEARCH_PROVIDER);
  assert.equal(adapter.route.model, OCI_SEARCH_MODEL);
});

test("executes strict Responses web search and caches the credential for the session", async () => {
  const securityCalls: string[][] = [];
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const adapter = createOciSearchAdapter({
    env: { LOGNAME: "fixture-user" },
    runSecurity: async (args) => {
      securityCalls.push([...args]);
      return "fixture-secret\n";
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({ status: "completed", output: completedOutput });
    },
  });

  const first = await adapter.run({ query: "q", numResults: 2 });
  const second = await adapter.run({ query: "q2", numResults: 1 });

  assert.equal(first.provider, OCI_SEARCH_PROVIDER);
  assert.equal(first.model, OCI_SEARCH_MODEL);
  assert.equal(first.sources.length, 1);
  assert.equal(second.answer, "Grounded answer");
  assert.deepEqual(securityCalls, [["find-generic-password", "-a", "fixture-user", "-s", "pi-xai-oci-api-key", "-w"]]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, OCI_SEARCH_URL);
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(requests[0]?.body.model, OCI_SEARCH_MODEL);
  assert.deepEqual(requests[0]?.body.tools, [{ type: "web_search" }]);
  assert.equal(requests[0]?.body.tool_choice, "required");

  adapter.clearSessionCache();
  await adapter.run({ query: "q3" });
  assert.equal(securityCalls.length, 2);
});

test("rejects unsupported filters and incomplete or ungrounded responses", async () => {
  const make = (body: unknown) => createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: async () => "fixture-secret",
    fetchImpl: async () => jsonResponse(body),
  });

  await assert.rejects(
    () => make({ status: "completed", output: completedOutput }).run({ query: "q", domainFilter: ["example.com"] }),
    /does not support domainFilter/,
  );
  await assert.rejects(
    () => make({ status: "incomplete", output: completedOutput }).run({ query: "q" }),
    /did not complete/,
  );
  await assert.rejects(
    () => make({ status: "completed", output: completedOutput.slice(1) }).run({ query: "q" }),
    /did not execute web_search/,
  );
});

test("reports a missing Keychain account without invoking security", async () => {
  let called = false;
  const adapter = createOciSearchAdapter({
    env: {},
    runSecurity: async () => {
      called = true;
      return "unused";
    },
  });
  await assert.rejects(() => adapter.run({ query: "q" }), /requires USER or LOGNAME/);
  assert.equal(called, false);
});

test("redacts credentials, bounds responses, and distinguishes timeout from cancellation", async () => {
  const failed = createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: async () => "fixture-secret",
    fetchImpl: async () => new Response("fixture-secret provider detail", { status: 401 }),
  });
  await assert.rejects(async () => failed.run({ query: "q" }), (error: unknown) => {
    assert.match(String(error), /<redacted>/);
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });

  const oversized = createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: async () => "fixture-secret",
    fetchImpl: async () => new Response("x".repeat(64)),
    maxResponseBytes: 16,
  });
  await assert.rejects(() => oversized.run({ query: "q" }), /response exceeded 16 bytes/);

  const timedOut = createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: hangingSecurity(),
    credentialTimeoutMs: 5,
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(() => timedOut.run({ query: "q" }), /credential lookup timed out/);
  } finally {
    clearTimeout(keepAlive);
  }

  const controller = new AbortController();
  const cancelled = createOciSearchAdapter({
    env: { USER: "fixture-user" },
    runSecurity: hangingSecurity(),
  });
  const pending = cancelled.run({ query: "q" }, controller.signal);
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
