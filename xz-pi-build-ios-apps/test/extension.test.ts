import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import buildIosApps, {
  BUILD_IOS_APPS_GUIDANCE,
  XCODEBUILDMCP_SERVER_NAME,
  XCODEBUILDMCP_VERSION,
  XCODEBUILDMCP_WORKFLOWS,
  createXcodeBuildMcpConfig,
} from "../index.js";

test("registers the pinned XcodeBuildMCP server", () => {
  let registration: { name: string; config: ReturnType<typeof createXcodeBuildMcpConfig> } | undefined;
  const handlers = new Map<string, (event: any) => void>();
  const pi = {
    registerMcpServer(name: string, config: ReturnType<typeof createXcodeBuildMcpConfig>) {
      registration = { name, config };
    },
    on(name: string, handler: (event: any) => void) {
      handlers.set(name, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;

  buildIosApps(pi);

  assert.equal(registration?.name, XCODEBUILDMCP_SERVER_NAME);
  assert.deepEqual(registration?.config, createXcodeBuildMcpConfig());
  assert.deepEqual(registration?.config.args, ["--yes", `xcodebuildmcp@${XCODEBUILDMCP_VERSION}`, "mcp"]);
  assert.equal(registration?.config.env.XCODEBUILDMCP_ENABLED_WORKFLOWS, XCODEBUILDMCP_WORKFLOWS);
  assert.equal(registration?.config.exposure, "codemode");
  assert.equal(registration?.config.timeout, 300);
  assert.ok(handlers.has("before_agent_start"));
});

test("adds routing guidance only when the router skill is available", () => {
  let beforeAgentStart: ((event: any) => void) | undefined;
  const pi = {
    registerMcpServer() {},
    on(name: string, handler: (event: any) => void) {
      if (name === "before_agent_start") beforeAgentStart = handler;
      return () => {};
    },
  } as unknown as ExtensionAPI;

  buildIosApps(pi);
  assert.ok(beforeAgentStart);

  const routedEvent = {
    systemPromptOptions: {
      skills: [{ name: "build-ios-apps" }],
      sections: {} as Record<string, string>,
    },
  };
  beforeAgentStart?.(routedEvent);
  assert.equal(routedEvent.systemPromptOptions.sections.build_ios_apps, BUILD_IOS_APPS_GUIDANCE);

  const filteredEvent = {
    systemPromptOptions: {
      skills: [{ name: "other-skill" }],
      sections: { build_ios_apps: "stale" } as Record<string, string>,
    },
  };
  beforeAgentStart?.(filteredEvent);
  assert.equal(filteredEvent.systemPromptOptions.sections.build_ios_apps, undefined);

  assert.doesNotThrow(() => beforeAgentStart?.({ systemPromptOptions: { skills: [] } }));
});
