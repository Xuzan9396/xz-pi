import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { TempWorkspace } from "./web-content.ts";
import { safeFetch } from "./web-content.ts";

const MAX_CLONE_MB = 350;
const COMMAND_TIMEOUT_MS = 60_000;

type Exec = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type GitHubKind = "repo" | "tree" | "blob" | "pull" | "issue";

export interface GitHubTarget {
  owner: string;
  repo: string;
  kind: GitHubKind;
  number?: number;
  parts: string[];
  url: string;
}

export interface GitHubResult {
  title: string;
  content: string;
  localPath?: string;
}

interface RepoMeta {
  size?: number;
  default_branch?: string;
  description?: string | null;
  html_url?: string;
}

function cleanSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseGitHubUrl(raw: string): GitHubTarget | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean).map(cleanSegment);
  if (parts.length < 2 || !/^[\w.-]+$/u.test(parts[0]!) || !/^[\w.-]+$/u.test(parts[1]!)) return undefined;
  const [owner, rawRepo] = parts;
  const repo = rawRepo!.replace(/\.git$/u, "");
  const marker = parts[2];
  if (marker === "pull" && /^\d+$/u.test(parts[3] ?? "")) return { owner: owner!, repo, kind: "pull", number: Number(parts[3]), parts: [], url: raw };
  if (marker === "issues" && /^\d+$/u.test(parts[3] ?? "")) return { owner: owner!, repo, kind: "issue", number: Number(parts[3]), parts: [], url: raw };
  if (marker === "tree" || marker === "blob") return { owner: owner!, repo, kind: marker, parts: parts.slice(3), url: raw };
  return { owner: owner!, repo, kind: "repo", parts: [], url: raw };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatPerson(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const item = value as Record<string, unknown>;
  return String(item.login ?? item.name ?? "unknown");
}

function bodyText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "(no description)";
}

export class GitHubHandler {
  private readonly clones = new Map<string, string>();
  private readonly exec: Exec;
  private readonly workspace: TempWorkspace;

  constructor(exec: Exec, workspace: TempWorkspace) {
    this.exec = exec;
    this.workspace = workspace;
  }

