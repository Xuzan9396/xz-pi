import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const GAP = "  ";

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string, home = homedir()): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  const insideHome = relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome ? `~${sep}${relativeToHome}` : "~";
}

export function formatFooterLocation(
  cwd: string,
  branch: string | null | undefined,
  sessionName: string | null | undefined,
  styleBranch: (text: string) => string = (text) => text,
): string {
  let location = formatCwd(cwd);
  if (branch) location += ` (${styleBranch(branch)})`;
  if (sessionName) location += ` • ${sessionName}`;
  return location;
}

function joinSides(left: string, right: string, width: number): string {
  const padding = Math.max(GAP.length, width - visibleWidth(left) - visibleWidth(right));
  return left + " ".repeat(padding) + right;
}

export function colorModelForThinking(
  theme: Pick<Theme, "getThinkingBorderColor">,
  thinkingLevel: ExtensionContext["thinkingLevel"],
  text: string,
): string {
  return theme.getThinkingBorderColor(thinkingLevel ?? "off")(text);
}

export function colorContextUsage(theme: Pick<Theme, "fg">, text: string): string {
  return theme.fg("borderAccent", text);
}

export interface CompactFooterHeader {
  pwd: string;
  context: string;
  provider?: string;
  model: string;
}

export function layoutFooterHeader(
  header: CompactFooterHeader,
  width: number,
  styleModel: (text: string) => string = (text) => text,
): string {
  if (width <= 0) return "";
  const left = `${header.pwd}${GAP}${header.context}`;
  const modelWithProvider = header.provider ? `(${header.provider}) ${header.model}` : header.model;
  if (visibleWidth(left) + GAP.length + visibleWidth(modelWithProvider) <= width) {
    return joinSides(left, styleModel(modelWithProvider), width);
  }
  if (visibleWidth(left) + GAP.length + visibleWidth(header.model) <= width) {
    return joinSides(left, styleModel(header.model), width);
  }

  const fixedWidth = visibleWidth(header.context) + GAP.length + visibleWidth(header.model);
  if (fixedWidth < width) {
    const pwdWidth = width - fixedWidth - GAP.length;
    const pwd = truncateToWidth(header.pwd, Math.max(0, pwdWidth), "...");
    return joinSides(pwd ? `${pwd}${GAP}${header.context}` : header.context, styleModel(header.model), width);
  }
  if (visibleWidth(header.context) + GAP.length + visibleWidth(header.model) <= width) {
    return joinSides(header.context, styleModel(header.model), width);
  }
  return styleModel(truncateToWidth(header.model, width, ""));
}

export class CompactUsageFooter implements Component {
  constructor(
    private readonly ctx: ExtensionContext,
    private readonly theme: Theme,
    private readonly footerData: ReadonlyFooterDataProvider,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const usage = this.ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
    const percent = usage?.percent === null ? undefined : (usage?.percent ?? 0).toFixed(1);
    const context = colorContextUsage(
      this.theme,
      `${percent === undefined ? "?" : `${percent}%`}/${formatTokens(contextWindow)} (auto)`,
    );
    const pwd = formatFooterLocation(
      this.ctx.sessionManager.getCwd(),
      this.footerData.getGitBranch(),
      this.ctx.sessionManager.getSessionName(),
      (branch) => this.theme.fg("success", branch),
    );

    const modelId = this.ctx.model?.id ?? "no-model";
    const model = this.ctx.model?.reasoning
      ? `${modelId} • ${this.ctx.thinkingLevel === "off" ? "thinking off" : (this.ctx.thinkingLevel ?? "off")}`
      : modelId;
    const provider = this.footerData.getAvailableProviderCount() > 1 ? this.ctx.model?.provider : undefined;
    const header = layoutFooterHeader(
      { pwd, context, ...(provider ? { provider } : {}), model },
      width,
      (text) => colorModelForThinking(this.theme, this.ctx.thinkingLevel, text),
    );
    const lines = [this.theme.fg("dim", header)];

    const statuses = Array.from(this.footerData.getExtensionStatuses().entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(text));
    if (statuses.length > 0) {
      lines.push(truncateToWidth(statuses.join(" "), width, this.theme.fg("dim", "...")));
    }
    return lines;
  }
}
