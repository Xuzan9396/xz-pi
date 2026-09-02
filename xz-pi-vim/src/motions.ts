import type { CursorPosition, MotionKey, TextRange } from "./types.js";

const SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

type Grapheme = { start: number; end: number; text: string };
type CharacterClass = "space" | "word" | "punctuation";

export function graphemes(text: string): Grapheme[] {
  if (!SEGMENTER) {
    const result: Grapheme[] = [];
    let start = 0;
    for (const character of Array.from(text)) {
      result.push({ start, end: start + character.length, text: character });
      start += character.length;
    }
    return result;
  }
  return Array.from(SEGMENTER.segment(text), (part) => ({
    start: part.index,
    end: part.index + part.segment.length,
    text: part.segment,
  }));
}

export function graphemeEndAt(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  return graphemes(text).find((part) => offset < part.end)?.end ?? text.length;
}

export function graphemeStartBefore(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const parts = graphemes(text);
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part && part.start < offset) return part.start;
  }
  return 0;
}

export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function cursorToOffset(text: string, cursor: CursorPosition): number {
  const lines = text.split("\n");
  const line = Math.max(0, Math.min(cursor.line, lines.length - 1));
  const starts = lineStartOffsets(text);
  const value = lines[line] ?? "";
  return (starts[line] ?? 0) + Math.max(0, Math.min(cursor.col, value.length));
}

export function offsetToCursor(text: string, rawOffset: number): CursorPosition {
  const offset = Math.max(0, Math.min(rawOffset, text.length));
  const starts = lineStartOffsets(text);
  let line = 0;
  for (let index = 1; index < starts.length; index++) {
    if ((starts[index] ?? text.length + 1) > offset) break;
    line = index;
  }
  return { line, col: offset - (starts[line] ?? 0) };
}

export function clampCursor(text: string, cursor: CursorPosition, insertMode = false): CursorPosition {
  const lines = text.split("\n");
  const line = Math.max(0, Math.min(cursor.line, lines.length - 1));
  const value = lines[line] ?? "";
  const max = insertMode ? value.length : Math.max(0, graphemeStartBefore(value, value.length));
  return { line, col: Math.max(0, Math.min(cursor.col, max)) };
}

export function firstNonWhitespace(line: string): number {
  const result = line.search(/\S/u);
  return result === -1 ? 0 : result;
}

function classify(character: string | undefined): CharacterClass {
  if (!character || /\s/u.test(character)) return "space";
  if (/^[\p{L}\p{N}_]/u.test(character)) return "word";
  return "punctuation";
}

function nextWordStart(text: string, offset: number): number {
  const parts = graphemes(text);
  let index = parts.findIndex((part) => offset < part.end);
  if (index < 0) return text.length;
  const initial = classify(parts[index]?.text);
  if (initial !== "space") {
    while (index < parts.length && classify(parts[index]?.text) === initial) index++;
  }
  while (index < parts.length && classify(parts[index]?.text) === "space") index++;
  return parts[index]?.start ?? text.length;
}

function previousWordStart(text: string, offset: number): number {
  const parts = graphemes(text);
  let index = parts.findIndex((part) => offset <= part.start);
  index = (index < 0 ? parts.length : index) - 1;
  while (index > 0 && classify(parts[index]?.text) === "space") index--;
  const type = classify(parts[index]?.text);
  while (index > 0 && classify(parts[index - 1]?.text) === type) index--;
  return parts[index]?.start ?? 0;
}

function nextWordEnd(text: string, offset: number): number {
  const parts = graphemes(text);
  let index = parts.findIndex((part) => offset < part.end);
  if (index < 0) return text.length;
  if (parts[index]?.start === offset && classify(parts[index]?.text) !== "space") index++;
  while (index < parts.length && classify(parts[index]?.text) === "space") index++;
  if (index >= parts.length) return text.length;
  const type = classify(parts[index]?.text);
  while (index + 1 < parts.length && classify(parts[index + 1]?.text) === type) index++;
  return parts[index]?.start ?? text.length;
}

function horizontalTarget(line: string, col: number, direction: -1 | 1, count: number): number {
  let result = col;
  for (let step = 0; step < count; step++) {
    result = direction < 0 ? graphemeStartBefore(line, result) : graphemeEndAt(line, result);
    if (direction > 0 && result >= line.length) {
      result = Math.max(0, graphemeStartBefore(line, line.length));
      break;
    }
  }
  return result;
}

export function moveByMotion(text: string, cursor: CursorPosition, motion: MotionKey, count = 1): CursorPosition {
  const safeCount = Math.max(1, Math.min(9999, Math.trunc(count)));
  const lines = text.split("\n");
  const current = clampCursor(text, cursor);
  const lineText = lines[current.line] ?? "";

  if (motion === "h") return { line: current.line, col: horizontalTarget(lineText, current.col, -1, safeCount) };
  if (motion === "l") return { line: current.line, col: horizontalTarget(lineText, current.col, 1, safeCount) };
  if (motion === "0") return { line: current.line, col: 0 };
  if (motion === "^") return { line: current.line, col: firstNonWhitespace(lineText) };
  if (motion === "$") return { line: current.line, col: Math.max(0, graphemeStartBefore(lineText, lineText.length)) };
  if (motion === "j" || motion === "k") {
    const delta = motion === "j" ? safeCount : -safeCount;
    const targetLine = Math.max(0, Math.min(current.line + delta, lines.length - 1));
    return clampCursor(text, { line: targetLine, col: current.col });
  }
  if (motion === "g") return clampCursor(text, { line: safeCount === 1 ? 0 : safeCount - 1, col: firstNonWhitespace(lines[safeCount - 1] ?? "") });
  if (motion === "G") {
    const targetLine = count > 1 ? Math.min(safeCount - 1, lines.length - 1) : lines.length - 1;
    return clampCursor(text, { line: targetLine, col: firstNonWhitespace(lines[targetLine] ?? "") });
  }

  let offset = cursorToOffset(text, current);
  for (let step = 0; step < safeCount; step++) {
    if (motion === "w") offset = nextWordStart(text, offset);
    if (motion === "b") offset = previousWordStart(text, offset);
    if (motion === "e") offset = nextWordEnd(text, offset);
  }
  return clampCursor(text, offsetToCursor(text, offset));
}

export function rangeForMotion(text: string, cursor: CursorPosition, motion: MotionKey, count = 1): TextRange {
  const target = moveByMotion(text, cursor, motion, count);
  const from = cursorToOffset(text, cursor);
  const to = cursorToOffset(text, target);

  if (motion === "j" || motion === "k" || motion === "g" || motion === "G") {
    const starts = lineStartOffsets(text);
    const startLine = Math.min(cursor.line, target.line);
    const endLine = Math.max(cursor.line, target.line);
    return { start: starts[startLine] ?? 0, end: starts[endLine + 1] ?? text.length, linewise: true };
  }
  if (motion === "e" || motion === "l" || motion === "$") {
    return { start: Math.min(from, to), end: graphemeEndAt(text, Math.max(from, to)) };
  }
  return { start: Math.min(from, to), end: Math.max(from, to) };
}
