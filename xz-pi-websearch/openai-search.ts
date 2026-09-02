import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_API_MODEL = "gpt-5.6-terra";

export interface SearchInput {
  query: string;
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
}

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchOutput {
  answer: string;
  sources: SearchSource[];
  provider: "openai-codex" | "openai";
  model: string;
}

type Model = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];
type Headers = Record<string, string | null>;

interface Auth {
  provider: "openai-codex" | "openai";
  apiKey: string;
  headers: Headers;
  model: string;
  url: string;
  codex: boolean;
}

function modelScore(model: Model): number {
  if (model.id.includes("terra")) return 300;
  if (/^gpt-\d+(?:\.\d+)?$/u.test(model.id)) return 200;
  if (model.id.includes("mini")) return 100;
  return 0;
}

export function pickSearchModel(models: readonly Model[], provider: string): Model | undefined {
  return models
    .filter((model) => model.provider === provider && /^gpt-/u.test(model.id))
    .filter((model) => !/(?:^|-)(?:pro|ultra)(?:-|$)/u.test(model.id))
    .sort((a, b) => modelScore(b) - modelScore(a) || b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
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

async function resolveAuth(ctx: ExtensionContext): Promise<Auth> {
  const models = ctx.modelRegistry.getAll();
  for (const provider of ["openai-codex", "openai"] as const) {
    const model = pickSearchModel(models, provider);
    if (!model) continue;
    try {
      const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!resolved.ok || !resolved.apiKey) continue;
      const codex = provider === "openai-codex";
      return {
        provider,
        apiKey: resolved.apiKey,
        headers: resolved.headers ?? {},
        model: model.id,
        url: codex ? CODEX_URL : OPENAI_URL,
        codex,
      };
    } catch {
      // Try the next official OpenAI provider.
    }
  }

  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) {
    return {
      provider: "openai",
      apiKey: key,
      headers: {},
      model: process.env.OPENAI_SEARCH_MODEL?.trim() || DEFAULT_API_MODEL,
      url: OPENAI_URL,
      codex: false,
    };
  }
  throw new Error("OpenAI web search unavailable. Run /login for Codex or set OPENAI_API_KEY.");
}

function domainName(raw: string): string | undefined {
  let value = raw.trim().replace(/^-/, "");
  if (!value) return undefined;
  try {
    value = new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu.test(value) ? value.toLowerCase() : undefined;
}

function searchTool(input: SearchInput): Record<string, unknown> {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of input.domainFilter ?? []) {
    const domain = domainName(raw);
    if (!domain) continue;
    const list = raw.trim().startsWith("-") ? blocked : allowed;
    if (!list.includes(domain)) list.push(domain);
  }
  const filters = {
    ...(allowed.length ? { allowed_domains: allowed.slice(0, 20) } : {}),
    ...(blocked.length ? { blocked_domains: blocked.slice(0, 20) } : {}),
  };
  return { type: "web_search", ...(Object.keys(filters).length ? { filters } : {}) };
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
      // Ignore keepalive or malformed SSE lines if other output is valid.
    }
  }
  const output = completed?.length ? completed : items;
  if (!output.length) throw new Error("OpenAI returned no parseable output.");
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

function requestHeaders(auth: Auth): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers)) if (value !== null) headers[name] = value;
  headers.Authorization = `Bearer ${auth.apiKey}`;
  headers["Content-Type"] = "application/json";
  headers["OpenAI-Beta"] = "responses=experimental";
  if (auth.codex) {
    const id = accountId(auth.apiKey);
    if (id) headers["chatgpt-account-id"] = id;
    headers.originator = "pi";
  }
  return headers;
}

export async function runSearch(input: SearchInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchOutput> {
  const auth = await resolveAuth(ctx);
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(auth.url, {
    method: "POST",
    headers: requestHeaders(auth),
    signal: combined,
    body: JSON.stringify({
      model: auth.model,
      instructions: instructions(input),
      input: [{ role: "user", content: [{ type: "input_text", text: input.query }] }],
      tools: [searchTool(input)],
      include: ["web_search_call.action.sources"],
      tool_choice: "required",
      parallel_tool_calls: true,
      store: false,
      stream: true,
    }),
  });
  if (!response.ok) {
    const error = (await response.text()).replaceAll(auth.apiKey, "<redacted>").slice(0, 300);
    throw new Error(`OpenAI search failed (${response.status}): ${error}`);
  }
  const parsed = await parseResponse(response);
  if (!parsed.sawSearch) throw new Error("OpenAI response did not execute web_search.");
  const answer = extractAnswer(parsed.output);
  const sources = extractSources(parsed.output, Math.max(1, Math.min(10, input.numResults ?? 5)));
  if (!answer && !sources.length) throw new Error("OpenAI search returned no answer or sources.");
  return { answer, sources, provider: auth.provider, model: auth.model };
}
