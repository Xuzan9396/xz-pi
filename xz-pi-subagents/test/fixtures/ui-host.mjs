// Manual TUI smoke fixture: local deterministic model, no real credentials or API costs.
// node test/fixtures/ui-host.mjs /absolute/path/to/xz-pi
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repo = resolve(process.argv[2] ?? "..");
const root = await mkdtemp(join(tmpdir(), "xz-ui-smoke-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace");
await mkdir(agentDir); await mkdir(cwd);
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const end = reason => { emit({}, reason); res.end("data: [DONE]\n\n"); };
  if (body.tools.some(t => t.function.name === "xz_subagents_run")) {
    if (body.messages.some(m => m.role === "tool")) { emit({ role: "assistant", content: "Main has received every child result." }); end("stop"); }
    else {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: "batch", type: "function", function: { name: "xz_subagents_run", arguments: JSON.stringify({ tasks: [{ name: "auth-scout", task: "Review authentication. Return a brief report.", skills: [] }, { name: "test-review", task: "Review test coverage. Return a brief report.", skills: [] }] }) } }] }); end("tool_calls");
    }
  } else {
    let i = 0;
    emit({ role: "assistant", content: "Starting delegated analysis…\n" });
    const timer = setInterval(() => {
      emit({ content: `Evidence ${++i}: inspecting fixture section.\n` });
      if (i >= 120) { clearInterval(timer); emit({ content: "Finished inspection." }); end("stop"); }
    }, 500);
    res.on("close", () => clearInterval(timer));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture", models: [{ id: "model" }] } } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [join(repo, "xz-pi-subagents"), join(repo, "xz-pi-vim")], enableInstallTelemetry: false }));
console.log(JSON.stringify({ root, agentDir, cwd }));
process.on("SIGTERM", async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); process.exit(); });
