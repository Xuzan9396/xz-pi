#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Enquirer from "enquirer";
import semver from "semver";

export const BUMP_LABELS = {
  patch: "补丁版本（兼容性修复）",
  minor: "次版本（向后兼容的新功能）",
  major: "主版本（不兼容变更）",
};

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const CHANGESET_DIR = join(ROOT_DIR, ".changeset");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function bumpVersion(version, bump) {
  const next = semver.inc(version, bump);
  if (!next) throw new Error(`无法识别版本号：${version}`);
  return next;
}

export function highestBump(left, right) {
  if (!left) return right;
  if (!right) return left;
  return BUMP_RANK[left] >= BUMP_RANK[right] ? left : right;
}

export function parseChangeset(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n)?([\s\S]*)$/);
  if (!match) return { releases: [], summary: content.trim() };

  const releases = [];
  for (const line of match[1].split("\n")) {
    const release = line.match(/^\s*["']([^"']+)["']\s*:\s*(patch|minor|major)\s*$/);
    if (release) releases.push({ name: release[1], bump: release[2] });
  }
  return { releases, summary: match[2].trim() };
}

export function renderChangeset(releases, summary) {
  const frontmatter = releases.map(({ name, bump }) => `${JSON.stringify(name)}: ${bump}`).join("\n");
  return `---\n${frontmatter}\n---\n\n${summary.trim()}\n`;
}

export function removePackagesFromChangeset(content, packageNames) {
  const parsed = parseChangeset(content);
  const releases = parsed.releases.filter(({ name }) => !packageNames.has(name));
  if (releases.length === parsed.releases.length) return { changed: false, content };
  if (releases.length === 0) return { changed: true, content: null };
  return { changed: true, content: renderChangeset(releases, parsed.summary) };
}

function getWorkspacePackages() {
  const rootPackage = readJson(join(ROOT_DIR, "package.json"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspaces)) throw new Error("根 package.json 没有可识别的 workspaces 配置");

  return workspaces.map((workspace) => {
    if (/[*?{}[\]]/.test(workspace)) {
      throw new Error(`tag.sh 当前要求 workspace 使用明确目录，暂不支持 glob：${workspace}`);
    }
    const directory = resolve(ROOT_DIR, workspace);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) throw new Error(`找不到 workspace package.json：${manifestPath}`);
    const manifest = readJson(manifestPath);
    return {
      name: manifest.name,
      version: manifest.version,
      directory,
      relativeDirectory: relative(ROOT_DIR, directory),
      private: manifest.private === true,
    };
  }).filter((pkg) => !pkg.private);
}

function getRegistryInfo(name) {
  const result = run("npm", ["view", `${name}@latest`, "version", "gitHead", "--json"], { capture: true });
  if (result.status !== 0) {
    if (`${result.stderr}\n${result.stdout}`.includes("E404")) {
      return { published: false, version: null, gitHead: null };
    }
    throw new Error(`读取 ${name} 的 npm 信息失败：\n${result.stderr || result.stdout}`);
  }

  const output = result.stdout.trim();
  const value = output ? JSON.parse(output) : {};
  return {
    published: true,
    version: typeof value === "string" ? value : value.version ?? null,
    gitHead: typeof value === "object" && value ? value.gitHead ?? null : null,
  };
}

function gitObjectExists(ref) {
  return run("git", ["cat-file", "-e", `${ref}^{commit}`], { capture: true }).status === 0;
}

function packageHasChanges(pkg, registry) {
  if (!registry.published) return { changed: true, reason: "npm 尚未发布" };

  const worktree = run("git", ["status", "--porcelain", "--", pkg.relativeDirectory], { capture: true });
  if (worktree.status !== 0) throw new Error(`无法检查 ${pkg.name} 的工作区状态`);
  if (worktree.stdout.trim()) return { changed: true, reason: "存在未提交修改" };

  if (registry.gitHead && gitObjectExists(registry.gitHead)) {
    const diff = run("git", ["diff", "--quiet", registry.gitHead, "--", pkg.relativeDirectory], { capture: true });
    if (diff.status === 0) return { changed: false, reason: `与 npm ${registry.version} 内容一致` };
    if (diff.status === 1) return { changed: true, reason: `相对 npm ${registry.version} 已改变` };
    throw new Error(`无法比较 ${pkg.name} 与 npm 发布提交 ${registry.gitHead}`);
  }

  const diff = run("npm", ["diff", `--diff=${pkg.name}@${registry.version}`, `--workspace=${pkg.name}`], { capture: true });
  if (diff.status !== 0) throw new Error(`无法比较 ${pkg.name} 与 npm ${registry.version}：\n${diff.stderr}`);
  return {
    changed: Boolean(diff.stdout.trim()),
    reason: diff.stdout.trim() ? `相对 npm ${registry.version} 已改变` : `与 npm ${registry.version} 内容一致`,
  };
}

