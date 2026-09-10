import { execFile } from "node:child_process";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim();
        reject(new Error(`${error.message}${detail ? `\n${detail}` : ""}`));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
