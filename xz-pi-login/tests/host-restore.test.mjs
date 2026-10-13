import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostEntry } from "./host-path.mjs";

test("restoring an orphaned login registers it with the real host without changing auth.json", () => {
  const host = new URL(hostEntry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(hostEntry)).href;
  const dir = mkdtempSync(join(tmpdir(), "xz-login-host-restore-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex-work": { type: "oauth", access: "fixture-only", refresh: "fixture-only", expires: Date.now() + 86_400_000 },
  }));
  writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({
    version: 1, accounts: { "openai-xuzan": { base: "openai", suffix: "xuzan" } },
  }));
  // Reproduce the user's metadata overlay as well as the missing alias mapping.
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
    "openai-codex-work": { modelOverrides: { "gpt-6.1-sol": { name: "Retained user override" } } },
  } }));
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from ${JSON.stringify(host)};
    globalThis.fetch = async () => { throw new Error('Restoration must not use network access'); };
    const dir = ${JSON.stringify(dir)}, cwd = ${JSON.stringify(cwd)};
    const login = ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};
    const createServices = () => createAgentSessionServices({ cwd, agentDir: dir,
      resourceLoaderOptions: { additionalExtensionPaths: [login], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
    const authBefore = readFileSync(join(dir, 'auth.json'), 'utf8');
    const modelsBefore = readFileSync(join(dir, 'models.json'), 'utf8');
    const services = await createServices();
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const runtime = services.modelRuntime;
    assert.ok((await runtime.listCredentials()).some(credential => credential.providerId === 'openai-codex-work'));
    assert.equal(runtime.getRegisteredNativeProvider('openai-codex-work'), undefined);
    assert.equal(runtime.getProvider('openai-codex-work').auth.oauth, undefined, 'metadata overrides alone do not register the required OAuth provider');
    const model = runtime.getModels('openai')[0];
    const { session } = await createAgentSessionFromServices({ services, model, noTools: true, sessionManager: SessionManager.inMemory(cwd) });
    const notifications = [];
    try {
      await session.bindExtensions({ mode: 'print', uiContext: { notify: message => notifications.push(message) } });
      await session.prompt('/xz-login restore openai-codex work confirm');
      assert.ok(notifications.some(message => message.includes('restored openai-codex-work with the existing login')), notifications.join('\\n'));
      const provider = runtime.getProvider('openai-codex-work');
      assert.ok(provider.auth.oauth, 'the login selector can now list this OAuth provider');
      assert.match(provider.name, /\\(work\\)$/);
      assert.equal(runtime.getProviderAuthStatus('openai-codex-work').configured, true);
      assert.equal(session.model.provider, model.provider);
      assert.equal(session.model.id, model.id);
    } finally { session.dispose(); }
    const aliases = JSON.parse(readFileSync(join(dir, 'config/xz-pi-login/accounts.json'), 'utf8')).accounts;
    assert.deepEqual(aliases, { 'openai-xuzan': { base: 'openai', suffix: 'xuzan' }, 'openai-codex-work': { base: 'openai-codex', suffix: 'work' } });
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), authBefore);
    assert.equal(readFileSync(join(dir, 'models.json'), 'utf8'), modelsBefore);
    const restarted = await createServices();
    assert.ok(restarted.modelRuntime.getProvider('openai-codex-work').auth.oauth, 'restored mapping must survive restart');
    assert.equal(restarted.modelRuntime.getProviderAuthStatus('openai-codex-work').configured, true);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), authBefore);
    console.log(JSON.stringify({ registered: true, authUnchanged: true, mappingSurvivesRestart: true }));
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "", HOME: dir, PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)), {
      registered: true, authUnchanged: true, mappingSurvivesRestart: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