function readPendingChangesets() {
  const files = readdirSync(CHANGESET_DIR)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();
  const parsedFiles = files.map((file) => {
    const path = join(CHANGESET_DIR, file);
    const content = readFileSync(path, "utf8");
    return { file, path, content, ...parseChangeset(content) };
  });
  const byPackage = new Map();
  for (const changeset of parsedFiles) {
    for (const release of changeset.releases) {
      byPackage.set(release.name, highestBump(byPackage.get(release.name), release.bump));
    }
  }
  return { files: parsedFiles, byPackage };
}

function printPackageTable(packages) {
  console.log("\n包状态：");
  for (const pkg of packages) {
    const npmVersion = pkg.registry.published ? pkg.registry.version : "未发布";
    const pending = pkg.pendingBump
      ? `；已有${BUMP_LABELS[pkg.pendingBump]}，预计 ${pkg.version} → ${bumpVersion(pkg.version, pkg.pendingBump)}`
      : "";
    const icon = pkg.changed ? "●" : "○";
    console.log(`  ${icon} ${pkg.name}：本地 ${pkg.version}；npm ${npmVersion}；${pkg.reason}${pending}`);
  }
}

function createChangesetName() {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `xz-release-${timestamp}.md`;
}

function replaceSelectedPendingChangesets(changesets, selectedNames) {
  for (const changeset of changesets.files) {
    const result = removePackagesFromChangeset(changeset.content, selectedNames);
    if (!result.changed) continue;
    if (result.content === null) unlinkSync(changeset.path);
    else writeFileSync(changeset.path, result.content, "utf8");
  }
}

async function selectReleases(candidates) {
  const { packages: selectedNames } = await Enquirer.prompt({
    type: "multiselect",
    name: "packages",
    message: "选择需要发布的包（↑/↓ 移动，Space 多选，Enter 确认）",
    choices: candidates.map((pkg) => ({
      name: pkg.name,
      message: `${pkg.name}（本地 ${pkg.version}，npm ${pkg.registry.version ?? "未发布"}${pkg.pendingBump ? `，已登记${BUMP_LABELS[pkg.pendingBump]}` : ""}）`,
    })),
    initial: candidates.filter((pkg) => pkg.pendingBump).map((pkg) => pkg.name),
    required: true,
  });

  const releases = [];
  for (const name of selectedNames) {
    const pkg = candidates.find((item) => item.name === name);
    const choices = ["patch", "minor", "major"].map((bump) => ({
      name: bump,
      message: `${BUMP_LABELS[bump]}：${pkg.version} → ${bumpVersion(pkg.version, bump)}`,
    }));
    const initial = pkg.pendingBump ? ["patch", "minor", "major"].indexOf(pkg.pendingBump) : 0;
    const { bump } = await Enquirer.prompt({
      type: "select",
      name: "bump",
      message: `${pkg.name} 选择升级类型`,
      choices,
      initial,
    });
    releases.push({ pkg, name, bump, nextVersion: bumpVersion(pkg.version, bump) });
  }
  return releases;
}

function printReleasePlan(releases, untouchedPending, packagesByName) {
  console.log("\n=== 发布计划 ===");
  for (const release of releases) {
    const npmVersion = release.pkg.registry.version ?? "未发布";
    console.log(`  ${release.name}：npm ${npmVersion}；${release.pkg.version} → ${release.nextVersion}（${BUMP_LABELS[release.bump]}）`);
  }
  for (const [name, bump] of untouchedPending) {
    const pkg = packagesByName.get(name);
    if (!pkg) continue;
    console.log(`  ${name}：保留已有 Changeset；${pkg.version} → ${bumpVersion(pkg.version, bump)}（${BUMP_LABELS[bump]}）`);
  }
}

