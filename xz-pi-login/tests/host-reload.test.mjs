import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostEntry } from "./host-path.mjs";

test("upgrading an already imported JS runtime cannot leave stale lifecycle exports on reload", () => {
  const host = new URL(hostEntry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(hostEntry)).href;
  const dir = mkdtempSync(join(tmpdir(), "xz-login-host-reload-"));
  const extensionDir = join(dir, "extension");
  mkdirSync(extensionDir);
  cpSync(new URL("../lib", import.meta.url), join(extensionDir, "lib"), { recursive: true });
  cpSync(new URL("../index.ts", import.meta.url), join(extensionDir, "index.ts"));
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(extensionDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const runtimeSource = fileURLToPath(new URL("../lib/runtime.ts", import.meta.url));
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { discoverAndLoadExtensions } from ${JSON.stringify(host)};
    const dir = ${JSON.stringify(dir)};
    const extensionDir = ${JSON.stringify(extensionDir)};
    writeFileSync(join(extensionDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'settings.json'), '{}');
    const nativeRuntime = join(extensionDir, 'lib/runtime.js');
    writeFileSync(nativeRuntime, \`export function createRuntimeState() { return {}; }
      export function registerStandalone() {}
      export function bindRoutingHooks() {}
      export function finishStartup() {}\`);
    // Native ESM imports are process-cached even when Pi disables jiti's module cache.
    const obsolete = await import(pathToFileURL(nativeRuntime).href);
    assert.equal(typeof obsolete.bindRuntimeHooks, 'undefined');
    writeFileSync(nativeRuntime, readFileSync(${JSON.stringify(runtimeSource)}, 'utf8'));
    const entry = join(extensionDir, 'index.ts');
    for (const reason of ['reload', 'session replacement']) {
      const result = await discoverAndLoadExtensions([entry], dir, dir);
      assert.deepEqual(result.errors, [], reason + ' must not reuse the obsolete JS runtime');
      const extension = result.extensions.find(extension => extension.path === entry);
      assert.ok(extension.commands.has('xz-login'));
      assert.ok(extension.handlers.has('session_start'));
      assert.ok(extension.handlers.has('before_provider_request'));
      assert.ok(extension.handlers.has('model_select'), 'physical selection lifecycle must load');
      assert.equal(extension.handlers.has('agent_before_settle'), false, 'retired pool failover hook must stay absent');
      if (reason === 'reload') {
        const runtimePath = join(extensionDir, 'lib/runtime.ts');
        writeFileSync(runtimePath, readFileSync(runtimePath, 'utf8').replace(
          'export function bindRuntimeHooks(pi, dir, state) {',
          \"export function bindRuntimeHooks(pi, dir, state) { pi.registerCommand('reload-marker', { handler() {} });\",
        ));
      } else {
        assert.ok(extension.commands.has('reload-marker'), 'TypeScript lifecycle helpers must be fresh after editing');
      }
    }
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "", HOME: dir, PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
