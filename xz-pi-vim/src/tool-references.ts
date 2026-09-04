import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { TextRange } from "./types.js";

export type ToolReferenceSource = "builtin" | "extension" | "mcp";
export type ToolReferenceKind = "mcp" | "package" | "tool";

export type ToolReferenceCandidate = {
  name: string;
  description?: string;
  kind: ToolReferenceKind;
  source: ToolReferenceSource;
  sourceLabel?: string;
  memberToolNames: string[];
};

export type ReferenceToolMetadata = {
  name: string;
  description: string;
  sourceInfo: {
    source: string;
    path: string;
    origin: "package" | "top-level";
  };
};

export type ToolReference = ToolReferenceCandidate & {
  start: number;
  end: number;
};

export type CompletedToolReference = {
  reference: ToolReference;
  text: string;
};

const TOOL_NAME_CHARACTER = /[A-Za-z0-9_.:-]/;

export function extractToolReferenceToken(textBeforeCursor: string): { prefix: string; query: string } | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])\$([^\s$]*)$/);
  if (!match) return undefined;
  const query = match[1] ?? "";
  return { prefix: `$${query}`, query };
}

export function classifyToolSource(tool: {
  name: string;
  sourceInfo?: { source?: string; path?: string };
}): ToolReferenceSource {
  const source = `${tool.sourceInfo?.source ?? ""} ${tool.sourceInfo?.path ?? ""}`.toLowerCase();
  if (tool.name.toLowerCase().includes("mcp__") || source.includes("mcp")) return "mcp";
  if (tool.sourceInfo?.source === "builtin") return "builtin";
  return "extension";
}

function mcpServerName(tool: ReferenceToolMetadata): string | undefined {
  if (tool.name.toLowerCase().startsWith("mcp__")) {
    const remainder = tool.name.slice(5);
    return remainder.split("__", 1)[0] || undefined;
  }
  const source = tool.sourceInfo.source;
  if (source.toLowerCase().includes("mcp")) {
    return source.replace(/^(?:npm|git):/, "").replace(/@[^/@]+$/, "").split(/[\\/]/).filter(Boolean).at(-1);
  }
  const pathMatch = tool.sourceInfo.path.match(/([^/\\]*mcp[^/\\]*)/i);
  return pathMatch?.[1];
}

function packageName(source: string): string {
  const clean = source.replace(/^(?:npm|git):/, "").replace(/@[^/@]+$/, "").replace(/[\\/]$/, "");
  if (clean.startsWith("@") && clean.includes("/")) return clean;
  return clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
}

export function buildReferenceCatalog(tools: readonly ReferenceToolMetadata[]): ToolReferenceCandidate[] {
  const mcpGroups = new Map<string, ReferenceToolMetadata[]>();
  const packageGroups = new Map<string, ReferenceToolMetadata[]>();
  const toolCandidates: ToolReferenceCandidate[] = [];

  for (const tool of tools) {
    const source = classifyToolSource(tool);
    toolCandidates.push({
      name: tool.name,
      description: tool.description,
      kind: "tool",
      source,
      sourceLabel: tool.sourceInfo.source,
      memberToolNames: [tool.name],
    });

    if (source === "mcp") {
      const server = mcpServerName(tool);
      if (server) mcpGroups.set(server, [...(mcpGroups.get(server) ?? []), tool]);
    }
    if (tool.sourceInfo.origin === "package") {
      const name = packageName(tool.sourceInfo.source);
      packageGroups.set(name, [...(packageGroups.get(name) ?? []), tool]);
    }
  }

  const mcpCandidates = [...mcpGroups.entries()].map(([name, members]): ToolReferenceCandidate => ({
    name,
    description: `${members.length} tool${members.length === 1 ? "" : "s"}`,
    kind: "mcp",
    source: "mcp",
    sourceLabel: members[0]!.sourceInfo.source,
    memberToolNames: members.map((tool) => tool.name),
  }));
  const packageCandidates = [...packageGroups.entries()]
    .filter(([, members]) => members.some((tool) => classifyToolSource(tool) !== "mcp"))
    .map(([name, members]): ToolReferenceCandidate => ({
      name,
      description: `${members.length} tool${members.length === 1 ? "" : "s"}`,
      kind: "package",
      source: "extension",
      sourceLabel: members[0]!.sourceInfo.source,
      memberToolNames: members.map((tool) => tool.name),
    }));

  return [...mcpCandidates, ...packageCandidates, ...toolCandidates];
}

const KIND_ORDER: ToolReferenceKind[] = ["mcp", "package", "tool"];
const KIND_ICON: Record<ToolReferenceKind, string> = { mcp: "◆", package: "◇", tool: "·" };

