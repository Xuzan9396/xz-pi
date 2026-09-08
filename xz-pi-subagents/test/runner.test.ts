import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ChildEvents, JsonLines, MAX_LINE_BYTES, cleanText } from "../src/protocol.js";
import { createRunner } from "../src/runner.js";
import { plan, record } from "./helpers.js";
const fake = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

test("LF decoder handles split UTF8, literal unicode line separators, noise and byte bounds", () => {
  const events: unknown[] = [];
  const parser = new JsonLines(event => events.push(event));
  const bytes = Buffer.from('noise\n{"text":"中文🙂\u2028\u2029ok"}\n{"last":true}');
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  parser.end(); assert.deepEqual(events, [{ text: "中文🙂\u2028\u2029ok" }, { last: true }]);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.alloc(MAX_LINE_BYTES + 1, 97)), /4 MiB/);
  assert.equal(cleanText("\x1b[2Jhello\x00\x1b]0;bad\x07"), "hello");
});

test("final error cannot reuse prior text and retries can produce a later successful result", () => {
  const r = record(); const events = new ChildEvents(r, ["read"]);
  events.accept({ type: "xz_subagent_ready", tools: ["read"] }); events.accept({ type: "agent_start" });
  events.accept({ type: "message_end", message: { role: "assistant", content: "earlier", stopReason: "toolUse" } });
  events.accept({ type: "message_start", message: { role: "assistant" } });
  events.accept({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } });
  events.accept({ type: "agent_end" }); assert.equal(r.output, ""); assert.equal(events.completionError(), "429");
  events.accept({ type: "agent_start" }); events.accept({ type: "message_start", message: { role: "assistant" } });
  events.accept({ type: "message_end", message: { role: "assistant", content: "recovered", stopReason: "stop" } });
  events.accept({ type: "agent_end" }); assert.equal(events.completionError(), undefined);
});

for (const [mode, status] of [["ok", "completed"], ["provider-error", "failed"], ["incomplete", "failed"], ["crash", "failed"], ["no-receipt", "failed"]] as const) {
  test(`subprocess ${mode}: terminal proof, artifacts and truthful outcome`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "xz-runner-test-")); t.after(() => rm(root, { recursive: true, force: true }));
    const r = record(); const p = plan(mode);
    const run = createRunner({ invocation: { command: process.execPath, args: [fake] }, tempRoot: root, killGraceMs: 50 });
    const result = await run(p, r, new AbortController().signal, () => {});
    assert.equal(result.status, status, result.error);
    assert.equal(await readFile(join(r.artifactDir!, "output.md"), "utf8"), result.output);
    if (process.platform !== "win32") assert.equal((await stat(join(r.artifactDir!, "events.jsonl"))).mode & 0o777, 0o600);
    if (mode === "ok") { assert.equal(result.output, "中文🙂\u2028result"); assert.equal(r.tokens, 9); }
  });
}

for (const cancel of [true, false]) {
  test(cancel ? "cancel kills a TERM-ignoring process tree" : "timeout is distinct from cancellation", { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "xz-runner-test-")); t.after(() => rm(root, { recursive: true, force: true }));
    const r = record(); const p = plan("hang"); p.timeoutMs = cancel ? 5000 : 250;
    const controller = new AbortController();
    const run = createRunner({ invocation: { command: process.execPath, args: [fake] }, tempRoot: root, killGraceMs: 100 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await run(p, r, controller.signal, () => {
      if (cancel && !timer && r.activity === "Thinking") timer = setTimeout(() => controller.abort(), 100);
    });
    clearTimeout(timer);
    assert.equal(result.status, cancel ? "cancelled" : "timed_out", result.error);
    const pid = Number(await readFile(join(r.artifactDir!, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
}

test("missing executable fails promptly", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xz-runner-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await createRunner({ invocation: { command: "/nonexistent/xz-pi", args: [] }, tempRoot: root })(plan(), record(), new AbortController().signal, () => {});
  assert.equal(result.status, "failed"); assert.match(result.error!, /Could not start/);
});
