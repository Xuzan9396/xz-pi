import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostEntry } from "./host-path.mjs";

const host = new URL(hostEntry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(hostEntry)).href;
const login = fileURLToPath(new URL("../index.ts", import.meta.url));

test("real host preserves physical defaults and project priority without registering xz-login models", () => {
  const dir = mkdtempSync(join(tmpdir(), "xz-login-host-physical-")), cwd = join(dir, "project");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(join(dir, "config", "xz-pi-login"), { recursive: true });
    const ids = ["openai-codex-work", "openai-codex-xuzan"];
    writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(ids.map(id => [id, { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 86400000 }]))));
    writeFileSync(join(dir, "config", "xz-pi-login", "accounts.json"), JSON.stringify({ version: 1, accounts: {
      "openai-codex-work": { base: "openai-codex", suffix: "work" }, "openai-codex-xuzan": { base: "openai-codex", suffix: "xuzan" },
    } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: ids[0], defaultModel: "gpt-6.1-sol" }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: ids[1], defaultModel: "gpt-6.1-sol" }));
    const source = `
      import assert from 'node:assert/strict';
      import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from ${JSON.stringify(host)};
      const services = await createAgentSessionServices({ cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(dir)}, resourceLoaderOptions: {
        additionalExtensionPaths: [${JSON.stringify(login)}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      } });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(${JSON.stringify(cwd)}), noTools: true });
      try {
        await session.bindExtensions({ mode: 'print' });
        assert.equal(session.model.provider, 'openai-codex-xuzan');
        assert.ok(services.modelRuntime.getAvailableSnapshot().every(model => !model.provider.startsWith('xz-login-')));
      } finally { session.dispose(); }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd, encoding: "utf8", timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: "", HOME: dir, PI_AGENT_DIR: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
