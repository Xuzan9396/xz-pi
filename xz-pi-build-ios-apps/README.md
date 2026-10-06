# xz-pi-build-ios-apps

Pi-native port of OpenAI's **Build iOS Apps** plugin, with automatic iOS workflow routing and a bundled XcodeBuildMCP registration.

## What is included

The package exposes a broad `build-ios-apps` router plus all nine upstream specialist skills:

- `build-ios-apps` — automatically routes general iOS, Swift, SwiftUI, Xcode, and Simulator requests
- `ios-app-intents`
- `ios-debugger-agent`
- `ios-ettrace-performance`
- `ios-memgraph-leaks`
- `ios-simulator-browser`
- `swiftui-liquid-glass`
- `swiftui-performance-audit`
- `swiftui-ui-patterns`
- `swiftui-view-refactor`

It also includes the complete reusable upstream references, scripts, templates, and icons.

## Requirements

- macOS 14.5 or newer
- Xcode 16 or newer, including Command Line Tools
- Node.js 18 or newer
- Pi 0.99 or newer for extension-registered MCP servers

Some workflows have additional on-demand requirements:

- Xcode and Simulator automation: `xcodebuildmcp@2.7.0`
- Simulator browser mirroring: `serve-sim@0.1.46`
- ETTrace profiling: the `ettrace` Homebrew package and a matching app-side framework
- Memory graphs: Apple's `leaks`, `xcrun`, and a running Simulator app

The npm CLIs are not installed globally. The MCP server and fallback workflows invoke reviewed, pinned versions through `npx`.

## Install

```bash
pi install npm:xz-pi-build-ios-apps
```

For local development from the monorepo root:

```bash
pi install -l ./xz-pi-build-ios-apps
# or for one session
pi -e ./xz-pi-build-ios-apps
```

Run `/reload` or restart Pi after installation. Confirm that the package is enabled with:

```bash
pi list
```

If the npm package exists under a Pi npm directory but its skills do not appear in the startup diagnostics, the package is not necessarily enabled. Open `pi config` and ensure both its extension and skills are active.

## Automatic routing

Pi advertises only skill names and descriptions until a skill is needed. This package adds a broad `build-ios-apps` routing skill and a short system-guidance section so requests involving iOS, SwiftUI, Xcode, Simulator, App Intents, profiling, or leaks proactively load the matching specialist workflow.

Skills remain directly invocable when an explicit workflow is preferred:

```text
/skill:build-ios-apps
/skill:ios-debugger-agent
/skill:swiftui-ui-patterns
/skill:ios-app-intents
```

## XcodeBuildMCP integration

The package extension registers an MCP server named `xcodebuildmcp` with:

- pinned package: `xcodebuildmcp@2.7.0`
- enabled workflows: `simulator`, `ui-automation`, and `debugging`
- five-minute request timeout for long Xcode operations
- a model-facing description covering projects, schemes, Simulator UI, logs, screenshots, and LLDB

The registration works with Pi's built-in MCP support. On Pi 0.99 or newer, `pi-mcp-adapter` also consumes extension registrations and exposes this server through its `mcp` gateway. A user or project MCP entry with the same name takes precedence, allowing local overrides without editing this package.

Inside Pi, inspect `/mcp` or the active MCP gateway and verify that `xcodebuildmcp` is connected. The `ios-debugger-agent` skill prefers MCP for build, launch, semantic UI automation, screenshots, runtime-log artifacts, and LLDB. It uses the pinned CLI only when the server is unavailable.

Verify the fallback tools manually without a global install:

```bash
npx --yes xcodebuildmcp@2.7.0 tools --json
npx --yes --package xcodebuildmcp@2.7.0 xcodebuildmcp-doctor
npx --yes serve-sim@0.1.46 --help
```

## Pi adaptations

Codex metadata is translated into Pi behavior instead of copied as inert files:

- `.codex-plugin/plugin.json` → npm/Pi package metadata and gallery assets
- `.mcp.json` → the package extension's pinned `pi.registerMcpServer(...)` registration
- plugin and skill `agents/openai.yaml` → the router skill, specialist descriptions, explicit `/skill:*` entries, and automatic system guidance
- Codex direct MCP names → MCP discovery compatible with both Pi built-in MCP and `pi-mcp-adapter`
- Codex in-app browser → an available Pi browser automation tool or the macOS default browser
- Codex terminal-input APIs → an interactive foreground terminal or visible `tmux` pane for ETTrace

See [UPSTREAM.md](UPSTREAM.md) for the exact upstream snapshot and behavioral differences.

## Updating from upstream

Copy the reusable upstream skill payload, retain and review the Pi adaptations in `UPSTREAM.md`, update the recorded commit and versions, then run:

```bash
npm run check --workspace xz-pi-build-ios-apps
npm pack --dry-run --workspace xz-pi-build-ios-apps
```

The package tests assert the complete expected upstream skill file set so omitted references, scripts, or templates fail CI.

## Security

Pi extensions and skills execute with your user permissions. This package starts XcodeBuildMCP through `npx` when Pi connects the registered server. Review the package before installation, use explicit Simulator identifiers, and keep temporary profiling or generated build output outside the target source tree unless requested otherwise.

## License

The vendored OpenAI plugin content is declared MIT-licensed upstream. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
