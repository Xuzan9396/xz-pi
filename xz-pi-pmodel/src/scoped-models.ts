import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import type { ModelReference } from "./catalog.js";
import {
  readPiSettingsFile,
  THINKING_LEVELS,
  type PiSettingsData,
  type PiSettingsPaths,
  type ThinkingLevel,
} from "./pi-settings.js";

export interface GlobalScopedModelsState {
  modelIds: readonly string[];
  unrestricted: boolean;
  projectOverride: boolean;
  sessionDiffers: boolean;
}

export interface ScopedModelsCleanupResult {
  removedPatterns: string[];
  skippedReason?: string;
}

interface PatternMatch {
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  invalidThinkingLevel?: boolean;
}

export function modelKey(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}

function exactMatch(pattern: string, models: readonly Model<any>[]): Model<any> | undefined {
  const reference = pattern.trim().toLowerCase();
  if (!reference) return undefined;
  const canonical = models.filter((model) => modelKey(model).toLowerCase() === reference);
  if (canonical.length > 0) return canonical.length === 1 ? canonical[0] : undefined;
  const slash = reference.indexOf("/");
  if (slash !== -1) {
    const provider = reference.slice(0, slash).trim();
    const id = reference.slice(slash + 1).trim();
    const qualified = models.filter((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
    if (qualified.length > 0) return qualified.length === 1 ? qualified[0] : undefined;
  }
  const bare = models.filter((model) => model.id.toLowerCase() === reference);
  return bare.length === 1 ? bare[0] : undefined;
}

// Match Pi 1.0's enabledModels semantics without importing private Pi modules.
// Picker search remains a separate, strictly contiguous-substring AND search.
export function resolveScopedPattern(pattern: string, models: readonly Model<any>[]): PatternMatch[] {
  const colon = pattern.lastIndexOf(":");
  const suffix = pattern.slice(colon + 1);
  const thinkingLevel = colon !== -1 && (THINKING_LEVELS as readonly string[]).includes(suffix)
    ? suffix as ThinkingLevel
    : undefined;

  if (/[*?\[]/.test(pattern)) {
    const glob = thinkingLevel ? pattern.slice(0, colon) : pattern;
    const exact = exactMatch(glob, models);
    const matches = exact ? [exact] : models.filter((model) => (
      minimatch(modelKey(model), glob, { nocase: true }) || minimatch(model.id, glob, { nocase: true })
    ));
    return matches.map((model) => ({ model, ...(thinkingLevel ? { thinkingLevel } : {}) }));
  }

  const exact = exactMatch(pattern, models);
  if (exact) return [{ model: exact }];
  const partial = models.filter((model) => (
    model.id.toLowerCase().includes(pattern.toLowerCase()) || model.name?.toLowerCase().includes(pattern.toLowerCase())
  ));
  const aliases = partial.filter((model) => !/-\d{8}$/.test(model.id));
  const best = (aliases.length > 0 ? aliases : partial).sort((a, b) => b.id.localeCompare(a.id))[0];
  if (best) return [{ model: best }];
  if (colon === -1) return [];
  const matches = resolveScopedPattern(pattern.slice(0, colon), models);
  // Invalid suffixes fall back to Pi's default thinking level.
  return matches.map((match) => ({
    model: match.model,
    ...(thinkingLevel && !match.invalidThinkingLevel
      ? { thinkingLevel }
      : { invalidThinkingLevel: true }),
  }));
}

function resolvePatterns(patterns: readonly string[], models: readonly Model<any>[]): PatternMatch[] {
  const resolved = new Map<string, PatternMatch>();
  for (const pattern of patterns) {
    for (const match of resolveScopedPattern(pattern, models)) {
      const key = modelKey(match.model);
      if (!resolved.has(key)) resolved.set(key, match);
    }
  }
  return [...resolved.values()];
}

export function resolveGlobalScopedModelsState(
  globalSettings: PiSettingsData,
  projectSettings: PiSettingsData,
  allModels: readonly Model<any>[],
  sessionScopedModels: readonly Model<any>[],
  projectTrusted = true,
): GlobalScopedModelsState {
  const matches = resolvePatterns(globalSettings.enabledModels ?? [], allModels);
  // Pi treats missing/empty scopes, including entirely unresolved patterns, as unrestricted.
  const unrestricted = matches.length === 0;
  const modelIds = (unrestricted ? allModels : matches.map((match) => match.model)).map(modelKey);
  const sessionIds = new Set((sessionScopedModels.length === 0 ? allModels : sessionScopedModels).map(modelKey));
  return {
    modelIds,
    unrestricted,
    projectOverride: projectTrusted && projectSettings.enabledModels !== undefined,
    sessionDiffers: modelIds.length !== sessionIds.size || modelIds.some((id) => !sessionIds.has(id)),
  };
}

export function readGlobalScopedModelsState(
  paths: PiSettingsPaths,
  allModels: readonly Model<any>[],
  sessionScopedModels: readonly Model<any>[],
  projectTrusted = true,
): GlobalScopedModelsState {
  return resolveGlobalScopedModelsState(
    readPiSettingsFile(paths.global),
    projectTrusted ? readPiSettingsFile(paths.project) : {},
    allModels,
    sessionScopedModels,
    projectTrusted,
  );
}

async function persistGlobalEnabledModels(
  paths: PiSettingsPaths,
  patterns: string[] | undefined,
): Promise<void> {
  // This operation is global-only; project settings must not influence or block it.
  const manager = SettingsManager.create(dirname(dirname(paths.project)), dirname(paths.global), { projectTrusted: false });
  const loadErrors = manager.drainErrors();
  if (loadErrors.length > 0) throw loadErrors[0]!.error;
  manager.setEnabledModels(patterns);
  await manager.flush();
  const writeErrors = manager.drainErrors();
  if (writeErrors.length > 0) throw writeErrors[0]!.error;
}

export async function cleanupGlobalScopedModels(
  paths: PiSettingsPaths,
  catalogModels: readonly Model<any>[],
  options: { catalogError?: string } = {},
): Promise<ScopedModelsCleanupResult> {
  // Never interpret authentication availability, an empty snapshot, or a failed
  // models.json load as evidence of deletion. Callers pass registry.getAll().
  if (options.catalogError || catalogModels.length === 0) {
    return {
      removedPatterns: [],
      skippedReason: options.catalogError ? "Model catalog has errors; references were retained." : "Model catalog is empty; references were retained.",
    };
  }
  const settings = readPiSettingsFile(paths.global);
  const removedPatterns: string[] = [];
  const remaining = (settings.enabledModels ?? []).filter((pattern) => {
    const reference = pattern.trim();
    const slash = reference.indexOf("/");
    // Only prune unresolved qualified references. Preserve bare aliases and
    // future-looking glob/brace/extglob patterns, even when they match nothing.
    const isPattern = /[*?\[\]{}]/.test(reference) || /[+@!]\(/.test(reference);
    const qualified = slash > 0 && reference.slice(slash + 1).trim().length > 0;
    if (!qualified || isPattern || resolveScopedPattern(pattern, catalogModels).length > 0) return true;
    removedPatterns.push(pattern);
    return false;
  });
  if (removedPatterns.length > 0) {
    // If every explicit reference was deleted, Pi already resolves that scope
    // as unrestricted. Clear the field instead of persisting an empty list.
    await persistGlobalEnabledModels(paths, remaining.length > 0 ? remaining : undefined);
  }
  return { removedPatterns };
}

export async function toggleGlobalScopedModel(
  paths: PiSettingsPaths,
  allModels: readonly Model<any>[],
  sessionScopedModels: readonly Model<any>[],
  model: ModelReference,
  projectTrusted = true,
): Promise<GlobalScopedModelsState> {
  const key = modelKey(model);
  if (!allModels.some((candidate) => modelKey(candidate) === key)) {
    throw new Error(`Cannot scope unavailable model: ${key}`);
  }
  // Validate before creating the official manager: never replace malformed settings.
  const settings = readPiSettingsFile(paths.global);
  const patterns = settings.enabledModels ?? [];
  const matches = resolvePatterns(patterns, allModels);
  const unrestricted = matches.length === 0;
  const included = unrestricted || matches.some((match) => modelKey(match.model) === key);
  let next: string[];
  if (!included) {
    next = [...patterns, key];
  } else if (unrestricted) {
    // Preserve unresolved IDs; make the unrestricted selection explicit to remove one model.
    next = [...patterns, ...allModels.filter((candidate) => modelKey(candidate) !== key).map(modelKey)];
  } else {
    // Only expand patterns containing this model; retain other globs and unavailable IDs.
    next = patterns.flatMap((pattern) => {
      const resolved = resolveScopedPattern(pattern, allModels);
      if (!resolved.some((match) => modelKey(match.model) === key)) return [pattern];
      return resolved.filter((match) => modelKey(match.model) !== key).map((match) => (
        modelKey(match.model) + (match.thinkingLevel ? `:${match.thinkingLevel}` : "")
      ));
    });
  }
  if (resolvePatterns(next, allModels).length === 0) {
    throw new Error("Cannot uncheck the last available scoped model: Pi treats an empty scope as all models.");
  }
  await persistGlobalEnabledModels(paths, next);
  return readGlobalScopedModelsState(paths, allModels, sessionScopedModels, projectTrusted);
}
