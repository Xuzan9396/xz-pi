import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GitHubHandler, parseGitHubUrl } from "./github.ts";
import { runSearch } from "./openai-search.ts";
import { fetchPage, inlineContent, TempWorkspace } from "./web-content.ts";

const MAX_SOURCES = 10;

export default function xzPiWebsearch(pi: ExtensionAPI) {
  const workspace = new TempWorkspace();
  const github = new GitHubHandler(
    async (command, args, options) => pi.exec(command, args, options),
    workspace,
  );

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search and summarize current web information using OpenAI/Codex Hosted Search, with citations. Use for facts that may be current or need online sources.",
    parameters: Type.Object({
      query: Type.String({ description: "Search question" }),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SOURCES, description: "Maximum sources (default 5)" })),
      recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Optional recency preference" })),
      domainFilter: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Allowed domains; prefix - to exclude" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) throw new Error("query is required.");
      onUpdate?.({ content: [{ type: "text", text: `Searching: ${query}` }], details: {} });
      const result = await runSearch({
        query,
        numResults: params.numResults,
        recencyFilter: params.recencyFilter,
        domainFilter: params.domainFilter,
      }, ctx, signal);
      const sources = result.sources.length
        ? `\n\n## Sources\n${result.sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join("\n")}`
        : "";
      const text = inlineContent(`${result.answer}${sources}`);
      return { content: [{ type: "text", text }], details: { provider: result.provider, model: result.model, sourceCount: result.sources.length } };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Read a public HTTP(S) page as Markdown. GitHub repository, tree, blob, pull-request, and issue URLs receive repository-aware handling. Long output is saved locally.",
    parameters: Type.Object({
      url: Type.String({ description: "Public HTTP(S) or GitHub URL" }),
      forceClone: Type.Optional(Type.Boolean({ description: "Clone a GitHub repository even when larger than 350MB" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const rawUrl = params.url.trim();
      if (!rawUrl) throw new Error("url is required.");
      const target = parseGitHubUrl(rawUrl);
      if (target) {
        onUpdate?.({ content: [{ type: "text", text: `Reading GitHub: ${target.owner}/${target.repo}` }], details: {} });
        const result = await github.fetch(target, params.forceClone ?? false, signal);
        let savedPath = result.localPath;
        if (result.content.length > 12_000 && (!savedPath || target.kind === "pull" || target.kind === "issue")) {
          savedPath = await workspace.savePage(rawUrl, result.title, result.content);
        }
        const header = `# ${result.title}\n\n${result.localPath ? `Local path: ${result.localPath}\n\n` : ""}`;
        return {
          content: [{ type: "text", text: `${header}${inlineContent(result.content, savedPath)}` }],
          details: { kind: `github-${target.kind}`, localPath: savedPath },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching: ${rawUrl}` }], details: {} });
      const page = await fetchPage(rawUrl, signal);
      const savedPath = await workspace.savePage(page.url, page.title, page.markdown);
      return {
        content: [{ type: "text", text: `# ${page.title}\n\nSource: ${page.url}\nSaved Markdown: ${savedPath}\n\n${inlineContent(page.markdown, savedPath)}` }],
        details: { kind: "web-page", url: page.url, localPath: savedPath, contentType: page.contentType },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await workspace.cleanup();
  });
}
