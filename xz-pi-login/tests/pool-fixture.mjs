import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function feature(name) {
  const url = new URL(`../lib/${name}.ts`, import.meta.url);
  assert.ok(existsSync(url), `v10 feature missing: ${name}`);
  return import(url.href);
}
export function eventBus() {
  const listeners = new Map();
  return {
    on(name, fn) {
      const list = listeners.get(name) ?? new Set();
      list.add(fn); listeners.set(name, list);
      return () => list.delete(fn);
    },
    emit(name, data) { for (const fn of [...listeners.get(name) ?? []]) fn(data); },
  };
}
export function model(provider, id = "fixture-model", api = provider === "anthropic" ? "anthropic-messages" : "openai-responses") {
  return { provider, id, name: id, api, baseUrl: "https://fixture.invalid", reasoning: true,
    input: ["text", "image"], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
export function createPoolFixture(t, { bases = ["openai"], aliases, auth, settings = {}, ambient = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xz-pool-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  aliases ??= Object.fromEntries(bases.flatMap(base => ["personal", "work"].map(suffix => [base + "-" + suffix, { base, suffix }])));
  auth ??= Object.fromEntries(Object.keys(aliases).map(id => [id, { type: "api_key", key: "fixture-only-" + id }]));
  mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({ version: 1, accounts: aliases }));
  const providers = new Map(bases.map(base => [base, {
    id: base, name: base, auth: { apiKey: {} }, getModels: () => [model(base)],
    stream() { throw new Error("Fixture has no external transport"); },
  }]));
  const virtual = new Map(), hooks = new Map(), selected = [];
  const pi = {
    events: eventBus(), registerProvider: definition => providers.set(definition.id, definition),
    unregisterProvider: id => providers.delete(id),
    registerVirtualModel: definition => virtual.set(definition.provider + "/" + definition.id, definition),
    unregisterVirtualModel: (provider, id) => virtual.delete(provider + "/" + id),
    on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); return () => {}; },
    async setModel(next) { selected.push(next); ctx.model = next; return true; },
    getThinkingLevel: () => "high", registerCommand() {},
  };
  const ownAuth = () => JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
  const all = () => [...providers.values()].flatMap(x => x.getModels()).concat([...virtual.values()].map(x => ({ ...model(x.provider, x.id), api: "pi-virtual" })));
  const registry = {
    getAll: all,
    getAvailable: () => all().filter(x => x.api === "pi-virtual" || Object.hasOwn(ownAuth(), x.provider) || ambient.includes(x.provider)),
    getRegisteredProviderIds: () => [...providers.keys()],
    getRegisteredNativeProvider: id => providers.get(id),
    getRegisteredProviderConfig: () => undefined,
    getProvider: id => providers.get(id),
    getProviderAuthStatus: id => ({ configured: Object.hasOwn(ownAuth(), id) || ambient.includes(id) }),
    hasConfiguredAuth: x => Object.hasOwn(ownAuth(), x.provider) || ambient.includes(x.provider),
    find: (provider, id) => all().find(x => x.provider === provider && x.id === id),
    refresh: async () => ({ errors: new Map(), aborted: false }),
  };
  const notices = [];
  const ctx = {
    model: model(bases[0]), modelRegistry: registry, cwd: dir, hasUI: true, mode: "tui",
    sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [], getSessionFile: () => undefined },
    isIdle: () => true, isProjectTrusted: () => true,
    ui: { notify: (...args) => notices.push(args), setStatus() {}, setWidget() {}, getEditorText: () => "", setEditorText() {} },
  };
  const state = { aliases, ownedAliases: new Set(), nativeAliases: new Map(), families: new Map(), preparedAccounts: new Set(),
    builtins: { builtinProviders: () => bases.map(base => providers.get(base)) }, accountFactories: new Map(),
    config: { cooldownMs: 60000, ttlMs: 60000, ttlByFamily: {} }, requests: new Map() };
  return { dir, pi, ctx, state, registry, virtual, providers, selected, notices, ownAuth, hooks };
}
