import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readXzPiVimSettings } from "../src/settings.js";

test("project settings are ignored until the project is trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "xz-pi-vim-settings-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ xzPiVim: { cursorShape: false } }));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ xzPiVim: { cursorShape: true, startInNormal: true } }));

  assert.deepEqual(readXzPiVimSettings(cwd, home, false), {
    startInNormal: false,
    cursorShape: false,
    modeColors: true,
    exCommand: true,
    inlineSlashCompletion: true,
    toolReferences: true,
    activateReferencedTools: true,
    highlightToolReferences: true,
  });
  assert.deepEqual(readXzPiVimSettings(cwd, home, true), {
    startInNormal: true,
    cursorShape: true,
    modeColors: true,
    exCommand: true,
    inlineSlashCompletion: true,
    toolReferences: true,
    activateReferencedTools: true,
    highlightToolReferences: true,
  });
});
