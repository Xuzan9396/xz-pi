import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xzPiLogin from "../index.ts";
import { aliasesPath, loadAliases } from "../lib/account-aliases.js";

let savedAgentDir;
let savedCodingAgentDir;

beforeEach(() => {
  savedAgentDir = process.env.PI_AGENT_DIR;
  savedCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  if (savedCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedCodingAgentDir;
});

function fixture({ auth = {}, aliases = {}, settings = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xz-pi-login-activation-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  if (Object.keys(aliases).length) {
    const path = aliasesPath(dir);
    mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, accounts: aliases }));
  }
  process.env.PI_AGENT_DIR = dir;
  return dir;
}

function fakePi(dir, native = {}) {
  const handlers = new Map();
  const commands = new Map();
  const providers = new Map(Object.entries(native));
  const nativeProviders = new Map(Object.entries(native));
  const virtualModels = new Map();
  const listeners = new Map();
  const pi = {
    handlers, commands, providers, unregistered: [], setModelCalls: [],
    events: {
      on(name, handler) {
        const list = listeners.get(name) || new Set();
        list.add(handler); listeners.set(name, list);
        return () => list.delete(handler);
      },
      emit(name, data) { for (const handler of listeners.get(name) || []) handler(data); },
    },
    registerVirtualModel(definition) { virtualModels.set(`${definition.provider}/${definition.id}`, definition); },
    unregisterVirtualModel(provider, id) { virtualModels.delete(`${provider}/${id}`); },
    on(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerProvider(...args) {
      const definition = args.length === 1 ? args[0] : { id: args[0], ...args[1] };
      providers.set(definition.id, definition);
      if (args.length === 1) nativeProviders.set(definition.id, definition);
    },
    unregisterProvider(id) { providers.delete(id); nativeProviders.delete(id); pi.unregistered.push(id); },
    async setModel(model) { pi.setModelCalls.push(model); return true; },
    getThinkingLevel: () => "medium",
    setThinkingLevel() {},
  };

  const registry = {
    getRegisteredProviderIds: () => [...providers.keys()],
    getRegisteredNativeProvider: id => nativeProviders.get(id),
    getRegisteredProviderConfig: () => undefined,
    getProvider: id => providers.get(id),
    getProviderAuthStatus: id => ({ configured: Object.hasOwn(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), id) }),
    hasConfiguredAuth: ({ provider }) => Object.hasOwn(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), provider),
    find: (provider, id) => {
      const virtual = virtualModels.get(`${provider}/${id}`);
      return virtual ? { ...virtual, api: "pi-virtual" } : providers.get(provider)?.getModels?.().find(model => model.id === id);
    },
    refresh: async () => ({ errors: new Map() }),
  };
  return { pi, registry };
}

function context(registry, extra = {}) {
  return {
    mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt-5.2" }, modelRegistry: registry,
    sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [] },
    ui: { notify() {}, getEditorText: () => "", setEditorText() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, setWidget() {} },
    ...extra,
  };
}

async function fire(pi, name, event, ctx) {
  let result;
  for (const handler of pi.handlers.get(name) || []) result = await handler(event, ctx);
  return result;
}

