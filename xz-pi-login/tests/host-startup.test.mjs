import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostEntry } from "./host-path.mjs";

test("native OAuth aliases are available before scope selection on startup and session replacement", () => {
  const host = new URL(hostEntry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(hostEntry)).href;
  const dir = mkdtempSync(join(tmpdir(), "xz-login-host-startup-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const extensionDir = join(dir, "extension");
  const stalePeerDir = join(extensionDir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(stalePeerDir, { recursive: true });
  copyFileSync(new URL("../index.ts", import.meta.url), join(extensionDir, "index.ts"));
  symlinkSync(fileURLToPath(new URL("../lib", import.meta.url)), join(extensionDir, "lib"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(stalePeerDir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-ai", version: "0.84.4", type: "module", exports: { "./providers/all": "./all.js" },
  }));
  writeFileSync(join(stalePeerDir, "all.js"), "throw new Error('A stale workspace SDK must never be loaded');");
  mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-xuzan": { type: "oauth", access: "fixture-only", refresh: "fixture-only", expires: Date.now() + 86_400_000 },
    "openai-codex-work": { type: "oauth", access: "fixture-work", refresh: "fixture-work", expires: Date.now() + 86_400_000 },
    "openai-codex-xuzan": { type: "oauth", access: "fixture-xuzan", refresh: "fixture-xuzan", expires: Date.now() + 86_400_000 },
  }));
  writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({
    version: 1, accounts: {
      "openai-xuzan": { base: "openai", suffix: "xuzan" },
      "openai-codex-work": { base: "openai-codex", suffix: "work" },
      "openai-codex-xuzan": { base: "openai-codex", suffix: "xuzan" },
      "openai-codex-pending": { base: "openai-codex", suffix: "pending" },
    },
  }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: "https://example.invalid/v1", api: "openai-responses", apiKey: "fixture-only", models: [{ id: "stable-model" }] },
  } }));

  // A separate process deliberately omits tests/host-modules.mjs. That hook
  // masks the bug by rebinding native JS imports which Pi itself cannot bind.
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, ModelRuntime, SessionManager } from ${JSON.stringify(host)};
    globalThis.fetch = async () => { throw new Error('Startup must not use network access'); };
    const dir = ${JSON.stringify(dir)};
    const cwd = ${JSON.stringify(cwd)};
    const login = ${JSON.stringify(join(extensionDir, "index.ts"))};
    const pmodel = ${JSON.stringify(fileURLToPath(new URL("../../xz-pi-pmodel/index.ts", import.meta.url)))};
    const authBefore = readFileSync(join(dir, 'auth.json'), 'utf8');
    const aliasesBefore = readFileSync(join(dir, 'config/xz-pi-login/accounts.json'), 'utf8');
    const initial = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-store.json') });
    const base = initial.getProvider('openai');
    assert.ok(base.auth.oauth, 'requires modern OpenAI ChatGPT OAuth');
    const target = base.getModels().find(model => model.id === 'gpt-6.1-sol') || base.getModels()[0];
    const codexTarget = initial.getProvider('openai-codex').getModels()[0];
    const ids = ['fixture/stable-model', 'openai-xuzan/' + target.id,
      'openai-codex-work/' + codexTarget.id, 'openai-codex-xuzan/' + codexTarget.id];
    const authIds = ['openai-xuzan/' + target.id, 'openai-codex-work/' + codexTarget.id, 'openai-codex-xuzan/' + codexTarget.id];
    const assertAccounts = runtime => {
      const available = runtime.getAvailableSnapshot();
      for (const provider of ['openai-codex-work', 'openai-codex-xuzan']) {
        assert.ok(runtime.getProvider(provider).auth.oauth);
        assert.ok(available.some(model => model.provider === provider && model.id === codexTarget.id), provider + ' must list independently');
      }
      assert.ok(runtime.getProvider('openai-codex-pending').getModels().length, 'unconfigured aliases retain their catalog for later login');
      assert.ok(!available.some(model => model.provider === 'openai-codex-pending'), 'unconfigured aliases must not be available');
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ids, defaultProvider: 'openai-codex-xuzan', defaultModel: codexTarget.id }));
    const snapshots = [];
    // Recreating services is the same startup boundary used by switchSession.
    for (const reason of ['startup', 'resume']) {
      const services = await createAgentSessionServices({ cwd, agentDir: dir,
        resourceLoaderOptions: { additionalExtensionPaths: [pmodel, login], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
      assert.deepEqual(services.diagnostics, []);
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const runtime = services.modelRuntime;
      assert.ok(runtime.getProvider('openai-xuzan').auth.oauth, 'alias must have host OAuth BEFORE session_start');
      assertAccounts(runtime);
      const available = runtime.getAvailableSnapshot();
      const scopedModels = ids.map(id => {
        const model = available.find(model => model.provider + '/' + model.id === id);
        assert.ok(model, 'startup scope must include ' + id);
        return { model };
      });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd),
        model: scopedModels[3].model, scopedModels, noTools: true, sessionStartEvent: { type: 'session_start', reason } });
      try {
        await session.bindExtensions({ mode: 'print' });
        await runtime.refresh({ allowNetwork: false });
        assert.deepEqual(session.scopedModels.map(({ model }) => model.provider + '/' + model.id), ids);
        assert.equal(session.model.provider, 'openai-codex-xuzan');
        assert.equal(session.model.id, codexTarget.id);
        await session.reload();
        await runtime.refresh({ allowNetwork: false });
        assertAccounts(runtime);
        assert.equal(session.model.provider, 'openai-codex-xuzan', 'reload must preserve the physical startup decision');
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enabledModels, authIds);
        snapshots.push({ reason, scoped: ids, oauth: true });
      } finally { session.dispose(); }
    }
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir: dir,
        resourceLoaderOptions: { additionalExtensionPaths: [pmodel, login], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
      const available = services.modelRuntime.getAvailableSnapshot();
      const configuredIds = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enabledModels || ids;
      const scopedModels = configuredIds.map(id => ({ model: available.find(model => model.provider + '/' + model.id === id) }));
      assert.ok(scopedModels.every(item => item.model), 'rebuilt scope must include the saved auth-backed selection');
      const explicit = available.find(model => model.provider === 'openai-codex-xuzan' && model.id === codexTarget.id);
      assert.ok(explicit, 'direct account selection remains compatible');
      return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: explicit, scopedModels, noTools: true })), services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: dir, sessionManager: SessionManager.create(cwd, join(dir, 'sessions')) });
    const notifications = [];
    const bind = session => session.bindExtensions({ mode: 'tui',
      uiContext: { notify: (message, type) => notifications.push({ message, type }), setWidget() {}, setStatus() {},
        custom: async factory => {
          let action;
          const component = factory({ requestRender() {} },
            { fg: (_color, text) => text, bold: text => text, style: text => text },
            { matches: (data, key) => data === key }, value => { action = value; });
          component.handleInput('tui.input.tab');
          const rendered = component.render(160).join('\\n');
          assert.match(rendered, /Scope: all/);
          assert.match(rendered, /openai-xuzan/);
          assert.match(rendered, /openai-codex-xuzan/);
          assert.doesNotMatch(rendered, /xz-login-|openai-codex-pending|fixture/);
          component.handleInput('app.models.save');
          assert.deepEqual(action, { type: 'save-global-scope', modelIds: authIds });
          return action;
        } },
      commandContextActions: { switchSession: (file, options) => runtime.switchSession(file, options) } });
    runtime.setRebindSession(bind);
    try {
      await bind(runtime.session);
      assert.ok(!notifications.some(({ message }) => /Account pool service is unavailable/.test(message)));
      assertAccounts(runtime.services.modelRuntime);
      runtime.session.sessionManager.appendMessage({ role: 'user', content: 'preserved conversation', timestamp: 1 });
      runtime.session.refreshContext();
      const originalFile = runtime.session.sessionFile;
      assert.ok(originalFile);
      const oldSession = runtime.session;
      await runtime.session.prompt('/pmodel');
      assert.notEqual(runtime.session, oldSession, 'Ctrl+S must rebuild the runtime');
      assert.equal(runtime.session.sessionFile, originalFile, 'synchronization must reopen the same conversation');
      assert.ok(runtime.session.messages.some(message => message.role === 'user' && message.content === 'preserved conversation'));
      assert.deepEqual(runtime.session.scopedModels.map(({ model }) => model.provider + '/' + model.id), authIds);
      assert.match(notifications.at(-1).message, /saved and synchronized/);
      assert.equal(notifications.at(-1).type, 'info');
      assertAccounts(runtime.services.modelRuntime);
      assert.equal(runtime.session.model.provider, 'openai-codex-xuzan', 'session synchronization preserves the explicit direct-account selection');
    } finally { await runtime.dispose(); }
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), authBefore);
    assert.equal(readFileSync(join(dir, 'config/xz-pi-login/accounts.json'), 'utf8'), aliasesBefore);
    console.log(JSON.stringify(snapshots));
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "", HOME: dir, PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
    const snapshots = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(snapshots.map(snapshot => snapshot.reason), ["startup", "resume"]);
    assert.ok(snapshots.every(snapshot => snapshot.oauth && snapshot.scoped.some(id => id.startsWith("openai-xuzan/"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
