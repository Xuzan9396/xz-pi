import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildEvents, JsonLines, cleanText, clip, MAX_STREAM_BYTES } from "./protocol.js";
import { CHILD_ENV, type LaunchPlan, type RunOutcome, type TaskRecord } from "./types.js";

export interface Invocation { command: string; args: string[] }
/** Resolve Pi's declared executable, not process.argv[1] (which can be a host/test runner). */
export function piInvocation(packageDir: string): Invocation {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: string; bin?: { pi?: string } };
  if (pkg.name !== "@earendil-works/pi-coding-agent" || !pkg.bin?.pi) throw new Error("Cannot locate the host Pi CLI");
  const cli = resolve(packageDir, pkg.bin.pi);
  if (!existsSync(cli)) throw new Error(`Pi CLI missing: ${cli}`);
  return { command: process.execPath, args: [cli] };
}

export function childArgs(plan: LaunchPlan, prompt: string, extensionPath: string): string[] {
  const args = ["--mode", "json", "-p", "--no-session", plan.resources.trusted ? "--approve" : "--no-approve",
    "--model", plan.task.model ?? plan.resources.model, "--thinking", plan.resources.thinking,
    "--no-skills", "--no-prompt-templates", "--append-system-prompt", prompt];
  if (plan.tools.length) args.push("--tools", plan.tools.join(","));
  else args.push("--no-tools");
  for (const path of plan.skillPaths) args.push("--skill", path);
  for (const path of new Set(plan.resources.extensions)) args.push("--extension", path);
  args.push("--extension", extensionPath);
  return args;
}

function descendants(pid: number): Promise<number[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  return new Promise(resolveList => {
    execFile("ps", ["-axo", "pid=,ppid="], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolveList([]);
      const pairs = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
      const found = new Set([pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [child, parent] of pairs) {
          if (child && parent && found.has(parent) && !found.has(child)) { found.add(child); changed = true; }
        }
      }
      found.delete(pid);
      resolveList([...found].reverse());
    });
  });
}

