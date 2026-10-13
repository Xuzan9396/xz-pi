import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CursorShapeController } from "./src/cursor-shape.js";
import { XzModalEditor } from "./src/modal-editor.js";
import { createInlineSlashAutocompleteProvider } from "./src/slash-autocomplete.js";
import { readXzPiVimSettings } from "./src/settings.js";
import { readEnabledPackageSources } from "./src/package-references.js";
import { buildReferenceCatalog, createToolReferenceAutocompleteProvider, ToolReferenceTracker, type ToolReference } from "./src/tool-references.js";
import { WorkDurationTimer } from "./src/work-duration.js";
import { MCP_STATUS_EVENT, parseMcpReferenceSnapshot, type McpReferenceServer } from "./src/mcp-references.js";

export { XzModalEditor } from "./src/modal-editor.js";

const BUILTIN_COMMANDS = new Set([
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
  "changelog", "hotkeys", "fork", "clone", "tree", "login", "logout", "new", "compact", "resume",
  "reload", "quit", "trust",
]);

export default function xzPiVim(pi: ExtensionAPI): void {
  let cursorController: CursorShapeController | null = null;
  let reloadCursorTimer: ReturnType<typeof setTimeout> | null = null;
  const referenceTracker = new ToolReferenceTracker();
  let activeEditor: XzModalEditor | null = null;
  let activateReferencedTools = true;
  let referencesForTurn: ToolReference[] = [];
  let workDurationLabel: string | undefined;
  let mcpServers: readonly McpReferenceServer[] | undefined;
  let enabledReferencePackages: readonly string[] = [];
  // Subscribe at factory load, before session_start initializes adapter metadata.
  // Do not clear here on session_start: the adapter may emit first in load order.
  pi.events.on(MCP_STATUS_EVENT, (value) => {
    const snapshot = parseMcpReferenceSnapshot(value);
    if (snapshot !== undefined) mcpServers = snapshot;
  });
  const workDurationTimer = new WorkDurationTimer((duration) => {
    workDurationLabel = `⏱ working ${duration}`;
    activeEditor?.setWorkDurationLabel(workDurationLabel);
  });

  pi.on("session_start", (event, ctx) => {
    const settings = readXzPiVimSettings(ctx.cwd, process.env.HOME, ctx.isProjectTrusted());
    workDurationTimer.dispose();
    workDurationLabel = undefined;
    referenceTracker.clear();
    activeEditor = null;
    activateReferencedTools = settings.activateReferencedTools;
    if (settings.inlineSlashCompletion) {
      ctx.ui.addAutocompleteProvider((current) => createInlineSlashAutocompleteProvider(current));
    }
    if (settings.toolReferences) {
      const enabledPackages = readEnabledPackageSources(ctx.cwd, ctx.isProjectTrusted());
      enabledReferencePackages = enabledPackages;
      ctx.ui.addAutocompleteProvider((current) => createToolReferenceAutocompleteProvider(
        current,
        () => buildReferenceCatalog(pi.getAllTools(), enabledPackages, mcpServers),
        (completion) => activeEditor?.queueCompletedToolReference(completion),
      ));
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      cursorController?.dispose();
      cursorController = new CursorShapeController(tui, settings.cursorShape);
      const editor = new XzModalEditor(tui, theme, keybindings, {
        startInNormal: settings.startInNormal,
        cursorShape: settings.cursorShape,
        modeColors: settings.modeColors,
        exCommand: settings.exCommand,
        inlineSlashCompletion: settings.inlineSlashCompletion,
        toolReferences: settings.toolReferences,
        highlightToolReferences: settings.highlightToolReferences,
        workDurationLabel,
        referenceTracker,
        syncCursor: (mode) => cursorController?.sync(mode) ?? false,
      });
      activeEditor = editor;
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

  pi.on("input", (event) => {
    if (event.source !== "extension") workDurationTimer.start();
    if (event.source !== "interactive") return;
    const submitted = referenceTracker.consumeSubmitted(event.text);
    if (submitted.length === 0) return;
    // Recheck the current catalog at submission: a server can have been disabled
    // since completion, so stale tags must not reactivate its retired tools.
    const catalog = buildReferenceCatalog(pi.getAllTools(), enabledReferencePackages, mcpServers);
    const references = submitted.flatMap((reference) => {
      const current = catalog.find((candidate) => candidate.kind === reference.kind && candidate.name === reference.name);
      return current ? [{ ...reference, memberToolNames: current.memberToolNames }] : [];
    });
    if (references.length === 0) return;
    referencesForTurn = references;
    if (activateReferencedTools) {
      const memberTools = references.flatMap((reference) => reference.memberToolNames);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...memberTools])]);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (referencesForTurn.length === 0) return;
    const references = referencesForTurn;
    referencesForTurn = [];
    const summary = references.map((reference) => `${reference.kind}: ${reference.name}`).join(", ");
    return {
      systemPrompt: `${event.systemPrompt}\n\nThe user explicitly referenced these capabilities (${summary}). Prefer their associated tools when appropriate for the request.`,
    };
  });

  pi.on("agent_settled", () => {
    workDurationTimer.settle();
  });

  pi.on("session_shutdown", (event) => {
    workDurationTimer.dispose();
    workDurationLabel = undefined;
    if (reloadCursorTimer) clearTimeout(reloadCursorTimer);
    reloadCursorTimer = null;
    cursorController?.dispose(event.reason);
    cursorController = null;
    activeEditor = null;
    referenceTracker.clear();
    referencesForTurn = [];
  });
}
