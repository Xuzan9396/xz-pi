import type { CursorPosition, TextRange } from "./types.js";
import { cursorToOffset, graphemeEndAt, lineStartOffsets } from "./motions.js";

export function characterSelectionRange(text: string, anchor: CursorPosition, cursor: CursorPosition): TextRange {
  const anchorOffset = cursorToOffset(text, anchor);
  const cursorOffset = cursorToOffset(text, cursor);
  const start = Math.min(anchorOffset, cursorOffset);
  const inclusiveEnd = Math.max(anchorOffset, cursorOffset);
  return { start, end: graphemeEndAt(text, inclusiveEnd) };
}

export function lineSelectionRange(text: string, anchor: CursorPosition, cursor: CursorPosition): TextRange {
  const starts = lineStartOffsets(text);
  const startLine = Math.min(anchor.line, cursor.line);
  const endLine = Math.max(anchor.line, cursor.line);
  const start = starts[startLine] ?? 0;
  const end = starts[endLine + 1] ?? text.length;
  return { start, end, linewise: true };
}
