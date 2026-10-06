import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export const PMODEL_PREFERENCES_VERSION = 1 as const;

export type PreferenceLayer = "global" | "project";
export type PreferenceSource = PreferenceLayer | "default";

export interface ProviderPreferences {
  modelOrder?: string[];
  visibleModels?: string[];
}

export interface PModelPreferencesV1 {
  version: typeof PMODEL_PREFERENCES_VERSION;
  migrations?: { projectThinkingDefaultsRemoved?: boolean };
  providerOrder?: string[];
  providers?: Record<string, ProviderPreferences>;
}

export interface PreferencePaths {
  global: string;
  project: string;
}

export interface ResolvedProviderPreferences extends ProviderPreferences {
  sources: {
    modelOrder: "global" | "default";
    visibleModels: PreferenceSource;
  };
}

export interface ResolvedPreferences extends PModelPreferencesV1 {
  providers: Record<string, ResolvedProviderPreferences>;
  sources: {
    providerOrder: "global" | "default";
  };
}

export type PreferenceOverride =
  | { field: "providerOrder"; value?: readonly string[] }
  | { field: "modelOrder"; provider: string; value?: readonly string[] }
  | { field: "visibleModels"; provider: string; value?: readonly string[] };

export type PreferenceOverrideTarget =
  | { field: "providerOrder" }
  | { field: "modelOrder"; provider: string }
  | { field: "visibleModels"; provider: string };

function uniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && !result.includes(item)) result.push(item);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizePreferences(value: unknown, source = "preferences"): PModelPreferencesV1 {
  if (!isRecord(value)) throw new Error(`Invalid ${source}: expected an object`);
  if (value.version !== PMODEL_PREFERENCES_VERSION) {
    throw new Error(`Invalid ${source}: expected version ${PMODEL_PREFERENCES_VERSION}`);
  }

  if (value.migrations !== undefined && (!isRecord(value.migrations) ||
      (value.migrations.projectThinkingDefaultsRemoved !== undefined && typeof value.migrations.projectThinkingDefaultsRemoved !== "boolean"))) {
    throw new Error(`Invalid ${source}: migrations must contain a boolean completion flag`);
  }
  const result: PModelPreferencesV1 = { ...value, version: PMODEL_PREFERENCES_VERSION };
  delete result.providerOrder;
  delete result.providers;
  const providerOrder = uniqueStrings(value.providerOrder);
  if (providerOrder) result.providerOrder = providerOrder;

  if (value.providers !== undefined) {
    if (!isRecord(value.providers)) throw new Error(`Invalid ${source}: providers must be an object`);
    const providers: Record<string, ProviderPreferences> = {};
    for (const [provider, raw] of Object.entries(value.providers)) {
      if (!provider || !isRecord(raw)) continue;
      const entry: ProviderPreferences = { ...raw };
      delete entry.modelOrder;
      delete entry.visibleModels;
      const modelOrder = uniqueStrings(raw.modelOrder);
      const visibleModels = uniqueStrings(raw.visibleModels);
      if (modelOrder) entry.modelOrder = modelOrder;
      if (visibleModels) entry.visibleModels = visibleModels;
      if (Object.keys(entry).length > 0) providers[provider] = entry;
    }
    if (Object.keys(providers).length > 0) result.providers = providers;
  }
  return result;
}

function emptyPreferences(): PModelPreferencesV1 {
  return { version: PMODEL_PREFERENCES_VERSION };
}

export function getPreferencePaths(
  cwd: string,
  agentDir = getAgentDir(),
): PreferencePaths {
  return {
    global: join(agentDir, "xz-pi-pmodel.json"),
    project: join(cwd, CONFIG_DIR_NAME, "xz-pi-pmodel.json"),
  };
}

export function readPreferenceFile(path: string): PModelPreferencesV1 {
  if (!existsSync(path)) return emptyPreferences();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read pmodel preferences at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizePreferences(parsed, path);
}

export function readPreferenceLayers(paths: PreferencePaths, options: { projectTrusted?: boolean } = {}): {
  global: PModelPreferencesV1;
  project: PModelPreferencesV1;
} {
  return {
    global: readPreferenceFile(paths.global),
    project: options.projectTrusted === false ? emptyPreferences() : readPreferenceFile(paths.project),
  };
}

function inherited<T>(
  projectValue: T | undefined,
  globalValue: T | undefined,
): { value: T | undefined; source: PreferenceSource } {
  if (projectValue !== undefined) return { value: projectValue, source: "project" };
  if (globalValue !== undefined) return { value: globalValue, source: "global" };
  return { value: undefined, source: "default" };
}

function globalOnly<T>(value: T | undefined): { value: T | undefined; source: "global" | "default" } {
  return { value, source: value === undefined ? "default" : "global" };
}

export function resolvePreferences(
  globalPreferences: PModelPreferencesV1,
  projectPreferences: PModelPreferencesV1,
): ResolvedPreferences {
  const providerOrder = globalOnly(globalPreferences.providerOrder);
  const providerIds = new Set([
    ...Object.keys(globalPreferences.providers ?? {}),
    ...Object.keys(projectPreferences.providers ?? {}),
  ]);
  const providers: Record<string, ResolvedProviderPreferences> = {};

  for (const provider of providerIds) {
    const globalProvider = globalPreferences.providers?.[provider];
    const projectProvider = projectPreferences.providers?.[provider];
    const modelOrder = globalOnly(globalProvider?.modelOrder);
    const visibleModels = inherited(projectProvider?.visibleModels, globalProvider?.visibleModels);
    providers[provider] = {
      ...(modelOrder.value !== undefined ? { modelOrder: [...modelOrder.value] } : {}),
      ...(visibleModels.value !== undefined ? { visibleModels: [...visibleModels.value] } : {}),
      sources: {
        modelOrder: modelOrder.source,
        visibleModels: visibleModels.source,
      },
    };
  }

  return {
    version: PMODEL_PREFERENCES_VERSION,
    ...(providerOrder.value !== undefined ? { providerOrder: [...providerOrder.value] } : {}),
    providers,
    sources: { providerOrder: providerOrder.source },
  };
}

