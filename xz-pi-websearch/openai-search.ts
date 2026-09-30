import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeDomainFilters,
  type ResponsesFlavor,
  type SearchInput,
  type SearchModel,
  type SearchOutput,
  type SearchRoute,
  type SearchSource,
} from "./search-types.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_API_MODEL = "gpt-5.6-terra";

interface ResolvedAuth {
  apiKey?: string;
  headers: Record<string, string | null>;
  baseUrl?: string;
}

function modelScore(model: SearchModel): number {
  if (model.provider === "github-copilot" && model.id === "grok-4.7") return 500;
  if (model.provider === "xai" && model.id === "grok-4.7") return 500;
  if (model.id.includes("terra")) return 300;
  if (/^gpt-\d+(?:\.\d+)?$/u.test(model.id)) return 200;
  if (model.id.includes("mini")) return 100;
  return 0;
}

export function isCodexSearchModel(model: Pick<SearchModel, "provider" | "api">): boolean {
  return model.provider === "openai-codex" || model.provider.startsWith("openai-codex-") || model.api === "openai-codex-responses";
}

export function responsesFlavor(model: Pick<SearchModel, "provider" | "api" | "id">): ResponsesFlavor | undefined {
  if (isCodexSearchModel(model)) return "codex";
  if (model.provider === "openai" && model.api === "openai-responses") return "openai";
  if (model.provider === "xai" && model.api === "openai-responses") return "xai";
  if (model.provider === "github-copilot" && model.api === "openai-responses") return "copilot";
  return undefined;
}

export function isResponsesSearchModel(model: Pick<SearchModel, "provider" | "api" | "id">): boolean {
  return responsesFlavor(model) !== undefined;
}

export function routeForResponsesModel(model: SearchModel): SearchRoute | undefined {
  const flavor = responsesFlavor(model);
  if (!flavor) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    adapter: "responses",
    flavor,
    label: `${model.provider} / ${model.id}`,
    verified: flavor === "codex" || flavor === "copilot",
  };
}

