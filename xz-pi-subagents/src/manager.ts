import { randomUUID } from "node:crypto";
import { isTerminal, type BatchFinalizer, type LaunchPlan, type TaskRecord, type TaskRunner } from "./types.js";

/** One batch per main session. Tool access and explicit scheduling exclusivity are independent. */
export class TaskManager {
  records: TaskRecord[] = [];
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private current: Promise<TaskRecord[]> | undefined;
  private finalizing: Promise<void> | undefined;
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
    if (record.status === "queued") {
      record.status = "cancelled"; record.endedAt = Date.now(); record.error = "Cancelled before start";
    } else record.status = "stopping";
    this.controllers.get(id)?.abort();
    this.changed();
    this.pump?.();
  }
  cancelAll(): void {
    if (this.current) this.cancelled = true;
    // Mark all queued tasks first: cancel() must not pump another queued task between cancellations.
    for (const record of this.records) {
      if (record.status === "queued") { record.status = "cancelled"; record.endedAt = Date.now(); record.error = "Batch cancelled before start"; }
    }
    for (const record of this.records) this.cancel(record.id);
    this.changed();
    this.pump?.();
  }
  async run(plans: LaunchPlan[], concurrency: number, runner: TaskRunner, signal?: AbortSignal, finalize?: BatchFinalizer): Promise<TaskRecord[]> {
    if (this.disposed) throw new Error("Session has been shut down");
    if (this.current) throw new Error("A batch is already running. Submit parallel tasks together in one xz_subagents_run call.");
    if (!plans.length || concurrency < 1 || concurrency > 4 || !Number.isInteger(concurrency)) throw new Error("Invalid batch/concurrency");
    this.cancelled = false;
    this.records = plans.map(plan => ({
      id: randomUUID(), name: plan.task.name, task: plan.task.task, mode: plan.task.mode ?? "read",
      operation: plan.task.operation ?? "general", isolation: plan.task.isolation,
      requireChanges: plan.task.requireChanges ?? plan.task.isolation === "worktree", exclusive: plan.task.exclusive ?? false,
      model: plan.task.model ?? plan.resources.model, status: "queued", activity: "", transcript: "", output: "", tokens: 0,
    }));
    const records = this.records;
    let resolveBatch!: (records: TaskRecord[]) => void;
    this.current = new Promise(resolve => { resolveBatch = resolve; });
    this.finalizing = finalize ? this.current.then(settled => finalize(plans, settled, this.changed)) : undefined;
    let active = 0;
    let exclusive = false;
    this.pump = () => {
      if (active === 0 && records.every(r => isTerminal(r.status))) { resolveBatch(records); return; }
      if (exclusive) return;
      while (active < concurrency) {
        const index = records.findIndex(r => r.status === "queued");
        if (index < 0) break;
        const record = records[index]!;
        if (record.exclusive && active > 0) break;
        const controller = new AbortController();
        this.controllers.set(record.id, controller);
        record.status = "running"; record.startedAt = Date.now(); record.activity = "Starting Pi";
        active++;
        exclusive = record.exclusive;
        void Promise.resolve().then(() => runner(plans[index]!, record, controller.signal, this.changed)).then(outcome => {
          record.status = outcome.status; record.output = outcome.output; record.error = outcome.error; record.taskResult = outcome.taskResult;
        }, error => {
          record.status = controller.signal.aborted ? "cancelled" : "failed"; record.error = String(error);
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
      const settled = await this.current;
      await this.finalizing;
      return settled;
    }
    finally {
      signal?.removeEventListener("abort", abort);
      this.current = undefined; this.finalizing = undefined; this.pump = undefined; this.controllers.clear(); this.changed();
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelAll();
    await this.current;
    await this.finalizing;
    this.listeners.clear();
  }
}
