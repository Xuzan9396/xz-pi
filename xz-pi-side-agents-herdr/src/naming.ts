import { basename, dirname, join } from "node:path";
import type { Registry } from "./types.js";

export function featureSlug(raw: string): string {
  let slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = "task";
  if (!/^[a-z]/.test(slug)) slug = `task-${slug}`;
  return slug.slice(0, 22).replace(/-+$/g, "") || "task";
}

export function nextIdentity(repoRoot: string, hint: string, registry: Registry, existingPaths: string[], existingBranches: string[] = []): {
  id: string;
  feature: string;
  number: number;
  branch: string;
  worktreePath: string;
} {
  const feature = featureSlug(hint);
  const parent = dirname(repoRoot);
  const repo = basename(repoRoot);
  let number = 1;
  const occupied = new Set(existingPaths);
  const branches = new Set(existingBranches);
  while (true) {
    const suffix = String(number).padStart(4, "0");
    const id = `${feature}-${suffix}`;
    const worktreePath = join(parent, `${repo}-agent-${feature}-${suffix}`);
    if (!registry.agents[id] && !occupied.has(worktreePath) && !branches.has(`side-agent/${id}`)) {
      return { id, feature, number, branch: `side-agent/${id}`, worktreePath };
    }
    number += 1;
  }
}

export function taskHint(task: string): string {
  return featureSlug(task.split(/\s+/).slice(0, 3).join("-"));
}
