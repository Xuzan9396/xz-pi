import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as runtime from "../lib/runtime.ts";
import { normalizeConfig } from "../lib/config.js";
import { setAccountAliases } from "../lib/slots.js";
import { sessionState } from "../lib/sessions.js";

const directories = [];
const originalAgentDir = process.env.PI_AGENT_DIR;
const originalCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = fileURLToPath(new URL("..", import.meta.url));
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = originalAgentDir;
  if (originalCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalCodingAgentDir;
  setAccountAliases({});
});

function createObservationFixture(strategy = "balanced") {
  const dir = mkdtempSync(join(tmpdir(), "xz-login-observation-"));
  directories.push(dir);
  process.env.PI_AGENT_DIR = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  const slots = ["openai-codex-work", "openai-codex-xuzan"];
  const aliases = Object.fromEntries(slots.map(provider => [provider, { base: "openai-codex", suffix: provider.split("-").at(-1) }]));
  const state = runtime.createRuntimeState(dir, normalizeConfig({ strategy }), { builtinProviders: () => [] });
  setAccountAliases(aliases);
  state.usageEnabled = false;
  const usageResponses = [];
  state.usage = { response: (...args) => usageResponses.push(args), updateStatus: async () => {} };
  const family = { base: "openai-codex", slots, status: "active", strategy, rrIndex: -1,
    ttlMs: 300_000, sessions: new Map(), cooldowns: new Map(), drained: new Map() };
  state.families.set(family.base, family);
  const model = { provider: slots[1], id: "fixture-model", api: "openai-codex-responses",
    name: "Fixture", reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let selected = model;
  let thinking = "xhigh";
  const handlers = new Map();
  const modelWrites = [];
  const thinkingWrites = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, list.filter(item => item !== handler));
    },
    async setModel(next) { modelWrites.push(next); selected = next; thinking = "medium"; return true; },
    getThinkingLevel: () => thinking,
    setThinkingLevel(next) { thinkingWrites.push(next); thinking = next; },
  };
  const ctx = {
    get model() { return selected; }, get thinkingLevel() { return thinking; },
    mode: "print", hasUI: false, sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [] },
    modelRegistry: { find: (provider, id) => slots.includes(provider) && id === model.id ? { ...model, provider } : undefined,
      getProvider: provider => slots.includes(provider) ? { id: provider } : undefined,
      hasConfiguredAuth: () => true },
  };
  // The fallback lets the pre-change test execute the real old lifecycle, rather
  // than failing merely because the new export has not been introduced yet.
  runtime.bindRuntimeHooks(pi, dir, state);
  return { dir, state, family, model, pi, ctx, handlers, modelWrites, thinkingWrites, usageResponses,
    selectByUser(next, level) { selected = next; thinking = level; } };
}

async function dispatchLifecycleEvent(fixture, name, event = {}) {
  let result;
  for (const handler of fixture.handlers.get(name) ?? []) result = await handler(event, fixture.ctx);
  return result;
}

