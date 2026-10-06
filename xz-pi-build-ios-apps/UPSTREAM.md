# Upstream

The files under the nine upstream skill directories and `assets/` are derived from OpenAI's Build iOS Apps plugin:

- Repository: https://github.com/openai/plugins
- Plugin path: `plugins/build-ios-apps`
- Plugin version: `0.1.2`
- Vendored Git commit: `1e285826e604f66f7208f7ac4dba0fe8341d1f57`
- Plugin tree: `f9a0d9e756f52a8a6764e823dc7760b64b6ec2f1`
- Declared license: MIT

The plugin tree was rechecked against upstream `main` commit `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f`; the Build iOS Apps tree was unchanged.

## Completeness boundary

The npm package retains the complete reusable payload:

- all nine upstream `SKILL.md` files, with documented Pi adaptations where runtime APIs differ
- every upstream reference document
- every upstream script and Swift template, preserving executable modes
- both upstream image assets

The package tests assert the expected file set for every upstream skill so missing references, scripts, or templates fail CI.

Codex-only metadata is not copied verbatim because Pi would ignore it:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- plugin- and skill-level `agents/openai.yaml`

Their behavior is translated into Pi resources instead of being shipped as inert metadata.

## Pi-specific adaptations

1. `package.json` carries the plugin identity, description, assets, skills, and extension entry that Pi understands.
2. `index.ts` translates `.mcp.json` into a pinned `pi.registerMcpServer("xcodebuildmcp", ...)` registration. It enables the current `simulator`, `ui-automation`, and `debugging` workflows. Upstream's `logging` workflow is not passed because XcodeBuildMCP 2.7.0 reports it as unknown; build and launch tools return runtime-log artifacts directly.
3. `build-ios-apps` is a Pi-native router skill. Together with the extension's short structured prompt guidance, it translates the upstream plugin/default-prompt surface into automatic specialist-skill selection.
4. `ios-debugger-agent` is MCP-first and supports both Pi built-in MCP/codemode and `pi-mcp-adapter`. It retains `xcodebuildmcp@2.7.0` as a reproducible CLI fallback when the registered server is unavailable.
5. `ios-simulator-browser` uses pinned `serve-sim@0.1.46` with an available Pi browser tool or macOS `open`, rather than the Codex-only embedded browser.
6. `ios-ettrace-performance` directs interactive ETTrace sessions to a foreground terminal or visible `tmux` pane instead of Codex terminal-input APIs.
7. The upstream skill-level display names and default prompts map to Pi skill descriptions and `/skill:<name>` commands. Pi does not consume `agents/openai.yaml`.

When updating, compare the adapted router, extension, debugger, simulator-browser, and ETTrace files before replacing any content. Do not reintroduce floating npm versions or Codex-only tool names without a Pi-compatible path.
