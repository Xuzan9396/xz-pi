import type { LaunchPlan, Resources, TaskRecord } from "../src/types.js";
export const resources: Resources = {
  cwd: process.cwd(), agentDir: "/tmp/agent", model: "fixture/model", thinking: "off", trusted: false,
  tools: ["read", "grep", "find", "ls", "write", "edit", "bash", "mcp", "xz_subagents_run"], skills: [], extensions: [],
};
export function plan(name = "one", mode: "read" | "write" = "read"): LaunchPlan {
  return { task: { name, task: name, mode, operation: "general" }, resources, context: "", tools: ["read"], skillPaths: [] };
}
export function record(name = "one"): TaskRecord {
  return { id: name, name, task: name, mode: "read", operation: "general", exclusive: false, model: "fixture/model", status: "running", attempt: 1, activity: "", transcript: "", output: "", tokens: 0 };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
