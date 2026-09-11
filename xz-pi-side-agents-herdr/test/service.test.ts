import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Herdr, LayoutPane } from "../src/herdr.js";
import { SideAgentService } from "../src/service.js";
import { Store } from "../src/store.js";

const run = promisify(execFile);

class FakeHerdr {
  panes: LayoutPane[] = [{ pane_id: "main", rect: { x: 0, y: 0, width: 200, height: 80 } }];
  splits: Array<{ targetPaneId: string; direction: string; ratio: number }> = [];
  prompts: Array<{ target: string; text: string }> = [];
  agentArgs: string[][] = [];
  async ensureReady() {}
  async layout() { return { panes: this.panes }; }
  async split(params: { targetPaneId: string; direction: "right" | "down"; ratio: number }) {
    this.splits.push(params);
    const pane_id = `child-${this.splits.length}`;
    this.panes.push({ pane_id, rect: { x: 144, y: 0, width: 56, height: this.splits.length === 1 ? 80 : 40 } });
    return { pane_id, tab_id: "tab", workspace_id: "workspace" };
  }
  async run() {}
  async waitOutput(_pane: string, marker: string) { return `${marker}0`; }
  async startAgent(_name: string, _pane: string, args: string[]) { this.agentArgs.push(args); return "ready" as const; }
  async prompt(target: string, text: string) { this.prompts.push({ target, text }); }
  async closePane() {}
  async getAgent() { return { pane_id: "child", agent_status: "working" }; }
  async readAgent() { return []; }
  async interrupt() {}
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const parent = await mkdtemp(join(tmpdir(), "xz-herdr-service-"));
  const repo = join(parent, "repo");
  await mkdir(repo);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await run("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(join(repo, "file.txt"), "base\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-qm", "base"]);
  const store = new Store(repo);
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.configPath, JSON.stringify({ version: 1, mainBranch: "main", mainPaneRatio: 0.72, childSplitRatio: 0.5, cleanupOnQuit: true }));
  const herdr = new FakeHerdr();
  const service = new SideAgentService(repo, store, herdr as unknown as Herdr);
  const ctx = { sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } } as ExtensionContext;
  return { repo, service, herdr, ctx };
}

test("service prunes a stale registry record after its merged worktree and pane are gone", async t => {
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "main";
  t.after(() => { if (previousPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousPane; });
  const { repo, service, ctx } = await fixture(t);
  const started = await service.start(ctx, { task: "finished", branchHint: "finished" });
  await service.update(started.id, { status: "paused", paneId: undefined });
  await run("git", ["-C", repo, "worktree", "remove", started.worktreePath]);
  await rm(started.worktreePath, { recursive: true, force: true });
  await assert.rejects(access(started.worktreePath));
  await run("git", ["-C", repo, "merge-base", "--is-ancestor", started.branch, "main"]);

  assert.deepEqual(await service.list(), []);
  await assert.rejects(run("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${started.branch}`]));
});

test("service creates named worktrees and places agents in a right-hand stack", async t => {
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "main";
  t.after(() => { if (previousPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousPane; });
  const { service, herdr, ctx } = await fixture(t);

  const first = await service.start(ctx, { task: "fix auth", branchHint: "fix-auth" });
  assert.equal(first.id, "fix-auth-0001");
  assert.match(first.worktreePath, /repo-agent-fix-auth-0001$/);
  assert.deepEqual({ targetPaneId: herdr.splits[0].targetPaneId, direction: herdr.splits[0].direction, ratio: herdr.splits[0].ratio }, { targetPaneId: "main", direction: "right", ratio: 0.72 });

  const second = await service.start(ctx, { task: "test auth", branchHint: "test-auth" });
  assert.equal(second.id, "test-auth-0001");
  assert.deepEqual({ targetPaneId: herdr.splits[1].targetPaneId, direction: herdr.splits[1].direction, ratio: herdr.splits[1].ratio }, { targetPaneId: "child-1", direction: "down", ratio: 0.5 });
  assert.equal(herdr.prompts.length, 2);
  assert.equal(herdr.agentArgs.length, 2);
  assert.equal(herdr.agentArgs.every(args => args.includes("--extension") && args.some(value => value.endsWith("/index.ts"))), true);
});
