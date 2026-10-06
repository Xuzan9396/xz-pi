import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const skillsRoot = join(packageRoot, "skills");
const upstreamSkills = [
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
const packageSkills = ["build-ios-apps", ...upstreamSkills].sort();
const upstreamPayload = {
  "ios-app-intents": [
    "SKILL.md",
    "references/code-templates.md",
    "references/example-patterns.md",
    "references/first-pass-checklist.md",
    "references/system-surfaces.md",
  ],
  "ios-debugger-agent": ["SKILL.md"],
  "ios-ettrace-performance": [
    "SKILL.md",
    "scripts/analyze_flamegraph_json.py",
    "scripts/collect_ios_dsyms.sh",
  ],
  "ios-memgraph-leaks": [
    "SKILL.md",
    "scripts/capture_sim_memgraph.sh",
    "scripts/summarize_memgraph_leaks.py",
  ],
  "ios-simulator-browser": [
    "SKILL.md",
    "scripts/lib/xcode-project.mjs",
    "scripts/swiftui-preview-browser.mjs",
    "scripts/templates/FocusedPreviewApp.swift",
    "scripts/templates/FocusedPreviewHotReloadRuntime.swift",
    "scripts/templates/PreviewBrowserEntries.swift",
  ],
  "swiftui-liquid-glass": ["SKILL.md", "references/liquid-glass.md"],
  "swiftui-performance-audit": [
    "SKILL.md",
    "references/code-smells.md",
    "references/demystify-swiftui-performance-wwdc23.md",
    "references/optimizing-swiftui-performance-instruments.md",
    "references/profiling-intake.md",
    "references/report-template.md",
    "references/understanding-hangs-in-your-app.md",
    "references/understanding-improving-swiftui-performance.md",
  ],
  "swiftui-ui-patterns": [
    "SKILL.md",
    "references/app-wiring.md",
    "references/async-state.md",
    "references/components-index.md",
    "references/controls.md",
    "references/deeplinks.md",
    "references/focus.md",
    "references/form.md",
    "references/grids.md",
    "references/haptics.md",
    "references/input-toolbar.md",
    "references/lightweight-clients.md",
    "references/list.md",
    "references/loading-placeholders.md",
    "references/macos-settings.md",
    "references/matched-transitions.md",
    "references/media.md",
    "references/menu-bar.md",
    "references/navigationstack.md",
    "references/overlay.md",
    "references/performance.md",
    "references/previews.md",
    "references/scroll-reveal.md",
    "references/scrollview.md",
    "references/searchable.md",
    "references/sheets.md",
    "references/split-views.md",
    "references/tabview.md",
    "references/theming.md",
    "references/title-menus.md",
    "references/top-bar.md",
  ],
  "swiftui-view-refactor": ["SKILL.md", "references/mv-patterns.md"],
};

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

function filesBelow(root) {
  const result = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(relative(root, path));
    }
  }
  visit(root);
  return result.sort();
}

