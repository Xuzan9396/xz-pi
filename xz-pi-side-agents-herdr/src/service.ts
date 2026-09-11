import { access, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { git } from "./process.js";
import { Herdr, mapHerdrStatus } from "./herdr.js";
import { choosePlacement } from "./layout.js";
import { nextIdentity, taskHint } from "./naming.js";
import { Store } from "./store.js";
import { ENV, type AgentRecord, type StartResult } from "./types.js";

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const now = () => new Date().toISOString();
const pathExists = async (path: string) => access(path).then(() => true, () => false);

export function buildBootstrapCommand(startScript: string, root: string, worktree: string, id: string, marker: string): string {
  // Keep `${marker}:` out of the echoed shell command. wait-output otherwise
  // matches the command line before the shell has executed the bootstrap.
  return `marker=${quote(marker)}; if [ -x ${quote(startScript)} ]; then ${quote(startScript)} ${quote(root)} ${quote(worktree)} ${quote(id)}; fi; code=$?; printf '\\n%s:%s\\n' "$marker" "$code"`;
}

export interface StartOptions { task: string; branchHint?: string; model?: string; resumeId?: string }

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
}

async function worktreePaths(root: string): Promise<string[]> {
  const output = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
  return output.split(/\r?\n/).filter(line => line.startsWith("worktree ")).map(line => resolve(line.slice(9).trim()));
}

async function syncLocalFiles(root: string, worktree: string): Promise<void> {
  const names = ["side-agent-start.sh", "side-agent-finish.sh", "side-agent-skills"];
  await mkdir(join(worktree, ".pi"), { recursive: true });
  for (const name of names) {
    const source = join(root, ".pi", name);
    try { await readFile(source); } catch {
      try { if (!(await readdir(source)).length && name === "side-agent-skills") continue; } catch { continue; }
    }
    const target = join(worktree, ".pi", name);
    await rm(target, { recursive: true, force: true });
    await symlink(source, target, process.platform === "win32" ? "junction" : undefined);
  }
}

export class SideAgentService {
  constructor(readonly root: string, readonly store = new Store(root), readonly herdr = new Herdr()) {}

