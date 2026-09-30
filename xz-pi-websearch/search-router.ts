import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { routeForAnthropicModel, runAnthropicSearch } from "./anthropic-search.ts";
import type { OciSearchAdapter } from "./oci-search.ts";
import { OCI_SEARCH_PROVIDER } from "./oci-search.ts";
import { routeForResponsesModel, runResponsesSearch } from "./openai-search.ts";
import {
  DEFAULT_SEARCH_PREFERENCE,
  routeKey,
  type SearchInput,
  type SearchModel,
  type SearchOutput,
  type SearchPreference,
  type SearchRoute,
} from "./search-types.ts";

export type { SearchPreference } from "./search-types.ts";

function providerPriority(provider: string): number {
  if (provider.startsWith("openai-codex")) return 0;
  if (provider === "github-copilot") return 1;
  if (provider === "openai") return 2;
  if (provider === "xai") return 3;
  if (provider === OCI_SEARCH_PROVIDER) return 4;
  if (provider === "anthropic") return 5;
  return 10;
}

function modelPriority(model: string): number {
  if (model === "grok-4.7") return 500;
  if (model.includes("terra")) return 400;
  if (model.includes("opus-5-5")) return 350;
  if (/^gpt-\d+(?:\.\d+)?$/u.test(model)) return 300;
  if (model.includes("sonnet-5")) return 250;
  if (model.includes("mini") || model.includes("haiku")) return 100;
  return 0;
}

function compareRoutes(a: SearchRoute, b: SearchRoute): number {
  return providerPriority(a.provider) - providerPriority(b.provider)
    || a.provider.localeCompare(b.provider)
    || modelPriority(b.model) - modelPriority(a.model)
    || b.model.localeCompare(a.model, undefined, { numeric: true });
}

export function discoverSearchRoutes(
  models: readonly SearchModel[],
  isAuthenticated: (model: SearchModel) => boolean,
): SearchRoute[] {
  const routes: SearchRoute[] = [];
  for (const model of models) {
    if (!isAuthenticated(model)) continue;
    const route = routeForResponsesModel(model) ?? routeForAnthropicModel(model);
    if (route && !routes.some((candidate) => routeKey(candidate) === routeKey(route))) routes.push(route);
  }
  return routes.sort(compareRoutes);
}

export async function listAvailableSearchRoutes(
  ctx: ExtensionContext,
  oci?: OciSearchAdapter,
  signal?: AbortSignal,
): Promise<SearchRoute[]> {
  const routes = discoverSearchRoutes(ctx.modelRegistry.getAll(), (model) => ctx.modelRegistry.hasConfiguredAuth(model));
  if (oci && await oci.isAvailable(signal) && !routes.some((route) => routeKey(route) === routeKey(oci.route))) {
    routes.push(oci.route);
  }
  return routes.sort(compareRoutes);
}

function routesForProvider(routes: readonly SearchRoute[], provider: string): SearchRoute[] {
  return routes.filter((route) => route.provider === provider).sort(compareRoutes);
}

export function automaticRouteCandidates(routes: readonly SearchRoute[], current?: SearchModel): SearchRoute[] {
  const ordered: SearchRoute[] = [];
  const add = (route: SearchRoute | undefined) => {
    if (route && !ordered.some((candidate) => routeKey(candidate) === routeKey(route))) ordered.push(route);
  };

  if (current) {
    add(routes.find((route) => route.provider === current.provider && route.model === current.id));
    for (const route of routesForProvider(routes, current.provider)) add(route);
  }
  for (const route of [...routes].sort(compareRoutes)) add(route);
  return ordered;
}

export function selectAutomaticRoute(routes: readonly SearchRoute[], current?: SearchModel): SearchRoute | undefined {
  return automaticRouteCandidates(routes, current)[0];
}

export function resolveSearchRoute(
  input: Pick<SearchInput, "provider" | "model">,
  routes: readonly SearchRoute[],
  current?: SearchModel,
  preference?: SearchPreference,
): SearchRoute {
  const provider = input.provider?.trim();
  const model = input.model?.trim();
  if (model && !provider) throw new Error("web_search model requires provider.");

  if (provider) {
    const matches = routesForProvider(routes, provider);
    const selected = model ? matches.find((route) => route.model === model) : matches[0];
    if (!selected) {
      const suffix = model ? `/${model}` : "";
      throw new Error(`Search route ${provider}${suffix} is not available or authenticated.`);
    }
    return selected;
  }

  const effective = preference ?? DEFAULT_SEARCH_PREFERENCE;
  if (effective.mode === "fixed") {
    const saved = routes.find((route) => route.provider === effective.provider && route.model === effective.model);
    if (!saved) throw new Error(`saved search route ${effective.provider}/${effective.model} is not available or authenticated.`);
    return saved;
  }

  if (effective.mode === "current-provider") {
    if (!current) throw new Error("Current model is unavailable, so its search provider cannot be selected. Run /xz-search.");
    const exact = routes.find((route) => route.provider === current.provider && route.model === current.id);
    if (exact) return exact;
    const sameProvider = routesForProvider(routes, current.provider)[0];
    if (sameProvider) return sameProvider;
    throw new Error(`current provider ${current.provider} has no available search route. Run /xz-search.`);
  }

  const automatic = selectAutomaticRoute(routes, current);
  if (!automatic) throw new Error("No authenticated search route is available. Run /login for a supported provider.");
  return automatic;
}

export interface SearchAdapters {
  oci?: OciSearchAdapter;
}

export async function runSearch(
  input: SearchInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  preference?: SearchPreference,
  adapters: SearchAdapters = {},
): Promise<SearchOutput> {
  const routes = await listAvailableSearchRoutes(ctx, adapters.oci, signal);
  const explicitlyRequestsOci = input.provider?.trim() === OCI_SEARCH_PROVIDER;
  const savedOci = preference?.mode === "fixed" && preference.provider === OCI_SEARCH_PROVIDER;
  if (adapters.oci && (explicitlyRequestsOci || savedOci) && !routes.some((route) => routeKey(route) === routeKey(adapters.oci!.route))) {
    routes.push(adapters.oci.route);
  }

  const route = resolveSearchRoute(input, routes, ctx.model, preference);
  if (route.adapter === "anthropic") return runAnthropicSearch(input, route, ctx, signal);
  if (route.adapter === "oci-responses") {
    if (!adapters.oci) throw new Error(`Search route ${route.provider}/${route.model} is not configured.`);
    return adapters.oci.run(input, signal);
  }
  return runResponsesSearch(input, route, ctx, signal);
}
