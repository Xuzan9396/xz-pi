import { getAgentDir, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

export function enabledPackageSources(
  globalPackages: readonly PackageSource[],
  projectPackages: readonly PackageSource[],
): string[] {
  // Match /packages: a scope is off when absent or all resource types are
  // explicitly disabled. autoload:false entries are resource overrides.
  return [...new Set([...globalPackages, ...projectPackages]
    .filter((entry) => typeof entry === "string" || entry.autoload === false ||
      !RESOURCE_TYPES.every((key) => Array.isArray(entry[key]) && entry[key]!.length === 0))
    .map((entry) => typeof entry === "string" ? entry : entry.source))];
}

export function readEnabledPackageSources(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): string[] {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  // Do not use getPackages(): project overrides would hide a globally enabled
  // package. Dollar references intentionally use Global OR Project instead.
  return enabledPackageSources(
    settings.getGlobalSettings().packages ?? [],
    projectTrusted ? settings.getProjectSettings().packages ?? [] : [],
  );
}
