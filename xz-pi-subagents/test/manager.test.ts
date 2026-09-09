import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskManager } from "../src/manager.js";
import type { RunOutcome, TaskRunner } from "../src/types.js";
import { deferred, plan, tick } from "./helpers.js";
const success = (output: string): RunOutcome => ({ status: "completed", output });

test("fanout enforces slots, joins ALL results in input order and isolates failures", async () => {
  const manager = new TaskManager();
  const gates = [deferred<RunOutcome>(), deferred<RunOutcome>(), deferred<RunOutcome>()];
  const starts: string[] = [];
  const runner: TaskRunner = async p => { starts.push(p.task.name); return gates[Number(p.task.name)]!.promise; };
  let settled = false;
  const batch = manager.run([plan("0"), plan("1"), plan("2")], 2, runner).then(r => { settled = true; return r; });
  await tick(); assert.deepEqual(starts, ["0", "1"]);
  gates[1]!.resolve({ status: "failed", error: "bad", output: "partial" });
  await tick(); assert.deepEqual(starts, ["0", "1", "2"]); assert.equal(settled, false);
  gates[2]!.resolve(success("two")); await tick(); assert.equal(settled, false);
  gates[0]!.resolve(success("zero"));
  assert.deepEqual((await batch).map(r => [r.name, r.status, r.output]), [["0", "completed", "zero"], ["1", "failed", "partial"], ["2", "completed", "two"]]);
  assert.equal(manager.busy, false);
});

test("explicit exclusive tasks wait for active work and block following tasks in either mode", async () => {
  const manager = new TaskManager();
  const gates = [deferred<RunOutcome>(), deferred<RunOutcome>(), deferred<RunOutcome>()];
  const starts: string[] = [];
  const exclusive = plan("1", "read"); exclusive.task.exclusive = true;
  const batch = manager.run([plan("0", "write"), exclusive, plan("2", "write")], 4, async p => { starts.push(p.task.name); return gates[Number(p.task.name)]!.promise; });
  await tick(); assert.deepEqual(starts, ["0"]);
  gates[0]!.resolve(success("0")); await tick(); assert.deepEqual(starts, ["0", "1"]);
  gates[1]!.resolve(success("1")); await tick(); assert.deepEqual(starts, ["0", "1", "2"]);
  gates[2]!.resolve(success("2")); await batch;
});

test("web/extension tasks in write mode run concurrently by default", async () => {
  const manager = new TaskManager();
  const gates = [deferred<RunOutcome>(), deferred<RunOutcome>()];
  const starts: string[] = [];
  const plans = [plan("0", "write"), plan("1", "write")];
  for (const p of plans) p.tools = ["web_search", "fetch_content"];
  const batch = manager.run(plans, 2, async p => { starts.push(p.task.name); return gates[Number(p.task.name)]!.promise; });
  await tick(); assert.deepEqual(starts, ["0", "1"]);
  assert.ok(manager.records.every(r => r.status === "running" && !r.exclusive));
  gates[0]!.resolve(success("first")); gates[1]!.resolve(success("second")); await batch;
});

test("batch cancellation intent remains visible after cleanup and resets for the next batch", async () => {
  const manager = new TaskManager(); const gate = deferred<RunOutcome>();
  const batch = manager.run([plan()], 1, () => gate.promise);
  await tick(); manager.cancelAll();
  assert.equal(manager.batchCancelled, true); assert.equal(manager.busy, true);
  assert.equal(manager.records[0]?.status, "stopping");
  gate.resolve({ status: "cancelled", output: "partial" }); await batch;
  assert.equal(manager.batchCancelled, true); assert.equal(manager.busy, false);
  await manager.run([plan("next")], 1, async () => success("ok"));
  assert.equal(manager.batchCancelled, false);
  manager.cancelAll(); assert.equal(manager.batchCancelled, false);
});

test("cancelling a queued task never launches it; cancelling one running task leaves siblings alive", async () => {
  const manager = new TaskManager();
  const starts: string[] = [];
  const second = deferred<RunOutcome>();
  const batch = manager.run([plan("a"), plan("b"), plan("c")], 2, (p, _r, signal) => {
    starts.push(p.task.name);
    return p.task.name === "b" ? second.promise : new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled", output: "partial" }), { once: true }));
  });
  await tick();
  manager.cancel(manager.records[2]!.id); manager.cancel(manager.records[0]!.id);
  await tick(); assert.deepEqual(starts, ["a", "b"]); assert.equal(manager.records[1]?.status, "running");
  second.resolve(success("ok"));
  assert.deepEqual((await batch).map(r => r.status), ["cancelled", "completed", "cancelled"]);
});

test("abort-before-start, parent abort, dispose and competing tool calls are bounded", async () => {
  const manager = new TaskManager();
  const pre = new AbortController(); pre.abort();
  const never: TaskRunner = async () => { throw new Error("must not launch"); };
  assert.equal((await manager.run([plan()], 1, never, pre.signal))[0]?.status, "cancelled");
  const abort = new AbortController(); let starts = 0;
  const batch = manager.run([plan("a"), plan("b")], 1, async (_p, _r, signal) => {
    starts++;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled", output: "" }), { once: true }));
  }, abort.signal);
  await tick(); await assert.rejects(manager.run([plan()], 1, never), /already running/);
  abort.abort(); await batch; assert.equal(starts, 1);
  await manager.dispose(); await manager.dispose();
  await assert.rejects(manager.run([plan()], 1, never), /shut down/);
});

test("main remains busy and waits for batch finalization after all children settle", async () => {
  const manager = new TaskManager(); const finalize = deferred<void>(); let finalized = false;
  const batch = manager.run([plan()], 1, async () => success("ok"), undefined, async () => { await finalize.promise; finalized = true; });
  await tick(); await tick();
  assert.equal(manager.busy, true); assert.equal(finalized, false);
  finalize.resolve(); await batch;
  assert.equal(finalized, true); assert.equal(manager.busy, false);
});

test("a throwing runner or UI listener cannot strand the batch", async () => {
  const manager = new TaskManager(); manager.subscribe(() => { throw new Error("UI failed"); });
  const records = await manager.run([plan("a"), plan("b")], 2, async () => { throw new Error("spawn failed"); });
  assert.deepEqual(records.map(r => r.status), ["failed", "failed"]);
});