function assertFrontmatter(name) {
  const content = read(`skills/${name}/SKILL.md`);
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${name} must have YAML frontmatter`);
  assert.match(match[1], new RegExp(`^name: ${name}$`, "m"));
  assert.match(match[1], /^description: .+$/m);

  for (const reference of content.matchAll(/`((?:\.\.\/[^`\n]+\/SKILL\.md|(?:references|scripts)\/[A-Za-z0-9._/-]+))`/g)) {
    assert.ok(
      existsSync(resolve(skillsRoot, name, reference[1])),
      `${name} references missing file ${reference[1]}`,
    );
  }
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
}

test("package exposes the extension, router, skills, and gallery assets", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.name, "xz-pi-build-ios-apps");
  assert.equal(manifest.type, "module");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(manifest.keywords.includes("pi-extension"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.equal(manifest.pi.image, "./assets/app-icon.png");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.ok(manifest.files.includes("index.ts"));

  assert.deepEqual(skillNames(), packageSkills);
  for (const name of packageSkills) assertFrontmatter(name);
  for (const path of [
    "index.ts",
    "README.md",
    "UPSTREAM.md",
    "LICENSE",
    "assets/app-icon.png",
    "assets/build-ios-apps-small.svg",
  ]) {
    assert.ok(existsSync(join(packageRoot, path)), `missing package resource ${path}`);
  }
});

test("all reusable upstream skill payload files are present", () => {
  for (const name of upstreamSkills) {
    assert.deepEqual(
      filesBelow(join(skillsRoot, name)),
      [...upstreamPayload[name]].sort(),
      `${name} payload differs from the expected upstream file set`,
    );
  }
});

test("vendored scripts pass syntax checks and executable scripts keep their mode", () => {
  const shellScripts = [
    "xz-pi-build-ios-apps/skills/ios-ettrace-performance/scripts/collect_ios_dsyms.sh",
    "xz-pi-build-ios-apps/skills/ios-memgraph-leaks/scripts/capture_sim_memgraph.sh",
  ];
  for (const script of shellScripts) run("bash", ["-n", script]);

  const pythonScripts = [
    "xz-pi-build-ios-apps/skills/ios-ettrace-performance/scripts/analyze_flamegraph_json.py",
    "xz-pi-build-ios-apps/skills/ios-memgraph-leaks/scripts/summarize_memgraph_leaks.py",
  ];
  for (const script of pythonScripts) {
    run("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", script]);
  }

  const executableResources = [
    ...shellScripts,
    ...pythonScripts,
    "xz-pi-build-ios-apps/skills/ios-simulator-browser/scripts/swiftui-preview-browser.mjs",
  ];
  for (const path of executableResources) {
    assert.notEqual(statSync(join(repoRoot, path)).mode & 0o111, 0, `${path} must remain executable`);
  }
});

test("debugger skill is MCP-first with a pinned CLI fallback and failure gates", () => {
  const content = read("skills/ios-debugger-agent/SKILL.md");
  assert.match(content, /registered `xcodebuildmcp` MCP server/i);
  assert.match(content, /mcp\(\{ server: "xcodebuildmcp" \}\)/);
  assert.match(content, /namespace: "mcp__xcodebuildmcp"/);
  assert.match(content, /xcodebuildmcp@2\.7\.0/);
  assert.doesNotMatch(content, /@latest/);
  for (const tool of ["list_sims", "session_set_defaults", "build_run_sim", "snapshot_ui", "debug_attach_sim", "debug_detach"]) {
    assert.match(content, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(content, /build fails[\s\S]*Stop before all UI interaction/i);
  assert.match(content, /pinned CLI fallback/i);
});

test("simulator browser uses pinned serve-sim and scoped cleanup", () => {
  const content = read("skills/ios-simulator-browser/SKILL.md");
  assert.doesNotMatch(content, /Codex in-app browser/i);
  assert.doesNotMatch(content, /@latest/);
  assert.match(content, /serve-sim@0\.1\.46/);
  assert.doesNotMatch(content, /serve-sim@0\.1\.46 --kill(?:\s*["'`]?)?(?:\n|$)/);
  assert.match(content, /--kill ["']?\$SIM/);
  assert.match(content, /\bopen\b/);
  run("node", ["--check", "xz-pi-build-ios-apps/skills/ios-simulator-browser/scripts/lib/xcode-project.mjs"]);
  run("node", ["--check", "xz-pi-build-ios-apps/skills/ios-simulator-browser/scripts/swiftui-preview-browser.mjs"]);
});

test("skill instructions avoid floating npm tools and Codex-only terminal APIs", () => {
  const allText = packageSkills.map((name) => read(`skills/${name}/SKILL.md`)).join("\n");
  const terminalApi = ["write", "_stdin"].join("");
  assert.doesNotMatch(allText, /@latest/);
  assert.doesNotMatch(allText, new RegExp(terminalApi));
});

test("monorepo integration documents the MCP-enabled package", () => {
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const releaseGuide = readFileSync(join(repoRoot, ".github/workflows/RELEASE.md"), "utf8");

  assert.ok(rootManifest.workspaces.includes("xz-pi-build-ios-apps"));
  assert.ok(lock.packages["xz-pi-build-ios-apps"]);
  assert.ok(lock.packages["node_modules/xz-pi-build-ios-apps"]?.link);
  assert.match(rootReadme, /pi install npm:xz-pi-build-ios-apps/);
  assert.match(rootReadme, /XcodeBuildMCP MCP/);
  assert.match(rootReadme, /pi -e \.\/xz-pi-build-ios-apps/);
  assert.match(releaseGuide, /xz-pi-build-ios-apps/);
});