  private async api(path: string, signal?: AbortSignal): Promise<unknown> {
    const gh = await this.exec("gh", ["api", path], { signal, timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    if (gh?.code === 0 && gh.stdout.trim()) return JSON.parse(gh.stdout);
    const { response, bytes } = await safeFetch(`https://api.github.com${path}`, signal, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    if (!response.ok) throw new Error(`GitHub API failed (${response.status}).`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  private async metadata(target: GitHubTarget, signal?: AbortSignal): Promise<RepoMeta> {
    return await this.api(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`, signal) as RepoMeta;
  }

  private async clone(target: GitHubTarget, signal?: AbortSignal): Promise<string> {
    const key = `${target.owner}/${target.repo}`.toLowerCase();
    const cached = this.clones.get(key);
    if (cached) return cached;
    const root = await this.workspace.ensure();
    const path = join(root, `repo-${target.owner}-${target.repo}`.replace(/[^a-z0-9_.-]/giu, "-"));
    await mkdir(root, { recursive: true });

    let result = await this.exec("gh", ["repo", "clone", `${target.owner}/${target.repo}`, path, "--", "--depth=1"], { signal, timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    if (!result || result.code !== 0) {
      await rm(path, { recursive: true, force: true });
      result = await this.exec("git", ["clone", "--depth=1", `https://github.com/${target.owner}/${target.repo}.git`, path], { signal, timeout: COMMAND_TIMEOUT_MS });
    }
    if (result.code !== 0) throw new Error(`GitHub clone failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
    this.clones.set(key, path);
    return path;
  }

  private async listLocal(repoPath: string, ref = "HEAD", path?: string, signal?: AbortSignal): Promise<string[]> {
    const spec = path ? `${ref}:${path}` : ref;
    const result = await this.exec("git", ["-C", repoPath, "ls-tree", "--name-only", spec], { signal, timeout: 20_000 });
    if (result.code !== 0) throw new Error(`Cannot list GitHub tree: ${result.stderr.slice(0, 300)}`);
    return result.stdout.split("\n").filter(Boolean).slice(0, 500);
  }

  private async resolveRef(repoPath: string, parts: string[], defaultBranch: string, signal?: AbortSignal): Promise<{ ref: string; path: string }> {
    const defaultParts = defaultBranch.split("/");
    if (parts.slice(0, defaultParts.length).join("/") === defaultBranch) {
      return { ref: "HEAD", path: parts.slice(defaultParts.length).join("/") };
    }
    for (let length = 1; length <= Math.min(4, parts.length); length++) {
      const ref = parts.slice(0, length).join("/");
      if (!ref || ref.startsWith("-") || ref.includes("..")) continue;
      const result = await this.exec("git", ["-C", repoPath, "fetch", "--depth=1", "origin", ref], { signal, timeout: COMMAND_TIMEOUT_MS });
      if (result.code === 0) return { ref: "FETCH_HEAD", path: parts.slice(length).join("/") };
    }
    throw new Error("Could not resolve the GitHub branch or tag in this URL.");
  }

  private async lightweight(target: GitHubTarget, meta: RepoMeta, signal?: AbortSignal): Promise<GitHubResult> {
    const branch = meta.default_branch || "HEAD";
    if (target.kind === "repo") {
      const tree = await this.api(`/repos/${target.owner}/${target.repo}/contents?ref=${encodeURIComponent(branch)}`, signal) as Array<Record<string, unknown>>;
      const lines = Array.isArray(tree) ? tree.slice(0, 500).map((item) => `${item.type === "dir" ? "d" : "f"} ${item.path}`) : [];
      return { title: `${target.owner}/${target.repo}`, content: `${meta.description ?? ""}\n\nDefault branch: ${branch}\nLarge repository: API view used instead of cloning.\n\n${lines.join("\n")}`.trim() };
    }
    const refAndPath = this.urlRefAndPath(target.parts, branch);
    const data = await this.api(`/repos/${target.owner}/${target.repo}/contents/${encodePath(refAndPath.path)}?ref=${encodeURIComponent(refAndPath.ref)}`, signal) as Record<string, unknown> | Array<Record<string, unknown>>;
    if (Array.isArray(data)) {
      return { title: `${target.owner}/${target.repo}/${refAndPath.path}`, content: data.slice(0, 500).map((item) => `${item.type === "dir" ? "d" : "f"} ${item.path}`).join("\n") };
    }
    if (data.type === "file" && typeof data.content === "string") {
      const content = Buffer.from(data.content.replace(/\n/gu, ""), String(data.encoding) === "base64" ? "base64" : "utf8").toString("utf8");
      return { title: `${target.owner}/${target.repo}/${refAndPath.path}`, content };
    }
    throw new Error("Unsupported GitHub content response.");
  }

  private urlRefAndPath(parts: string[], defaultBranch: string): { ref: string; path: string } {
    const branchParts = defaultBranch.split("/");
    if (parts.slice(0, branchParts.length).join("/") === defaultBranch) return { ref: defaultBranch, path: parts.slice(branchParts.length).join("/") };
    return { ref: parts[0] || defaultBranch, path: parts.slice(1).join("/") };
  }

  private async repository(target: GitHubTarget, forceClone: boolean, signal?: AbortSignal): Promise<GitHubResult> {
    const meta = await this.metadata(target, signal);
    if (!forceClone && typeof meta.size === "number" && meta.size / 1024 > MAX_CLONE_MB) return this.lightweight(target, meta, signal);
    const repoPath = await this.clone(target, signal);
    if (target.kind === "repo") {
      const entries = await this.listLocal(repoPath, "HEAD", undefined, signal);
      return {
        title: `${target.owner}/${target.repo}`,
        localPath: repoPath,
        content: `${meta.description ?? ""}\n\nLocal clone: ${repoPath}\nDefault branch: ${meta.default_branch ?? "unknown"}\n\nTop-level files:\n${entries.join("\n")}`.trim(),
      };
    }

    const resolvedRef = await this.resolveRef(repoPath, target.parts, meta.default_branch || "main", signal);
    if (!resolvedRef.path || resolvedRef.path.split("/").includes("..")) throw new Error("GitHub URL does not contain a safe repository path.");
    const absolute = resolve(repoPath, resolvedRef.path);
    if (!absolute.startsWith(`${resolve(repoPath)}${sep}`)) throw new Error("GitHub path escapes the cloned repository.");

    if (target.kind === "tree") {
      const entries = await this.listLocal(repoPath, resolvedRef.ref, resolvedRef.path, signal);
      const localPath = resolvedRef.ref === "HEAD" ? absolute : undefined;
      return { title: `${target.owner}/${target.repo}/${resolvedRef.path}`, localPath, content: `${localPath ? `Local path: ${localPath}\n\n` : ""}${entries.join("\n")}` };
    }
    if (resolvedRef.ref !== "HEAD") {
      const shown = await this.exec("git", ["-C", repoPath, "show", `${resolvedRef.ref}:${resolvedRef.path}`], { signal, timeout: 20_000 });
      if (shown.code !== 0) throw new Error(`Cannot read GitHub file: ${shown.stderr.slice(0, 300)}`);
      return { title: `${target.owner}/${target.repo}/${resolvedRef.path}`, content: shown.stdout };
    }
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("GitHub blob URL does not point to a file.");
    return { title: `${target.owner}/${target.repo}/${resolvedRef.path}`, localPath: absolute, content: await readFile(absolute, "utf8") };
  }

  private formatGhView(target: GitHubTarget, data: Record<string, unknown>): GitHubResult {
    const lines = [
      `# ${String(data.title ?? `${target.kind} #${target.number}`)}`,
      "",
      `URL: ${String(data.html_url ?? data.url ?? target.url)}`,
      `State: ${String(data.state ?? "unknown")}`,
      `Author: ${formatPerson(data.author)}`,
    ];
    if (target.kind === "pull") {
      lines.push(`Draft: ${String(data.isDraft ?? false)}`, `Base → head: ${String(data.baseRefName ?? "?")} → ${String(data.headRefName ?? "?")}`, `Review: ${String(data.reviewDecision ?? "")}`, "");
    } else lines.push("");
    lines.push(bodyText(data.body));

    const addList = (heading: string, value: unknown, formatter: (item: Record<string, unknown>) => string) => {
      if (!Array.isArray(value) || !value.length) return;
      lines.push("", `## ${heading}`);
      for (const item of value.slice(0, 100)) if (item && typeof item === "object") lines.push(formatter(item as Record<string, unknown>));
    };
    addList("Comments", data.comments, (item) => `- ${formatPerson(item.author)}: ${bodyText(item.body)}`);
    addList("Reviews", data.reviews, (item) => `- ${formatPerson(item.author)} [${String(item.state ?? "")}]: ${bodyText(item.body)}`);
    addList("Files", data.files, (item) => `- ${String(item.path ?? item.filename ?? "")}`);
    addList("Commits", data.commits, (item) => `- ${String(item.oid ?? item.sha ?? "").slice(0, 12)} ${String(item.messageHeadline ?? item.commit ?? "")}`);
    addList("Checks", data.statusCheckRollup, (item) => `- ${String(item.name ?? item.context ?? "check")}: ${String(item.conclusion ?? item.state ?? item.status ?? "unknown")}`);
    return { title: String(data.title ?? `${target.kind} #${target.number}`), content: lines.join("\n") };
  }

  private async discussion(target: GitHubTarget, signal?: AbortSignal): Promise<GitHubResult> {
    const fields = target.kind === "pull"
      ? "number,title,state,author,body,url,baseRefName,headRefName,isDraft,reviewDecision,statusCheckRollup,commits,files,comments,reviews"
      : "number,title,state,author,body,url,comments";
    const gh = await this.exec("gh", [target.kind === "pull" ? "pr" : "issue", "view", target.url, "--json", fields], { signal, timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    if (gh?.code === 0) return this.formatGhView(target, JSON.parse(gh.stdout) as Record<string, unknown>);

    const base = `/repos/${target.owner}/${target.repo}`;
    if (target.kind === "issue") {
      const issue = await this.api(`${base}/issues/${target.number}`, signal) as Record<string, unknown>;
      const comments = await this.api(`${base}/issues/${target.number}/comments?per_page=100`, signal);
      return this.formatGhView(target, { ...issue, author: issue.user, comments: Array.isArray(comments) ? comments.map((item) => ({ ...(item as object), author: (item as Record<string, unknown>).user })) : [] });
    }
    const [pull, comments, reviews, files, commits] = await Promise.all([
      this.api(`${base}/pulls/${target.number}`, signal),
      this.api(`${base}/issues/${target.number}/comments?per_page=100`, signal),
      this.api(`${base}/pulls/${target.number}/reviews?per_page=100`, signal),
      this.api(`${base}/pulls/${target.number}/files?per_page=100`, signal),
      this.api(`${base}/pulls/${target.number}/commits?per_page=100`, signal),
    ]);
    const value = pull as Record<string, unknown>;
    const normalizeUsers = (items: unknown) => Array.isArray(items) ? items.map((item) => ({ ...(item as object), author: (item as Record<string, unknown>).user })) : [];
    return this.formatGhView(target, {
      ...value, author: value.user,
      baseRefName: (value.base as Record<string, unknown> | undefined)?.ref,
      headRefName: (value.head as Record<string, unknown> | undefined)?.ref,
      isDraft: value.draft,
      comments: normalizeUsers(comments), reviews: normalizeUsers(reviews), files, commits,
    });
  }

  async fetch(target: GitHubTarget, forceClone = false, signal?: AbortSignal): Promise<GitHubResult> {
    if (target.kind === "pull" || target.kind === "issue") return this.discussion(target, signal);
    return this.repository(target, forceClone, signal);
  }
}
