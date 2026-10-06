---
name: build-ios-apps
description: Build, run, debug, profile, and refine iOS, Swift, SwiftUI, Xcode, App Intents, and Simulator projects. Use proactively for any Apple app task involving an iPhone or iPad app, .xcodeproj or .xcworkspace, SwiftUI UI or previews, Simulator interaction, build failures, runtime logs, performance, memory leaks, or view refactoring; route the work to the bundled specialist skills and XcodeBuildMCP.
---

# Build iOS Apps

Use this skill as the entry point for iOS development work. Select the smallest matching specialist workflow, read that sibling skill before acting, and combine skills only when the task genuinely crosses concerns. Do not load every reference up front.

## Route the Request

| Need | Read and follow |
| --- | --- |
| Build, launch, inspect, automate, collect logs, or use LLDB on Simulator | `../ios-debugger-agent/SKILL.md` |
| Mirror Simulator in a browser or hot-reload package-backed SwiftUI previews | `../ios-simulator-browser/SKILL.md` |
| Capture or compare an ETTrace CPU profile | `../ios-ettrace-performance/SKILL.md` |
| Capture a memgraph, diagnose retention, or verify a leak fix | `../ios-memgraph-leaks/SKILL.md` |
| Expose actions or entities to Shortcuts, Siri, Spotlight, widgets, or controls | `../ios-app-intents/SKILL.md` |
| Build or review iOS 26+ Liquid Glass UI | `../swiftui-liquid-glass/SKILL.md` |
| Audit SwiftUI rendering, scrolling, updates, or hangs | `../swiftui-performance-audit/SKILL.md` |
| Design or implement SwiftUI navigation, state, controls, and screen composition | `../swiftui-ui-patterns/SKILL.md` |
| Split or stabilize a large SwiftUI view without changing behavior | `../swiftui-view-refactor/SKILL.md` |

## Default Behavior

1. Inspect the repository before choosing a project, workspace, scheme, target, simulator, or deployment version. Do not guess when the repository or a tool can answer.
2. For Simulator build, run, UI, screenshot, runtime-log, or debugger work, load `ios-debugger-agent` and prefer the package-registered `xcodebuildmcp` MCP server.
3. Keep profiling and generated artifacts outside the source tree unless the user explicitly requests otherwise.
4. Stop dependent actions after a failed prerequisite. In particular, do not automate UI after a failed build or claim a preview, trace, or leak fix without its required proof.
5. Preserve the project's existing architecture and conventions unless the user asks for a broader redesign.

## MCP Availability

The package extension registers XcodeBuildMCP as `xcodebuildmcp` with the simulator, UI-automation, and debugging workflows enabled. Pi's built-in MCP support exposes it through MCP/codemode; `pi-mcp-adapter` exposes the same registration through its `mcp` gateway. If the server is unavailable, diagnose that first, then use the pinned CLI fallback documented by `ios-debugger-agent` rather than silently switching to an unpinned tool.
