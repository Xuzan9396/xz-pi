import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WorktreeService } from "./src/service.js";

const ACTIONS = ["create", "status", "list", "capture", "apply", "remove"] as const;
type Action = typeof ACTIONS[number];
interface ToolInput { action: Action; id?: string; name?: string; cwd?: string; force?: boolean }

function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function pathFrom(cwd: string, value?: string): string {
  const normalized = value?.startsWith("@") ? value.slice(1) : value;
  return resolve(cwd, normalized || ".");
}

export default function xzPiWorktree(pi: ExtensionAPI): void {
  const service = new WorktreeService({ stateRoot: resolve(getAgentDir(), "xz-pi-worktree", "runs") });
  const serial = serialQueue();

  pi.registerTool({
    name: "xz_worktree",
    label: "Git worktree",
    description: "Manage standalone Git worktrees. Actions: create a managed sibling worktree, inspect status, list manifests, capture a binary patch, apply a captured worktree to a clean unchanged main checkout, or remove it. State and patches persist under the Pi agent directory. Mutating actions require a trusted project.",
    promptSnippet: "Create, inspect, capture, apply, or remove standalone Git worktrees",
    promptGuidelines: [
      "Use xz_worktree only for explicit Git worktree lifecycle requests.",
      "Before xz_worktree apply or remove, preserve the returned id. Never use force removal unless the user accepts discarding remaining worktree changes.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "Worktree lifecycle action" }),
      id: Type.Optional(Type.String({ description: "Managed worktree id; required except for create/list" })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-zA-Z0-9_-]+$", description: "Label for create" })),
      cwd: Type.Optional(Type.String({ description: "Repository path for create/list; defaults to current cwd" })),
      force: Type.Optional(Type.Boolean({ description: "Allow remove to discard worktree changes" })),
    }),
    async execute(_toolCallId, input: ToolInput, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const mutating = input.action !== "status" && input.action !== "list";
      if (mutating && !ctx.isProjectTrusted()) throw new Error("xz_worktree mutation requires a trusted project");
      const result = await serial(async () => {
        signal?.throwIfAborted();
        if (input.action === "create") {
          if (!input.name) throw new Error("create requires name");
          return service.create({ cwd: pathFrom(ctx.cwd, input.cwd), name: input.name }, signal);
        }
        if (input.action === "list") return service.list(pathFrom(ctx.cwd, input.cwd), signal);
        if (!input.id) throw new Error(`${input.action} requires id`);
        if (input.action === "status") return service.status(input.id, signal);
        if (input.action === "capture") return service.capture(input.id, signal);
        if (input.action === "apply") return service.apply(input.id, signal);
        return service.remove(input.id, input.force ?? false, signal);
      });
      const json = JSON.stringify(result, null, 2);
      const bounded = truncateHead(json, { maxBytes: 50_000, maxLines: 2000 });
      return {
        content: [{ type: "text", text: bounded.content + (bounded.truncated ? "\n[Result truncated]" : "") }],
        details: { action: input.action, result },
      };
    },
    renderCall(args, theme) {
      const target = args.name ?? args.id ?? args.cwd ?? "";
      return new Text(theme.fg("toolTitle", `Git worktree · ${args.action}${target ? ` · ${target}` : ""}`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "Git worktree operation running…"), 0, 0);
      const details = result.details as { action?: string; result?: unknown } | undefined;
      const summary = details?.action ? `${details.action} completed` : "completed";
      const body = expanded ? `\n${result.content.filter(item => item.type === "text").map(item => item.text).join("\n")}` : "";
      return new Text(theme.fg("success", `✓ ${summary}`) + body, 0, 0);
    },
  });
}
