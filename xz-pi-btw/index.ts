import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  sessionEntryToContextMessages,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  appendSideExchange,
  buildSideMessages,
  extractResponseText,
  serializeMainContext,
  SIDE_SYSTEM_PROMPT,
  type SideExchange,
} from "./src/conversation.js";

class SideConversationView implements Component, Focusable {
  private readonly input = new Input();
  private pendingQuestion: string | undefined;
  private status = "Ready";
  private scrollOffset = 0;
  private closed = false;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly exchanges: SideExchange[],
    private readonly ask: (question: string) => void,
    private readonly close: () => void,
  ) {
    this.input.onSubmit = (value) => {
      const question = value.trim();
      if (!question || this.pendingQuestion) return;
      this.input.setValue("");
      this.scrollOffset = 0;
      this.ask(question);
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  setPending(question: string): void {
    this.pendingQuestion = question;
    this.status = "Thinking… Ctrl+C returns to the main session";
    this.scrollOffset = 0;
    this.tui.requestRender();
  }

  finishPending(): void {
    this.pendingQuestion = undefined;
    this.status = "Ready";
    this.scrollOffset = 0;
    this.tui.requestRender();
  }

  failPending(message: string): void {
    this.pendingQuestion = undefined;
    this.status = `Error: ${message}`;
    this.scrollOffset = 0;
    this.tui.requestRender();
  }

  markClosed(): void {
    this.closed = true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollOffset += Math.max(1, this.tui.terminal.rows - 10);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.tui.terminal.rows - 10));
      this.tui.requestRender();
      return;
    }
    if (this.pendingQuestion || this.closed) return;
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const transcript: string[] = [];

    for (const exchange of this.exchanges) {
      transcript.push(...new Text(this.theme.fg("accent", `You: ${exchange.question}`), 1, 0).render(renderWidth));
      transcript.push(...new Markdown(exchange.answer, 1, 1, getMarkdownTheme()).render(renderWidth));
    }
    if (this.pendingQuestion) {
      transcript.push(...new Text(this.theme.fg("accent", `You: ${this.pendingQuestion}`), 1, 0).render(renderWidth));
      transcript.push(...new Text(this.theme.fg("muted", "Thinking…"), 1, 1).render(renderWidth));
    }
    if (transcript.length === 0) {
      transcript.push(this.theme.fg("dim", "  Ask a side question below. The main-session context is available as reference."));
    }

    const fixedRows = 6;
    const viewportHeight = Math.max(1, this.tui.terminal.rows - fixedRows);
    const maxStart = Math.max(0, transcript.length - viewportHeight);
    const start = Math.max(0, maxStart - Math.min(this.scrollOffset, maxStart));
    const visibleTranscript = transcript.slice(start, start + viewportHeight);
    const blankLine = " ".repeat(renderWidth);
    while (visibleTranscript.length < viewportHeight) visibleTranscript.push(blankLine);

    // Overlay lines must be padded to the full width. Short or missing lines are
    // transparent during overlay composition and would leave the parent transcript
    // visible around the BTW window.
    const fillLine = (line: string): string => {
      const clipped = truncateToWidth(line, renderWidth, "");
      return clipped + " ".repeat(Math.max(0, renderWidth - visibleWidth(clipped)));
    };
    const border = this.theme.fg("accent", "─".repeat(renderWidth));
    const statusColor = this.status.startsWith("Error:") ? "error" : this.pendingQuestion ? "warning" : "muted";

    return [
      fillLine(border),
      fillLine(this.theme.fg("accent", this.theme.bold(" BTW — ephemeral side conversation "))),
      ...visibleTranscript.map(fillLine),
      fillLine(border),
      fillLine(this.theme.fg(statusColor, ` ${this.status}`)),
      ...this.input.render(renderWidth).map(fillLine),
      fillLine(this.theme.fg("dim", " Enter: send  •  PageUp/PageDown: scroll  •  Ctrl+C/Esc: return to main")),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

export default function xzPiBtw(pi: ExtensionAPI): void {
  let exchanges: SideExchange[] = [];

  pi.on("session_start", () => {
    exchanges = [];
  });

  pi.registerCommand("btw", {
    description: "Open an ephemeral side-conversation window using the current session context",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive TUI mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Freeze the parent context when the side window opens. Side turns never
      // append to the parent SessionManager.
      const contextMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
      const mainConversation = serializeMainContext(contextMessages);
      const model = ctx.model;
      const systemPrompt = `${ctx.getSystemPrompt()}\n\n${SIDE_SYSTEM_PROMPT}`;
      const sideSessionId = uuidv7();
      let activeRequest: AbortController | undefined;
      let view: SideConversationView;
      let isClosed = false;

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const close = () => {
          if (isClosed) return;
          isClosed = true;
          view.markClosed();
          activeRequest?.abort();
          done(undefined);
        };

        const ask = (question: string) => {
          if (isClosed || activeRequest) return;
          const controller = new AbortController();
          activeRequest = controller;
          view.setPending(question);
          const sideMessages = buildSideMessages(mainConversation, exchanges, question);

          ctx.modelRegistry
            .complete(
              model,
              { systemPrompt, messages: sideMessages },
              {
                signal: controller.signal,
                cacheRetention: "none",
                sessionId: sideSessionId,
              },
            )
            .then((response) => {
              if (isClosed || controller.signal.aborted) return;
              const answer = extractResponseText(response.content);
              if (!answer) {
                view.failPending("The side response was empty");
                return;
              }
              const nextExchanges = appendSideExchange(exchanges, { question, answer });
              exchanges.splice(0, exchanges.length, ...nextExchanges);
              view.finishPending();
            })
            .catch((error: unknown) => {
              if (isClosed || controller.signal.aborted) return;
              view.failPending(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
              if (activeRequest === controller) activeRequest = undefined;
            });
        };

        view = new SideConversationView(tui, theme, exchanges, ask, close);
        const initialQuestion = args.trim();
        if (initialQuestion) queueMicrotask(() => ask(initialQuestion));
        return view;
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      });
    },
  });
}
