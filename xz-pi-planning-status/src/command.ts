export type XzCommandResult =
  | { kind: "set"; enabled: boolean }
  | { kind: "status" }
  | { kind: "invalid" };

export function resolveXzCommand(args: string, currentlyEnabled: boolean): XzCommandResult {
  const command = args.trim().toLowerCase();
  if (command === "") return { kind: "set", enabled: !currentlyEnabled };
  if (command === "on") return { kind: "set", enabled: true };
  if (command === "off") return { kind: "set", enabled: false };
  if (command === "status") return { kind: "status" };
  return { kind: "invalid" };
}
