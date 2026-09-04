import { XzModalEditor } from "../src/modal-editor.js";

type EditorArgs = ConstructorParameters<typeof XzModalEditor>;

export const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120, write() {} },
  getShowHardwareCursor: () => false,
  setShowHardwareCursor() {},
} as unknown as EditorArgs[0];

export const stubTheme = {
  borderColor: (text: string) => text,
  fg: (_name: string, text: string) => text,
  selectList: {},
} as unknown as EditorArgs[1];

export const stubKeybindings = {
  matches: (data: string, action: string) => {
    if (action === "app.interrupt") return data === "\x1b";
    if (action === "app.exit") return data === "\x04";
    return false;
  },
} as unknown as EditorArgs[2];

export function createEditor(text = "", options: EditorArgs[3] = {}): XzModalEditor {
  const editor = new XzModalEditor(stubTui, stubTheme, stubKeybindings, options);
  for (const character of text) editor.handleInput(character === "\n" ? "\n" : character);
  editor.handleInput("\x1b");
  editor.handleInput("g");
  editor.handleInput("g");
  editor.handleInput("0");
  return editor;
}

export function send(editor: XzModalEditor, keys: readonly string[]): void {
  for (const key of keys) editor.handleInput(key);
}
