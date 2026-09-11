import { exec, parseJsonOutput } from "./process.js";

interface Envelope<T> { result: T }
interface PaneInfo { pane_id: string; tab_id?: string; workspace_id?: string; agent_status?: string }
export interface LayoutPane { pane_id: string; rect: { width: number; height: number; x: number; y: number } }

export class Herdr {
  async ensureReady(): Promise<void> {
    if (process.env.HERDR_ENV !== "1") throw new Error("/agent must be run inside a Herdr-managed pane (HERDR_ENV=1)");
    const status = await exec("herdr", ["status"]);
    if (!status.stdout.includes("endpoint_compatible: yes")) throw new Error("Herdr client/server endpoint is not compatible");
  }

  async layout(paneId: string): Promise<{ panes: LayoutPane[] }> {
    const out = await exec("herdr", ["pane", "layout", "--pane", paneId]);
    const json = parseJsonOutput<Envelope<{ layout: { panes: LayoutPane[] } }>>(out.stdout, "herdr pane layout");
    return { panes: json.result.layout.panes };
  }

  async split(params: { targetPaneId: string; direction: "right" | "down"; ratio: number; cwd: string; env: Record<string, string> }): Promise<PaneInfo> {
    const args = ["pane", "split", "--pane", params.targetPaneId, "--direction", params.direction, "--ratio", String(params.ratio), "--cwd", params.cwd, "--no-focus"];
    for (const [key, value] of Object.entries(params.env)) args.push("--env", `${key}=${value}`);
    const out = await exec("herdr", args);
    const json = parseJsonOutput<Envelope<{ pane: PaneInfo }>>(out.stdout, "herdr pane split");
    if (!json.result.pane?.pane_id) throw new Error("Herdr did not return a pane id");
    return json.result.pane;
  }

  async run(paneId: string, command: string): Promise<void> {
    await exec("herdr", ["pane", "run", paneId, command]);
  }

  async waitOutput(paneId: string, text: string, timeoutMs: number): Promise<string> {
    const out = await exec("herdr", ["pane", "wait-output", paneId, "--match", text, "--source", "recent-unwrapped", "--timeout", String(timeoutMs)]);
    return out.stdout;
  }

  async closePane(paneId: string): Promise<void> {
    await exec("herdr", ["pane", "close", paneId], { allowFailure: true });
  }

  async startAgent(name: string, paneId: string, args: string[]): Promise<"ready" | "blocked"> {
    const command = ["agent", "start", name, "--kind", "pi", "--pane", paneId];
    if (args.length) command.push("--", ...args);
    try {
      await exec("herdr", command);
      return "ready";
    } catch (error) {
      // Herdr keeps the assigned agent name when startup reaches an approval or
      // question UI. Preserve the pane so the user can resolve it directly.
      if (String(error).includes("agent_not_ready")) return "blocked";
      throw error;
    }
  }

  async getAgent(target: string): Promise<PaneInfo | undefined> {
    const out = await exec("herdr", ["agent", "get", target], { allowFailure: true });
    if (!out.stdout.trim()) return undefined;
    try {
      const json = parseJsonOutput<Envelope<{ agent: PaneInfo }>>(out.stdout, "herdr agent get");
      return json.result.agent;
    } catch { return undefined; }
  }

  async readAgent(target: string, lines = 20): Promise<string[]> {
    const out = await exec("herdr", ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)], { allowFailure: true });
    if (!out.stdout.trim()) return [];
    try {
      const json = parseJsonOutput<Envelope<Record<string, unknown>>>(out.stdout, "herdr agent read");
      const result = json.result as { text?: string; content?: string; output?: string };
      return (result.text ?? result.content ?? result.output ?? "").split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch { return out.stdout.split(/\r?\n/).filter(Boolean).slice(-lines); }
  }

  async prompt(target: string, text: string): Promise<void> {
    await exec("herdr", ["agent", "prompt", target, text]);
  }

  async interrupt(target: string): Promise<void> {
    await exec("herdr", ["agent", "send-keys", target, "ctrl+c"], { allowFailure: true });
  }
}

export function mapHerdrStatus(status?: string): "running" | "waiting_user" | "blocked" | undefined {
  if (status === "working") return "running";
  if (status === "blocked") return "blocked";
  if (status === "idle" || status === "done") return "waiting_user";
  return undefined;
}
