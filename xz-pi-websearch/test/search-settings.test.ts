import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readSearchDefault,
  settingsPath,
  writeSearchDefault,
} from "../search-settings.ts";

test("writes and reads private atomic version 3 defaults", async () => {
  const home = await mkdtemp(join(tmpdir(), "xz-websearch-settings-"));
  assert.deepEqual(await readSearchDefault(home, ""), { mode: "current-provider" });

  await writeSearchDefault({ mode: "auto" }, home, "");
  assert.deepEqual(await readSearchDefault(home, ""), { mode: "auto" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath(home, ""), "utf8")), {
    version: 3,
    default: { mode: "auto" },
  });

  const fixed = { mode: "fixed", provider: "github-copilot", model: "grok-4.7" } as const;
  await writeSearchDefault(fixed, home, "");
  assert.deepEqual(await readSearchDefault(home, ""), fixed);
  if (process.platform !== "win32") assert.equal((await stat(settingsPath(home, ""))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dirname(settingsPath(home, "")))).sort(), ["settings.json"]);
});

test("version 1 and 2 settings reset to current-provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "xz-websearch-settings-"));
  const path = settingsPath(home, "");
  await writeSearchDefault({ mode: "auto" }, home, "");

  await writeFile(path, '{"version":1,"provider":"openai-codex-work","model":"gpt-6-terra"}\n');
  assert.deepEqual(await readSearchDefault(home, ""), { mode: "current-provider" });

  await writeFile(path, '{"version":2,"mode":"fixed","provider":"github-copilot","model":"grok-4.7"}\n');
  assert.deepEqual(await readSearchDefault(home, ""), { mode: "current-provider" });
});

test("malformed or unknown settings fall back to current-provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "xz-websearch-settings-"));
  await writeSearchDefault({ mode: "auto" }, home, "");
  await writeFile(settingsPath(home, ""), '{"version":3,"default":{"mode":"future"}}\n');
  assert.deepEqual(await readSearchDefault(home, ""), { mode: "current-provider" });
});
