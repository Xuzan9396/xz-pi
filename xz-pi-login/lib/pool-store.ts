import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicStorage } from "./credentials.js";
import { isRecord, onlyKeys, providerIdentity, safeIdentity } from "./pool-contract.ts";

export const REMOVAL_PHASES = ["prepared", "credential-removed", "provider-removed", "references-removed", "alias-removed", "complete"];
export function poolsPath(dir) { return join(dir, "config", "xz-pi-login", "pools.json"); }
export function emptyPoolDocument() {
  return { version: 1, revision: 0, preferred: {}, catalog: {}, cooldowns: {}, removals: {} };
}
export function readPrivateJson(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new Error();
    return value;
  } catch { throw new Error("Invalid pool configuration; existing file was retained"); }
}
function validMetadata(value) {
  return onlyKeys(value, ["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevels"]) &&
    safeIdentity(value.id) && safeIdentity(value.name) && safeIdentity(value.api) &&
    typeof value.reasoning === "boolean" && Array.isArray(value.input) && value.input.every(x => x === "text" || x === "image") &&
    Number.isFinite(value.contextWindow) && value.contextWindow >= 0 && Number.isFinite(value.maxTokens) && value.maxTokens >= 0 &&
    Array.isArray(value.thinkingLevels) && value.thinkingLevels.every(x => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(x));
}
export function validatePoolDocument(value) {
  const invalid = () => { throw new Error("Invalid pool metadata; existing file was retained"); };
  if (!onlyKeys(value, ["version", "revision", "preferred", "catalog", "cooldowns", "removals", "migration"]) ||
      value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !["preferred", "catalog", "cooldowns", "removals"].every(key => isRecord(value[key]))) invalid();
  for (const [base, id] of Object.entries(value.preferred)) if (!providerIdentity(base) || !providerIdentity(id)) invalid();
  for (const [base, models] of Object.entries(value.catalog)) {
    if (!providerIdentity(base) || !isRecord(models)) invalid();
    for (const [id, model] of Object.entries(models)) if (!safeIdentity(id) || !validMetadata(model) || model.id !== id) invalid();
  }
  for (const [key, until] of Object.entries(value.cooldowns)) if (!safeIdentity(key) || !Number.isFinite(until) || until < 0) invalid();
  for (const [id, job] of Object.entries(value.removals)) {
    if (!providerIdentity(id) || !onlyKeys(job, ["operationId", "base", "suffix", "phase", "authHash", "providerHash", "aliasHash"]) ||
        !providerIdentity(job.operationId) || !providerIdentity(job.base) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(job.suffix) ||
        id !== job.base + "-" + job.suffix || !REMOVAL_PHASES.includes(job.phase) ||
        !["authHash", "providerHash", "aliasHash"].every(key => job[key] === undefined || /^[a-f0-9]{64}$/.test(job[key]))) invalid();
  }
  if (value.migration !== undefined && (!onlyKeys(value.migration, ["id", "completed"]) ||
      !providerIdentity(value.migration.id) || typeof value.migration.completed !== "boolean")) invalid();
  return value;
}
export function readPoolDocument(dir) {
  const path = poolsPath(dir);
  return existsSync(path) ? validatePoolDocument(readPrivateJson(path)) : emptyPoolDocument();
}
// All transforms read under the same per-file lock. Never write a stale snapshot.
export async function mutatePrivateJson(path, transform, { create = true } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
  try {
    if (!create && !existsSync(path)) return undefined;
    const current = readPrivateJson(path);
    const draft = structuredClone(current);
    const next = await transform(draft) ?? draft;
    if (!isRecord(next)) throw new Error("Invalid pool configuration");
    if (JSON.stringify(current) !== JSON.stringify(next)) atomicStorage(path, next);
    return next;
  } finally { await release(); }
}
export async function mutatePoolDocument(dir, transform) {
  return mutatePrivateJson(poolsPath(dir), async raw => {
    const current = Object.keys(raw).length ? validatePoolDocument(raw) : emptyPoolDocument();
    const draft = structuredClone(current);
    const next = await transform(draft) ?? draft;
    next.revision = current.revision + 1;
    return validatePoolDocument(next);
  });
}
// Backups are exclusively config metadata. Callers must never pass auth.json.
export function backupConfig(dir, operationId, filename, content) {
  if (!["settings.json", "xz-pi-pmodel.json"].includes(filename) || !providerIdentity(operationId)) throw new Error("Invalid pool backup");
  const root = join(dir, "config", "xz-pi-login", "backups", operationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, filename);
  try { writeFileSync(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return path;
}
