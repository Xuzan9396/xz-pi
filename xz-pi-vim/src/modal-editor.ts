import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripSoftwareCursorWhenHardwareCursorIsUsed } from "./cursor-shape.js";
import { parseExCommand } from "./ex-command.js";
import { isBackspaceInput, isCtrlRInput, isDigit, isEnterInput, isEscapeInput, isPrintableInput } from "./input-keys.js";
import { clampCursor, cursorToOffset, graphemeEndAt, graphemeStartBefore, lineStartOffsets, moveByMotion, offsetToCursor, rangeForMotion } from "./motions.js";
import { EMPTY_REGISTER, normalizeRegister } from "./registers.js";
import type { ActiveMode, CursorPosition, EditorSnapshot, MotionKey, PendingOperator, TextRange, VimMode, VimRegister } from "./types.js";
import { characterSelectionRange, lineSelectionRange } from "./visual-selection.js";

type ConstructorArgs = ConstructorParameters<typeof CustomEditor>;
type ThemeLike = ConstructorArgs[1] & { fg?: (name: string, text: string) => string };
type TuiLike = ConstructorArgs[0] & { requestRender(): void };

type MutableEditorInternals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  preferredVisualCol?: number | null;
  lastAction?: string | null;
  onChange?: (text: string) => void;
};

export type XzModalEditorOptions = {
  startInNormal?: boolean;
  cursorShape?: boolean;
  modeColors?: boolean;
  exCommand?: boolean;
};

const MOTION_KEYS = new Set<MotionKey>(["h", "j", "k", "l", "0", "^", "$", "w", "b", "e", "G"]);
const MAX_HISTORY = 200;

export class XzModalEditor extends CustomEditor {
  private mode: VimMode;
  private countPrefix = "";
  private operatorCount = "";
  private pendingOperator: PendingOperator | null = null;
  private pendingG = false;
  private visualAnchor: CursorPosition | null = null;
  private register: VimRegister = EMPTY_REGISTER;
  private undoHistory: EditorSnapshot[] = [];
  private redoHistory: EditorSnapshot[] = [];
  private insertSessionStart: EditorSnapshot | null;
  private pendingExCommand: string | null = null;
  private notifyFn: (message: string) => void = () => {};
  private quitFn: () => void = () => {};
  private commandNamesFn: () => ReadonlySet<string> = () => new Set();
  private modeChangeFn: (mode: ActiveMode) => void = () => {};
  private readonly themeRef: ThemeLike;
  private readonly tuiRef: TuiLike;
  private readonly cursorShapeEnabled: boolean;
  private readonly modeColorsEnabled: boolean;
  private readonly exCommandEnabled: boolean;

  constructor(tui: ConstructorArgs[0], theme: ConstructorArgs[1], keybindings: ConstructorArgs[2], options: XzModalEditorOptions = {}) {
    super(tui, theme, keybindings);
    this.tuiRef = tui as TuiLike;
    this.themeRef = theme as ThemeLike;
    this.cursorShapeEnabled = options.cursorShape ?? false;
    this.modeColorsEnabled = options.modeColors ?? true;
    this.exCommandEnabled = options.exCommand ?? true;
    this.mode = options.startInNormal ? "normal" : "insert";
    this.insertSessionStart = this.mode === "insert" ? this.captureSnapshot() : null;
  }

  getMode(): ActiveMode {
    return this.pendingExCommand !== null ? "ex" : this.mode;
  }

  getRegister(): VimRegister {
    return { ...this.register };
  }

  setNotifyFn(fn: (message: string) => void): void {
    this.notifyFn = fn;
  }

  setQuitFn(fn: () => void): void {
    this.quitFn = fn;
  }

  setCommandNamesFn(fn: () => ReadonlySet<string>): void {
    this.commandNamesFn = fn;
  }

  setModeChangeFn(fn: (mode: ActiveMode) => void): void {
    this.modeChangeFn = fn;
    fn(this.getMode());
  }

