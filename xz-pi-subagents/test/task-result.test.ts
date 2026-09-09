import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskResult } from "../src/task-result.js";

test("structured task result parses the final valid protocol block", () => {
  const text = `Done.\n<!-- XZ_SUBAGENT_RESULT\n${JSON.stringify({
    status: "completed", summary: "implemented", changedFiles: ["src/a.ts"],
    commandsRun: [{ command: "npm test", exitCode: 0, summary: "passed" }],
    tests: [{ name: "unit", passed: true, evidence: "12 passed" }],
    findings: [{ severity: "low", description: "follow-up", file: "src/a.ts", line: 2 }],
    assumptions: [], blockers: [],
  })}\n-->`;
  const result = parseTaskResult(text);
  assert.equal(result?.summary, "implemented");
  assert.deepEqual(result?.changedFiles, ["src/a.ts"]);
  assert.equal(result?.commandsRun[0]?.exitCode, 0);
});

test("malformed or incomplete result blocks fail closed", () => {
  assert.equal(parseTaskResult("plain text"), undefined);
  assert.equal(parseTaskResult("<!-- XZ_SUBAGENT_RESULT\n{}\n-->"), undefined);
  assert.equal(parseTaskResult("<!-- XZ_SUBAGENT_RESULT\nnot-json\n-->"), undefined);
});
