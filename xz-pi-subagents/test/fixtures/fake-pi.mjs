import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
const config = JSON.parse(readFileSync(process.env.XZ_PI_SUBAGENT_CONFIG, "utf8"));
let input = "";
for await (const chunk of process.stdin) input += chunk;
const mode = input.split("\n")[1];
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
writeFileSync(join(dirname(process.env.XZ_PI_SUBAGENT_CONFIG), "pid"), String(process.pid));
if (mode === "crash") { process.stderr.write("fixture crash"); process.exit(3); }
if (mode !== "no-receipt") writeFileSync(`${process.env.XZ_PI_SUBAGENT_CONFIG}.ready.json`, JSON.stringify({ type: "xz_subagent_ready", tools: config.tools }));
// Even a matching-looking log line must not count as the private startup receipt.
if (mode === "no-receipt") emit({ type: "xz_subagent_ready", tools: config.tools });
emit({ type: "agent_start" });
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(join(dirname(process.env.XZ_PI_SUBAGENT_CONFIG), "grandchild-pid"), String(child.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "中文🙂\u2028result" } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "中文🙂\u2028result" }], stopReason: mode === "provider-error" ? "error" : "stop", errorMessage: mode === "provider-error" ? "provider failed" : undefined, usage: { input: 5, output: 3, cacheRead: 1 } } });
  if (mode !== "incomplete") emit({ type: "agent_end" });
}
