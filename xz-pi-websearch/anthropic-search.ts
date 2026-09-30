import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeDomainFilters,
  type SearchInput,
  type SearchModel,
  type SearchOutput,
  type SearchRoute,
  type SearchSource,
} from "./search-types.ts";

const SEARCH_TIMEOUT_MS = 60_000;

interface AnthropicParsedResponse {
  answer: string;
  sources: SearchSource[];
  sawSearch: boolean;
}

export function isAnthropicSearchModel(model: Pick<SearchModel, "provider" | "api" | "id">): boolean {
  return model.provider === "anthropic" && model.api === "anthropic-messages";
}

export function routeForAnthropicModel(model: SearchModel): SearchRoute | undefined {
  if (!isAnthropicSearchModel(model)) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    adapter: "anthropic",
    label: `${model.provider} / ${model.id}`,
    verified: false,
  };
}

export function buildAnthropicSearchTool(input: SearchInput): Record<string, unknown> {
  const { allowed, blocked } = normalizeDomainFilters(input.domainFilter);
  if (allowed.length && blocked.length) throw new Error("Anthropic web search cannot combine allowed and blocked domains.");
  if (allowed.length > 20 || blocked.length > 20) throw new Error("Anthropic web search accepts at most 20 domains.");
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: Math.max(1, Math.min(5, Math.floor(input.numResults ?? 5))),
    ...(allowed.length ? { allowed_domains: allowed } : {}),
    ...(blocked.length ? { blocked_domains: blocked } : {}),
  };
}

function instructions(input: SearchInput): string {
  const count = Math.max(1, Math.min(10, Math.floor(input.numResults ?? 5)));
  const lines = [
    "Search the web and answer only from the search evidence.",
    "Write a concise, well-organized answer with inline citations.",
    `Use at most ${count} strong sources and prefer official or primary sources.`,
    "Do not exceed 800 words.",
  ];
  if (input.recencyFilter) {
    const names = { day: "24 hours", week: "week", month: "month", year: "year" } as const;
    lines.push(`Prefer evidence from the past ${names[input.recencyFilter]}.`);
  }
  return lines.join(" ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseAnthropicResponse(value: unknown, limit = 5): AnthropicParsedResponse {
  const body = record(value);
  const content = Array.isArray(body?.content) ? body.content : [];
  const answer: string[] = [];
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let sawSearch = false;

  const add = (urlValue: unknown, titleValue: unknown) => {
    if (typeof urlValue !== "string" || !urlValue.trim() || seen.has(urlValue)) return;
    seen.add(urlValue);
    sources.push({ title: typeof titleValue === "string" && titleValue.trim() ? titleValue : urlValue, url: urlValue });
  };

  for (const rawBlock of content) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block.type === "server_tool_use" && block.name === "web_search") sawSearch = true;
    if (block.type === "web_search_tool_result") {
      sawSearch = true;
      const results = Array.isArray(block.content) ? block.content : [];
      for (const rawResult of results) {
        const result = record(rawResult);
        if (result?.type === "web_search_result") add(result.url, result.title);
      }
    }
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim()) answer.push(block.text.trim());
      const citations = Array.isArray(block.citations) ? block.citations : [];
      for (const rawCitation of citations) {
        const citation = record(rawCitation);
        if (citation?.type === "web_search_result_location") add(citation.url, citation.title);
      }
    }
  }

  return { answer: answer.join("\n"), sources: sources.slice(0, limit), sawSearch };
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  headers[name] = value;
}

function secretValues(apiKey: string | undefined, headers: Record<string, string | null>): string[] {
  const values = new Set<string>();
  if (apiKey) values.add(apiKey);
  for (const [name, value] of Object.entries(headers)) {
    if (!value || !/authorization|api-key|token/iu.test(name)) continue;
    values.add(value);
    values.add(value.replace(/^Bearer\s+/iu, ""));
  }
  return [...values].filter(Boolean);
}

export async function runAnthropicSearch(
  input: SearchInput,
  route: SearchRoute,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchOutput> {
  const model = ctx.modelRegistry.find(route.provider, route.model);
  if (!model || !isAnthropicSearchModel(model)) throw new Error(`Search route ${route.provider}/${route.model} is not supported.`);
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) throw new Error(`Search route ${route.provider}/${route.model} auth failed: ${resolved.error}`);

  const authHeaders = resolved.headers ?? {};
  const hasHeaderAuth = Object.keys(authHeaders).some((name) => /authorization|api-key/iu.test(name));
  if (!resolved.apiKey && !hasHeaderAuth) throw new Error(`Search route ${route.provider}/${route.model} is not authenticated.`);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(model.headers ?? {})) if (value !== null) headers[name] = value;
  for (const [name, value] of Object.entries(authHeaders)) if (value !== null) setHeader(headers, name, value);
  if (resolved.apiKey) {
    if (ctx.modelRegistry.isUsingOAuth(model)) setHeader(headers, "Authorization", `Bearer ${resolved.apiKey}`);
    else setHeader(headers, "x-api-key", resolved.apiKey);
  }
  setHeader(headers, "anthropic-version", "2023-06-01");
  setHeader(headers, "content-type", "application/json");

  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const baseUrl = resolved.baseUrl ?? model.baseUrl;
  const response = await fetchImpl(`${baseUrl.replace(/\/$/u, "")}/v1/messages`, {
    method: "POST",
    headers,
    signal: combined,
    body: JSON.stringify({
      model: route.model,
      max_tokens: 1024,
      system: instructions(input),
      messages: [{ role: "user", content: input.query }],
      tools: [buildAnthropicSearchTool(input)],
      stream: false,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    let safe = text;
    for (const secret of secretValues(resolved.apiKey, authHeaders)) safe = safe.replaceAll(secret, "<redacted>");
    throw new Error(`${route.provider} search failed (${response.status}): ${safe.slice(0, 300)}`);
  }

  const parsed = parseAnthropicResponse(JSON.parse(text), Math.max(1, Math.min(10, input.numResults ?? 5)));
  if (!parsed.sawSearch) throw new Error(`${route.provider} response did not execute web_search.`);
  if (!parsed.answer && !parsed.sources.length) throw new Error(`${route.provider} search returned no answer or sources.`);
  return { answer: parsed.answer, sources: parsed.sources, provider: route.provider, model: route.model };
}