async function maybeTestCommitAndPush(changesetPath) {
  const { runTests } = await Enquirer.prompt({
    type: "confirm",
    name: "runTests",
    message: "是否运行全仓检查 npm run check？",
    initial: true,
  });
  if (runTests) {
    const check = run("npm", ["run", "check"]);
    if (check.status !== 0) throw new Error("检查失败，已保留 Changeset，但不会提交或推送");
  }

  const { shouldPush } = await Enquirer.prompt({
    type: "confirm",
    name: "shouldPush",
    message: "是否执行 git add -A、提交并推送当前全部修改？",
    initial: false,
  });
  if (!shouldPush) {
    console.log(`\n已生成 ${relative(ROOT_DIR, changesetPath)}，请检查后自行提交。`);
    return;
  }

  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (!status.stdout.trim()) {
    console.log("没有需要提交的修改。");
    return;
  }
  const { commitMessage } = await Enquirer.prompt({
    type: "input",
    name: "commitMessage",
    message: "Git 提交说明",
    initial: "chore: add release changeset",
    validate: (value) => value.trim() ? true : "提交说明不能为空",
  });
  if (run("git", ["add", "-A"]).status !== 0) throw new Error("git add 失败");
  if (run("git", ["commit", "-m", commitMessage.trim()]).status !== 0) throw new Error("git commit 失败");
  if (run("git", ["push"]).status !== 0) throw new Error("git push 失败");
  console.log("\n已推送。GitHub Release Workflow 将创建或更新发布 PR；合并发布 PR 后 npm 自动发布。 ");
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`用法：./tag.sh\n\n中文多包 Changeset 发布助手。它不会直接创建 Git Tag 或绕过发布 PR。`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tag.sh 需要在交互式终端中运行");
  }

  console.log("=== xz-pi 中文发布助手 ===");
  console.log("正在读取 npm 版本并检查包目录变化…");

  const changesets = readPendingChangesets();
  const packages = getWorkspacePackages().map((pkg) => {
    const registry = getRegistryInfo(pkg.name);
    const change = packageHasChanges(pkg, registry);
    return { ...pkg, registry, ...change, pendingBump: changesets.byPackage.get(pkg.name) };
  });
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  printPackageTable(packages);

  const unchanged = packages.filter((pkg) => !pkg.changed);
  if (unchanged.length) {
    console.log(`\n自动跳过未变化的包：${unchanged.map((pkg) => pkg.name).join("、")}`);
  }
  const candidates = packages.filter((pkg) => pkg.changed);
  if (!candidates.length) {
    console.log("\n没有检测到需要发布的包。未生成 Changeset。");
    return;
  }

  const releases = await selectReleases(candidates);
  if (!releases.length) {
    console.log("\n未选择任何包，未修改 Changeset。");
    return;
  }
  const selectedNames = new Set(releases.map((release) => release.name));
  const untouchedPending = [...changesets.byPackage].filter(([name]) => !selectedNames.has(name));
  printReleasePlan(releases, untouchedPending, packagesByName);

  const { summary } = await Enquirer.prompt({
    type: "input",
    name: "summary",
    message: "填写本次面向用户的中文更新说明",
    validate: (value) => value.trim() ? true : "更新说明不能为空",
  });
  const { confirmed } = await Enquirer.prompt({
    type: "confirm",
    name: "confirmed",
    message: "确认生成以上 Changeset？",
    initial: true,
  });
  if (!confirmed) {
    console.log("已取消，未修改 Changeset。 ");
    return;
  }

  // A selected package replaces its previous pending entries, so choosing a
  // lower bump really takes effect instead of being overridden by an old major.
  replaceSelectedPendingChangesets(changesets, selectedNames);
  const changesetPath = join(CHANGESET_DIR, createChangesetName());
  writeFileSync(
    changesetPath,
    renderChangeset(releases.map(({ name, bump }) => ({ name, bump })), summary),
    "utf8",
  );
  console.log(`\n已生成：${relative(ROOT_DIR, changesetPath)}`);
  await maybeTestCommitAndPush(changesetPath);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    if (error?.name === "") process.exitCode = 130;
    else {
      console.error(`\n错误：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
}