const outcomes = [
  { label: "success without HTTP hook", stopReason: "stop" },
  { label: "success with stale warmth", stopReason: "stop", status: 200 },
  ...[401, 402, 403, 429].map(status => ({ label: `HTTP ${status}`, status, stopReason: "error", errorMessage: `HTTP ${status}` })),
  { label: "quota error after HTTP 200", status: 200, stopReason: "error", errorMessage: "usage_limit exceeded" },
  { label: "failure before provider request", noRequest: true, stopReason: "error", errorMessage: "No API key" },
  { label: "stream timeout", stopReason: "error", errorMessage: "bridge connection lost" },
  { label: "user cancel", stopReason: "aborted", errorMessage: "Request aborted" },
];
for (const strategy of ["balanced", "round-robin", "failover"]) {
  for (const outcome of outcomes) {
    test(`T1 ${strategy}: ${outcome.label} only observes and never switches or continues`, async () => {
      const f = createObservationFixture(strategy);
      await dispatchLifecycleEvent(f, "before_agent_start");
      if (!outcome.noRequest) await dispatchLifecycleEvent(f, "before_provider_request", { payload: { input: [{ role: "user", content: "fixture" }] } });
      if (outcome.status !== undefined) await dispatchLifecycleEvent(f, "after_provider_response", { status: outcome.status, headers: {} });
      const { session } = sessionState(f.family, f.ctx);
      session.warm.set(f.model.provider, Date.now() - 600_000);
      const message = { role: "assistant", provider: f.model.provider, model: f.model.id,
        stopReason: outcome.stopReason, errorMessage: outcome.errorMessage, content: [] };
      await dispatchLifecycleEvent(f, "turn_end", { message, toolResults: [] });
      await dispatchLifecycleEvent(f, "agent_end", { messages: [message] });
      const entries = [];
      const settle = { outcome: outcome.stopReason === "error" ? "error" : "success", entries,
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-attempt", message }, messages: [message] }] } };
      const result = await dispatchLifecycleEvent(f, "agent_before_settle", settle);
      assert.deepEqual(f.modelWrites, [], "no lifecycle is authorized to select another account");
      assert.deepEqual(f.thinkingWrites, [], "observers do not write thinking preferences");
      assert.equal(f.ctx.model.provider, f.model.provider);
      assert.equal(f.ctx.thinkingLevel, "xhigh");
      assert.equal(result, undefined, "observers must not request continuation or context replacement");
      assert.deepEqual(entries, []);
      const journal = readFileSync(join(f.dir, "xz-pi-login-journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(journal.some(row => row.kind === "turn"), "run-end evidence is retained");
      assert.ok(!journal.some(row => ["route", "resume", "thinking"].includes(row.kind)));
      const debug = existsSync(join(f.dir, "xz-pi-login-debug.log"))
        ? readFileSync(join(f.dir, "xz-pi-login-debug.log"), "utf8") : "";
      assert.doesNotMatch(debug, /"kind":"handler_error"/, "swallowed handler errors cannot make the test pass");
      if (outcome.status === 200) assert.equal(f.family.drained.get(f.model.provider), 1);
      if ([401, 402, 403, 429].includes(outcome.status) || outcome.stopReason === "error") {
        assert.ok(f.family.cooldowns.has(f.model.provider), "failure observations remain available to status displays");
      }
      if (outcome.status !== undefined) assert.equal(f.usageResponses.length, 1);
    });
  }
}

test("T1 passive hooks leave late user selections and other session observations alone", async () => {
  const f = createObservationFixture();
  await dispatchLifecycleEvent(f, "before_provider_request", { payload: { input: [] } });
  const other = { ...f.ctx, sessionManager: { getSessionId: () => "other-session" } };
  const { session } = sessionState(f.family, other);
  session.warm.set("openai-codex-work", 123);
  const foreground = { provider: "unmanaged-foreground", id: "manual-model", api: "fixture-api" };
  f.selectByUser(foreground, "high");
  await dispatchLifecycleEvent(f, "after_provider_response", { status: 200, headers: {} });
  await dispatchLifecycleEvent(f, "agent_end", { messages: [] });
  assert.equal(session.warm.get("openai-codex-work"), 123);
  assert.equal(f.ctx.model, foreground);
  assert.equal(f.ctx.thinkingLevel, "high");
  assert.deepEqual(f.modelWrites, []);
  assert.deepEqual(f.thinkingWrites, []);
});

test("T1 alias history projection keeps message bodies and stored identities intact", async () => {
  const f = createObservationFixture();
  const content = Object.freeze([{ type: "thinking", thinking: "fixture", thinkingSignature: "fixture-signature" },
    { type: "toolCall", id: "fixture-tool-id", name: "fixture-tool", arguments: {} }]);
  const message = Object.freeze({ role: "assistant", api: f.model.api, model: f.model.id,
    provider: "openai-codex-work", content });
  const foreign = Object.freeze({ ...message, api: "different-api" });
  const messages = Object.freeze([message, foreign]);
  const result = await dispatchLifecycleEvent(f, "context_with_system", { messages });
  assert.equal(result.messages[0].provider, f.model.provider);
  assert.equal(result.messages[0].content, content);
  assert.equal(result.messages[1], foreign);
  assert.equal(message.provider, "openai-codex-work");
  assert.equal(messages[0], message);
  assert.deepEqual(f.modelWrites, []);
});

test("production package confines model changes to startup/delete policy and has no retired random router", () => {
  const retired = ["recovery.js", "router.js", "balanced.js", "strategy.js", "switch.js", "thinking.js"];
  for (const file of retired) assert.equal(existsSync(join(root, "lib", file)), false, `${file} must be deleted, not disabled`);
  const files = [join(root, "index.ts")];
  const collect = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(?:js|ts)$/.test(entry.name)) files.push(path);
    }
  };
  collect(join(root, "lib"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\.setThinkingLevel\s*\(/, file);
    if (/\.setModel\s*\(/.test(source)) assert.ok(
      file.endsWith("startup-policy.ts") || file.endsWith("account-removal.ts"),
      `model changes are not allowed in ${file}`,
    );
    assert.doesNotMatch(source, /from\s+["'][^"']*\/(?:recovery|router|balanced|strategy|switch|thinking)\.js["']/, file);
  }
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.doesNotMatch(metadata.description, /rotation|failover/i);
  assert.ok(!metadata.keywords.some(key => ["rotation", "failover"].includes(key)));
  const changesetDir = join(dirname(root), ".changeset");
  const changes = readdirSync(changesetDir)
    .filter(file => file.endsWith(".md") && file !== "README.md")
    .map(file => readFileSync(join(changesetDir, file), "utf8"));
  assert.ok(changes.some(change => /^"xz-pi-login": minor$/m.test(change)), "xz-pi-login requires a minor changeset");
});
