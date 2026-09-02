import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import type { ActiveMode } from "./types.js";

const BLOCK_CURSOR = "\x1b[2 q";
const BAR_CURSOR = "\x1b[6 q";
const RESTORE_CURSOR = "\x1b[0 q";
const SHOW_CURSOR = "\x1b[?25h";
const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;

type CursorTui = {
  terminal?: { write?: (data: string) => void };
  getShowHardwareCursor?: () => boolean;
  setShowHardwareCursor?: (show: boolean) => void;
};

export class CursorShapeController {
  private lastMode: ActiveMode | null = null;
  private disposed = false;
  private readonly previousHardwareCursor: boolean | undefined;

  constructor(private readonly tui: CursorTui, private readonly enabled: boolean) {
    this.previousHardwareCursor = tui.getShowHardwareCursor?.();
    if (enabled) tui.setShowHardwareCursor?.(true);
  }

  sync(mode: ActiveMode): void {
    if (!this.enabled || this.disposed || this.lastMode === mode) return;
    this.lastMode = mode;
    this.writeShape(mode);
  }

  reassert(): void {
    if (!this.enabled || this.disposed) return;
    this.tui.setShowHardwareCursor?.(true);
    if (this.lastMode) this.writeShape(this.lastMode);
  }

  dispose(reason?: string): void {
    if (!this.enabled || this.disposed) return;
    this.disposed = true;
    this.tui.terminal?.write?.(RESTORE_CURSOR);
    if (reason === "quit") this.tui.terminal?.write?.(SHOW_CURSOR);
    else if (this.previousHardwareCursor !== undefined) this.tui.setShowHardwareCursor?.(this.previousHardwareCursor);
    this.lastMode = null;
  }

  private writeShape(mode: ActiveMode): void {
    this.tui.terminal?.write?.(mode === "insert" ? BAR_CURSOR : BLOCK_CURSOR);
  }
}

export function stripSoftwareCursorWhenHardwareCursorIsUsed(lines: string[]): void {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line?.includes(CURSOR_MARKER)) continue;
    const markerEnd = line.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length;
    const cursorStart = line.indexOf(SOFTWARE_CURSOR_START, markerEnd);
    if (cursorStart < 0) return;
    const contentStart = cursorStart + SOFTWARE_CURSOR_START.length;
    const resets = SOFTWARE_CURSOR_RESETS
      .map((sequence) => ({ sequence, index: line.indexOf(sequence, contentStart) }))
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index);
    const reset = resets[0];
    if (!reset) return;
    lines[index] = line.slice(0, cursorStart) + line.slice(contentStart, reset.index) + line.slice(reset.index + reset.sequence.length);
    return;
  }
}
