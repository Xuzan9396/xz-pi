import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SearchModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];
export type SearchAdapterKind = "responses" | "anthropic" | "oci-responses";
export type ResponsesFlavor = "openai" | "codex" | "xai" | "copilot";

export type SearchPreference =
  | { mode: "auto" }
  | { mode: "current-provider" }
  | { mode: "fixed"; provider: string; model: string };

export const DEFAULT_SEARCH_PREFERENCE: SearchPreference = { mode: "current-provider" };

export function parseSearchPreference(value: unknown): SearchPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode === "auto") return { mode: "auto" };
  if (record.mode === "current-provider") return { mode: "current-provider" };
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return record.mode === "fixed" && provider && model ? { mode: "fixed", provider, model } : undefined;
}

export function cloneSearchPreference(preference: SearchPreference): SearchPreference {
  return preference.mode === "fixed" ? { ...preference } : { mode: preference.mode };
}

export interface SearchInput {
  query: string;
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  provider?: string;
  model?: string;
}

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchOutput {
  answer: string;
  sources: SearchSource[];
  provider: string;
  model: string;
}

export interface SearchRoute {
  provider: string;
  model: string;
  adapter: SearchAdapterKind;
  flavor?: ResponsesFlavor;
  label: string;
  verified: boolean;
}

export interface DomainFilters {
  allowed: string[];
  blocked: string[];
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

export function normalizeDomainFilters(values: readonly string[] = []): DomainFilters {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of values) {
    const domain = domainName(raw);
    if (!domain) continue;
    const list = raw.trim().startsWith("-") ? blocked : allowed;
    if (!list.includes(domain)) list.push(domain);
  }
  return { allowed, blocked };
}

export function routeKey(route: Pick<SearchRoute, "provider" | "model">): string {
  return `${route.provider}/${route.model}`;
}