function cleanPreferences(preferences: PModelPreferencesV1): PModelPreferencesV1 {
  if (preferences.providers) {
    for (const [provider, value] of Object.entries(preferences.providers)) {
      if (Object.keys(value).length === 0) delete preferences.providers[provider];
    }
    if (Object.keys(preferences.providers).length === 0) delete preferences.providers;
  }
  return preferences;
}

function applyOverride(preferences: PModelPreferencesV1, override: PreferenceOverride): void {
  if (override.field === "providerOrder") {
    if (override.value === undefined) delete preferences.providerOrder;
    else preferences.providerOrder = uniqueStrings([...override.value]) ?? [];
    return;
  }

  preferences.providers ??= {};
  preferences.providers[override.provider] ??= {};
  const provider = preferences.providers[override.provider]!;
  if (override.value === undefined) delete provider[override.field];
  else provider[override.field] = uniqueStrings([...override.value]) ?? [];
}

function patchPreferenceFile(path: string, override: PreferenceOverride): PModelPreferencesV1 {
  const preferences = readPreferenceFile(path);
  applyOverride(preferences, override);
  cleanPreferences(preferences);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return preferences;
}

export function writePreferenceOverride(
  paths: PreferencePaths,
  layer: PreferenceLayer,
  override: PreferenceOverride,
): PModelPreferencesV1 {
  return patchPreferenceFile(paths[override.field === "visibleModels" ? layer : "global"], override);
}

export function clearProjectOverride(
  paths: PreferencePaths,
  override: PreferenceOverrideTarget,
): PModelPreferencesV1 {
  const removal: PreferenceOverride = override.field === "providerOrder"
    ? { field: "providerOrder" }
    : { field: override.field, provider: override.provider };
  // Legacy ordering cleanup must never redirect to the global-only order writer.
  return patchPreferenceFile(paths.project, removal);
}

function persistPreferences(path: string, preferences: PModelPreferencesV1): void {
  cleanPreferences(preferences);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function markProjectThinkingMigration(paths: PreferencePaths, options: { projectTrusted: boolean }): void {
  if (!options.projectTrusted) throw new Error("Cannot mark migration before project trust is granted");
  const preferences = readPreferenceFile(paths.project);
  preferences.migrations = { ...preferences.migrations, projectThinkingDefaultsRemoved: true };
  persistPreferences(paths.project, preferences);
}

export function migrateProjectOrdering(
  paths: PreferencePaths,
  options: { projectTrusted: boolean },
): { migrated: PreferenceOverrideTarget[]; cleared: PreferenceOverrideTarget[] } {
  if (!options.projectTrusted) return { migrated: [], cleared: [] };
  const { global, project } = readPreferenceLayers(paths);
  const migrated: PreferenceOverrideTarget[] = [];
  const cleared: PreferenceOverrideTarget[] = [];
  if (project.providerOrder !== undefined) {
    if (global.providerOrder === undefined) {
      global.providerOrder = [...project.providerOrder];
      migrated.push({ field: "providerOrder" });
    }
    delete project.providerOrder;
    cleared.push({ field: "providerOrder" });
  }
  for (const [provider, preferences] of Object.entries(project.providers ?? {})) {
    if (preferences.modelOrder === undefined) continue;
    if (global.providers?.[provider]?.modelOrder === undefined) {
      global.providers ??= {};
      global.providers[provider] ??= {};
      global.providers[provider]!.modelOrder = [...preferences.modelOrder];
      migrated.push({ field: "modelOrder", provider });
    }
    delete preferences.modelOrder;
    cleared.push({ field: "modelOrder", provider });
  }
  // Save the destination first. On project-write failure, resolution still
  // ignores legacy local orders and a later attempt can finish the migration.
  if (migrated.length > 0) persistPreferences(paths.global, global);
  if (cleared.length > 0) persistPreferences(paths.project, project);
  return { migrated, cleared };
}

export function cleanupProjectVisibility(
  paths: PreferencePaths,
  catalogModels: readonly Model<any>[],
  options: { projectTrusted: boolean; catalogError?: string },
): { restoredProviders: string[]; skippedReason?: string } {
  if (!options.projectTrusted || options.catalogError || catalogModels.length === 0) {
    return { restoredProviders: [], skippedReason: !options.projectTrusted
      ? "Project is not trusted." : "Model catalog is not reliable." };
  }
  const project = readPreferenceFile(paths.project);
  const known = new Set(catalogModels.map((model) => `${model.provider}/${model.id}`));
  const restoredProviders: string[] = [];
  for (const [provider, preferences] of Object.entries(project.providers ?? {})) {
    // Empty lists intentionally hide everything; new catalog additions alone
    // do not invalidate a still-valid explicit list.
    if (!preferences.visibleModels?.some((id) => !known.has(`${provider}/${id}`))) continue;
    delete preferences.visibleModels;
    restoredProviders.push(provider);
  }
  if (restoredProviders.length > 0) persistPreferences(paths.project, project);
  return { restoredProviders };
}