export function pickSearchModel(models: readonly SearchModel[], provider: string): SearchModel | undefined {
  return models
    .filter((model) => model.provider === provider && isResponsesSearchModel(model))
    .filter((model) => !/(?:^|-)(?:pro|ultra)(?:-|$)/u.test(model.id))
    .sort((a, b) => modelScore(b) - modelScore(a) || b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

export function searchModelCandidates(models: readonly SearchModel[], current?: SearchModel): SearchModel[] {
  const candidates: SearchModel[] = [];
  const add = (model: SearchModel | undefined) => {
    if (model && isResponsesSearchModel(model) && !candidates.some((item) => item.provider === model.provider && item.id === model.id)) {
      candidates.push(model);
    }
  };

  add(current);
  if (current) add(pickSearchModel(models, current.provider));

  const providers = [...new Set(models.filter(isResponsesSearchModel).map((model) => model.provider))]
    .sort((a, b) => Number(!a.startsWith("openai-codex")) - Number(!b.startsWith("openai-codex")) || a.localeCompare(b));
  for (const provider of providers) add(pickSearchModel(models, provider));
  return candidates;
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const value = part.replace(/-/gu, "+").replace(/_/gu, "/");
    return JSON.parse(Buffer.from(value.padEnd(Math.ceil(value.length / 4) * 4, "="), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function accountId(token: string): string | undefined {
  const auth = decodeJwt(token)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" ? id : undefined;
}

function instructions(input: SearchInput): string {
  const count = Math.max(1, Math.min(10, Math.floor(input.numResults ?? 5)));
  const lines = [
    "Search the web and answer only from the search evidence.",
    "Write a concise, well-organized answer with inline clickable citations.",
    `Use at most ${count} strong sources and prefer official or primary sources.`,
    "Do not exceed 800 words.",
  ];
  if (input.recencyFilter) {
    const names = { day: "24 hours", week: "week", month: "month", year: "year" } as const;
    lines.push(`Prefer evidence from the past ${names[input.recencyFilter]}.`);
  }
  return lines.join(" ");
}

export function buildResponsesSearchTool(input: SearchInput, route: SearchRoute): Record<string, unknown> {
  const { allowed, blocked } = normalizeDomainFilters(input.domainFilter);
  const xaiStyle = route.flavor === "xai" || route.flavor === "copilot";
  if (xaiStyle) {
    if (allowed.length > 5 || blocked.length > 5) throw new Error(`${route.provider} web search accepts at most 5 domains.`);
    if (allowed.length && blocked.length) throw new Error(`${route.provider} web search cannot combine allowed and excluded domains.`);
    const filters = allowed.length ? { allowed_domains: allowed } : blocked.length ? { excluded_domains: blocked } : undefined;
    return { type: "web_search", ...(filters ? { filters } : {}) };
  }
  if (allowed.length > 20 || blocked.length > 20) throw new Error(`${route.provider} web search accepts at most 20 domains per filter.`);
  const filters = {
    ...(allowed.length ? { allowed_domains: allowed } : {}),
    ...(blocked.length ? { blocked_domains: blocked } : {}),
  };
  return { type: "web_search", ...(Object.keys(filters).length ? { filters } : {}) };
}

export interface ParsedResponse {
  output: unknown[];
  sawSearch: boolean;
}

export async function parseResponse(response: Response): Promise<ParsedResponse> {
  const body = await response.text();
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { output?: unknown[] };
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    return { output, sawSearch: output.some(isSearchCall) };
  }

  const items: unknown[] = [];
  let completed: unknown[] | undefined;
  let sawSearch = false;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const event = JSON.parse(value) as Record<string, unknown>;
      if (typeof event.type === "string" && event.type.startsWith("response.web_search_call")) sawSearch = true;
      if (event.type === "response.output_item.done" && event.item) {
        items.push(event.item);
        sawSearch ||= isSearchCall(event.item);
      }
      if ((event.type === "response.done" || event.type === "response.completed") && event.response && typeof event.response === "object") {
        const output = (event.response as { output?: unknown[] }).output;
        if (Array.isArray(output)) completed = output;
      }
    } catch {
      // Ignore malformed SSE lines if other output is valid.
    }
  }
  const output = completed?.length ? completed : items;
  if (!output.length) throw new Error("Responses provider returned no parseable output.");
  return { output, sawSearch: sawSearch || output.some(isSearchCall) };
}

function isSearchCall(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "web_search_call";
}

export function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

export function extractSources(output: unknown[], limit = 5): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: unknown, rawTitle: unknown) => {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return;
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.searchParams.get("utm_source") === "openai") parsed.searchParams.delete("utm_source");
      url = parsed.toString();
    } catch { /* Keep provider URL as returned. */ }
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ title: typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : url, url });
  };

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue;
        const annotations = (part as { annotations?: unknown[] }).annotations;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
          if (annotation && typeof annotation === "object" && (annotation as { type?: unknown }).type === "url_citation") {
            add((annotation as Record<string, unknown>).url, (annotation as Record<string, unknown>).title);
          }
        }
      }
    }
    if (record.type === "web_search_call") {
      const action = record.action && typeof record.action === "object" ? record.action as Record<string, unknown> : {};
      for (const group of [action.sources, record.sources, record.results]) {
        if (!Array.isArray(group)) continue;
        for (const source of group) {
          if (!source || typeof source !== "object") continue;
          const value = source as Record<string, unknown>;
          add(value.url ?? value.source_website_url, value.title ?? value.caption);
        }
      }
    }
  }
  return sources.slice(0, limit);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  headers[name] = value;
}

function requestHeaders(model: SearchModel, route: SearchRoute, auth: ResolvedAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(model.headers ?? {})) if (value !== null) headers[name] = value;
  for (const [name, value] of Object.entries(auth.headers)) if (value !== null) setHeader(headers, name, value);
  if (route.flavor === "copilot") {
    Object.assign(headers, {
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "Editor-Version": "vscode/1.105.1",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
      "X-GitHub-Api-Version": "2025-04-01",
      "X-Initiator": "user",
    });
  }
  if (auth.apiKey) setHeader(headers, "Authorization", `Bearer ${auth.apiKey}`);
  setHeader(headers, "Content-Type", "application/json");
  if (route.flavor === "openai" || route.flavor === "codex") setHeader(headers, "OpenAI-Beta", "responses=experimental");
  if (route.flavor === "codex" && auth.apiKey) {
    const id = accountId(auth.apiKey);
    if (id) setHeader(headers, "chatgpt-account-id", id);
    setHeader(headers, "originator", "pi");
  }
  return headers;
}

