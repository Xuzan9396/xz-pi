import { CustomEditor, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { TaskManager } from "./manager.js";
import { cleanText } from "./protocol.js";
import { isTerminal, type TaskRecord } from "./types.js";

export const STATUS_LABELS = {
  queued: "排队", running: "运行中", stopping: "正在停止", completed: "已完成", failed: "失败", cancelled: "已取消", timed_out: "超时",
};
const KEY = "xz-subagents";
const elapsed = (r: TaskRecord) => r.startedAt ? `${Math.max(0, Math.floor(((r.endedAt ?? Date.now()) - r.startedAt) / 1000))}s` : "—";
const oneLine = (text: string) => cleanText(text).replace(/\s+/g, " ");

/** Read-only compatibility adapter. Never replaces the user's editor (including xz-pi-vim). */
export function canEnterFleet(tui: TUI | undefined): boolean {
  if (!tui || tui.hasOverlay()) return false;
  const getter = (tui as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent;
  const walk = (nodes: Component[]): CustomEditor | undefined => {
    for (const node of nodes) {
      if (node instanceof CustomEditor && node.focused) return node;
      const children = (node as { children?: Component[] }).children;
      if (Array.isArray(children)) { const found = walk(children); if (found) return found; }
    }
    return undefined;
  };
  const focused = getter ? getter.call(tui) : walk(tui.children);
  if (!(focused instanceof CustomEditor) || !focused.focused || focused.getText() !== "") return false;
  // Pi has no public autocomplete-state getter. Read only this narrow known field;
  // on an unknown editor version, fail closed instead of stealing completion keys.
  if (!("autocompleteState" in focused) || Reflect.get(focused, "autocompleteState")) return false;
  const mode = (focused as CustomEditor & { getMode?: () => string }).getMode?.();
  return !mode || mode === "normal" || mode === "insert";
}

export class FleetView {
  private ctx?: ExtensionContext;
  private tui?: TUI;
  private unsubscribe?: () => void;
  private inputUnsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private mounted = false;
  private visible = true;
  private batchRecords?: readonly TaskRecord[];
  private autoHideHandled = false;
  private active = false;
  private selected: string | null = null;
  private armed?: { id: string; at: number };
  private closeDetail?: () => void;
  private detailId?: string;
  private detailOpening = false;
  constructor(private manager: TaskManager) {}

  attach(ctx: ExtensionContext): void {
    if (this.ctx === ctx) return;
    if (this.ctx) this.dispose();
    if (ctx.mode !== "tui") return;
    this.ctx = ctx;
    this.unsubscribe = this.manager.subscribe(() => this.refresh());
    this.inputUnsubscribe = ctx.ui.onTerminalInput(data => this.handleInput(data));
    this.refresh();
  }
  refresh(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const records = this.manager.records;
    if (this.batchRecords !== records) {
      this.batchRecords = records;
      this.visible = true; this.autoHideHandled = false;
      this.active = false; this.selected = null; this.armed = undefined;
    }
    if (this.selected && !records.some(r => r.id === this.selected)) this.selected = null;
    const readingThisBatch = !!this.detailId && records.some(r => r.id === this.detailId);
    if (this.detailId && !readingThisBatch) this.closeDetail?.();
    if (this.manager.batchCancelled && !this.manager.busy && !this.autoHideHandled) {
      this.autoHideHandled = true;
      // Do not dismiss a reader, or conceal a failure to verify process cleanup.
      if (!readingThisBatch && records.every(r => r.status !== "failed")) this.hide();
    }
    if (this.visible && !this.mounted && records.length) {
      this.mounted = true;
      ctx.ui.setWidget(KEY, (tui, theme) => {
        this.tui = tui;
        return { render: width => this.render(width, theme), invalidate: () => {} };
      }, { placement: "belowEditor" });
    }
    const ticking = this.manager.busy && (this.mounted || this.detailOpening);
    if (ticking && !this.timer) this.timer = setInterval(() => this.tui?.requestRender(), 200);
    if (!ticking && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.mounted || this.detailOpening) this.tui?.requestRender();
  }
  handleInput(data: string): { consume: true } | undefined {
    if (isKeyRelease(data) || this.detailOpening || this.closeDetail) return;
    if (!this.ctx || !this.manager.records.length || !canEnterFleet(this.tui)) {
      this.active = false; this.armed = undefined;
      return;
    }
    if (!this.active) {
      if (!matchesKey(data, "down")) return;
      this.visible = true; this.active = true; this.selected = null; this.armed = undefined;
    } else if (matchesKey(data, "escape")) {
      this.hide();
      return { consume: true };
    } else if (matchesKey(data, "down") || matchesKey(data, "up")) {
      const ids: (string | null)[] = [null, ...this.manager.records.map(r => r.id)];
      const index = ids.indexOf(this.selected);
      if (matchesKey(data, "up") && index <= 0) this.active = false;
      else this.selected = ids[Math.max(0, Math.min(ids.length - 1, index + (matchesKey(data, "down") ? 1 : -1)))] ?? null;
      this.armed = undefined;
    } else if (matchesKey(data, "enter")) {
      this.armed = undefined;
      const record = this.manager.records.find(r => r.id === this.selected);
      if (record) this.openDetail(record);
      else this.active = false;
    } else if (matchesKey(data, "x") && this.selected) {
      const record = this.manager.records.find(r => r.id === this.selected);
      if (record && !isTerminal(record.status)) {
        if (this.armed?.id === record.id && Date.now() - this.armed.at < 3000) {
          this.manager.cancel(record.id); this.armed = undefined;
        } else this.armed = { id: record.id, at: Date.now() };
      }
    } else {
      this.active = false; this.armed = undefined; this.tui?.requestRender();
      return; // Ordinary typing/Vim keys continue to the existing editor.
    }
    this.refresh();
    return { consume: true };
  }
  /** Hide presentation only. Retain the TUI handle for focus checks when ↓ reopens it. */
  private hide(): void {
    this.visible = false; this.active = false; this.armed = undefined;
    clearInterval(this.timer); this.timer = undefined;
    if (this.mounted) this.ctx?.ui.setWidget(KEY, undefined);
    this.mounted = false;
    this.tui?.requestRender();
  }
  render(width: number, theme: Theme): string[] {
    const records = this.manager.records;
    const finished = records.filter(r => isTerminal(r.status)).length;
    const lines = [theme.fg("dim", this.active ? "↑↓ 选择 · Enter 详情 · x 两次取消 · Esc 隐藏面板" : "↓ 查看子任务（空输入框）")];
    lines.push(`${this.active && !this.selected ? ">" : " "} main  ${this.manager.busy ? "等待子任务" : "本批次结束"} · ${finished}/${records.length}`);
    const maxRows = Math.max(1, Math.min(6, Math.floor((this.tui?.terminal.rows ?? 30) / 3)));
    const selectedIndex = records.findIndex(r => r.id === this.selected);
    const start = Math.max(0, Math.min(Math.max(0, records.length - maxRows), selectedIndex - maxRows + 1));
    if (start) lines.push(theme.fg("dim", `  ↑ ${start} more`));
    for (const record of records.slice(start, start + maxRows)) {
      const selected = this.active && record.id === this.selected;
      const state = STATUS_LABELS[record.status];
      const icon = record.status === "completed" ? "✓" : isTerminal(record.status) ? "!" : record.status === "queued" ? "○" : "●";
      const armed = selected && this.armed?.id === record.id && Date.now() - this.armed.at < 3000;
      const row = `${selected ? ">" : " "} ${icon} ${record.name}  ${state} · ${elapsed(record)} · ${record.tokens} tokens  ${armed ? "再按 x 确认取消" : oneLine(record.activity || record.task)}`;
      lines.push(theme.fg(selected ? "accent" : "muted", row));
    }
    if (start + maxRows < records.length) lines.push(theme.fg("dim", `  ↓ ${records.length - start - maxRows} more`));
    return lines.map(line => truncateToWidth(line, Math.max(0, width)));
  }
  private openDetail(record: TaskRecord): void {
    const ctx = this.ctx;
    if (!ctx || this.detailOpening) return;
    this.detailOpening = true; this.detailId = record.id;
    void ctx.ui.custom<void>((tui, theme, _kb, done) => {
      if (this.ctx !== ctx || !this.manager.records.includes(record)) { queueMicrotask(() => done()); return { render: () => [], invalidate: () => {} }; }
      this.closeDetail = () => done();
      return new DetailView(record, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), () => this.manager.cancel(record.id));
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "80%", anchor: "center" } }).catch(error => {
      if (this.ctx === ctx) ctx.ui.notify(`Cannot open task details: ${String(error)}`, "error");
    }).finally(() => {
      this.closeDetail = undefined; this.detailOpening = false; this.detailId = undefined;
      this.tui?.requestRender();
    });
  }
  dispose(): void {
    this.inputUnsubscribe?.(); this.unsubscribe?.();
    this.inputUnsubscribe = undefined; this.unsubscribe = undefined;
    this.closeDetail?.(); this.hide();
    this.ctx = undefined; this.tui = undefined; this.batchRecords = undefined;
    this.active = false; this.armed = undefined;
  }
}

