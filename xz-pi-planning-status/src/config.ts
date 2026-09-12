import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_ENABLED = true;
export const CONFIG_FILE_NAME = "xz-planning-status.json";

export function getGlobalConfigPath(home = process.env.HOME): string | null {
  return home ? join(home, ".pi", "agent", CONFIG_FILE_NAME) : null;
}

export function readGlobalEnabled(home = process.env.HOME): boolean {
  const path = getGlobalConfigPath(home);
  if (!path) return DEFAULT_ENABLED;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(value) && typeof value.enabled === "boolean") return value.enabled;
  } catch {
    // A missing or malformed config falls back to the documented default.
  }
  return DEFAULT_ENABLED;
}

export function writeGlobalEnabled(enabled: boolean, home = process.env.HOME): void {
  const path = getGlobalConfigPath(home);
  if (!path) throw new Error("Cannot save /xz preference because HOME is not set");

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
