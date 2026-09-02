export type VimMode = "insert" | "normal" | "visual" | "visual-line";

export type ActiveMode = VimMode | "ex";

export type PendingOperator = "d" | "c" | "y";

export type MotionKey = "h" | "j" | "k" | "l" | "0" | "^" | "$" | "w" | "b" | "e" | "g" | "G";

export type CursorPosition = {
  line: number;
  col: number;
};

export type EditorSnapshot = {
  text: string;
  cursor: CursorPosition;
};

export type RegisterKind = "character" | "line";

export type VimRegister = {
  text: string;
  kind: RegisterKind;
};

export type TextRange = {
  start: number;
  end: number;
  linewise?: boolean;
};

export type ModeChangeEvent = {
  mode: ActiveMode;
};
