import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createRunner, piInvocation } from "../src/runner.js";
import { plan, record } from "./helpers.js";

const piDir = process.env.XZ_TEST_PI_PACKAGE_DIR ?? getPackageDir();
function send(res: ServerResponse, text: string, calls?: Array<{ name: string; args: unknown }>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = calls ? { role: "assistant", tool_calls: calls.map((call, i) => ({ index: i, id: `call_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { role: "assistant", content: text };
  const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  chunk({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  res.end("data: [DONE]\n\n");
}
async function setup(t: { after(fn: () => unknown): void }, responder: (body: any, res: ServerResponse) => void) {
  const root = await mkdtemp(join(tmpdir(), "xz-integration-"));
  const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
  await mkdir(agentDir); await mkdir(cwd);
  const server = createServer(async (req, res) => {
    let input = ""; for await (const chunk of req) input += chunk;
    try { responder(JSON.parse(input), res); }
    catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = (server.address() as { port: number }).port;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-local-only", models: [{ id: "model", compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], enableInstallTelemetry: false }));
  return { root, cwd, agentDir };
}

test("real Pi child loads selected skills, project context and explicit extension tools", { timeout: 30_000 }, async t => {
  const requests: any[] = [];
  let skillPath = "";
  const env = await setup(t, (body, res) => {
    requests.push(body);
    const results = body.messages.filter((m: any) => m.role === "tool");
    if (!results.length) send(res, "", [{ name: "read", args: { path: skillPath } }, { name: "fixture_echo", args: { value: "from-child" } }]);
    else send(res, "SKILL_AND_EXTENSION_OK");
  });
  const skillDir = join(env.agentDir, "skills", "fixture-skill"); await mkdir(skillDir, { recursive: true });
  skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, "---\nname: fixture-skill\ndescription: Fixture skill for child delegation\n---\nSKILL_BODY_MARKER\n");
  await writeFile(join(env.cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
  const extension = join(env.root, "fixture-extension.ts");
  await writeFile(extension, `import { Type } from "typebox";\nexport default function(pi) { pi.registerTool({ name: "fixture_echo", label: "Echo", description: "Local fixture echo", parameters: Type.Object({ value: Type.String() }), execute: async (_id, args) => ({ content: [{type: "text", text: "EXTENSION_MARKER " + args.value}] }) }); }`);
  const p = plan("integration", "write");
  p.resources = { ...p.resources, ...env, extensions: [extension], trusted: true };
  p.tools = ["read", "fixture_echo"]; p.skillPaths = [skillPath];
  const r = record();
  const outcome = await createRunner({ invocation: piInvocation(piDir), tempRoot: env.root })(p, r, new AbortController().signal, () => {});
  assert.equal(outcome.status, "completed", `${outcome.error}\n${await readFile(join(r.attemptDir!, "stderr.log"), "utf8")}`);
  assert.equal(outcome.output, "SKILL_AND_EXTENSION_OK");
  assert.ok(requests.length >= 2);
  assert.match(JSON.stringify(requests[0].messages), /fixture-skill/);
  assert.match(JSON.stringify(requests[0].messages), /PROJECT_CONTEXT_MARKER/);
  assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), ["fixture_echo", "read"]);
  assert.match(JSON.stringify(requests[1].messages), /SKILL_BODY_MARKER/);
  assert.match(JSON.stringify(requests[1].messages), /EXTENSION_MARKER from-child/);
});

test("real main joins two overlapping write-mode Pi children using a web-search fixture", { timeout: 45_000 }, async t => {
  const children = new Set<string>();
  const pending = new Map<string, { res: ServerResponse; timer: ReturnType<typeof setTimeout> }>();
  t.after(() => { for (const item of pending.values()) clearTimeout(item.timer); });
  let overlapped = false;
  let joined = false;
  let failure = "";
  const env = await setup(t, (body, res) => {
    const main = body.tools.some((tool: any) => tool.function.name === "xz_subagents_run");
    if (main) {
      const result = body.messages.find((m: any) => m.role === "tool");
      if (!result) send(res, "", [{ name: "xz_subagents_run", args: { tasks: [
        { name: "a", task: "CHILD_A", mode: "write", tools: ["web_search"], skills: [] },
        { name: "b", task: "CHILD_B", mode: "write", tools: ["web_search"], skills: [] }
      ], concurrency: 2 } }]);
      else {
        joined = overlapped && children.size === 2 && String(result.content).includes("a: completed") && String(result.content).includes("b: completed");
        failure = JSON.stringify(result);
        send(res, joined ? "MAIN_JOINED" : "MAIN_JOIN_FAILED");
      }
    } else {
      const label = JSON.stringify(body.messages).includes("CHILD_A") ? "A" : "B";
      const result = body.messages.find((m: any) => m.role === "tool");
      if (!result) { send(res, "", [{ name: "web_search", args: { query: `CHILD_${label}` } }]); return; }
      assert.match(String(result.content), /FIXTURE_SEARCH/);
      // Neither child can finish until BOTH have reached this request. A serial scheduler
      // hits the watchdog instead and fails the overlap assertion without hanging the suite.
      const timer = setTimeout(() => { pending.delete(label); children.add(label); send(res, `SERIAL_${label}`); }, 5000);
      pending.set(label, { res, timer });
      if (pending.size === 2) {
        overlapped = true;
        for (const [name, item] of pending) { clearTimeout(item.timer); children.add(name); send(item.res, `CHILD_${name}_DONE`); }
        pending.clear();
      }
    }
  });
  const pkg = fileURLToPath(new URL("../", import.meta.url));
  const search = join(env.root, "web-search-fixture.ts");
  await writeFile(search, `import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "web_search", label: "Fixture search", description: "Local test fixture, not an internet search", parameters: Type.Object({ query: Type.String() }), execute: async (_id, args) => ({ content: [{type: "text", text: "FIXTURE_SEARCH " + args.query}] }) }); }`);
  await writeFile(join(env.agentDir, "settings.json"), JSON.stringify({ packages: [pkg], extensions: [search], enableInstallTelemetry: false }));
  const invocation = piInvocation(piDir);
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolveResult, reject) => {
    const child = spawn(invocation.command, [...invocation.args, "--mode", "json", "-p", "--no-session", "--no-approve", "--model", "fixture/model", "--thinking", "off", "Delegate to two children, then join."], {
      cwd: env.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", TMPDIR: env.root }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("main fixture timed out")); }, 35_000);
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolveResult({ code, out, err }); });
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(joined, true, `${failure}\n${result.err}\n${result.out.slice(-6000)}`);
  assert.match(result.out, /MAIN_JOINED/);
});

test("delegation does not grant trust to project extensions", { timeout: 20_000 }, async t => {
  const env = await setup(t, (_body, res) => send(res, "TRUST_CHECK_OK"));
  const extensionDir = join(env.cwd, ".pi", "extensions"); await mkdir(extensionDir, { recursive: true });
  const marker = join(env.root, "untrusted-executed");
  await writeFile(join(extensionDir, "unsafe.ts"), `import {writeFileSync} from "node:fs"; export default function() {writeFileSync(${JSON.stringify(marker)}, "bad");}`);
  const p = plan("trust"); p.resources = { ...p.resources, ...env, trusted: false };
  const outcome = await createRunner({ invocation: piInvocation(piDir), tempRoot: env.root })(p, record(), new AbortController().signal, () => {});
  assert.equal(outcome.status, "completed", outcome.error); assert.equal(existsSync(marker), false);
});

// Optional integration against a separately installed adapter; never reads the user's MCP config.
for (const approved of [true, false]) {
  test(`real pi-mcp-adapter: ${approved ? "local stdio call" : "headless approval is not bypassed"}`, { timeout: 30_000, skip: !process.env.XZ_TEST_MCP_ADAPTER }, async t => {
    const responses: string[] = [];
    const env = await setup(t, (body, res) => {
      const result = body.messages.find((m: any) => m.role === "tool");
      if (!result) send(res, "", [{ name: "mcp", args: { server: "fixture", tool: "echo", args: { value: "local-ping" } } }]);
      else { responses.push(JSON.stringify(result)); send(res, "MCP_CHECK_FINISHED"); }
    });
    const marker = join(env.root, "tool-called");
    const server = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
    const extension = join(env.root, "adapter-wrapper.ts");
    const config = { mcpServers: { fixture: { command: process.execPath, args: [server, marker] } }, settings: { approveTools: !approved } };
    await writeFile(extension, `import { createMcpAdapter } from ${JSON.stringify(process.env.XZ_TEST_MCP_ADAPTER)}; export default createMcpAdapter({config:${JSON.stringify(config)}});`);
    const p = plan("mcp-check", "write"); p.resources = { ...p.resources, ...env, extensions: [extension] };
    p.tools = ["mcp"];
    const r = record();
    const outcome = await createRunner({ invocation: piInvocation(piDir), tempRoot: env.root })(p, r, new AbortController().signal, () => {});
    assert.equal(outcome.status, "completed", `${outcome.error}\n${await readFile(join(r.attemptDir!, "stderr.log"), "utf8")}`);
    assert.equal(existsSync(marker), approved, responses.join("\n"));
    assert.match(responses.join("\n"), approved ? /MCP_ECHO local-ping/ : /approval_required|approval/i);
  });
}
