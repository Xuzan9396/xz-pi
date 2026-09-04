# Upstream

The files under `skills/` and `assets/` are derived from OpenAI's Build iOS Apps plugin:

- Repository: https://github.com/openai/plugins
- Plugin path: `plugins/build-ios-apps`
- Plugin version: `0.1.2`
- Git commit: `1e285826e604f66f7208f7ac4dba0fe8341d1f57`
- Declared license: MIT

Vendored on 2026-09-04 for use as a Pi package.

## Pi-specific adaptations

The reusable `SKILL.md`, references, scripts, templates, and icons are retained. Codex-only runtime metadata is not packaged as a Pi resource:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- plugin- and skill-level `agents/openai.yaml`

Behavioral adaptations:

1. `ios-debugger-agent` uses the pinned `xcodebuildmcp@2.7.0` CLI instead of Codex MCP tool calls.
2. `ios-simulator-browser` uses pinned `serve-sim@0.1.46` with an available browser tool or macOS `open`, rather than a Codex-only embedded browser.
3. `ios-ettrace-performance` directs interactive ETTrace sessions to a foreground terminal or visible `tmux` pane instead of Codex terminal-input APIs.

When updating, compare these adapted files before replacing them with a newer upstream snapshot.
