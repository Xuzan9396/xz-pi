import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type McpCapableExtensionAPI = ExtensionAPI & {
  registerMcpServer?: (name: string, config: ReturnType<typeof createXcodeBuildMcpConfig>) => void;
};

export const XCODEBUILDMCP_SERVER_NAME = "xcodebuildmcp";
export const XCODEBUILDMCP_VERSION = "2.7.0";
export const XCODEBUILDMCP_WORKFLOWS = "simulator,ui-automation,debugging";
export const BUILD_IOS_APPS_GUIDANCE =
  "For requests involving iOS, Swift, SwiftUI, Xcode, App Intents, Simulator, profiling, leaks, or Apple UI, proactively load the `build-ios-apps` skill and the specialist skills it routes to. For Simulator build, run, UI, log, or debugger work, prefer the registered `xcodebuildmcp` MCP server; use its pinned CLI only when MCP is unavailable.";

export function createXcodeBuildMcpConfig() {
  return {
    command: "npx",
    args: ["--yes", `xcodebuildmcp@${XCODEBUILDMCP_VERSION}`, "mcp"],
    env: {
      XCODEBUILDMCP_ENABLED_WORKFLOWS: XCODEBUILDMCP_WORKFLOWS,
    },
    exposure: "codemode" as const,
    description:
      "Build, run, inspect, automate, debug, and collect runtime logs for iOS Simulator apps with XcodeBuildMCP.",
    timeout: 300,
  };
}

export default function buildIosApps(pi: McpCapableExtensionAPI): void {
  if (typeof pi.registerMcpServer === "function") {
    pi.registerMcpServer(XCODEBUILDMCP_SERVER_NAME, createXcodeBuildMcpConfig());
  }

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions as typeof event.systemPromptOptions & {
      sections?: Record<string, string>;
    };
    if (!options.sections) return;

    const hasRouter = options.skills?.some((skill) => skill.name === "build-ios-apps") ?? false;
    if (hasRouter) {
      options.sections.build_ios_apps = BUILD_IOS_APPS_GUIDANCE;
    } else {
      delete options.sections.build_ios_apps;
    }
  });
}
