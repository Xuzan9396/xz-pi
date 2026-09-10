import { randomUUID } from "node:crypto";
import { isTerminal, type LaunchPlan, type TaskRecord, type TaskRunner } from "./types.js";

/** One batch per main session. Tool access and explicit scheduling exclusivity are independent. */
export class TaskManager {
  records: TaskRecord[] = [];
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private current: Promise<TaskRecord[]> | undefined;
  private disposed = false;
  private cancelled = false;
  private pump: (() => void) | undefined;
  get busy(): boolean { return this.current !== undefined; }
  /** Cancellation intent persists through settlement so the UI can hide only after cleanup. */
  get batchCancelled(): boolean { return this.cancelled; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed = (): void => {
    for (const listener of this.listeners) { try { listener(); } catch { /* UI errors must not strand a batch */ } }
  };
  cancel(id: string): void {
    const record = this.records.find(r => r.id === id);
    if (!record || isTerminal(record.status)) return;
    if (record.status === "queued" || record.status === "paused" || record.status === "resuming") {
      record.status = "cancelled"; record.endedAt = Date.now(); record.activity = ""; record.error = "Cancelled before completion";
    } else record.status = "stopping";
    this.controllers.get(id)?.abort();
    this.changed();
    this.pump?.();
  }
  cancelAll(): void {
    if (this.current) this.cancelled = true;
    // Mark all tasks without a running process first: cancel() must not launch another task between cancellations.
    for (const record of this.records) {
      if (record.status === "queued" || record.status === "paused" || record.status === "resuming") {
        record.status = "cancelled"; record.endedAt = Date.now(); record.activity = ""; record.error = "Batch cancelled before completion";
      }
    }
    for (const record of this.records) this.cancel(record.id);
    this.changed();
    this.pump?.();
  }
  continueTask(id: string): boolean {
    if (!this.current || this.cancelled) return false;
    const record = this.records.find(r => r.id === id);
    if (!record || record.status !== "paused") return false;
    record.status = "resuming";
    record.activity = "Waiting to start a fresh Pi";
    record.error = undefined;
    this.changed();
    this.pump?.();
    return true;
  }
  async run(plans: LaunchPlan[], concurrency: number, runner: TaskRunner, signal?: AbortSignal, pauseOnFailure = false): Promise<TaskRecord[]> {
    if (this.disposed) throw new Error("Session has been shut down");
    if (this.current) throw new Error("A batch is already running. Submit parallel tasks together in one xz_subagents_run call.");
    if (!plans.length || concurrency < 1 || concurrency > 4 || !Number.isInteger(concurrency)) throw new Error("Invalid batch/concurrency");
    this.cancelled = false;
    this.records = plans.map(plan => ({
      id: randomUUID(), name: plan.task.name, task: plan.task.task, mode: plan.task.mode ?? "read",
      operation: plan.task.operation ?? "general", exclusive: plan.task.exclusive ?? false,
      model: plan.task.model ?? plan.resources.model, status: "queued", attempt: 0,
      activity: "", transcript: "", output: "", tokens: 0,
    }));
    const records = this.records;
    let resolveBatch!: (records: TaskRecord[]) => void;
    this.current = new Promise(resolve => { resolveBatch = resolve; });
    let active = 0;
    let exclusive = false;
    this.pump = () => {
      if (active === 0 && records.every(r => isTerminal(r.status))) { resolveBatch(records); return; }
      if (exclusive) return;
      while (active < concurrency) {
        const index = records.findIndex(r => r.status === "queued" || r.status === "resuming");
        if (index < 0) break;
        const record = records[index]!;
        if (record.exclusive && active > 0) break;
        const controller = new AbortController();
        this.controllers.set(record.id, controller);
        record.attempt++;
        record.status = "running"; record.startedAt = Date.now(); record.endedAt = undefined;
        record.activity = record.attempt > 1 ? `Starting fresh Pi (attempt ${record.attempt})` : "Starting Pi";
        record.output = ""; record.error = undefined; record.taskResult = undefined;
        active++;
        exclusive = record.exclusive;
        void Promise.resolve().then(() => runner(plans[index]!, record, controller.signal, this.changed)).then(outcome => {
          record.output = outcome.output; record.taskResult = outcome.taskResult;
          if (outcome.status === "failed" && pauseOnFailure && !controller.signal.aborted && !this.cancelled) {
            record.status = "paused"; record.error = outcome.error; record.lastError = outcome.error ?? "Child failed";
          } else {
            record.status = outcome.status; record.error = outcome.error;
            if (outcome.status === "failed") record.lastError = outcome.error ?? "Child failed";
          }
        }, error => {
          const message = String(error);
          if (!controller.signal.aborted && !this.cancelled && pauseOnFailure) {
            record.status = "paused"; record.error = message; record.lastError = message;
          } else {
            record.status = controller.signal.aborted ? "cancelled" : "failed"; record.error = message;
            if (!controller.signal.aborted) record.lastError = message;
          }
        }).finally(() => {
          record.endedAt = Date.now(); record.activity = "";
          this.controllers.delete(record.id);
          active--; if (record.exclusive) exclusive = false;
          this.changed(); this.pump?.();
        });
        if (exclusive) break;
      }
      this.changed();
    };
    const abort = () => this.cancelAll();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else this.pump();
    try {
      return await this.current;
    }
    finally {
      signal?.removeEventListener("abort", abort);
      this.current = undefined; this.pump = undefined; this.controllers.clear(); this.changed();
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelAll();
    await this.current;
    this.listeners.clear();
  }
}
