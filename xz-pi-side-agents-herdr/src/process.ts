import { execFile } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export function exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; allowFailure?: boolean } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout), stderr: String(stderr) };
      if (error && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || error.message}`));
      } else resolve(result);
    });
  });
}

export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> {
  return exec("git", ["-C", cwd, ...args], { signal });
}

export function parseJsonOutput<T>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${command} returned invalid JSON: ${stdout.slice(0, 500)}`);
  }
}
