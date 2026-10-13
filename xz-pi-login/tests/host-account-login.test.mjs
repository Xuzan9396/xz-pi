import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostEntry } from "./host-path.mjs";

test("a newly prepared sibling becomes selectable immediately after host login without rediscovery", () => {
  const host = new URL(hostEntry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(hostEntry)).href;
  const dir = mkdtempSync(join(tmpdir(), "xz-login-host-account-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex-work": { type: "oauth", access: "fixture-work", refresh: "fixture-work", expires: Date.now() + 86_400_000 },
  }));
  writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({
    version: 1, accounts: { "openai-codex-work": { base: "openai-codex", suffix: "work" } },
  }));
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from ${JSON.stringify(host)};
    globalThis.fetch = async () => { throw new Error('No network in account login regression'); };
    const dir = ${JSON.stringify(dir)}, cwd = ${JSON.stringify(cwd)};
    const services = await createAgentSessionServices({ cwd, agentDir: dir,
      resourceLoaderOptions: { additionalExtensionPaths: [
        ${JSON.stringify(fileURLToPath(new URL("../../xz-pi-pmodel/index.ts", import.meta.url)))},
        ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))},
      ], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const runtime = services.modelRuntime;
    const work = runtime.getAvailableSnapshot().find(model => model.provider === 'openai-codex-work');
    assert.ok(work);
    const { session } = await createAgentSessionFromServices({ services, model: work,
      scopedModels: [{ model: work }], noTools: true, sessionManager: SessionManager.inMemory(cwd) });
    const notifications = [];
    let pickerOpened = false;
    try {
      await session.bindExtensions({ mode: 'tui', uiContext: {
        notify: message => notifications.push(message), setWidget() {}, setStatus() {},
        getEditorText: () => '', setEditorText() {},
        custom: async factory => {
          const component = factory({ requestRender() {} },
            { fg: (_color, text) => text, bold: text => text, style: text => text },
            { matches: (data, key) => data === key }, () => {});
          component.handleInput('tui.input.tab');
          const rendered = component.render(160).join('\\n');
          assert.match(rendered, /Scope: all/);
          assert.match(rendered, /openai-codex-work/);
          assert.match(rendered, /openai-codex-xuzan/);
          pickerOpened = true;
          return { type: 'cancel' };
        },
      } });
      await session.prompt('/xz-login add openai-codex xuzan');
      const id = 'openai-codex-xuzan';
      const alias = runtime.getRegisteredNativeProvider(id);
      assert.ok(alias?.auth.oauth, notifications.join('\\n'));
      assert.ok(alias.getModels().length, 'prepared aliases must not have a permanently empty catalog');
      await runtime.refresh({ allowNetwork: false });
      assert.ok(!runtime.getAvailableSnapshot().some(model => model.provider === id), 'no login yet');

      // Stub ONLY the browser exchange. Preserve the extension's catalog and
      // exercise the real host credential write + login availability refresh.
      runtime.registerNativeProvider({ ...alias, auth: { ...alias.auth, oauth: {
        ...alias.auth.oauth,
        login: async () => ({ type: 'oauth', access: 'fixture-xuzan', refresh: 'fixture-xuzan', expires: Date.now() + 86_400_000 }),
      } } });
      await runtime.login(id, 'oauth', { signal: new AbortController().signal, notify() {}, prompt: async () => '' });
      const selected = runtime.getAvailableSnapshot().find(model => model.provider === id && model.id === work.id);
      assert.ok(selected, 'host login must expose the sibling without /xz-login refresh or another task');
      assert.equal((await runtime.getAuth(id)).auth.apiKey, 'fixture-xuzan');
      assert.equal((await runtime.getAuth('openai-codex-work')).auth.apiKey, 'fixture-work');
      await session.prompt('/pmodel');
      assert.ok(pickerOpened, notifications.join('\\n'));
      await session.setModel(selected);
      assert.equal(session.model.provider, id);
      await session.setModel(work);
      await runtime.logout(id);
      await runtime.refresh({ allowNetwork: false });
      assert.ok(!runtime.getAvailableSnapshot().some(model => model.provider === id), 'logout removes availability, not the account catalog');
      assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === 'openai-codex-work'));
      const credentials = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
      assert.equal(credentials['openai-codex-work'].access, 'fixture-work');
      assert.equal(credentials[id], undefined);
      console.log('account-login-ok');
    } finally { session.dispose(); }
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "", HOME: dir, PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
    assert.match(child.stdout, /account-login-ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
