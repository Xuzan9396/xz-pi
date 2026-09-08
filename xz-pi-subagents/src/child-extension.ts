import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV, type ChildConfig } from "./types.js";
import { delegationAllowed } from "./policy.js";

/** Explicitly loaded only in a spawned Pi process, never discovered as a package entry. */
export default function childPolicy(pi: ExtensionAPI): void {
  const file = process.env[CHILD_ENV];
  if (!file) throw new Error("Missing child launch configuration");
  const config = JSON.parse(readFileSync(file, "utf8")) as ChildConfig;
  if (!Array.isArray(config.tools) || config.tools.some(t => typeof t !== "string") || !Number.isInteger(config.parentPid) || config.parentPid < 1) {
    throw new Error("Invalid child launch configuration");
  }
  const allowed = new Set(config.tools);
  let ready = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  pi.on("session_start", (_event, ctx) => {
    timer = setInterval(() => {
      try { process.kill(config.parentPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        ctx.abort();
        ctx.shutdown();
        setTimeout(() => process.exit(1), 2000).unref();
        clearInterval(timer);
      }
    }, 1000);
    timer.unref();
  });
  pi.on("before_agent_start", () => {
    ready = false;
    rmSync(`${file}.ready.json`, { force: true });
    const active = new Set(pi.getActiveTools());
    const missing = [...allowed].filter(name => !active.has(name));
    if (missing.length) throw new Error(`Child tools unavailable: ${missing.join(", ")}. Check extension/MCP configuration and permissions.`);
    ready = true;
    // Pi redirects extension stdout to stderr in JSON mode. Use a private receipt
    // written before agent_start rather than mixing extension logs into the protocol.
    writeFileSync(`${file}.ready.json`, JSON.stringify({ type: "xz_subagent_ready", tools: [...active] }), { mode: 0o600 });
  });
  pi.on("tool_call", event => {
    if (!ready || !delegationAllowed(event.toolName, allowed)) return { block: true, reason: "Tool outside the delegated allowlist", terminate: true };
  });
  pi.on("session_shutdown", () => { clearInterval(timer); timer = undefined; });
}