describe("extension activation", () => {
  it("registers only /xz-login and uses independent log/config names", () => {
    const dir = fixture();
    const { pi } = fakePi(dir);
    xzPiLogin(pi);
    assert.ok(pi.commands.has("xz-login"));
    assert.equal(pi.commands.has("rotator"), false);
    assert.deepEqual([...pi.handlers.keys()].sort(), [
      "session_start", "before_agent_start", "context_with_system", "before_provider_request",
      "after_provider_response", "agent_end", "session_compact", "cache_warming_decision", "input", "model_select",
    ].sort());
  });

  it("T2 removes next from the command, menu and completions without changing accounts", async () => {
    const aliases = { "openai-work": { base: "openai", suffix: "work" } };
    const dir = fixture({ aliases, auth: { "openai-work": { type: "api_key", key: "fixture-only" } } });
    const { pi, registry } = fakePi(dir);
    xzPiLogin(pi);
    const command = pi.commands.get("xz-login");
    const completions = command.getArgumentCompletions("").map(row => row.value);
    assert.ok(!completions.includes("next"));
    assert.equal(command.getArgumentCompletions("next"), null);
    assert.doesNotMatch(command.description, /\bnext\b/);
    for (const name of ["add", "restore", "status", "refresh", "accounts", "limits", "remove", "reset"]) {
      assert.ok(completions.includes(name), `${name} is retained`);
    }
    let menu;
    const ctx = context(registry);
    ctx.ui.select = async (_title, values) => { menu = values; return undefined; };
    const authBefore = readFileSync(join(dir, "auth.json"), "utf8");
    const aliasesBefore = readFileSync(aliasesPath(dir), "utf8");
    await command.handler("menu", ctx);
    assert.ok(!menu.includes("Switch account"));
    const result = await command.handler("next", ctx);
    assert.doesNotMatch(result, /no other healthy|switched to|switch did not land/);
    assert.deepEqual(pi.setModelCalls, []);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), authBefore);
    assert.equal(readFileSync(aliasesPath(dir), "utf8"), aliasesBefore);
  });

  it("status advertises named auth providers and leaves legacy config unchanged", async () => {
    const dir = fixture({ aliases: { "openai-work": { base: "openai", suffix: "work" } } });
    const path = join(dir, "config", "xz-pi-login", "config.json");
    const original = JSON.stringify({ strategy: "round-robin", announceSwitches: true, showUsage: false });
    writeFileSync(path, original);
    const { pi, registry } = fakePi(dir);
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("status", context(registry));
    assert.match(result, /named auth providers/);
    assert.match(result, /\/model.*\/pmodel/);
    assert.doesNotMatch(result, /balanced|round-robin|failover/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(pi.setModelCalls, []);
  });

  it("enters standby when pi-rotator or pi-multi-account is enabled", () => {
    for (const rival of ["npm:pi-rotator", "npm:pi-multi-account"]) {
      const dir = fixture({ settings: { packages: [rival] } });
      const { pi, registry } = fakePi(dir);
      xzPiLogin(pi);
      assert.equal(pi.handlers.size, 0);
      assert.match(pi.commands.get("xz-login").handler("", context(registry)), /STANDBY/);
    }
  });

  it("refreshes add completions from Pi's native provider registry", async () => {
    const dir = fixture();
    const community = { id: "community-native", name: "Community", getModels: () => [], stream: () => {} };
    const { pi, registry } = fakePi(dir, { "community-native": community });
    xzPiLogin(pi);
    await fire(pi, "session_start", {}, context(registry));
    const values = pi.commands.get("xz-login").getArgumentCompletions("add ").map(row => row.value);
    assert.ok(values.includes("add openai"));
    assert.ok(values.includes("add community-native"));
  });

  it("restores a persisted named provider before it has credentials", () => {
    const dir = fixture({ aliases: { "openai-work": { base: "openai", suffix: "work" } } });
    const { pi } = fakePi(dir);
    xzPiLogin(pi);
    assert.ok(pi.providers.has("openai-work"));
    assert.equal(pi.providers.get("openai-work").name.endsWith("(work)"), true);
  });

  it("keeps sibling catalogs stable when the routing carrier changes", async () => {
    const aliases = {
      "openai-codex-work": { base: "openai-codex", suffix: "work" },
      "openai-codex-xuzan": { base: "openai-codex", suffix: "xuzan" },
    };
    const credential = { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 86400000 };
    const dir = fixture({ aliases, auth: Object.fromEntries(Object.keys(aliases).map(id => [id, credential])) });
    const base = { id: "openai-codex", name: "Codex fixture", auth: { oauth: {} },
      getModels: () => [{ id: "fixture-model", provider: "openai-codex" }], stream() {} };
    const { pi, registry } = fakePi(dir, { "openai-codex": base });
    xzPiLogin(pi);
    const ctx = context(registry);
    await fire(pi, "session_start", {}, ctx);
    const definitions = Object.keys(aliases).map(id => pi.providers.get(id));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex-xuzan": credential }));
    await pi.commands.get("xz-login").handler("refresh", ctx);
    for (const definition of definitions) {
      assert.equal(pi.providers.get(definition.id), definition, "carrier changes must not re-register native siblings");
      assert.deepEqual(definition.getModels(), [{ id: "fixture-model", provider: definition.id }]);
    }
  });

  it("rebinds startup aliases to Pi's live provider auth definition", async () => {
    const dir = fixture({ aliases: { "openai-work": { base: "openai", suffix: "work" } } });
    const { pi, registry } = fakePi(dir);
    const live = {
      id: "openai", name: "Live OpenAI", auth: { oauth: { login: async () => ({}) } },
      getModels: () => [{ provider: "openai", id: "live-model", type: "chat" }], stream: () => {},
    };
    registry.getProvider = id => id === "openai" ? live : pi.providers.get(id);

    xzPiLogin(pi);
    await fire(pi, "session_start", {}, context(registry));

    assert.equal(pi.providers.get("openai-work").auth, live.auth);
    assert.ok(pi.providers.get("openai-work").auth.oauth);
  });

  it("discovers provider families added by a newer live Pi registry", async () => {
    const dir = fixture();
    const { pi, registry } = fakePi(dir);
    const live = {
      id: "future-host", name: "Future Host", auth: { oauth: { login: async () => ({}) } },
      getModels: () => [{ provider: "future-host", id: "future-model", type: "chat" }], stream: () => {},
    };
    registry.getAll = () => live.getModels();
    registry.getProvider = id => id === live.id ? live : pi.providers.get(id);

    xzPiLogin(pi);
    await fire(pi, "session_start", {}, context(registry));

    const values = pi.commands.get("xz-login").getArgumentCompletions("add ").map(row => row.value);
    assert.ok(values.includes("add future-host"));
    await pi.commands.get("xz-login").handler("add future-host work", context(registry, { mode: "rpc", hasUI: false, ui: undefined }));
    assert.equal(pi.providers.get("future-host-work").auth, live.auth);
  });
});

