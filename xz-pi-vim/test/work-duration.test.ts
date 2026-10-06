import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkDuration, WorkDurationTimer, type WorkDurationScheduler } from "../src/work-duration.js";

test("work duration formats seconds, minutes, and hours", () => {
  assert.equal(formatWorkDuration(0), "0秒");
  assert.equal(formatWorkDuration(59_999), "59秒");
  assert.equal(formatWorkDuration(60_000), "1分钟0秒");
  assert.equal(formatWorkDuration(3_661_000), "1小时1分钟1秒");
});

test("work duration timer restarts, settles, and disposes one interval", () => {
  let now = 0;
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  const updates: string[] = [];
  const scheduler: WorkDurationScheduler = {
    setInterval(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      const numericHandle = handle as number;
      cleared.push(numericHandle);
      callbacks.delete(numericHandle);
    },
  };
  const timer = new WorkDurationTimer((duration) => updates.push(duration), {
    now: () => now,
    scheduler,
  });

  timer.start();
  now = 1_250;
  callbacks.get(1)?.();
  now = 2_000;
  timer.start();
  now = 4_500;
  timer.settle();
  timer.dispose();

  assert.deepEqual(updates, ["0秒", "1秒", "0秒", "2秒"]);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(callbacks.size, 0);
});
