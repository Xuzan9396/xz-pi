# xz-pi-build-ios-apps

Pi package that ports OpenAI's **Build iOS Apps** plugin to Pi-native skill workflows.

## Included skills

- `ios-app-intents`
- `ios-debugger-agent`
- `ios-ettrace-performance`
- `ios-memgraph-leaks`
- `ios-simulator-browser`
- `swiftui-liquid-glass`
- `swiftui-performance-audit`
- `swiftui-ui-patterns`
- `swiftui-view-refactor`

## Requirements

- macOS 14.5 or newer
- Xcode 16 or newer, including Command Line Tools
- Node.js 18 or newer
- Pi

Some workflows have additional on-demand requirements:

- Simulator debugging: `xcodebuildmcp@2.7.0`
- Simulator browser mirroring: `serve-sim@0.1.46`
- ETTrace profiling: the `ettrace` Homebrew package and a matching app-side framework
- Memory graphs: Apple's `leaks`, `xcrun`, and a running Simulator app

The npm CLIs are not bundled or installed globally by this package. The skills invoke pinned versions through `npx` so each workflow remains reproducible.

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

Run `/reload` or restart Pi after installation. Skills can then be invoked explicitly, for example:

```text
/skill:ios-debugger-agent
/skill:swiftui-ui-patterns
/skill:ios-app-intents
```

## Verify external tools

Use the pinned versions without installing them globally:

```bash
npx --yes xcodebuildmcp@2.7.0 --help
npx --yes --package xcodebuildmcp@2.7.0 xcodebuildmcp-doctor
npx --yes serve-sim@0.1.46 --help
```

A global install is also supported when you explicitly choose to manage the same versions yourself:

```bash
npm install -g xcodebuildmcp@2.7.0 serve-sim@0.1.46
xcodebuildmcp --help
serve-sim --help
```

## Pi adaptations

Pi does not load the upstream plugin's `.mcp.json`. The `ios-debugger-agent` skill therefore uses the XcodeBuildMCP CLI directly and requests JSON output where machine-readable results are useful.

Simulator mirroring uses `serve-sim` to expose a local URL. Open that URL with an available Pi browser automation tool; if none is loaded, use macOS `open` and verify the rendered Simulator frame there.

ETTrace's interactive runner should be launched in a foreground terminal or a visible `tmux` pane so prompts can be answered directly.

## Updating from upstream

See [UPSTREAM.md](UPSTREAM.md). Copy the upstream skill payload, retain the Pi-specific adaptations described there, update the recorded commit and versions, then run:

```bash
npm run check --workspace xz-pi-build-ios-apps
npm pack --dry-run --workspace xz-pi-build-ios-apps
```

## Security

Pi skills can instruct the agent to execute local commands with your user permissions. Review the skills and helper scripts before installation. The simulator workflows require an explicit device identifier, and temporary profiling/build output must remain outside the target application's source tree unless the user explicitly requests otherwise.

## License

The vendored OpenAI plugin content is declared MIT-licensed upstream. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