describe("add account", () => {
  it("selects a provider, asks for an alias, persists it and prefills /login", async () => {
    const dir = fixture();
    const { pi, registry } = fakePi(dir);
    const editor = [];
    const live = context(registry, { model: null, ui: {
      notify() {}, getEditorText: () => "", setEditorText: text => editor.push(text), setWidget() {},
      select: async () => "openai", input: async () => " Work_1 ", confirm: async () => false,
    } });
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("add", live);
    assert.match(result, /prepared openai-work_1/);
    assert.deepEqual(editor, ["/login openai-work_1"]);
    assert.deepEqual(loadAliases(dir), { "openai-work_1": { base: "openai", suffix: "work_1" } });
    assert.ok(pi.providers.has("openai-work_1"));
  });

  it("supports explicit provider and alias without UI", async () => {
    const dir = fixture();
    const { pi, registry } = fakePi(dir);
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("add openai personal", context(registry, { mode: "rpc", hasUI: false, ui: undefined }));
    assert.match(result, /\/login openai-personal/);
    assert.ok(loadAliases(dir)["openai-personal"]);
  });

  it("rejects invalid and duplicate aliases without overwriting the first", async () => {
    const dir = fixture();
    const { pi, registry } = fakePi(dir);
    const live = context(registry, { mode: "rpc", hasUI: false, ui: undefined });
    xzPiLogin(pi);
    assert.match(await pi.commands.get("xz-login").handler("add openai work;rm", live), /must match/);
    await pi.commands.get("xz-login").handler("add openai work", live);
    assert.match(await pi.commands.get("xz-login").handler("add openai work", live), /already exists/);
    assert.deepEqual(Object.keys(loadAliases(dir)), ["openai-work"]);
  });
});

