import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAliases } from "./account-aliases.js";
import { readAuthProviderIds, resolvePhysicalProvider } from "./auth-catalog.ts";
import { poolBase, isRecord } from "./pool-contract.ts";
import { mutatePrivateJson, readPoolDocument, readPrivateJson } from "./pool-store.ts";

const GLOB = /[*?\[\]{}]|[+@!]\(/;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function splitReference(pattern) {
  if (GLOB.test(pattern)) return undefined;
  const slash = pattern.indexOf("/");
  if (slash < 1) return undefined;
  const provider = pattern.slice(0, slash), tail = pattern.slice(slash + 1);
  const level = LEVELS.find(value => tail.endsWith(":" + value));
  return { provider, id: level ? tail.slice(0, -(level.length + 1)) : tail, suffix: level ? ":" + level : "" };
}
function modelList(ctx) {
  return ctx?.modelRegistry?.getAvailable?.() ?? ctx?.modelRegistry?.getAll?.() ?? [];
}
function resolver(dir, models) {
  const aliases = loadAliases(dir), authIds = readAuthProviderIds(dir), preferred = readPoolDocument(dir).preferred;
  return (provider, id) => {
    const base = poolBase(provider);
    if (!base) return provider;
    return resolvePhysicalProvider(authIds, models, base, id, preferred[base], aliases);
  };
}
function migrateSettings(raw, resolve) {
  if (raw.defaultProvider !== undefined && typeof raw.defaultProvider !== "string" ||
      raw.defaultModel !== undefined && typeof raw.defaultModel !== "string" ||
      raw.enabledModels !== undefined && (!Array.isArray(raw.enabledModels) || raw.enabledModels.some(x => typeof x !== "string"))) {
    throw new Error("Invalid model settings; existing references were retained");
  }
  const warnings = [];
  if (typeof raw.defaultProvider === "string" && typeof raw.defaultModel === "string" && poolBase(raw.defaultProvider)) {
    const provider = resolve(raw.defaultProvider, raw.defaultModel);
    if (provider) raw.defaultProvider = provider;
    else {
      warnings.push(`Provider ${raw.defaultProvider} has been deleted; choose a new provider and model`);
      delete raw.defaultProvider; delete raw.defaultModel;
    }
  }
  if (raw.enabledModels) raw.enabledModels = [...new Set(raw.enabledModels.flatMap(pattern => {
    const reference = splitReference(pattern);
    if (!reference || !poolBase(reference.provider)) return [pattern];
    const provider = resolve(reference.provider, reference.id);
    if (!provider) return [];
    return [`${provider}/${reference.id}${reference.suffix}`];
  }))];
  return warnings;
}
function migratePreferences(raw, resolve, models) {
  if (raw.providerOrder !== undefined && (!Array.isArray(raw.providerOrder) || raw.providerOrder.some(x => typeof x !== "string")) ||
      raw.providers !== undefined && !isRecord(raw.providers)) throw new Error("Invalid pmodel preferences; existing references were retained");
  const replacement = provider => {
    if (!poolBase(provider)) return provider;
    const id = models.find(model => model.provider === provider)?.id ?? models[0]?.id;
    return id ? resolve(provider, id) : undefined;
  };
  if (raw.providerOrder) raw.providerOrder = [...new Set(raw.providerOrder.flatMap(provider => replacement(provider) ?? []))];
  if (raw.providers) {
    const providers = {};
    for (const [provider, value] of Object.entries(raw.providers)) {
      const target = replacement(provider);
      if (target && !Object.hasOwn(providers, target)) providers[target] = value;
    }
    raw.providers = providers;
  }
}

export function planPoolMigration(dir, state, ctx) {
  const models = modelList(ctx), resolve = resolver(dir, models), settings = readPrivateJson(join(dir, "settings.json"));
  const before = JSON.stringify(settings); migrateSettings(settings, resolve);
  return { needed: JSON.stringify(settings) !== before, patch: settings, preferred: {} };
}

export async function applyPoolMigration(dir, state, ctx) {
  const models = modelList(ctx);
  if (!models.length) return { changed: false, warnings: [] };
  const resolve = resolver(dir, models), warnings = [];
  let changed = false;
  const paths = [join(dir, "settings.json")];
  if (ctx?.isProjectTrusted?.() !== false && ctx?.cwd) paths.push(join(ctx.cwd, ".pi", "settings.json"));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    await mutatePrivateJson(path, raw => {
      const before = JSON.stringify(raw); warnings.push(...migrateSettings(raw, resolve));
      changed ||= JSON.stringify(raw) !== before; return raw;
    }, { create: false });
  }
  const preferences = [join(dir, "xz-pi-pmodel.json")];
  if (ctx?.isProjectTrusted?.() !== false && ctx?.cwd) preferences.push(join(ctx.cwd, ".pi", "xz-pi-pmodel.json"));
  for (const path of preferences) {
    if (!existsSync(path)) continue;
    await mutatePrivateJson(path, raw => {
      const before = JSON.stringify(raw); migratePreferences(raw, resolve, models);
      changed ||= JSON.stringify(raw) !== before; return raw;
    }, { create: false });
  }
  return { changed, warnings };
}
export const resumePoolMigration = applyPoolMigration;