export class DetailView implements Component {
  private offset = 0;
  private follow = true;
  private armedAt = 0;
  private maxOffset = 0;
  private pageSize = 10;
  constructor(
    private record: TaskRecord, private theme: Theme, private rows: () => number,
    private redraw: () => void, private close: () => void, private cancel: () => void,
  ) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) { this.close(); return; }
    if (matchesKey(data, "x") && !isTerminal(this.record.status)) {
      if (this.armedAt && Date.now() - this.armedAt < 3000) { this.cancel(); this.armedAt = 0; }
      else this.armedAt = Date.now();
      this.redraw(); return;
    }
    this.armedAt = 0;
    if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
      this.offset = Math.max(0, this.offset - (matchesKey(data, "up") ? 1 : this.pageSize)); this.follow = false;
    } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
      this.offset = Math.min(this.maxOffset, this.offset + (matchesKey(data, "down") ? 1 : this.pageSize)); this.follow = this.offset === this.maxOffset;
    } else if (matchesKey(data, "home")) { this.offset = 0; this.follow = false; }
    else if (matchesKey(data, "end")) this.follow = true;
    this.redraw();
  }
  render(width: number): string[] {
    if (width < 5) return [];
    const record = this.record;
    const inner = width - 4;
    const body = [
      `Task: ${record.task}`, `Operation: ${record.operation}`, `Isolation: ${record.isolation ?? "shared cwd"}`,
      `Model: ${record.model}`, `Artifacts: ${record.artifactDir ?? "Not started"}`,
      record.worktree ? `Integration: ${record.worktree.integration}\nPatch: ${record.worktree.patchPath}${record.worktree.integration === "conflict" || record.worktree.integration === "preserved" ? `\nPreserved worktree: ${record.worktree.worktreePath}` : ""}` : "",
      record.taskResult ? `Structured result: ${JSON.stringify(record.taskResult, null, 2)}` : "",
      "", record.transcript || "Waiting for output…", record.error ? `\nError: ${record.error}` : "",
    ].filter(Boolean).join("\n");
    const content = cleanText(body).replace(/\t/g, "  ").split("\n").flatMap(line => wrapTextWithAnsi(line || " ", inner));
    this.pageSize = Math.max(1, Math.floor(this.rows() * 0.7) - 4);
    this.maxOffset = Math.max(0, content.length - this.pageSize);
    this.offset = this.follow ? this.maxOffset : Math.min(this.offset, this.maxOffset);
    const header = this.theme.fg("accent", `${record.name} · ${STATUS_LABELS[record.status]} · ${elapsed(record)} · ${record.tokens} tokens`);
    const stop = !isTerminal(record.status) ? (this.armedAt && Date.now() - this.armedAt < 3000 ? "再按 x 确认取消" : "x 两次取消") : "任务已结束";
    const box = (text: string): string => {
      const line = truncateToWidth(text, inner);
      return `│ ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} │`;
    };
    const page = content.slice(this.offset, this.offset + this.pageSize);
    while (page.length < this.pageSize) page.push("");
    const lines = [
      `╭${"─".repeat(width - 2)}╮`, box(header), ...page.map(box),
      box(this.theme.fg("dim", `↑↓/PgUp/PgDn 滚动 · End 跟随 · ${stop} · Esc 返回`)),
      `╰${"─".repeat(width - 2)}╯`,
    ];
    return lines.map(line => this.theme.bg("toolPendingBg", truncateToWidth(line, width)));
  }
}
