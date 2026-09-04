import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const INITIAL_VERSIONS_FILE = ".changeset/xz-initial-versions.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateInitialVersion(value) {
  const version = value.trim();
  if (semver.valid(version) !== version) return "请输入标准 SemVer，例如 0.1.0";
  if (semver.prerelease(version)) return "初始化版本暂不支持预发布版本，请输入例如 0.1.0";
  return true;
}

export function readInitialVersions(rootDir) {
  const path = join(rootDir, INITIAL_VERSIONS_FILE);
  if (!existsSync(path)) return {};
  const value = readJson(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${INITIAL_VERSIONS_FILE} 格式无效`);
  }
  return value;
}

export function writeInitialVersions(rootDir, versions) {
  const path = join(rootDir, INITIAL_VERSIONS_FILE);
  if (Object.keys(versions).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, `${JSON.stringify(versions, null, 2)}\n`, "utf8");
}

function getWorkspaceManifests(rootDir) {
  const rootPackage = readJson(join(rootDir, "package.json"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspaces)) throw new Error("根 package.json 没有可识别的 workspaces 配置");

  const manifests = new Map();
  for (const workspace of workspaces) {
    if (/[*?{}[\]]/.test(workspace)) continue;
    const directory = resolve(rootDir, workspace);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    manifests.set(manifest.name, { directory, manifestPath, manifest });
  }
  return manifests;
}

export function applyInitialVersions(rootDir) {
  const versions = readInitialVersions(rootDir);
  const manifests = getWorkspaceManifests(rootDir);

  for (const [name, settings] of Object.entries(versions)) {
    if (!settings || validateInitialVersion(String(settings.version ?? "")) !== true) {
      throw new Error(`${name} 的初始化版本无效`);
    }
    const workspace = manifests.get(name);
    if (!workspace) throw new Error(`找不到初始化包：${name}`);
    if (workspace.manifest.version !== settings.generatedVersion) {
      throw new Error(
        `${name} 经 Changesets 生成的版本应为 ${settings.generatedVersion}，实际为 ${workspace.manifest.version}`,
      );
    }

    workspace.manifest.version = settings.version;
    writeFileSync(workspace.manifestPath, `${JSON.stringify(workspace.manifest, null, 2)}\n`, "utf8");

    const changelogPath = join(workspace.directory, "CHANGELOG.md");
    if (!existsSync(changelogPath)) throw new Error(`找不到 ${name} 的 CHANGELOG.md`);
    const changelog = readFileSync(changelogPath, "utf8");
    const heading = `## ${settings.generatedVersion}`;
    if (!changelog.split("\n").includes(heading)) {
      throw new Error(`${name} 的 CHANGELOG.md 中找不到版本标题 ${heading}`);
    }
    writeFileSync(changelogPath, changelog.replace(heading, `## ${settings.version}`), "utf8");
  }

  const metadataPath = join(rootDir, INITIAL_VERSIONS_FILE);
  if (existsSync(metadataPath)) unlinkSync(metadataPath);
  return versions;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const applied = applyInitialVersions(resolve(process.cwd()));
    for (const [name, { version }] of Object.entries(applied)) {
      console.log(`已设置 ${name} 初始化版本：${version}`);
    }
  } catch (error) {
    console.error(`\n错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
