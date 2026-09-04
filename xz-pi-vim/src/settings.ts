import { readFileSync } from "node:fs";
import { join } from "node:path";

export type XzPiVimSettings = {
  startInNormal: boolean;
  cursorShape: boolean;
  modeColors: boolean;
  exCommand: boolean;
  inlineSlashCompletion: boolean;
  toolReferences: boolean;
  activateReferencedTools: boolean;
  highlightToolReferences: boolean;
};

export const DEFAULT_SETTINGS: XzPiVimSettings = {
  startInNormal: false,
  cursorShape: true,
  modeColors: true,
  exCommand: true,
  inlineSlashCompletion: true,
  toolReferences: true,
  activateReferencedTools: true,
  highlightToolReferences: true,
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readXzPiVimSettings(cwd: string, home = process.env.HOME, projectTrusted = false): XzPiVimSettings {
  const globalSettings = home ? readJson(join(home, ".pi", "agent", "settings.json")) : undefined;
  const projectSettings = projectTrusted ? readJson(join(cwd, ".pi", "settings.json")) : undefined;
  const globalValue = isRecord(globalSettings) && isRecord(globalSettings.xzPiVim) ? globalSettings.xzPiVim : {};
  const projectValue = isRecord(projectSettings) && isRecord(projectSettings.xzPiVim) ? projectSettings.xzPiVim : {};
  const merged = { ...globalValue, ...projectValue };
  return {
    startInNormal: booleanOrDefault(merged.startInNormal, DEFAULT_SETTINGS.startInNormal),
    cursorShape: booleanOrDefault(merged.cursorShape, DEFAULT_SETTINGS.cursorShape),
    modeColors: booleanOrDefault(merged.modeColors, DEFAULT_SETTINGS.modeColors),
    exCommand: booleanOrDefault(merged.exCommand, DEFAULT_SETTINGS.exCommand),
    inlineSlashCompletion: booleanOrDefault(merged.inlineSlashCompletion, DEFAULT_SETTINGS.inlineSlashCompletion),
    toolReferences: booleanOrDefault(merged.toolReferences, DEFAULT_SETTINGS.toolReferences),
    activateReferencedTools: booleanOrDefault(merged.activateReferencedTools, DEFAULT_SETTINGS.activateReferencedTools),
    highlightToolReferences: booleanOrDefault(merged.highlightToolReferences, DEFAULT_SETTINGS.highlightToolReferences),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
