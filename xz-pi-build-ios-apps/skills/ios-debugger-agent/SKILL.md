---
name: ios-debugger-agent
description: Build, run, and debug iOS apps on Simulator with the XcodeBuildMCP CLI. Use when launching an app, inspecting simulator UI or logs, or diagnosing runtime behavior.
---

# iOS Debugger Agent

## Overview

Use the pinned XcodeBuildMCP CLI to build and run the current project scheme on an iOS Simulator, inspect the runtime UI, interact with elements, capture screenshots, and collect launch logs. Prefer JSONL for long-running commands so progress remains visible; use JSON for short commands that need machine-readable output.

## CLI

Use the reviewed version without requiring a global install:

```bash
xcodebuildmcp_pi() {
  npx --yes xcodebuildmcp@2.7.0 "$@"
}
```

Before relying on a command after updating this skill, inspect the shipped tools:

```bash
xcodebuildmcp_pi tools
xcodebuildmcp_pi doctor
```

Do not replace the pinned version with a floating version during a debugging session.

## Core Workflow

Follow this sequence unless the user asks for a narrower action.

### 1) Discover a booted simulator

```bash
xcodebuildmcp_pi simulator list --output json
```

Select a device whose state is `Booted` and retain its explicit UDID. If none is booted, ask the user to boot one. Do not boot a simulator automatically unless the user asks.

### 2) Discover the project and scheme

Use the repository's existing `.xcodeproj` or `.xcworkspace`. If the scheme is unknown:

```bash
xcodebuildmcp_pi simulator discover-projects --output json
xcodebuildmcp_pi simulator list-schemes \
  --project-path /absolute/path/App.xcodeproj \
  --output json
```

Use `--workspace-path` instead of `--project-path` for workspace-based projects. Pass the project/workspace, scheme, and simulator ID explicitly, or reuse an existing `.xcodebuildmcp/config.yaml` whose defaults match the requested app. Do not create or overwrite project configuration without user approval.

### 3) Build and run

Prefer JSONL because builds can be long-running:

```bash
xcodebuildmcp_pi simulator build-and-run --json '{
  "projectPath": "/absolute/path/App.xcodeproj",
  "scheme": "App",
  "simulatorId": "<SIMULATOR_UDID>",
  "configuration": "Debug"
}' --output jsonl
```

For a workspace, send `workspacePath` instead of `projectPath`. Put app runtime arguments in `launchArgs`; reserve `extraArgs` for `xcodebuild` flags and build settings.

If the build fails, stop before any UI interaction. Read the streamed failure and artifact paths, preserve the relevant error output, fix or report the build issue, and only continue after a successful build.

After a successful build, verify that the app launched:

```bash
xcodebuildmcp_pi simulator snapshot-ui \
  --simulator-id "<SIMULATOR_UDID>" \
  --output json
```

A successful build alone is not proof that the requested app is visible.

If the app is already installed and only launch is requested:

```bash
xcodebuildmcp_pi simulator launch-app --json '{
  "simulatorId": "<SIMULATOR_UDID>",
  "bundleId": "com.example.App"
}' --output json
```

If the bundle identifier is unknown, resolve it from the built app:

```bash
APP_PATH="$(xcodebuildmcp_pi simulator get-app-path --json '{
  "projectPath": "/absolute/path/App.xcodeproj",
  "scheme": "App",
  "simulatorId": "<SIMULATOR_UDID>"
}' --output json)"
xcodebuildmcp_pi simulator get-app-bundle-id --app-path "<APP_PATH>" --output json
```

Parse the JSON result rather than treating the complete JSON envelope as the path.

## UI Interaction and Debugging

Capture a fresh semantic UI snapshot before targeting elements:

```bash
xcodebuildmcp_pi ui-automation snapshot-ui \
  --simulator-id "<SIMULATOR_UDID>" \
  --output json
```

Use element references from the current snapshot whenever possible:

```bash
xcodebuildmcp_pi ui-automation tap --json '{
  "simulatorId": "<SIMULATOR_UDID>",
  "elementRef": "<ELEMENT_REF>"
}' --output json

xcodebuildmcp_pi ui-automation type-text --json '{
  "simulatorId": "<SIMULATOR_UDID>",
  "elementRef": "<ELEMENT_REF>",
  "text": "Hello"
}' --output json

xcodebuildmcp_pi ui-automation gesture --json '{
  "simulatorId": "<SIMULATOR_UDID>",
  "preset": "scroll-down"
}' --output json
```

Run `xcodebuildmcp_pi <workflow> <tool> --help` if a tool's current argument schema is uncertain. Never guess coordinates or JSON keys when the pinned CLI can describe them.

Capture visual evidence when needed:

```bash
xcodebuildmcp_pi simulator screenshot \
  --simulator-id "<SIMULATOR_UDID>" \
  --output json
```

Re-run `snapshot-ui` after navigation or layout changes before interacting again.

## Logs and Console Output

`simulator build-and-run` and `simulator launch-app` capture runtime logs and return artifact paths. Read the returned log artifacts and summarize only relevant lines. Use `--output jsonl` for a launch or build where live progress matters, and retain the final artifact paths.

When launch arguments are needed for diagnostic logging, pass them through `launchArgs` and relaunch. Do not put runtime arguments in `extraArgs`.

## Troubleshooting

- If a build fails, stop UI work, inspect the actual build error, and retry only after addressing it.
- If the wrong app launches, confirm the scheme, simulator UDID, and bundle identifier.
- If an element is not hittable, capture a new `snapshot-ui` after the layout change.
- If a CLI verb or option is rejected, run `xcodebuildmcp_pi tools` and the tool's `--help`; do not silently fall back to an unpinned package.
- If the CLI cannot initialize, run `xcodebuildmcp_pi doctor` and report its environment findings.
