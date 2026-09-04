import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const skillsRoot = join(packageRoot, "skills");
const expectedSkills = [
  "ios-app-intents",
  "ios-debugger-agent",
  "ios-ettrace-performance",
  "ios-memgraph-leaks",
  "ios-simulator-browser",
  "swiftui-liquid-glass",
  "swiftui-performance-audit",
  "swiftui-ui-patterns",
  "swiftui-view-refactor",
];
const portableSkills = expectedSkills.filter(
  (name) => !["ios-debugger-agent", "ios-simulator-browser"].includes(name),
);

function read(relativePath) {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

function skillNames() {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function assertFrontmatter(name) {
  const content = read(`skills/${name}/SKILL.md`);
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${name} must have YAML frontmatter`);
  assert.match(match[1], new RegExp(`^name: ${name}$`, "m"));
  assert.match(match[1], /^description: .+$/m);

  for (const reference of content.matchAll(/`((?:references|scripts)\/[A-Za-z0-9._/-]+)`/g)) {
    assert.ok(
      existsSync(join(skillsRoot, name, reference[1])),
      `${name} references missing file ${reference[1]}`,
    );
  }
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
}

test("portable skills and package foundation are complete", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.name, "xz-pi-build-ios-apps");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.equal(manifest.pi.image, "./assets/app-icon.png");

  for (const name of portableSkills) {
    assert.ok(skillNames().includes(name), `missing portable skill ${name}`);
    assertFrontmatter(name);
  }
  for (const path of ["README.md", "UPSTREAM.md", "LICENSE", "assets/app-icon.png", "assets/build-ios-apps-small.svg"]) {
    assert.ok(existsSync(join(packageRoot, path)), `missing package resource ${path}`);
  }
});

test("vendored scripts pass syntax checks", () => {
  run("bash", ["-n", "xz-pi-build-ios-apps/skills/ios-ettrace-performance/scripts/collect_ios_dsyms.sh"]);
  run("bash", ["-n", "xz-pi-build-ios-apps/skills/ios-memgraph-leaks/scripts/capture_sim_memgraph.sh"]);
  for (const script of [
    "xz-pi-build-ios-apps/skills/ios-ettrace-performance/scripts/analyze_flamegraph_json.py",
    "xz-pi-build-ios-apps/skills/ios-memgraph-leaks/scripts/summarize_memgraph_leaks.py",
  ]) {
    run("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", script]);
  }
});

test("debugger skill uses the pinned CLI and preserves failure gates", () => {
  const content = read("skills/ios-debugger-agent/SKILL.md");
  const forbiddenMcpPrefix = ["mcp", "__XcodeBuildMCP__"].join("");
  const floatingVersion = ["@", "latest"].join("");
  assert.doesNotMatch(content, new RegExp(forbiddenMcpPrefix));
  assert.doesNotMatch(content, new RegExp(floatingVersion));
  assert.match(content, /xcodebuildmcp@2\.7\.0/);
  assert.match(content, /simulator build-and-run/);
  assert.match(content, /(?:simulator|ui-automation) snapshot-ui/);
  assert.match(content, /stop.*UI|do not.*UI/is);
});

test("simulator browser uses pinned serve-sim and scoped cleanup", () => {
  const content = read("skills/ios-simulator-browser/SKILL.md");
  const codexBrowserPhrase = ["Codex", " in-app browser"].join("");
  const floatingVersion = ["@", "latest"].join("");
  assert.doesNotMatch(content, new RegExp(codexBrowserPhrase, "i"));
  assert.doesNotMatch(content, new RegExp(floatingVersion));
  assert.match(content, /serve-sim@0\.1\.46/);
  assert.doesNotMatch(content, /serve-sim@0\.1\.46 --kill(?:\s*["'`]?)?(?:\n|$)/);
  assert.match(content, /--kill ["']?\$SIM/);
  assert.match(content, /\bopen\b/);
  for (const path of [
    "skills/ios-simulator-browser/scripts/lib/xcode-project.mjs",
    "skills/ios-simulator-browser/scripts/swiftui-preview-browser.mjs",
    "skills/ios-simulator-browser/scripts/templates/FocusedPreviewApp.swift",
    "skills/ios-simulator-browser/scripts/templates/FocusedPreviewHotReloadRuntime.swift",
    "skills/ios-simulator-browser/scripts/templates/PreviewBrowserEntries.swift",
  ]) {
    assert.ok(existsSync(join(packageRoot, path)), `missing simulator resource ${path}`);
  }
  run("node", ["--check", "xz-pi-build-ios-apps/skills/ios-simulator-browser/scripts/lib/xcode-project.mjs"]);
  run("node", ["--check", "xz-pi-build-ios-apps/skills/ios-simulator-browser/scripts/swiftui-preview-browser.mjs"]);
});

test("all nine skills and published resources are present", () => {
  assert.deepEqual(skillNames(), expectedSkills);
  for (const name of expectedSkills) assertFrontmatter(name);

  const allText = expectedSkills.map((name) => read(`skills/${name}/SKILL.md`)).join("\n");
  const forbiddenMcpPrefix = ["mcp", "__XcodeBuildMCP__"].join("");
  const floatingVersion = ["@", "latest"].join("");
  const terminalApi = ["write", "_stdin"].join("");
  assert.doesNotMatch(allText, new RegExp(forbiddenMcpPrefix));
  assert.doesNotMatch(allText, new RegExp(floatingVersion));
  assert.doesNotMatch(allText, new RegExp(terminalApi));
});

test("monorepo integration includes build-ios-apps everywhere", () => {
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const releaseGuide = readFileSync(join(repoRoot, ".github/workflows/RELEASE.md"), "utf8");

  assert.ok(rootManifest.workspaces.includes("xz-pi-build-ios-apps"));
  assert.ok(lock.packages["xz-pi-build-ios-apps"]);
  assert.ok(lock.packages["node_modules/xz-pi-build-ios-apps"]?.link);
  assert.match(rootReadme, /pi install npm:xz-pi-build-ios-apps/);
  assert.match(rootReadme, /pi -e \.\/xz-pi-build-ios-apps/);
  assert.match(releaseGuide, /xz-pi-build-ios-apps/);
});
