import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CursorShapeController } from "./src/cursor-shape.js";
import { XzModalEditor } from "./src/modal-editor.js";
import { readXzPiVimSettings } from "./src/settings.js";

export { XzModalEditor } from "./src/modal-editor.js";

const BUILTIN_COMMANDS = new Set([
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
  "changelog", "hotkeys", "fork", "clone", "tree", "login", "logout", "new", "compact", "resume",
  "reload", "quit", "trust",
]);

export default function xzPiVim(pi: ExtensionAPI): void {
  let cursorController: CursorShapeController | null = null;
  let reloadCursorTimer: ReturnType<typeof setTimeout> | null = null;

  pi.on("session_start", (event, ctx) => {
    const settings = readXzPiVimSettings(ctx.cwd, process.env.HOME, ctx.isProjectTrusted());
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      cursorController?.dispose();
      cursorController = new CursorShapeController(tui, settings.cursorShape);
      const editor = new XzModalEditor(tui, theme, keybindings, {
        startInNormal: settings.startInNormal,
        cursorShape: settings.cursorShape,
        modeColors: settings.modeColors,
        exCommand: settings.exCommand,
      });
      editor.setNotifyFn((message) => ctx.ui.notify(message, "warning"));
      editor.setQuitFn(() => ctx.shutdown());
      editor.setCommandNamesFn(() => new Set([
        ...BUILTIN_COMMANDS,
        ...pi.getCommands().map((command) => command.name),
      ]));
      editor.setModeChangeFn((mode) => {
        cursorController?.sync(mode);
        pi.events.emit("xz-pi-vim:mode-change", { mode });
      });
      return editor;
    });

    // Pi reapplies its own hardware-cursor setting after reload handlers finish.
    // Reassert Vim's cursor on the next event-loop turn so it is not hidden again.
    if (event.reason === "reload" && settings.cursorShape) {
      const controller = cursorController;
      reloadCursorTimer = setTimeout(() => {
        reloadCursorTimer = null;
        if (cursorController === controller) controller?.reassert();
      }, 0);
    }
  });

  pi.on("session_shutdown", (event) => {
    if (reloadCursorTimer) clearTimeout(reloadCursorTimer);
    reloadCursorTimer = null;
    cursorController?.dispose(event.reason);
    cursorController = null;
  });
}