  async start(ctx: ExtensionContext, options: StartOptions): Promise<StartResult> {
    await this.herdr.ensureReady();
    const config = await this.store.config();
    if (options.resumeId) return this.resume(ctx, options.resumeId, options.model);

    const branchOutput = (await git(this.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/side-agent/"])).stdout;
    const paths = await worktreePaths(this.root);
    const baseCommit = (await git(this.root, ["rev-parse", `refs/heads/${config.mainBranch}`])).stdout.trim();
    let record!: AgentRecord;
    // Allocate and reserve the id under the registry lock. Two parent Pi
    // sessions may call agent-start concurrently for the same feature.
    await this.store.mutate(registry => {
      const identity = nextIdentity(
        this.root,
        options.branchHint ?? taskHint(options.task),
        registry,
        paths,
        branchOutput.split(/\r?\n/).filter(Boolean),
      );
      record = {
        ...identity,
        task: options.task,
        status: "allocating_worktree",
        mainBranch: config.mainBranch,
        baseCommit,
        warnings: [],
        parentSessionId: ctx.sessionManager.getSessionFile(),
        model: options.model,
        startedAt: now(), updatedAt: now(),
      };
      registry.agents[record.id] = record;
    });

    let paneId: string | undefined;
    try {
      await git(this.root, ["worktree", "add", "-b", record.branch, record.worktreePath, baseCommit]);
      await syncLocalFiles(this.root, record.worktreePath);
      await this.update(record.id, { status: "spawning_pane" });

      const placement = await this.placement(record.id, config.mainPaneRatio, config.childSplitRatio);
      const pane = await this.herdr.split({
        ...placement, cwd: record.worktreePath,
        env: {
          [ENV.agentId]: record.id,
          [ENV.parentSession]: record.parentSessionId ?? "",
          [ENV.parentRepo]: this.root,
          [ENV.stateRoot]: this.root,
        },
      });
      paneId = pane.pane_id;
      // The actual pane id cannot be known until split; the child can also read HERDR_PANE_ID directly.
      await this.update(record.id, {
        paneId, tabId: pane.tab_id, workspaceId: pane.workspace_id,
        herdrAgentName: record.id, status: "starting",
      });

      const startScript = join(record.worktreePath, ".pi", "side-agent-start.sh");
      const marker = `__XZ_SIDE_AGENT_BOOTSTRAP_${record.id}__`;
      const command = buildBootstrapCommand(startScript, this.root, record.worktreePath, record.id, marker);
      await this.herdr.run(paneId, command);
      const bootstrap = await this.herdr.waitOutput(paneId, `${marker}:`, 120_000);
      if (!bootstrap.includes(`${marker}:0`)) throw new Error("side-agent bootstrap failed");

      // Always pass this extension explicitly. This keeps child lifecycle hooks
      // available when the parent itself was started with `pi -e <local-path>`;
      // Pi de-duplicates an already installed extension by resolved path.
      const args: string[] = ["--extension", fileURLToPath(new URL("../index.ts", import.meta.url))];
      if (options.model) args.push("--model", options.model);
      const skills = join(record.worktreePath, ".pi", "side-agent-skills");
      try { await readdir(skills); args.push("--skill", skills); } catch { /* optional */ }
      const startup = await this.herdr.startAgent(record.id, paneId, args);
      if (startup === "blocked") {
        const warning = "Child Pi is blocked during startup; inspect its Herdr pane. The kickoff task will be submitted after it becomes idle.";
        await this.update(record.id, { status: "blocked", kickoffPending: true, warnings: [...record.warnings, warning] });
      } else {
        await this.update(record.id, { status: "running" });
        await this.herdr.prompt(record.id, `${options.task}\n\nParent Pi session: ${record.parentSessionId ?? "unknown"}`);
      }
      return this.result(await this.requireRecord(record.id));
    } catch (error) {
      await this.update(record.id, { status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: now() });
      if (paneId) await this.herdr.closePane(paneId);
      const dirty = await git(record.worktreePath, ["status", "--porcelain"]).catch(() => ({ stdout: "dirty", stderr: "" }));
      const commits = await git(record.worktreePath, ["rev-list", "--count", `${record.baseCommit}..${record.branch}`]).catch(() => ({ stdout: "1", stderr: "" }));
      if (!dirty.stdout.trim() && Number(commits.stdout.trim()) === 0) {
        const removed = await git(this.root, ["worktree", "remove", record.worktreePath]).then(() => true, () => false);
        if (removed) {
          await git(this.root, ["branch", "-D", record.branch]).catch(() => undefined);
          await this.store.mutate(registry => { delete registry.agents[record.id]; });
        }
      }
      throw error;
    }
  }

  async resume(ctx: ExtensionContext, id: string, model?: string): Promise<StartResult> {
    const record = await this.requireRecord(id);
    if (record.status !== "paused" && record.status !== "failed" && record.status !== "crashed") throw new Error(`${id} is not resumable`);
    if (!record.childSessionId) throw new Error(`${id} has no child session to resume`);
    if (!(await pathExists(record.worktreePath))) {
      const branchExists = await git(this.root, ["rev-parse", "--verify", `refs/heads/${record.branch}`]).then(() => true, () => false);
      if (!branchExists) throw new Error(`${id} cannot resume: branch ${record.branch} no longer exists`);
      await git(this.root, ["worktree", "add", record.worktreePath, record.branch]);
      await syncLocalFiles(this.root, record.worktreePath);
    }
    let paneId = record.paneId;
    if (!paneId || !(await this.herdr.getAgent(paneId)) && !(await this.paneExists(paneId))) {
      const config = await this.store.config();
      const placement = await this.placement(record.id, config.mainPaneRatio, config.childSplitRatio);
      const pane = await this.herdr.split({
        ...placement, cwd: record.worktreePath,
        env: { [ENV.agentId]: id, [ENV.parentSession]: record.parentSessionId ?? "", [ENV.parentRepo]: this.root, [ENV.stateRoot]: this.root },
      });
      paneId = pane.pane_id;
      await this.update(id, { paneId, tabId: pane.tab_id, workspaceId: pane.workspace_id });
    }
    const args = ["--extension", fileURLToPath(new URL("../index.ts", import.meta.url)), "--session", record.childSessionId];
    if (model) args.unshift("--model", model);
    const startup = await this.herdr.startAgent(id, paneId, args);
    await this.update(id, { status: startup === "blocked" ? "blocked" : "waiting_user", finishedAt: undefined, error: undefined });
    return this.result(await this.requireRecord(id));
  }

  private async placement(excludeId: string, mainRatio = 0.72, childRatio = 0.5): Promise<{ targetPaneId: string; direction: "right" | "down"; ratio: number }> {
    const callerPane = process.env.HERDR_PANE_ID;
    if (!callerPane) throw new Error("HERDR_PANE_ID is missing");
    const layout = await this.herdr.layout(callerPane);
    const visible = new Set(layout.panes.map(pane => pane.pane_id));
    const registry = await this.store.load();
    const childPaneIds = Object.values(registry.agents)
      .filter(record => record.id !== excludeId && record.paneId && visible.has(record.paneId) && !["failed", "crashed"].includes(record.status))
      .map(record => record.paneId!);
    return choosePlacement(callerPane, layout.panes, childPaneIds, mainRatio, childRatio);
  }

  private async paneExists(paneId: string): Promise<boolean> {
    const result = await import("./process.js").then(({ exec }) => exec("herdr", ["pane", "get", paneId], { allowFailure: true }));
    return Boolean(result.stdout.trim());
  }

  private async reconcileMissingResources(record: AgentRecord): Promise<AgentRecord | undefined> {
    if (await pathExists(record.worktreePath)) return record;
    if (record.paneId && await this.paneExists(record.paneId)) return record;

    const branchExists = await git(this.root, ["rev-parse", "--verify", `refs/heads/${record.branch}`]).then(() => true, () => false);
    if (branchExists) {
      const merged = await git(this.root, ["merge-base", "--is-ancestor", record.branch, record.mainBranch]).then(() => true, () => false);
      if (!merged) {
        if (record.paneId) return this.update(record.id, { paneId: undefined, tabId: undefined, workspaceId: undefined });
        return record;
      }
      await git(this.root, ["branch", "-D", record.branch]);
    }
    await this.store.mutate(registry => { delete registry.agents[record.id]; });
    return undefined;
  }

  async refresh(id: string): Promise<AgentRecord | undefined> {
    const record = (await this.store.load()).agents[id];
    if (!record) return undefined;
    if (["paused", "cleaning", "failed", "crashed"].includes(record.status)) return this.reconcileMissingResources(record);
    if (["allocating_worktree", "spawning_pane", "starting"].includes(record.status) || !record.paneId) return record;
    const agent = await this.herdr.getAgent(record.herdrAgentName ?? record.paneId);
    const mapped = mapHerdrStatus(agent?.agent_status);
    if (mapped === "waiting_user" && record.kickoffPending && record.herdrAgentName) {
      await this.herdr.prompt(record.herdrAgentName, `${record.task}\n\nParent Pi session: ${record.parentSessionId ?? "unknown"}`);
      return this.update(id, { status: "running", kickoffPending: false });
    }
    if (mapped && mapped !== record.status) return this.update(id, { status: mapped });
    if (!agent) {
      const paneExists = await this.paneExists(record.paneId);
      return this.update(id, { status: "crashed", error: paneExists ? "Child Pi disappeared but its Herdr pane remains" : "Herdr pane disappeared" });
    }
    return (await this.store.load()).agents[id];
  }

  async list(): Promise<AgentRecord[]> {
    const records = Object.values((await this.store.load()).agents);
    const refreshed = await Promise.all(records.map(record => this.refresh(record.id)));
    return refreshed.filter((record): record is AgentRecord => record !== undefined);
  }

  async send(id: string, prompt: string): Promise<{ ok: boolean; message: string }> {
    const record = await this.refresh(id);
    if (!record?.herdrAgentName) return { ok: false, message: `Unknown agent id: ${id}` };
    let payload = prompt;
    if (payload.startsWith("!")) {
      await this.herdr.interrupt(record.herdrAgentName);
      payload = payload.slice(1).trimStart();
      if (payload) await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (payload) await this.herdr.prompt(record.herdrAgentName, payload);
    await this.update(id, { status: "running" });
    return { ok: true, message: `Sent prompt to ${id}` };
  }

  async check(id: string): Promise<Record<string, unknown>> {
    const record = await this.refresh(id);
    if (!record) return { ok: false, error: `Unknown agent id: ${id}` };
    return { ok: true, agent: record, backlog: record.herdrAgentName ? await this.herdr.readAgent(record.herdrAgentName, 20) : [] };
  }

  async update(id: string, patch: Partial<AgentRecord>): Promise<AgentRecord> {
    let result: AgentRecord | undefined;
    await this.store.mutate(registry => {
      const record = registry.agents[id];
      if (!record) throw new Error(`Unknown agent id: ${id}`);
      Object.assign(record, patch, { updatedAt: now() });
      result = record;
    });
    return result!;
  }

  async requireRecord(id: string): Promise<AgentRecord> {
    const record = (await this.store.load()).agents[id];
    if (!record) throw new Error(`Unknown agent id: ${id}`);
    return record;
  }

  private result(record: AgentRecord): StartResult {
    if (!record.paneId) throw new Error(`Agent ${record.id} has no pane`);
    return { ok: true, id: record.id, task: record.task, paneId: record.paneId, tabId: record.tabId, workspaceId: record.workspaceId, worktreePath: record.worktreePath, branch: record.branch, warnings: record.warnings };
  }
}
