import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

export type InlineSlashToken = {
  prefix: string;
  query: string;
};

/** Match a slash-command token preceded by horizontal whitespace, but not a line-leading command. */
export function extractInlineSlashToken(textBeforeCursor: string): InlineSlashToken | undefined {
  const match = textBeforeCursor.match(/[ \t]\/([^\s/]*)$/);
  if (!match) return undefined;
  const query = match[1] ?? "";
  return { prefix: `/${query}`, query };
}

export function createInlineSlashAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const token = extractInlineSlashToken(currentLine.slice(0, cursorCol));
      if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      // Ask Pi's current provider with a virtual line-leading command. This keeps
      // built-in, extension, prompt-template, and skill commands in sync with Pi.
      const virtualLines = [...lines];
      virtualLines[cursorLine] = `/${token.query}`;
      const suggestions = await current.getSuggestions(virtualLines, cursorLine, token.query.length + 1, {
        signal: options.signal,
        force: false,
      });
      return suggestions ? { ...suggestions, prefix: token.prefix } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      if (prefix.startsWith("/") && /[ \t]$/.test(beforePrefix)) {
        const afterCursor = currentLine.slice(cursorCol);
        const newLines = [...lines];
        newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 2,
        };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const currentLine = lines[cursorLine] ?? "";
      if (extractInlineSlashToken(currentLine.slice(0, cursorCol))) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