  override handleInput(data: string): void {
    if (isEscapeInput(data)) {
      this.handleEscape(data);
      return;
    }
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }
    if (this.pendingExCommand !== null) {
      this.handleExInput(data);
      return;
    }
    if (this.pendingG) {
      this.handlePendingG(data);
      return;
    }
    if (this.pendingOperator) {
      this.handlePendingOperator(data);
      return;
    }
    if (this.mode === "visual" || this.mode === "visual-line") {
      if (this.handleVisualInput(data)) return;
    }
    this.handleNormalInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.cursorShapeEnabled) stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    if (lines.length === 0 || width <= 0) return lines;
    const label = this.colorModeLabel(this.buildModeLabel());
    const lastIndex = lines.length - 1;
    const current = lines[lastIndex] ?? "";
    const available = Math.max(0, width - visibleWidth(label));
    lines[lastIndex] = truncateToWidth(current, available, "") + label;
    return lines;
  }

  private handleEscape(data: string): void {
    if (this.pendingExCommand !== null) {
      this.pendingExCommand = null;
      this.resetPending();
      this.emitModeChange();
      return;
    }
    if (this.mode === "insert") {
      this.finishInsertSession();
      const cursor = this.getCursor();
      const line = this.getLines()[cursor.line] ?? "";
      this.setCursor({ line: cursor.line, col: graphemeStartBefore(line, cursor.col) }, false);
      this.setMode("normal");
      return;
    }
    if (this.mode === "visual" || this.mode === "visual-line") {
      this.visualAnchor = null;
      this.resetPending();
      this.setMode("normal");
      return;
    }
    if (this.pendingOperator || this.pendingG || this.countPrefix || this.operatorCount) {
      this.resetPending();
      this.requestRender();
      return;
    }
    super.handleInput(data);
  }

  private handleNormalInput(data: string): void {
    if (isCtrlRInput(data)) {
      this.performRedo();
      return;
    }
    if (isDigit(data) && (data !== "0" || this.countPrefix.length > 0)) {
      this.countPrefix = this.appendCount(this.countPrefix, data);
      this.requestRender();
      return;
    }
    if (MOTION_KEYS.has(data as MotionKey)) {
      this.move(data as MotionKey, this.takeCount());
      return;
    }

    switch (data) {
      case "g":
        this.pendingG = true;
        this.requestRender();
        return;
      case "i":
        this.enterInsert(this.captureSnapshot());
        return;
      case "a":
        this.moveInsertionPointAfterCursor();
        this.enterInsert(this.captureSnapshot());
        return;
      case "I":
        this.moveToFirstNonWhitespaceForInsert();
        this.enterInsert(this.captureSnapshot());
        return;
      case "A":
        this.moveToLineEndForInsert();
        this.enterInsert(this.captureSnapshot());
        return;
      case "o":
        this.openLine(true);
        return;
      case "O":
        this.openLine(false);
        return;
      case "v":
        this.visualAnchor = this.getCursor();
        this.setMode("visual");
        return;
      case "V":
        this.visualAnchor = this.getCursor();
        this.setMode("visual-line");
        return;
      case "d":
      case "c":
      case "y":
        this.pendingOperator = data;
        this.operatorCount = this.countPrefix;
        this.countPrefix = "";
        this.requestRender();
        return;
      case "x":
        this.deleteCharacters(false, this.takeCount());
        return;
      case "X":
        this.deleteCharacters(true, this.takeCount());
        return;
      case "D":
        this.applyOperator("d", "$", this.takeCount());
        return;
      case "C":
        this.applyOperator("c", "$", this.takeCount());
        return;
      case "s":
        this.substituteCharacters(this.takeCount());
        return;
      case "S":
        this.changeLines(this.takeCount());
        return;
      case "p":
        this.putRegister(true, this.takeCount());
        return;
      case "P":
        this.putRegister(false, this.takeCount());
        return;
      case "J":
        this.joinLines(this.takeCount());
        return;
      case "u":
        this.takeCount();
        this.performUndo();
        return;
      case ":":
        if (this.exCommandEnabled) {
          this.pendingExCommand = ":";
          this.emitModeChange();
        }
        return;
      default:
        this.takeCount();
        if (!isPrintableInput(data)) super.handleInput(data);
    }
  }

  private handlePendingG(data: string): void {
    if (data === "g") {
      if (this.pendingOperator) {
        const operator = this.pendingOperator;
        const count = this.takeOperatorCount();
        this.resetPending();
        this.applyOperator(operator, "g", count);
      } else {
        const count = this.takeCount();
        this.pendingG = false;
        this.move("g", count);
      }
      return;
    }
    this.pendingG = false;
    if (this.pendingOperator) this.pendingOperator = null;
    this.countPrefix = "";
    this.operatorCount = "";
    this.requestRender();
  }

  private handlePendingOperator(data: string): void {
    const operator = this.pendingOperator;
    if (!operator) return;
    if (isDigit(data) && (data !== "0" || this.operatorCount.length > 0)) {
      this.countPrefix = this.appendCount(this.countPrefix, data);
      this.requestRender();
      return;
    }
    if (data === operator) {
      const count = this.takeOperatorCount();
      this.resetPending();
      this.applyLineOperator(operator, count);
      return;
    }
    if (data === "g") {
      this.pendingG = true;
      return;
    }
    if (MOTION_KEYS.has(data as MotionKey)) {
      const count = this.takeOperatorCount();
      this.resetPending();
      this.applyOperator(operator, data as MotionKey, count);
      return;
    }
    this.resetPending();
    this.requestRender();
  }

  private handleVisualInput(data: string): boolean {
    if (data === "v") {
      if (this.mode === "visual") {
        this.visualAnchor = null;
        this.setMode("normal");
      } else {
        this.setMode("visual");
      }
      return true;
    }
    if (data === "V") {
      if (this.mode === "visual-line") {
        this.visualAnchor = null;
        this.setMode("normal");
      } else {
        this.setMode("visual-line");
      }
      return true;
    }
    if (data === "d" || data === "x" || data === "y" || data === "c") {
      this.applyVisualOperator(data === "x" ? "d" : data);
      return true;
    }
    if (isDigit(data) && (data !== "0" || this.countPrefix.length > 0)) {
      this.countPrefix = this.appendCount(this.countPrefix, data);
      this.requestRender();
      return true;
    }
    if (MOTION_KEYS.has(data as MotionKey)) {
      this.move(data as MotionKey, this.takeCount());
      return true;
    }
    if (data === "g") {
      this.pendingG = true;
      return true;
    }
    return isPrintableInput(data);
  }

  private handleExInput(data: string): void {
    if (isEnterInput(data)) {
      const command = this.pendingExCommand ?? ":";
      this.pendingExCommand = null;
      this.submitExCommand(command);
      this.emitModeChange();
      return;
    }
    if (isBackspaceInput(data)) {
      const current = this.pendingExCommand ?? ":";
      this.pendingExCommand = current.length <= 1 ? null : current.slice(0, -1);
      this.emitModeChange();
      return;
    }
    if (isPrintableInput(data)) {
      this.pendingExCommand = `${this.pendingExCommand ?? ":"}${data.split("\n", 1)[0] ?? ""}`;
      this.requestRender();
    }
  }

  private submitExCommand(input: string): void {
    const parsed = parseExCommand(input, this.commandNamesFn());
    if (parsed.kind === "cancel") return;
    if (parsed.kind === "unsupported") {
      this.notifyFn(`不支持的 EX 命令：${parsed.input}`);
      return;
    }
    if (parsed.kind === "quit") {
      if (!parsed.force && this.getText().trim().length > 0) {
        this.notifyFn("输入区非空；使用 :q! 强制退出。");
        return;
      }
      this.quitFn();
      return;
    }
    if (parsed.kind === "shell") {
      this.dispatchHostInput(`${parsed.excludeFromContext ? "!!" : "!"}${parsed.command}`);
      return;
    }
    this.dispatchHostInput(`/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`);
  }

  private dispatchHostInput(line: string): void {
    const snapshot = this.captureSnapshot();
    this.writeState(line, { line: 0, col: line.length });
    try {
      this.onSubmit?.(line);
    } finally {
      this.restoreSnapshot(snapshot);
    }
  }

  private move(motion: MotionKey, count: number): void {
    this.setCursor(moveByMotion(this.getText(), this.getCursor(), motion, count), false);
  }

  private applyOperator(operator: PendingOperator, motion: MotionKey, count: number): void {
    const range = rangeForMotion(this.getText(), this.getCursor(), motion, count);
    if (operator === "y") {
      this.yankRange(range);
      this.setCursor(moveByMotion(this.getText(), this.getCursor(), motion, count), false);
      return;
    }
    this.deleteOrChangeRange(range, operator === "c");
  }

  private applyLineOperator(operator: PendingOperator, count: number): void {
    const range = this.currentLineRange(count);
    if (operator === "y") {
      this.yankRange(range);
      return;
    }
    this.deleteOrChangeRange(range, operator === "c");
  }

  private applyVisualOperator(operator: PendingOperator): void {
    const anchor = this.visualAnchor ?? this.getCursor();
    const range = this.mode === "visual-line"
      ? lineSelectionRange(this.getText(), anchor, this.getCursor())
      : characterSelectionRange(this.getText(), anchor, this.getCursor());
    this.visualAnchor = null;
    if (operator === "y") {
      this.yankRange(range);
      this.setMode("normal");
      return;
    }
    this.deleteOrChangeRange(range, operator === "c");
  }

  private deleteOrChangeRange(range: TextRange, change: boolean): void {
    if (range.end <= range.start) {
      if (change) this.enterInsert(this.captureSnapshot());
      return;
    }
    const before = this.captureSnapshot();
    const text = this.getText();
    const removed = text.slice(range.start, range.end);
    this.register = normalizeRegister(removed, range.linewise ? "line" : "character");
    let nextText = text.slice(0, range.start) + text.slice(range.end);
    if (range.linewise && range.start === 0) nextText = nextText.replace(/^\n/, "");
    if (range.linewise && range.end === text.length && nextText.endsWith("\n")) nextText = nextText.slice(0, -1);
    const nextCursor = clampCursor(nextText, offsetToCursor(nextText, Math.min(range.start, nextText.length)), change);
    if (change) {
      this.writeState(nextText, nextCursor, true);
      this.enterInsert(before);
    } else {
      this.commitMutation(before, nextText, nextCursor);
      this.visualAnchor = null;
      this.setMode("normal");
    }
  }

  private yankRange(range: TextRange): void {
    if (range.end <= range.start) return;
    this.register = normalizeRegister(this.getText().slice(range.start, range.end), range.linewise ? "line" : "character");
    this.resetPending();
    this.requestRender();
  }

  private deleteCharacters(backward: boolean, count: number): void {
    const text = this.getText();
    const cursorOffset = cursorToOffset(text, this.getCursor());
    let start = cursorOffset;
    let end = cursorOffset;
    for (let index = 0; index < count; index++) {
      if (backward) start = graphemeStartBefore(text, start);
      else end = graphemeEndAt(text, end);
    }
    if (backward) end = cursorOffset;
    this.deleteOrChangeRange({ start, end }, false);
  }

  private substituteCharacters(count: number): void {
    const text = this.getText();
    const start = cursorToOffset(text, this.getCursor());
    let end = start;
    for (let index = 0; index < count; index++) end = graphemeEndAt(text, end);
    this.deleteOrChangeRange({ start, end }, true);
  }

  private changeLines(count: number): void {
    this.deleteOrChangeRange(this.currentLineRange(count), true);
  }

  private currentLineRange(count: number): TextRange {
    const text = this.getText();
    const starts = lineStartOffsets(text);
    const line = this.getCursor().line;
    return {
      start: starts[line] ?? 0,
      end: starts[Math.min(line + count, starts.length)] ?? text.length,
      linewise: true,
    };
  }

  private putRegister(after: boolean, count: number): void {
    if (!this.register.text) return;
    const before = this.captureSnapshot();
    let text = this.getText();
    let offset: number;
    const repeated = this.register.text.repeat(count);
    if (this.register.kind === "line") {
      const starts = lineStartOffsets(text);
      const line = this.getCursor().line;
      if (after) {
        offset = starts[line + 1] ?? text.length;
        const insertingAtEnd = offset === text.length;
        const prefix = insertingAtEnd && text.length > 0 && !text.endsWith("\n") ? "\n" : "";
        const payload = insertingAtEnd ? repeated.replace(/\n$/, "") : repeated;
        text = text.slice(0, offset) + prefix + payload + text.slice(offset);
        offset += prefix.length;
      } else {
        offset = starts[line] ?? 0;
        text = text.slice(0, offset) + repeated + text.slice(offset);
      }
    } else {
      const cursorOffset = cursorToOffset(text, this.getCursor());
      offset = after ? graphemeEndAt(text, cursorOffset) : cursorOffset;
      text = text.slice(0, offset) + repeated + text.slice(offset);
    }
    this.commitMutation(before, text, clampCursor(text, offsetToCursor(text, offset)));
  }

  private joinLines(count: number): void {
    const before = this.captureSnapshot();
    const lines = this.getLines();
    const cursor = this.getCursor();
    let joins = Math.max(1, count);
    while (joins > 0 && cursor.line + 1 < lines.length) {
      const left = lines[cursor.line] ?? "";
      const right = (lines[cursor.line + 1] ?? "").trimStart();
      lines.splice(cursor.line, 2, `${left.replace(/\s+$/, "")} ${right}`);
      joins--;
    }
    const text = lines.join("\n");
    this.commitMutation(before, text, clampCursor(text, cursor));
  }

  private openLine(below: boolean): void {
    const before = this.captureSnapshot();
    const lines = this.getLines();
    const cursor = this.getCursor();
    const targetLine = below ? cursor.line + 1 : cursor.line;
    lines.splice(targetLine, 0, "");
    this.writeState(lines.join("\n"), { line: targetLine, col: 0 });
    this.enterInsert(before);
  }

  private moveInsertionPointAfterCursor(): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    this.setCursor({ line: cursor.line, col: graphemeEndAt(line, cursor.col) }, true);
  }

  private moveToFirstNonWhitespaceForInsert(): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    this.setCursor(moveByMotion(this.getText(), cursor, "^"), true);
    if (!line) this.setCursor({ line: cursor.line, col: 0 }, true);
  }

  private moveToLineEndForInsert(): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    this.setCursor({ line: cursor.line, col: line.length }, true);
  }

  private enterInsert(startSnapshot: EditorSnapshot): void {
    this.insertSessionStart = startSnapshot;
    this.resetPending();
    this.setMode("insert");
  }

  private finishInsertSession(): void {
    const start = this.insertSessionStart;
    this.insertSessionStart = null;
    if (!start || start.text === this.getText()) return;
    this.pushUndo(start);
  }

  private performUndo(): void {
    const snapshot = this.undoHistory.pop();
    if (!snapshot) return;
    this.redoHistory.push(this.captureSnapshot());
    this.restoreSnapshot(snapshot);
    this.resetPending();
  }

  private performRedo(): void {
    const snapshot = this.redoHistory.pop();
    if (!snapshot) return;
    this.undoHistory.push(this.captureSnapshot());
    this.restoreSnapshot(snapshot);
    this.resetPending();
  }

  private commitMutation(before: EditorSnapshot, text: string, cursor: CursorPosition): void {
    if (before.text === text) return;
    this.pushUndo(before);
    this.writeState(text, cursor);
  }

  private pushUndo(snapshot: EditorSnapshot): void {
    const last = this.undoHistory[this.undoHistory.length - 1];
    if (!last || last.text !== snapshot.text || last.cursor.line !== snapshot.cursor.line || last.cursor.col !== snapshot.cursor.col) {
      this.undoHistory.push(snapshot);
      if (this.undoHistory.length > MAX_HISTORY) this.undoHistory.shift();
    }
    this.redoHistory = [];
  }

  private captureSnapshot(): EditorSnapshot {
    return { text: this.getText(), cursor: this.getCursor() };
  }

  private restoreSnapshot(snapshot: EditorSnapshot): void {
    this.writeState(snapshot.text, snapshot.cursor);
  }

  private writeState(text: string, cursor: CursorPosition, insertMode = this.mode === "insert"): void {
    const internal = this as unknown as MutableEditorInternals;
    const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    internal.state.lines = lines.length > 0 ? lines : [""];
    const safeCursor = clampCursor(internal.state.lines.join("\n"), cursor, insertMode);
    internal.state.cursorLine = safeCursor.line;
    internal.state.cursorCol = safeCursor.col;
    internal.preferredVisualCol = null;
    internal.lastAction = null;
    internal.onChange?.(this.getText());
    this.requestRender();
  }

  private setCursor(cursor: CursorPosition, insertMode: boolean): void {
    const internal = this as unknown as MutableEditorInternals;
    const safe = clampCursor(this.getText(), cursor, insertMode);
    internal.state.cursorLine = safe.line;
    internal.state.cursorCol = safe.col;
    internal.preferredVisualCol = null;
    internal.lastAction = null;
    this.requestRender();
  }

  private setMode(mode: VimMode): void {
    this.mode = mode;
    this.emitModeChange();
  }

  private emitModeChange(): void {
    this.modeChangeFn(this.getMode());
    this.requestRender();
  }

  private requestRender(): void {
    this.tuiRef.requestRender();
  }

  private resetPending(): void {
    this.countPrefix = "";
    this.operatorCount = "";
    this.pendingOperator = null;
    this.pendingG = false;
  }

  private appendCount(current: string, digit: string): string {
    return String(Math.min(9999, Number(`${current}${digit}`)));
  }

  private takeCount(): number {
    const count = Number(this.countPrefix) || 1;
    this.countPrefix = "";
    return count;
  }

  private takeOperatorCount(): number {
    const first = Number(this.operatorCount) || 1;
    const second = Number(this.countPrefix) || 1;
    this.operatorCount = "";
    this.countPrefix = "";
    return Math.min(9999, first * second);
  }

  private buildModeLabel(): string {
    if (this.pendingExCommand !== null) return ` EX ${this.pendingExCommand}_ `;
    const name = this.mode === "visual-line" ? "V-LINE" : this.mode.toUpperCase();
    const pending = `${this.operatorCount}${this.pendingOperator ?? ""}${this.countPrefix}${this.pendingG ? "g" : ""}`;
    return pending ? ` ${name} ${pending}_ ` : ` ${name} `;
  }

  private colorModeLabel(label: string): string {
    const reverse = (text: string) => `\x1b[7m${text}\x1b[27m`;
    if (!this.modeColorsEnabled || !this.themeRef.fg) return reverse(label);
    const color = this.getMode() === "insert" ? "success" : this.getMode() === "visual" || this.getMode() === "visual-line" ? "warning" : this.getMode() === "ex" ? "accent" : "muted";
    return reverse(this.themeRef.fg(color, label));
  }
}
