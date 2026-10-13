import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAuthProviderIds(agentDir = getAgentDir()): string[] {
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read Pi auth provider catalog: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(value)) throw new Error("Invalid Pi auth provider catalog: expected an object");
  return Object.keys(value);
}

export function filterAuthenticatedModels<T extends Model<any>>(models: readonly T[], providerIds: readonly string[]): T[] {
  const authenticated = new Set(providerIds);
  return models.filter(model => authenticated.has(model.provider));
}

export function classifyMissingReference(
  reference: { provider: string; id: string },
  providerIds: readonly string[],
  models: readonly Pick<Model<any>, "provider" | "id">[],
): "provider" | "model" | undefined {
  if (!providerIds.includes(reference.provider)) return "provider";
  return models.some(model => model.provider === reference.provider && model.id === reference.id) ? undefined : "model";
}
