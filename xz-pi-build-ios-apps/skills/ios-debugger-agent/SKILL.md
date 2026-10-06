---
name: ios-debugger-agent
description: Build, run, inspect, automate, and debug iOS apps on Simulator with XcodeBuildMCP. Use when working with Xcode projects or workspaces, launching an app, fixing build failures, inspecting Simulator UI or screenshots, collecting runtime logs, driving UI, or diagnosing runtime behavior with LLDB.
---

# iOS Debugger Agent

## Overview

Use the package-registered `xcodebuildmcp` MCP server to build and run the current app on iOS Simulator, inspect semantic UI state, interact with elements, capture screenshots and runtime logs, and debug with LLDB. Keep one MCP server session for stateful defaults and debugger calls. Use the pinned CLI only when the MCP server is unavailable.

## Access XcodeBuildMCP

The package registers XcodeBuildMCP `2.7.0` as the server `xcodebuildmcp`, with `simulator`, `ui-automation`, and `debugging` workflows enabled.

Choose the access path Pi makes available:

- **`mcp` gateway (`pi-mcp-adapter`)**: inspect `mcp({ server: "xcodebuildmcp" })`, search with `mcp({ search: "...", server: "xcodebuildmcp" })`, describe an uncertain tool, then call it with `mcp({ tool: "<tool>", server: "xcodebuildmcp", args: { ... } })`.
- **Pi built-in MCP/codemode**: use `searchTools("...", { namespace: "mcp__xcodebuildmcp" })`, inspect uncertain schemas with `describeTool(...)`, and call the discovered MCP tool.
- **Direct MCP tools**: if Pi has already exposed `mcp__xcodebuildmcp__...` tools, call those directly.

At the pinned version, the primary tools include `list_sims`, `session_set_defaults`, `build_run_sim`, `launch_app_sim`, `get_sim_app_path`, `get_app_bundle_id`, `snapshot_ui`, `wait_for_ui`, `tap`, `type_text`, `gesture`, `screenshot`, and `debug_*`. Tool exposure can rename the model-facing prefix, so discover by server and tool name rather than guessing a complete prefixed name.

## Core Workflow

Follow this sequence unless the user requests a narrower action.

### 1. Discover the project and simulator

1. Inspect the repository for `.xcworkspace` and `.xcodeproj` files. Prefer the workspace when the project already uses one.
2. Use `list_sims` and retain an explicit Simulator UDID.
3. Prefer a simulator already in state `Booted`. If none is booted, ask before booting one unless the user already requested a full build-and-run workflow.
4. Use `discover_projs` or `list_schemes` when the repository does not make the project path or scheme unambiguous.

Do not select a scheme, target, or device only from its name when the available metadata can confirm it.

### 2. Set session defaults

Use `session_set_defaults` with:

- exactly one of `projectPath` or `workspacePath`
- the app `scheme`
- `simulatorId`
- optional `configuration: "Debug"` and `useLatestOS: true`

Reuse existing defaults only after `session_show_defaults` confirms they match this task. Pass explicit arguments instead when parallel work could change shared defaults. Do not create or overwrite `.xcodebuildmcp/config.yaml` without user approval.

### 3. Build and run

Call `build_run_sim`. Put app runtime arguments in `launchArgs`; reserve `extraArgs` for `xcodebuild` flags and build settings.

If the build fails:

1. Stop before all UI interaction and debugger attachment.
2. Preserve the relevant compiler output and artifact paths.
3. Fix or report the actual build error.
4. Continue only after a successful build.

After a successful build, call `snapshot_ui` or `screenshot` to prove the requested app is visible. A successful build response alone is not launch proof.

If the app is already installed and only launch is requested, use `launch_app_sim`. If its bundle identifier is unknown, resolve the built `.app` with `get_sim_app_path`, then call `get_app_bundle_id`; do not parse a complete JSON response envelope as a filesystem path.

## UI Inspection and Interaction

1. Call `snapshot_ui` before targeting an element.
2. Prefer current `elementRef` targets over coordinates.
3. Use `tap` for one target or `batch` for safe same-screen actions.
4. Use `type_text` only after identifying the intended field; provide its `elementRef`.
5. Prefer `swipe` or `drag` within a current element reference when the snapshot recommends it; use a generic `gesture` only when appropriate.
6. After navigation, scrolling, a sheet change, or a visible layout change, call `wait_for_ui` or take a fresh `snapshot_ui` before reusing references.
7. Use `screenshot` for visual proof when needed.

Never claim success from a stale snapshot or from a command that did not verify the resulting screen.

## Runtime Logs

`build_run_sim` and `launch_app_sim` capture runtime output and return log artifact paths. Read the returned artifact rather than launching a second untracked logging process. Summarize only relevant lines and keep the artifact path in the report.

When diagnostic launch arguments are required, pass them through `launchArgs` and relaunch. Do not put runtime arguments in `extraArgs`.

## LLDB Debugging

Use the `debug_*` tools only after a successful launch:

1. Describe `debug_attach_sim` and attach to the intended app and Simulator.
2. Add only the breakpoints needed for the current hypothesis with `debug_breakpoint_add`.
3. Use `debug_continue`, `debug_stack`, `debug_variables`, or `debug_lldb_command` to gather focused evidence.
4. Remove temporary breakpoints when appropriate and always call `debug_detach` when finished.

Do not leave an app paused or an LLDB session attached after the task. Avoid arbitrary mutating LLDB commands unless the user requested that experiment.

## Pinned CLI Fallback

Use the CLI only if the registered MCP server is missing, disabled, or failed to connect. First inspect `/mcp` or the available MCP gateway status and report the reason. Do not switch between MCP and CLI in the middle of a stateful debugger flow.

```bash
xcodebuildmcp_pi() {
  npx --yes xcodebuildmcp@2.7.0 "$@"
}
```

Discover the installed commands and environment:

```bash
xcodebuildmcp_pi tools --json
xcodebuildmcp_pi doctor
```

Representative fallback flow:

```bash
xcodebuildmcp_pi simulator list --output json

xcodebuildmcp_pi simulator build-and-run --json '{
  "projectPath": "/absolute/path/App.xcodeproj",
  "scheme": "App",
  "simulatorId": "<SIMULATOR_UDID>",
  "configuration": "Debug"
}' --output jsonl

xcodebuildmcp_pi ui-automation snapshot-ui \
  --simulator-id "<SIMULATOR_UDID>" \
  --output json
```

Use `--workspace-path` instead of `--project-path` for a workspace. Prefer JSONL for long-running builds and JSON for short machine-readable calls. If a CLI option is uncertain, run `xcodebuildmcp_pi <workflow> <tool> --help`; do not guess or fall back to an unpinned package.

## Troubleshooting

- If `xcodebuildmcp` is absent from MCP status, confirm the complete Pi package—not only its skills—is enabled, then reload Pi.
- If the MCP server fails to initialize, inspect its connection error and run the pinned CLI doctor.
- If the wrong app launches, confirm project/workspace, scheme, Simulator UDID, and bundle identifier.
- If an element is not hittable, refresh the semantic UI snapshot after the last layout change.
- If a tool or argument is rejected, describe its live schema; do not assume an older upstream name still matches.
