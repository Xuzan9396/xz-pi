import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cloneSearchPreference,
  DEFAULT_SEARCH_PREFERENCE,
  parseSearchPreference,
  type SearchPreference,
} from "./search-types.ts";

export const SETTINGS_VERSION = 3;
const SETTINGS_DIRECTORY = "xz-pi-websearch";
const SETTINGS_FILE = "settings.json";

export function settingsPath(home = process.env.HOME, override = process.env.XZ_PI_WEBSEARCH_DIR): string {
  const directory = override?.trim() || (home ? join(home, ".pi", "agent", SETTINGS_DIRECTORY) : undefined);
  if (!directory) throw new Error("Cannot access /xz-search settings because HOME is not set.");
  return join(directory, SETTINGS_FILE);
}

function parseSettings(value: unknown): SearchPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== SETTINGS_VERSION) return undefined;
  return parseSearchPreference(record.default);
}

export async function readSearchDefault(
  home = process.env.HOME,
  override = process.env.XZ_PI_WEBSEARCH_DIR,
): Promise<SearchPreference> {
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath(home, override), "utf8"));
    return cloneSearchPreference(parseSettings(value) ?? DEFAULT_SEARCH_PREFERENCE);
  } catch {
    return cloneSearchPreference(DEFAULT_SEARCH_PREFERENCE);
  }
}

export const readSearchPreference = readSearchDefault;

export async function writeSearchDefault(
  preference: SearchPreference,
  home = process.env.HOME,
  override = process.env.XZ_PI_WEBSEARCH_DIR,
): Promise<void> {
  const path = settingsPath(home, override);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const value = { version: SETTINGS_VERSION, default: cloneSearchPreference(preference) };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export const writeSearchPreference = writeSearchDefault;