function responseUrl(model: SearchModel, route: SearchRoute, auth: ResolvedAuth): string {
  if (route.flavor === "codex") return CODEX_URL;
  const base = auth.baseUrl ?? model.baseUrl;
  return `${base.replace(/\/$/u, "")}/responses`;
}

function credentialValues(auth: ResolvedAuth): string[] {
  const values = new Set<string>();
  if (auth.apiKey) values.add(auth.apiKey);
  for (const [name, value] of Object.entries(auth.headers)) {
    if (!value || !/authorization|api-key|token/iu.test(name)) continue;
    values.add(value);
    values.add(value.replace(/^Bearer\s+/iu, ""));
  }
  return [...values].filter(Boolean);
}

function redactError(text: string, auth: ResolvedAuth): string {
  let safe = text;
  for (const value of credentialValues(auth)) safe = safe.replaceAll(value, "<redacted>");
  return safe.slice(0, 300);
}

async function executeResponsesSearch(
  input: SearchInput,
  route: SearchRoute,
  model: SearchModel,
  auth: ResolvedAuth,
  signal?: AbortSignal,
): Promise<SearchOutput> {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(responseUrl(model, route, auth), {
    method: "POST",
    headers: requestHeaders(model, route, auth),
    signal: combined,
    body: JSON.stringify({
      model: route.model,
      instructions: instructions(input),
      input: [{ role: "user", content: [{ type: "input_text", text: input.query }] }],
      tools: [buildResponsesSearchTool(input, route)],
      include: ["web_search_call.action.sources"],
      tool_choice: "required",
      parallel_tool_calls: true,
      store: false,
      stream: true,
    }),
  });
  if (!response.ok) {
    const error = redactError(await response.text(), auth);
    throw new Error(`${route.provider} search failed (${response.status}): ${error}`);
  }
  const parsed = await parseResponse(response);
  if (!parsed.sawSearch) throw new Error(`${route.provider} response did not execute web_search.`);
  const answer = extractAnswer(parsed.output);
  const sources = extractSources(parsed.output, Math.max(1, Math.min(10, input.numResults ?? 5)));
  if (!answer && !sources.length) throw new Error(`${route.provider} search returned no answer or sources.`);
  return { answer, sources, provider: route.provider, model: route.model };
}

async function resolveModelAuth(model: SearchModel, ctx: ExtensionContext): Promise<ResolvedAuth | undefined> {
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return undefined;
  const headers = resolved.headers ?? {};
  const hasHeaderAuth = Object.keys(headers).some((name) => /authorization|api-key/iu.test(name));
  if (!resolved.apiKey && !hasHeaderAuth) return undefined;
  return { apiKey: resolved.apiKey, headers, baseUrl: resolved.baseUrl };
}

export async function runResponsesSearch(
  input: SearchInput,
  route: SearchRoute,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SearchOutput> {
  const model = ctx.modelRegistry.find(route.provider, route.model);
  if (!model || !isResponsesSearchModel(model)) throw new Error(`Search route ${route.provider}/${route.model} is not supported.`);
  const auth = await resolveModelAuth(model, ctx);
  if (!auth) throw new Error(`Search route ${route.provider}/${route.model} is not authenticated.`);
  return executeResponsesSearch(input, route, model, auth, signal);
}

// Compatibility entry point used until the provider-neutral router selects an explicit route.
export async function runSearch(input: SearchInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchOutput> {
  for (const model of searchModelCandidates(ctx.modelRegistry.getAll(), ctx.model)) {
    try {
      const auth = await resolveModelAuth(model, ctx);
      const route = routeForResponsesModel(model);
      if (auth && route) return executeResponsesSearch(input, route, model, auth, signal);
    } catch {
      // Try the next authenticated Responses provider.
    }
  }

  const key = process.env.OPENAI_API_KEY?.trim();
  const model = ctx.modelRegistry.find("openai", process.env.OPENAI_SEARCH_MODEL?.trim() || DEFAULT_API_MODEL);
  if (key && model) {
    const route = routeForResponsesModel(model);
    if (route) return executeResponsesSearch(input, route, model, { apiKey: key, headers: {} }, signal);
  }
  throw new Error("Web search unavailable. Select or authenticate a supported OpenAI/Codex, Copilot Grok, or xAI route.");
}

export type { SearchInput, SearchOutput, SearchSource } from "./search-types.ts";