function candidateItems(candidates: readonly ToolReferenceCandidate[], query: string): AutocompleteItem[] {
  const items: AutocompleteItem[] = [];
  for (const kind of KIND_ORDER) {
    const values = candidates.filter((candidate) => candidate.kind === kind);
    const matches = query
      ? fuzzyFilter(values, query, (candidate) => `${candidate.name} ${candidate.description ?? ""} ${candidate.sourceLabel ?? ""}`)
      : values.sort((left, right) => left.name.localeCompare(right.name));
    for (const candidate of matches) {
      items.push({
        value: candidate.name,
        label: `${KIND_ICON[kind]} ${candidate.name}`,
        description: `${kind.toUpperCase()} · ${candidate.description ?? candidate.sourceLabel ?? ""}`.replace(/ · $/, ""),
      });
    }
  }
  return items;
}

function cursorOffset(lines: readonly string[], line: number, col: number): number {
  let offset = 0;
  for (let index = 0; index < line; index++) offset += (lines[index]?.length ?? 0) + 1;
  return offset + col;
}

export function createToolReferenceAutocompleteProvider(
  current: AutocompleteProvider,
  getCandidates: () => readonly ToolReferenceCandidate[],
  onComplete: (completion: CompletedToolReference) => void,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const token = extractToolReferenceToken(line.slice(0, cursorCol));
      if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const items = candidateItems(getCandidates(), token.query);
      return items.length > 0 ? { items, prefix: token.prefix } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      if (prefix.startsWith("$") && (beforePrefix === "" || /[ \t]$/.test(beforePrefix))) {
        const afterCursor = line.slice(cursorCol);
        const newLines = [...lines];
        newLines[cursorLine] = `${beforePrefix}${item.value} ${afterCursor}`;
        const start = cursorOffset(lines, cursorLine, beforePrefix.length);
        const candidate = getCandidates().find((value) => value.name === item.value);
        if (candidate) {
          onComplete({
            text: newLines.join("\n"),
            reference: { ...candidate, start, end: start + item.value.length },
          });
        }
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 1,
        };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      if (extractToolReferenceToken(line.slice(0, cursorCol))) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export class ToolReferenceTracker {
  private references: ToolReference[] = [];
  private submitted: { text: string; references: ToolReference[] } | undefined;

  getAll(): readonly ToolReference[] {
    return this.references;
  }

  add(reference: ToolReference): void {
    this.references = this.references
      .filter((current) => current.end <= reference.start || current.start >= reference.end)
      .concat({ ...reference })
      .sort((left, right) => left.start - right.start);
  }

  clear(): void {
    this.references = [];
    this.submitted = undefined;
  }

  snapshot(): ToolReference[] {
    return this.references.map((reference) => ({ ...reference }));
  }

  restore(references: readonly ToolReference[] = []): void {
    this.references = references.map((reference) => ({ ...reference }));
  }

  findForBackwardDelete(offset: number): ToolReference | undefined {
    return this.references.find((reference) => offset > reference.start && offset <= reference.end);
  }

  findForForwardDelete(offset: number): ToolReference | undefined {
    return this.references.find((reference) => offset >= reference.start && offset < reference.end);
  }

  expandRange(range: TextRange): TextRange {
    let start = range.start;
    let end = range.end;
    let changed = true;
    while (changed) {
      changed = false;
      for (const reference of this.references) {
        if (end <= reference.start || start >= reference.end) continue;
        const nextStart = Math.min(start, reference.start);
        const nextEnd = Math.max(end, reference.end);
        if (nextStart !== start || nextEnd !== end) changed = true;
        start = nextStart;
        end = nextEnd;
      }
    }
    return { ...range, start, end };
  }

  reconcile(before: string, after: string): void {
    if (before === after) return;
    if (after === "" && before !== "" && this.references.length > 0) {
      this.submitted = { text: before, references: this.snapshot() };
    }

    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix++;

    const oldEnd = before.length - suffix;
    const delta = after.length - before.length;
    this.references = this.references.flatMap((reference) => {
      if (reference.end <= prefix) return [{ ...reference }];
      if (reference.start >= oldEnd) return [{ ...reference, start: reference.start + delta, end: reference.end + delta }];
      return [];
    });
  }

  consumeSubmitted(text: string): ToolReference[] {
    if (!this.submitted || this.submitted.text !== text) return [];
    const references = this.submitted.references.filter((reference) => text.slice(reference.start, reference.end) === reference.name);
    this.submitted = undefined;
    return references;
  }

  hasNameAt(text: string, reference: ToolReference): boolean {
    if (text.slice(reference.start, reference.end) !== reference.name) return false;
    const before = text[reference.start - 1];
    const after = text[reference.end];
    return (!before || !TOOL_NAME_CHARACTER.test(before)) && (!after || !TOOL_NAME_CHARACTER.test(after));
  }
}
