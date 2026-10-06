import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { markProjectThinkingMigration, readPreferenceFile, type PreferenceLayer, type PreferenceSource, type PreferencePaths } from "./preferences.js";
import type { Model } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PiSettingsData {
  enabledModels?: string[];
  defaultProvider?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

export interface PiSettingsPaths {
  global: string;
  project: string;
}

export interface ResolvedModelDefault {
  provider: string;
  id: string;
  source: Exclude<PreferenceSource, "default">;
}

export interface ModelDefaultState {
  global?: { provider: string; id: string };
  project?: { provider: string; id: string };
  effective?: ResolvedModelDefault;
}

export interface ModelDefaultSaveResult {
  defaults: ModelDefaultState;
  changed: boolean;
}

export function resolveModelDefaultState(global: PiSettingsData, project: PiSettingsData): ModelDefaultState {
  const savedGlobal = resolveModelDefault(global, {});
  const effective = resolveModelDefault(global, project);
  return {
    ...(savedGlobal ? { global: { provider: savedGlobal.provider, id: savedGlobal.id } } : {}),
    ...(effective?.source === "project" ? { project: { provider: effective.provider, id: effective.id } } : {}),
    ...(effective ? { effective } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSettings(value: unknown, path: string): PiSettingsData {
  if (!isRecord(value)) throw new Error(`Invalid Pi settings at ${path}: expected an object`);
  const result = { ...value } as PiSettingsData;
  if (result.enabledModels !== undefined && (
    !Array.isArray(result.enabledModels) || result.enabledModels.some((pattern) => typeof pattern !== "string")
  )) {
    throw new Error(`Invalid Pi settings at ${path}: enabledModels must be an array of strings`);
  }
  if (result.defaultProvider !== undefined && typeof result.defaultProvider !== "string") {
    throw new Error(`Invalid Pi settings at ${path}: defaultProvider must be a string`);
  }
  if (result.defaultModel !== undefined && typeof result.defaultModel !== "string") {
    throw new Error(`Invalid Pi settings at ${path}: defaultModel must be a string`);
  }
  // Thinking fields belong to Pi. Never normalize or discard them during a model write.
  return result;
}

export function getPiSettingsPaths(cwd: string, agentDir = getAgentDir()): PiSettingsPaths {
  return {
    global: join(agentDir, "settings.json"),
    project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
  };
}

function readSettingsObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Pi settings at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid Pi settings at ${path}: expected an object`);
  return parsed;
}

export function readPiSettingsFile(path: string): PiSettingsData {
  return normalizeSettings(readSettingsObject(path), path);
}

export function readPiSettingsLayers(paths: PiSettingsPaths, options: { projectTrusted?: boolean } = {}): {
  global: PiSettingsData;
  project: PiSettingsData;
} {
  return {
    global: readPiSettingsFile(paths.global),
    project: options.projectTrusted === false ? {} : readPiSettingsFile(paths.project),
  };
}

export function resolveModelDefault(
  globalSettings: PiSettingsData,
  projectSettings: PiSettingsData,
): ResolvedModelDefault | undefined {
  const provider = projectSettings.defaultProvider ?? globalSettings.defaultProvider;
  const id = projectSettings.defaultModel ?? globalSettings.defaultModel;
  if (!provider || !id) return undefined;
  const source = projectSettings.defaultProvider !== undefined || projectSettings.defaultModel !== undefined
    ? "project"
    : "global";
  return { provider, id, source };
}

export function patchPiSettings(
  paths: PiSettingsPaths,
  layer: PreferenceLayer,
  update: (settings: PiSettingsData) => void,
  options: { projectTrusted?: boolean } = {},
): PiSettingsData {
  if (layer === "project" && options.projectTrusted !== true) {
    throw new Error("Cannot write project Pi settings before project trust is granted");
  }
  const path = paths[layer];
  const settings = readPiSettingsFile(path);
  update(settings);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return settings;
}

export function setModelDefault(
  paths: PiSettingsPaths,
  layer: PreferenceLayer,
  provider: string,
  id: string,
  options: { projectTrusted?: boolean } = {},
): PiSettingsData {
  return patchPiSettings(paths, layer, (settings) => {
    settings.defaultProvider = provider;
    settings.defaultModel = id;
  }, options);
}

export function clearProjectModelDefault(
  paths: PiSettingsPaths,
  options: { projectTrusted?: boolean } = {},
): PiSettingsData {
  return patchPiSettings(paths, "project", (settings) => {
    delete settings.defaultProvider;
    delete settings.defaultModel;
  }, options);
}

export async function toggleModelDefault(
  paths: PiSettingsPaths,
  layer: PreferenceLayer,
  model: { provider: string; id: string },
  options: { projectTrusted?: boolean } = {},
): Promise<ModelDefaultSaveResult> {
  if (layer === "project" && options.projectTrusted !== true) {
    throw new Error("Cannot write project Pi settings before project trust is granted");
  }
  if (!model.provider.trim() || !model.id.trim()) throw new Error("A default requires a provider and model ID");
  const read = () => {
    const layers = readPiSettingsLayers(paths, { projectTrusted: options.projectTrusted === true });
    return resolveModelDefaultState(layers.global, layers.project);
  };
  const before = read();
  const selected = before[layer];
  const checked = selected?.provider === model.provider && selected.id === model.id;
  if (layer === "global" && checked) return { defaults: before, changed: false };
  if (layer === "global") {
    const manager = SettingsManager.create(dirname(dirname(paths.project)), dirname(paths.global), { projectTrusted: false });
    const loadErrors = manager.drainErrors();
    if (loadErrors.length) throw loadErrors[0]!.error;
    manager.setDefaultModelAndProvider(model.provider, model.id);
    await manager.flush();
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0]!.error;
  } else {
    const raw = readSettingsObject(paths.project);
    if (checked) {
      delete raw.defaultProvider;
      delete raw.defaultModel;
    } else {
      raw.defaultProvider = model.provider;
      raw.defaultModel = model.id;
    }
    mkdirSync(dirname(paths.project), { recursive: true, mode: 0o700 });
    writeFileSync(paths.project, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return { defaults: read(), changed: true };
}

export interface ProjectDefaultsCleanupResult {
  modelDefaultCleared: boolean;
  skippedReason?: string;
}

export function cleanupProjectDefaults(
  paths: PiSettingsPaths,
  catalogModels: readonly Model<any>[],
  options: { projectTrusted: boolean; catalogError?: string },
): ProjectDefaultsCleanupResult {
  const result: ProjectDefaultsCleanupResult = {
    modelDefaultCleared: false,
  };
  if (!options.projectTrusted || options.catalogError || catalogModels.length === 0) {
    result.skippedReason = !options.projectTrusted ? "Project is not trusted." : "Model catalog is not reliable.";
    return result;
  }
  const global = readPiSettingsFile(paths.global);
  const raw = readSettingsObject(paths.project);
  const project = normalizeSettings(raw, paths.project);
  const known = new Map(catalogModels.map((model) => [`${model.provider}/${model.id}`, model]));
  const effective = resolveModelDefault(global, project);
  if ((project.defaultProvider !== undefined || project.defaultModel !== undefined) &&
      (!effective || !known.has(`${effective.provider}/${effective.id}`))) {
    delete raw.defaultProvider;
    delete raw.defaultModel;
    delete project.defaultProvider;
    delete project.defaultModel;
    result.modelDefaultCleared = true;
  }
  if (result.modelDefaultCleared) {
    mkdirSync(dirname(paths.project), { recursive: true, mode: 0o700 });
    writeFileSync(paths.project, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return result;
}

export function migrateLegacyProjectThinking(
  preferences: PreferencePaths,
  paths: PiSettingsPaths,
  options: { projectTrusted: boolean },
): { changed: boolean; skippedReason?: string } {
  if (!options.projectTrusted) return { changed: false, skippedReason: "Project is not trusted." };
  const preference = readPreferenceFile(preferences.project);
  if (preference.migrations?.projectThinkingDefaultsRemoved === true) return { changed: false };
  const raw = readSettingsObject(paths.project);
  normalizeSettings(raw, paths.project);
  const changed = Object.hasOwn(raw, "defaultThinkingLevel") || Object.hasOwn(raw, "modelThinkingLevels");
  if (changed) {
    delete raw.defaultThinkingLevel;
    delete raw.modelThinkingLevels;
    // The user explicitly chose no backup. Only these two legacy project keys are removed.
    mkdirSync(dirname(paths.project), { recursive: true, mode: 0o700 });
    writeFileSync(paths.project, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  try {
    markProjectThinkingMigration(preferences, options);
  } catch (cause) {
    throw Object.assign(new Error("Project thinking migration marker could not be saved", { cause }), { settingsChanged: changed });
  }
  return { changed };
}

