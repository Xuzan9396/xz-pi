import type { Model } from "@earendil-works/pi-ai";
import { buildModelSearchFields } from "./search.js";
import type { ModelDefaultState } from "./pi-settings.js";

export interface CatalogModelState {
  current?: ModelReference;
  defaults?: ModelDefaultState;
}

export type ModelScope = "all" | "scoped";

export interface ProviderCatalogPreferences {
  modelOrder?: readonly string[];
  visibleModels?: readonly string[];
}

export interface CatalogPreferences {
  providerOrder?: readonly string[];
  providers?: Readonly<Record<string, ProviderCatalogPreferences>>;
}

export interface ModelReference {
  provider: string;
  id: string;
}

export interface CatalogEntry {
  provider: string;
  id: string;
  fullId: string;
  name: string;
  model?: Model<any>;
  available: boolean;
  visible: boolean;
  current: boolean;
  default: boolean;
  globalDefault: boolean;
  projectDefault: boolean;
  searchFields: string[];
}

export interface ProviderGroup {
  provider: string;
  models: CatalogEntry[];
  visibleModels: CatalogEntry[];
  hiddenModels: CatalogEntry[];
}

function fullId(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function sameModel(model: ModelReference | undefined, provider: string, id: string): boolean {
  return model?.provider === provider && model.id === id;
}

function orderedValues(values: Iterable<string>, preferred: readonly string[] = []): string[] {
  const known = new Set(values);
  const ordered: string[] = [];
  for (const value of preferred) {
    if (!ordered.includes(value)) ordered.push(value);
  }
  const remaining = [...known].filter((value) => !ordered.includes(value));
  remaining.sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

export function resolveModelScope(
  allModels: readonly Model<any>[],
  scopedModels: readonly Model<any>[],
  scope: ModelScope,
): Model<any>[] {
  if (scope === "all" || scopedModels.length === 0) return [...allModels];
  const scopedIds = new Set(scopedModels.map((model) => fullId(model.provider, model.id)));
  return allModels.filter((model) => scopedIds.has(fullId(model.provider, model.id)));
}

export function applyCatalogPreferences(
  models: readonly Model<any>[],
  preferences: CatalogPreferences = {},
  state: CatalogModelState = {},
): ProviderGroup[] {
  const available = new Map(models.map((model) => [fullId(model.provider, model.id), model]));
  const providerIds = new Set(models.map((model) => model.provider));
  for (const provider of preferences.providerOrder ?? []) providerIds.add(provider);
  for (const provider of Object.keys(preferences.providers ?? {})) providerIds.add(provider);

  return orderedValues(providerIds, preferences.providerOrder).map((provider) => {
    const providerPreferences = preferences.providers?.[provider];
    const actualIds = models.filter((model) => model.provider === provider).map((model) => model.id);
    const configuredIds = [
      ...(providerPreferences?.modelOrder ?? []),
      ...(providerPreferences?.visibleModels ?? []),
    ];
    const modelIds = orderedValues([...actualIds, ...configuredIds], providerPreferences?.modelOrder);
    const visibleSet = providerPreferences?.visibleModels
      ? new Set(providerPreferences.visibleModels)
      : undefined;

    const entries = modelIds.map((id): CatalogEntry => {
      const model = available.get(fullId(provider, id));
      const isCurrent = sameModel(state.current, provider, id);
      const globalDefault = sameModel(state.defaults?.global, provider, id);
      const projectDefault = sameModel(state.defaults?.project, provider, id);
      const isDefault = globalDefault || projectDefault;
      const isAvailable = model !== undefined;
      const visible = isAvailable && (visibleSet === undefined || visibleSet.has(id));
      const searchable = model ?? { provider, id, name: id };
      return {
        provider,
        id,
        fullId: fullId(provider, id),
        name: model?.name ?? id,
        ...(model ? { model } : {}),
        available: isAvailable,
        visible,
        current: isCurrent,
        default: isDefault,
        globalDefault,
        projectDefault,
        searchFields: buildModelSearchFields(searchable, { current: isCurrent, default: isDefault }),
      };
    });

    return {
      provider,
      models: entries,
      visibleModels: entries.filter((entry) => entry.visible),
      hiddenModels: entries.filter((entry) => !entry.visible),
    };
  });
}

export function buildProviderGroups(
  allModels: readonly Model<any>[],
  scopedModels: readonly Model<any>[],
  scope: ModelScope,
  preferences: CatalogPreferences = {},
  state: CatalogModelState = {},
): ProviderGroup[] {
  return applyCatalogPreferences(resolveModelScope(allModels, scopedModels, scope), preferences, state);
}
