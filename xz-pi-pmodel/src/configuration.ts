import type { Model } from "@earendil-works/pi-ai";
import {
  cleanupProjectVisibility,
  migrateProjectOrdering,
  type PreferencePaths,
} from "./preferences.js";
import { cleanupProjectDefaults, migrateLegacyProjectThinking, type PiSettingsPaths } from "./pi-settings.js";

export function reconcileProjectConfiguration(
  preferences: PreferencePaths,
  settings: PiSettingsPaths,
  catalogModels: readonly Model<any>[],
  options: { projectTrusted: boolean; catalogError?: string },
) {
  const ordering = migrateProjectOrdering(preferences, options);
  const visibility = cleanupProjectVisibility(preferences, catalogModels, options);
  // Do defaults last so a preceding preference-write failure cannot hide a
  // successful settings change from the caller's reload bookkeeping.
  const defaults = cleanupProjectDefaults(settings, catalogModels, options);
  try {
    const thinkingMigration = options.catalogError || catalogModels.length === 0
      ? { changed: false, skippedReason: "Model catalog is not reliable." }
      : migrateLegacyProjectThinking(preferences, settings, options);
    return { ordering, visibility, defaults, thinkingMigration };
  } catch (error) {
    if (error instanceof Error && defaults.modelDefaultCleared) Object.assign(error, { settingsChanged: true });
    throw error;
  }
}
