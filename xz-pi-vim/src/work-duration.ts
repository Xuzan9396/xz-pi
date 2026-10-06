export type WorkDurationScheduler = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type WorkDurationTimerOptions = {
  now?: () => number;
  scheduler?: WorkDurationScheduler;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 1_000;

const defaultScheduler: WorkDurationScheduler = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export function formatWorkDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}秒`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}分钟${seconds}秒`;
  return `${hours}小时${minutes}分钟${seconds}秒`;
}

export class WorkDurationTimer {
  private readonly now: () => number;
  private readonly scheduler: WorkDurationScheduler;
  private readonly intervalMs: number;
  private startedAt: number | null = null;
  private intervalHandle: unknown | null = null;

  constructor(
    private readonly onUpdate: (duration: string) => void,
    options: WorkDurationTimerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    this.clearInterval();
    this.startedAt = this.now();
    this.emitUpdate();
    this.intervalHandle = this.scheduler.setInterval(() => this.emitUpdate(), this.intervalMs);
  }

  settle(): void {
    if (this.startedAt === null) return;
    this.emitUpdate();
    this.startedAt = null;
    this.clearInterval();
  }

  dispose(): void {
    this.startedAt = null;
    this.clearInterval();
  }

  private emitUpdate(): void {
    if (this.startedAt === null) return;
    this.onUpdate(formatWorkDuration(this.now() - this.startedAt));
  }

  private clearInterval(): void {
    if (this.intervalHandle === null) return;
    this.scheduler.clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
}
