import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piAI from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import btwExtension from "../extensions/btw";

const roots: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withExtension = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-btw-sdk-test-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const marker = join(root, "lifecycle.txt");
  if (withExtension) {
    const extension = join(root, "lookup.ts");
    await writeFile(extension, `
      import { appendFileSync } from 'node:fs';
      export default function(pi) {
        pi.on('session_start', () => appendFileSync(${JSON.stringify(marker)}, 'start\\n'));
        pi.on('session_shutdown', () => appendFileSync(${JSON.stringify(marker)}, 'stop\\n'));
        pi.registerTool({name:'lookup_fact',label:'Lookup',description:'Look up a fact',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'fixture fact'}],details:{}})});
      }
    `);
    await writeFile(join(agentDir, "btw.json"), JSON.stringify({ extensions: [extension] }));
  }

  const requests: Array<{ prompt: string; messages: Context["messages"]; tools: string[] }> = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  });
  modelRuntime.registerProvider("btw-test", {
    baseUrl: "http://unused.invalid",
    api: "btw-test-api",
    apiKey: "fixture-key",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      // Pi 0.99 embeds the prompt and tool updates in system messages. Older
      // supported SDKs pass them as separate fields on Context.
      const compat = piAI as typeof piAI & {
        getCurrentSystemPrompt?: (messages: Context["messages"]) => string;
        getCurrentTools?: (messages: Context["messages"]) => Tool[];
      };
      const legacy = context as Context;
      const prompt = compat.getCurrentSystemPrompt?.(context.messages) ?? legacy.systemPrompt ?? "";
      const tools = compat.getCurrentTools?.(context.messages) ?? legacy.tools ?? [];
      requests.push({ prompt, messages: structuredClone(context.messages), tools: tools.map((tool) => tool.name) });
      const last = context.messages.at(-1);
      const callTool = tools.some((tool) => tool.name === "lookup_fact") && last?.role === "user" && JSON.stringify(last.content).includes("use lookup");
      const stopReason = callTool ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: callTool ? [{ type: "toolCall", id: "lookup-1", name: "lookup_fact", arguments: {} }] : [{ type: "text", text: "fixture answer" }],
        stopReason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = piAI.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    },
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: "parent context sentinel", timestamp: Date.now() });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [btwExtension, (pi) => pi.registerTool({
      name: "unavailable_parent_tool", label: "Parent tool", description: "Parent-only fixture",
      parameters: piAI.Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "parent-only fact" }], details: {} }),
    })],
    systemPrompt: "Project instruction sentinel. Parent can use unavailable_parent_tool.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, sessionManager, settingsManager, resourceLoader: loader,
    model: modelRuntime.getModel("btw-test", "fixture")!, thinkingLevel: "off",
  });
  sessions.push(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  // Exercise a populated parent history, including Pi's persisted system/tool
  // messages on newer releases, before creating any child session.
  await session.prompt("parent request sentinel");
  expect(requests.at(-1)!.tools).toContain("unavailable_parent_tool");
  requests.length = 0;
  const parentAnswers = sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant");
  const command = async (name: string, args: string) => {
    const registered = session.extensionRunner.getCommand(name);
    expect(registered, `registered command ${name}`).toBeDefined();
    await registered!.handler(args, session.extensionRunner.createCommandContext());
    expect(errors).toEqual([]);
  };
  return { sessionManager, requests, command, marker, parentAnswers };
}

describe("package integration", () => {
  it("publishes the new extension and skill without the legacy implementation", async () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    expect(manifest.name).toBe("xz-pi-btw");
    expect(manifest.pi.extensions).toEqual(["./extensions/btw.ts"]);
    expect(manifest.pi.skills).toEqual(["./skills"]);
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces=false"], { cwd, encoding: "utf8" }))[0];
    const files = packed.files.map((file: { path: string }) => file.path);
    for (const path of ["extensions/btw.ts", "extensions/btw-extension-tools.ts", "skills/btw/SKILL.md", "UPSTREAM.md", "README.md", "LICENSE"]) {
      expect(files).toContain(path);
    }
    expect(files).not.toContain("index.ts");
    expect(files.some((path: string) => /^(src|test|tests)\//.test(path))).toBe(false);
    expect(await readFile(join(cwd, "LICENSE"), "utf8")).toContain("Dan Bachelder");
  });
});

describe("BTW commands with the real Pi SDK", () => {
  it.each([
    { command: "btw", inheritsContext: true, tools: ["read", "bash", "edit", "write"] },
    { command: "btw:tangent", inheritsContext: false, tools: ["read", "bash", "edit", "write"] },
    { command: "btw:ask", inheritsContext: true, tools: ["read", "grep", "find", "ls"] },
  ])("$command sends the correct context, capabilities, and tool surface", async (mode) => {
    const { command, requests, sessionManager, parentAnswers } = await fixture();
    await command(mode.command, "child question sentinel");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.tools.sort()).toEqual([...mode.tools].sort());
    expect(request.prompt).toContain("Project instruction sentinel");
    expect(request.prompt).toContain("<btw_capabilities>");
    expect(request.prompt).toContain(`Available tools in this BTW session: ${mode.tools.join(", ")}.`);
    expect(JSON.stringify(request.messages).includes("parent context sentinel")).toBe(mode.inheritsContext);
    expect(JSON.stringify(request.messages)).toContain("child question sentinel");
    expect(sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "btw-thread-entry")).toBe(true);
    // A child response must never become an assistant response in the parent.
    expect(sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant")).toEqual(parentAnswers);
  });

  it("keeps follow-ups in the child and summarizes with no tools", async () => {
    const { command, requests } = await fixture();
    await command("btw", "first child question");
    await command("btw", "follow-up question");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("first child question");
    expect(requests[1].messages.some((message) => message.role === "assistant")).toBe(true);
    await command("btw:summarize", "");
    expect(requests).toHaveLength(3);
    expect(requests[2].tools).toEqual([]);
    expect(requests[2].prompt).toContain("No tools are available in this BTW session.");
    expect(JSON.stringify(requests[2].messages)).toContain("follow-up question");
  });

  it("executes an opted-in tool and excludes it from read-only and summary sessions", async () => {
    const { command, requests, marker } = await fixture(true);
    await command("btw", "use lookup");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools).toContain("lookup_fact");
    expect(requests[0].prompt).toContain("write, lookup_fact.");
    expect(requests[1].messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("fixture fact"))).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("start\n");
    await command("btw:ask", "read-only question");
    expect(requests.at(-1)!.tools.sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(await readFile(marker, "utf8")).toBe("start\nstop\n");
    await command("btw:summarize", "");
    expect(requests.at(-1)!.tools).toEqual([]);
    expect(await readFile(marker, "utf8")).toBe("start\nstop\n");
  });
});
