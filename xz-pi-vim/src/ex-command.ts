export type ExCommand =
  | { kind: "cancel" }
  | { kind: "quit"; force: boolean }
  | { kind: "shell"; command: string; excludeFromContext: boolean }
  | { kind: "pi"; name: string; args: string }
  | { kind: "unsupported"; input: string };

const QUIT_NAMES = new Set(["q", "qa", "quit", "qall", "quitall"]);
const RESERVED_NAMES = new Set(["s", "g", "v", "d", "m", "t", "co", "j", "w", "r", "normal", "sort", "&", ">", "<"]);

export function parseExCommand(input: string, knownCommands: ReadonlySet<string>): ExCommand {
  const body = input.replace(/^:/, "").trim();
  if (!body) return { kind: "cancel" };

  const forcedName = body.endsWith("!") ? body.slice(0, -1) : body;
  if (QUIT_NAMES.has(forcedName)) return { kind: "quit", force: body.endsWith("!") };

  if (body.startsWith("!!")) {
    const command = body.slice(2).trim();
    return command ? { kind: "shell", command, excludeFromContext: true } : { kind: "unsupported", input };
  }
  if (body.startsWith("!")) {
    const command = body.slice(1).trim();
    return command ? { kind: "shell", command, excludeFromContext: false } : { kind: "unsupported", input };
  }

  const match = body.match(/^(\S+)(?:\s+(.*))?$/);
  const name = match?.[1] ?? "";
  const args = match?.[2] ?? "";
  if (RESERVED_NAMES.has(name.replace(/!$/, ""))) return { kind: "unsupported", input };
  if (knownCommands.has(name)) return { kind: "pi", name, args };
  return { kind: "unsupported", input };
}
