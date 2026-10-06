import type { Model } from "@earendil-works/pi-ai";

export type SearchableModel = Pick<Model<any>, "provider" | "id" | "name">;

export interface ModelSearchMarkers {
  current?: boolean;
  default?: boolean;
}

export function buildModelSearchFields(
  model: SearchableModel,
  markers: ModelSearchMarkers = {},
): string[] {
  const fields = [
    model.provider,
    model.id,
    `${model.provider}/${model.id}`,
    `${model.provider} ${model.id}`,
    model.name,
  ];
  if (markers.current) fields.push("current");
  if (markers.default) fields.push("default");
  return fields;
}

export function tokenizeQuery(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

export function matchesModelQuery(
  model: SearchableModel,
  query: string,
  markers: ModelSearchMarkers = {},
): boolean {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return true;
  const fields = buildModelSearchFields(model, markers).map((field) => field.toLocaleLowerCase());
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}