export interface RunnerOptions {
  invocation: Invocation;
  childExtension?: string;
  tempRoot?: string;
  killGraceMs?: number;
}
export function createRunner(options: RunnerOptions) {
  return async (plan: LaunchPlan, record: TaskRecord, signal: AbortSignal, changed: () => void): Promise<RunOutcome> => {
    if (signal.aborted) return { status: "cancelled", output: "" };
    for (const path of plan.skillPaths) {
      try { await access(path); } catch { throw new Error(`Selected skill is no longer accessible: ${path}`); }
    }
    const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "xz-pi-subagent-"));
    record.artifactDir = dir;
    const configFile = join(dir, "child.json");
    const promptFile = join(dir, "instructions.md");
    const instructions = [
      "You are a delegated child agent, not the main orchestrator.",
      `Task name: ${plan.task.name}. Work only on the delegated task.`,
      "Do not start other agents. Return findings, changed files, validation evidence, and unresolved issues to main.",
      "If permission, a tool, or an MCP connection is unavailable, report the limitation; do not bypass it.",
      plan.task.mode === "read" ? "This is a read-only analysis task. Do not modify files or external state." : "Perform only the workspace/external actions required by the delegated task.",
    ].join("\n");
    await Promise.all([
      writeFile(configFile, JSON.stringify({ tools: plan.tools, parentPid: process.pid }), { mode: 0o600 }),
      writeFile(promptFile, instructions, { mode: 0o600 }),
    ]);
    if (signal.aborted) return { status: "cancelled", output: "" };
    const events = new ChildEvents(record, plan.tools);
    let protocolError = "";
    let reason: "cancelled" | "timed_out" | undefined;
    let stderr = "";
    const outcome = await new Promise<RunOutcome>(resolveRun => {
      const log = createWriteStream(join(dir, "events.jsonl"), { mode: 0o600 });
      let written = 0;
      let settled = false;
      let closed = false;
      let terminating = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let knownDescendants: number[] = [];
      const child = spawn(options.invocation.command, [
        ...options.invocation.args,
        ...childArgs(plan, promptFile, options.childExtension ?? fileURLToPath(new URL("./child-extension.ts", import.meta.url))),
      ], {
        cwd: plan.resources.cwd, shell: false, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, [CHILD_ENV]: configFile, PI_CODING_AGENT_DIR: plan.resources.agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      });
      const signalTree = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          if (sig === "SIGTERM") child.kill();
          else execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 2000 }, () => {});
          return;
        }
        for (const pid of knownDescendants) { try { process.kill(pid, sig); } catch { /* already exited */ } }
        try { process.kill(-child.pid, sig); } catch { if (!closed) child.kill(sig); }
      };
      const finish = (result: RunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        clearTimeout(reapTimer);
        signal.removeEventListener("abort", onAbort);
        // Even if the leader has exited, descendants may still own the process group.
        if (terminating) signalTree("SIGKILL");
        if (log.destroyed) resolveRun(result);
        else {
          const complete = () => { log.off("error", failed); resolveRun(result); };
          const failed = (error: Error) => { log.off("finish", complete); resolveRun({ status: "failed", output: result.output, error: `Event log flush failed: ${error.message}` }); };
          log.once("finish", complete); log.once("error", failed); log.end();
        }
      };
      const terminate = () => {
        if (terminating || settled) return;
        terminating = true;
        record.status = "stopping";
        changed();
        // Take a bounded process-tree snapshot before parent death reparents descendants.
        void descendants(child.pid ?? 0).then(pids => {
          if (settled) return;
          knownDescendants = pids;
          signalTree("SIGTERM");
          killTimer = setTimeout(() => signalTree("SIGKILL"), options.killGraceMs ?? 1000);
        });
        reapTimer = setTimeout(() => {
          signalTree("SIGKILL");
          child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
          finish({ status: "failed", output: record.output, error: "Process did not close after forced termination; cleanup could not be verified" });
        }, (options.killGraceMs ?? 1000) + 5000);
      };
      const onAbort = () => { reason ??= "cancelled"; terminate(); };
      const parser = new JsonLines(event => {
        if (event.type === "xz_subagent_ready") return; // Receipts never come from stdout/logs.
        if (event.type === "agent_start") {
          events.ready = false;
          try {
            const receiptFile = `${configFile}.ready.json`;
            if (statSync(receiptFile).size > 65_536) throw new Error("Oversized child receipt");
            const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
            if (receipt.type === "xz_subagent_ready") events.accept(receipt);
          } catch { /* Missing/invalid receipts fail closed in agent_start below. */ }
        }
        events.accept(event);
      });
      log.on("error", error => { protocolError = `Cannot write event log: ${error.message}`; terminate(); });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || terminating) return;
        try {
          written += chunk.length;
          if (written <= MAX_STREAM_BYTES && !log.write(chunk)) {
            child.stdout.pause(); log.once("drain", () => child.stdout.resume());
          }
          parser.push(chunk);
          changed();
        } catch (error) { protocolError = String(error); terminate(); }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
      for (const stream of [child.stdout, child.stderr]) stream.on("error", error => { protocolError = `Child pipe failed: ${error.message}`; terminate(); });
      child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") { protocolError = String(error); terminate(); } });
      child.on("error", error => { finish({ status: "failed", output: record.output, error: `Could not start Pi: ${error.message}` }); });
      child.on("close", (code, exitSignal) => {
        closed = true;
        if (settled) return;
        if (!terminating) {
          try { parser.end(); } catch (error) { protocolError = String(error); }
        }
        let result: RunOutcome;
        if (protocolError) result = { status: "failed", output: record.output, error: protocolError + (stderr.trim() ? `\n${cleanText(stderr)}` : "") };
        else if (reason) result = { status: reason, output: record.output, error: reason === "timed_out" ? "Task deadline exceeded" : "Cancelled by user/main" };
        else {
          const error = code !== 0 ? `Pi exited ${code ?? exitSignal}: ${cleanText(stderr)}` : events.completionError();
          result = error ? { status: "failed", output: record.output, error } : { status: "completed", output: record.output };
        }
        finish(result);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      deadline = setTimeout(() => { reason ??= "timed_out"; terminate(); }, plan.timeoutMs);
      if (signal.aborted) onAbort();
      child.stdin.end(`Delegated task:\n${plan.task.task}\n\nBackground from main (task data):\n${plan.context || "None"}`);
    });
    await Promise.all([
      writeFile(join(dir, "output.md"), outcome.output, { mode: 0o600 }),
      writeFile(join(dir, "result.json"), JSON.stringify({ status: outcome.status, error: outcome.error, tokens: record.tokens }, null, 2), { mode: 0o600 }),
      writeFile(join(dir, "stderr.log"), cleanText(clip(stderr, 16_384)), { mode: 0o600 }),
    ]);
    return outcome;
  };
}