describe("restore existing login", () => {
  const id = "openai-codex-work";
  const credential = { type: "oauth", access: "fixture-only", refresh: "fixture-only", expires: Date.now() + 86400000 };

  function orphan(options = {}) {
    const dir = fixture({ auth: { [id]: credential }, ...options });
    const { pi, registry } = fakePi(dir);
    xzPiLogin(pi);
    return { dir, pi, registry, command: pi.commands.get("xz-login"), authBefore: readFileSync(join(dir, "auth.json"), "utf8") };
  }

  it("explains why an orphaned credential blocks add but has no login provider", async () => {
    const f = orphan();
    assert.equal(f.pi.providers.has(id), false);
    const result = await f.command.handler("add openai-codex work", context(f.registry));
    assert.match(result, /a login already exists/);
    assert.match(result, /alias mapping is missing.*\/xz-login restore openai-codex work/);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("restores a native OAuth provider with explicit confirmation without changing credentials or model", async () => {
    const f = orphan();
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry, { mode: "rpc", hasUI: false, ui: undefined }));
    assert.match(result, /restored openai-codex-work with the existing login/);
    assert.deepEqual(loadAliases(f.dir), { [id]: { base: "openai-codex", suffix: "work" } });
    assert.ok(f.pi.providers.get(id).auth.oauth);
    assert.match(f.pi.providers.get(id).name, /\(work\)$/);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
    assert.deepEqual(f.pi.setModelCalls, []);
  });

  it("supports interactive confirmation and never prefills a new login", async () => {
    const f = orphan();
    const prompts = [];
    const editor = [];
    const ctx = context(f.registry);
    ctx.ui.confirm = async (title, message) => { prompts.push({ title, message }); return true; };
    ctx.ui.setEditorText = value => editor.push(value);
    const result = await f.command.handler("restore openai-codex work", ctx);
    assert.match(result, /restored openai-codex-work/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].message, /account of openai-codex/);
    assert.deepEqual(editor, []);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("does nothing without confirmation, including in non-UI mode", async () => {
    for (const ui of [true, false]) {
      const f = orphan();
      const ctx = ui ? context(f.registry) : context(f.registry, { hasUI: false, ui: undefined });
      const result = await f.command.handler("restore openai-codex work", ctx);
      assert.match(result, /No login or mapping changed.*restore openai-codex work confirm/);
      assert.equal(existsSync(aliasesPath(f.dir)), false);
      assert.equal(f.pi.providers.has(id), false);
      assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
    }
  });

  it("does not create credentials when the stored login is missing", async () => {
    const f = orphan({ auth: {} });
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /no stored login/);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("does not replace a foreign registered provider", async () => {
    const f = orphan();
    const foreign = { id, name: "Foreign owner", auth: { oauth: {} }, getModels: () => [] };
    f.pi.providers.set(id, foreign);
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /provider id is already registered/);
    assert.equal(f.pi.providers.get(id), foreign);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("recovers an OAuth account with an empty metadata-only placeholder", async () => {
    const f = orphan();
    const source = { providers: { [id]: { modelOverrides: { fixture: { name: "Retained metadata" } } } } };
    writeFileSync(join(f.dir, "models.json"), JSON.stringify(source));
    const placeholder = { id, name: id, auth: { apiKey: {} }, getModels: () => [] };
    f.pi.providers.set(id, placeholder);
    const authStatus = f.registry.getProviderAuthStatus;
    f.registry.getProviderAuthStatus = key => key === id && f.pi.providers.get(id) === placeholder ? { configured: false } : authStatus(key);
    const hint = await f.command.handler("add openai-codex work", context(f.registry));
    assert.match(hint, /alias mapping is missing/);
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /restored openai-codex-work/);
    assert.notEqual(f.pi.providers.get(id), placeholder);
    assert.ok(f.pi.providers.get(id).auth.oauth);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "models.json"), "utf8")), source);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("does not take over a custom endpoint even when it has metadata overrides", async () => {
    const f = orphan();
    writeFileSync(join(f.dir, "models.json"), JSON.stringify({ providers: { [id]: { baseUrl: "https://example.invalid", modelOverrides: {} } } }));
    const foreign = { id, auth: { apiKey: {} }, getModels: () => [] };
    f.pi.providers.set(id, foreign);
    f.registry.getProviderAuthStatus = () => ({ configured: false });
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /provider id is already registered/);
    assert.equal(f.pi.providers.get(id), foreign);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("does not overwrite an existing mapping or infer a different base", async () => {
    const aliases = { [id]: { base: "openai", suffix: "codex-work" } };
    const f = orphan({ aliases });
    const before = readFileSync(aliasesPath(f.dir), "utf8");
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /alias already exists/);
    assert.equal(readFileSync(aliasesPath(f.dir), "utf8"), before);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("rejects authentication types unsupported by the selected native provider", async () => {
    const f = orphan({ auth: { [id]: { type: "api_key", key: "fixture-only" } } });
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /does not support.*authentication type/);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("rejects unknown providers, unsafe aliases and invalid confirmation flags", async () => {
    const f = orphan();
    for (const input of ["restore unknown work confirm", "restore openai-codex work;rm confirm", "restore openai-codex work force"]) {
      const result = await f.command.handler(input, context(f.registry));
      assert.match(result, /no native provider|alias must match|Usage:/);
      assert.deepEqual(loadAliases(f.dir), {});
    }
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("rechecks credential existence after confirmation instead of resurrecting a removed login", async () => {
    const f = orphan();
    const ctx = context(f.registry);
    ctx.ui.confirm = async () => { writeFileSync(join(f.dir, "auth.json"), "{}"); return true; };
    const result = await f.command.handler("restore openai-codex work", ctx);
    assert.match(result, /stored login.*changed during confirmation/);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(f.pi.providers.has(id), false);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), "{}");
  });

  it("rolls back only the new mapping on registration failure while retaining the login", async () => {
    const f = orphan();
    const register = f.pi.registerProvider;
    f.pi.registerProvider = value => { if (value.id === id) throw new Error("fixture failure"); register(value); };
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /restoration failed.*existing login was retained/);
    assert.deepEqual(loadAliases(f.dir), {});
    assert.equal(f.pi.providers.has(id), false);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("retains a successfully restored mapping when catalog refresh fails", async () => {
    const f = orphan();
    f.registry.refresh = async () => { throw new Error("fixture-only"); };
    const result = await f.command.handler("restore openai-codex work confirm", context(f.registry));
    assert.match(result, /restored.*catalog refresh failed.*mapping was retained/);
    assert.ok(loadAliases(f.dir)[id]);
    assert.ok(f.pi.providers.get(id).auth.oauth);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("a concurrent duplicate restore does not remove the first operation's mapping", async () => {
    const f = orphan();
    const results = await Promise.all([
      f.command.handler("restore openai-codex work confirm", context(f.registry)),
      f.command.handler("restore openai-codex work confirm", context(f.registry)),
    ]);
    assert.ok(results.some(result => /restored.*existing login/.test(result)));
    assert.ok(results.some(result => /mapped or registered concurrently/.test(result)));
    assert.deepEqual(loadAliases(f.dir), { [id]: { base: "openai-codex", suffix: "work" } });
    assert.ok(f.pi.providers.get(id).auth.oauth);
    assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), f.authBefore);
  });

  it("offers restore in completion and the interactive menu", async () => {
    const f = orphan();
    assert.ok(f.command.getArgumentCompletions("rest").some(row => row.value === "restore"));
    assert.ok(f.command.getArgumentCompletions("restore openai-codex").some(row => row.value === "restore openai-codex"));
    const ctx = context(f.registry);
    ctx.ui.select = async title => title === "XZ Login" ? "Restore existing login" : "openai-codex";
    ctx.ui.input = async () => "work";
    ctx.ui.confirm = async () => true;
    const result = await f.command.handler("", ctx);
    assert.match(result, /restored openai-codex-work/);
    assert.ok(loadAliases(f.dir)[id]);
  });
});

describe("remove account", () => {
  it("lists managed aliases, confirms, logs out and removes the mapping", async () => {
    const aliases = { "openai-work": { base: "openai", suffix: "work" } };
    const dir = fixture({ auth: { openai: {}, "openai-work": { type: "api_key", key: "fixture" } }, aliases });
    const { pi, registry } = fakePi(dir);
    registry.getModelRuntime = () => ({ logout: async id => {
      const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
      delete auth[id];
      writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
    } });
    const live = context(registry, { ui: {
      notify() {}, setWidget() {}, select: async (_title, values) => values[0], confirm: async () => true,
    } });
    xzPiLogin(pi);
    const completion = pi.commands.get("xz-login").getArgumentCompletions("remove ");
    assert.deepEqual(completion.map(row => row.value), ["remove openai-work"]);
    assert.match(await pi.commands.get("xz-login").handler("remove", live), /Removed login, alias and Provider/);
    assert.deepEqual(loadAliases(dir), {});
    assert.equal(existsSync(aliasesPath(dir)), true);
    assert.ok(pi.unregistered.includes("openai-work"));
  });

  it("retains the alias when logout fails before removing credentials", async () => {
    const aliases = { "openai-work": { base: "openai", suffix: "work" } };
    const dir = fixture({ auth: { "openai-work": { type: "api_key", key: "fixture" } }, aliases });
    const { pi, registry } = fakePi(dir);
    registry.getModelRuntime = () => ({ logout: async () => { throw new Error("failed before write"); } });
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("remove openai-work confirm", context(registry, { model: { provider: "openai", id: "gpt" } }));
    assert.match(result, /Retry remove to continue safely/);
    assert.ok(loadAliases(dir)["openai-work"]);
  });

  it("cleans the alias when logout removed credentials but refresh reported failure", async () => {
    const aliases = { "openai-work": { base: "openai", suffix: "work" } };
    const dir = fixture({ auth: { "openai-work": { type: "api_key", key: "fixture" } }, aliases });
    const { pi, registry } = fakePi(dir);
    registry.getModelRuntime = () => ({ logout: async id => {
      writeFileSync(join(dir, "auth.json"), "{}");
      throw new Error(`refresh failed after ${id}`);
    } });
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("remove openai-work confirm", context(registry, { model: { provider: "openai", id: "gpt" } }));
    assert.match(result, /Removed login, alias and Provider/);
    assert.deepEqual(loadAliases(dir), {});
  });

  it("removes an idle active alias without switching to an internal provider", async () => {
    const aliases = { "openai-work": { base: "openai", suffix: "work" } };
    const dir = fixture({ auth: { "openai-work": {} }, aliases });
    const { pi, registry } = fakePi(dir);
    xzPiLogin(pi);
    const result = await pi.commands.get("xz-login").handler("remove openai-work confirm", context(registry, { model: { provider: "openai-work", id: "gpt" } }));
    assert.match(result, /Removed login, alias and Provider/);
    assert.equal(loadAliases(dir)["openai-work"], undefined);
    assert.deepEqual(pi.setModelCalls, []);
  });
});
