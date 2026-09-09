import type { StructuredTaskResult } from "./types.js";

export const RESULT_PROTOCOL = `End your final response with exactly one machine-readable block:
<!-- XZ_SUBAGENT_RESULT
{"status":"completed|blocked|failed","summary":"short result","changedFiles":["path"],"commandsRun":[{"command":"...","exitCode":0,"summary":"..."}],"tests":[{"name":"...","passed":true,"evidence":"..."}],"findings":[{"severity":"high|medium|low","description":"...","file":"optional","line":1}],"assumptions":[],"blockers":[]}
-->
Use truthful empty arrays when a field does not apply. A blocked task must use status "blocked" and explain blockers.`;

const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function parseTaskResult(text: string): StructuredTaskResult | undefined {
  const matches = [...text.matchAll(/<!--\s*XZ_SUBAGENT_RESULT\s*\n([\s\S]*?)\n\s*-->/g)];
  const raw = matches.at(-1)?.[1];
  if (!raw || Buffer.byteLength(raw) > 64 * 1024) return;
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(raw)); } catch { return; }
  if (!value || !["completed", "blocked", "failed"].includes(String(value.status)) || typeof value.summary !== "string") return;
  const changedFiles = strings(value.changedFiles); const assumptions = strings(value.assumptions); const blockers = strings(value.blockers);
  if (!changedFiles || !assumptions || !blockers || !Array.isArray(value.commandsRun) || !Array.isArray(value.tests) || !Array.isArray(value.findings)) return;
  const commandsRun = value.commandsRun.map(object);
  const tests = value.tests.map(object);
  const findings = value.findings.map(object);
  if (commandsRun.some(item => !item || typeof item.command !== "string" || !Number.isInteger(item.exitCode) || typeof item.summary !== "string")) return;
  if (tests.some(item => !item || typeof item.name !== "string" || typeof item.passed !== "boolean" || typeof item.evidence !== "string")) return;
  if (findings.some(item => !item || !["high", "medium", "low"].includes(String(item.severity)) || typeof item.description !== "string" || (item.file !== undefined && typeof item.file !== "string") || (item.line !== undefined && !Number.isInteger(item.line)))) return;
  return {
    status: value.status as StructuredTaskResult["status"], summary: value.summary,
    changedFiles, assumptions, blockers,
    commandsRun: commandsRun.map(item => ({ command: item!.command as string, exitCode: item!.exitCode as number, summary: item!.summary as string })),
    tests: tests.map(item => ({ name: item!.name as string, passed: item!.passed as boolean, evidence: item!.evidence as string })),
    findings: findings.map(item => ({
      severity: item!.severity as "high" | "medium" | "low", description: item!.description as string,
      ...(typeof item!.file === "string" ? { file: item!.file } : {}), ...(typeof item!.line === "number" ? { line: item!.line } : {}),
    })),
  };
}
