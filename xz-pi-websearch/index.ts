import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GitHubHandler, parseGitHubUrl } from "./github.ts";
import { createOciSearchAdapter, type OciSearchAdapter } from "./oci-search.ts";
import { listAvailableSearchRoutes, runSearch } from "./search-router.ts";
import { showSearchSelector } from "./search-selector.ts";
import { createSearchSessionState } from "./search-session.ts";
import { readSearchDefault, writeSearchDefault } from "./search-settings.ts";
import { fetchPage, inlineContent, TempWorkspace } from "./web-content.ts";

const MAX_SOURCES = 10;

interface WebsearchDependencies {
  ociSearch?: OciSearchAdapter;
  selectSearch?: typeof showSearchSelector;
}

export default function xzPiWebsearch(pi: ExtensionAPI, dependencies: WebsearchDependencies = {}) {
  const workspace = new TempWorkspace();
  const ociSearch = dependencies.ociSearch ?? createOciSearchAdapter();
  const selectSearch = dependencies.selectSearch ?? showSearchSelector;
  const searchSession = createSearchSessionState(
    (customType, data) => pi.appendEntry(customType, data),
    () => readSearchDefault(),
  );
  const github = new GitHubHandler(
    async (command, args, options) => pi.exec(command, args, options),
    workspace,
  );

  pi.on("session_start", async (event, ctx) => {
    ociSearch.clearSessionCache();
    await searchSession.restore(ctx, event.reason);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await searchSession.restore(ctx);
  });

  pi.registerCommand("xz-search", {
    description: "Choose the current-session web search route and optionally save its default",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("/xz-search does not accept arguments; run it without text to choose interactively.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/xz-search requires an interactive TUI or RPC client.", "warning");
        return;
      }
      const routes = await listAvailableSearchRoutes(ctx, ociSearch, ctx.signal);
      const savedDefault = await readSearchDefault();
      const selected = await selectSearch(ctx, routes, searchSession.current, savedDefault);
      if (!selected) return;

      searchSession.set(selected.preference);
      if (selected.saveDefault) await writeSearchDefault(selected.preference);
      const routeName = selected.preference.mode === "fixed"
        ? `${selected.preference.provider}/${selected.preference.model}`
        : selected.preference.mode;
      ctx.ui.notify(
        selected.saveDefault
          ? `Search route ${routeName} is active and saved as the default.`
          : `Search route ${routeName} is active for this session.`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search and summarize current web information using an authenticated provider/model search route, with citations. Use for facts that may be current or need online sources.",
    parameters: Type.Object({
      query: Type.String({ description: "Search question" }),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SOURCES, description: "Maximum sources (default 5)" })),
      recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Optional recency preference" })),
      domainFilter: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Allowed domains; prefix - to exclude" })),
      provider: Type.Optional(Type.String({ description: "Exact Pi provider id; omit for configured/automatic selection" })),
      model: Type.Optional(Type.String({ description: "Exact search model id; requires provider" })),
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
        provider: params.provider,
        model: params.model,
      }, ctx, signal, searchSession.current, { oci: ociSearch });
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
    ociSearch.clearSessionCache();
    await workspace.cleanup();
  });
}
