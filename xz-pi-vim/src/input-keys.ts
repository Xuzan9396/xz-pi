import { matchesKey } from "@earendil-works/pi-tui";

export function isEscapeInput(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

export function isEnterInput(data: string): boolean {
  return data === "\r" || data === "\n" || matchesKey(data, "enter") || matchesKey(data, "return");
}

export function isBackspaceInput(data: string): boolean {
  return data === "\x7f" || data === "\x08" || matchesKey(data, "backspace") || matchesKey(data, "ctrl+h");
}

export function isCtrlRInput(data: string): boolean {
  return data === "\x12" || matchesKey(data, "ctrl+r");
}

export function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  for (const character of data) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
}

export function isDigit(data: string): boolean {
  return data.length === 1 && data >= "0" && data <= "9";
}
