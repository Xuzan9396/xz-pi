import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { effectiveAuth, mutateStoredAuth } from "./credentials.js";
import { loadAliases, removeAlias } from "./account-aliases.js";
import { mutatePoolDocument, mutatePrivateJson, readPoolDocument, readPrivateJson } from "./pool-store.ts";

function hash(value) {
  return value === undefined ? undefined : createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function targetProvider(dir, id) {
  if (!existsSync(join(dir, "models.json"))) return undefined;
  const models = readPrivateJson(join(dir, "models.json"));
  if (models.providers !== undefined && (!models.providers || Object.getPrototypeOf(models.providers) !== Object.prototype)) {
    throw new Error("Invalid models metadata; account removal was postponed");
  }
  return models.providers?.[id];
}
function assertJobTarget(dir, id, job) {
  const record = loadAliases(dir)[id];
  if (record && hash(record) !== job.aliasHash) throw new Error("Account alias changed concurrently; removal was postponed");
  const provider = targetProvider(dir, id);
  if (provider !== undefined && hash(provider) !== job.providerHash) throw new Error("Account Provider changed concurrently; removal was postponed");
}
async function phase(dir, id, value) {
  await mutatePoolDocument(dir, draft => {
    const job = draft.removals[id];
    if (!job) throw new Error("Account removal progress is missing");
    job.phase = value;
  });
}
export async function beginAccountRemoval(dir, state, id) {
  const alias = loadAliases(dir)[id];
  if (!alias) throw new Error("Account alias is not managed by xz-pi-login");
  const auth = effectiveAuth(dir);
  const provider = targetProvider(dir, id);
  await mutatePoolDocument(dir, draft => {
    if (draft.removals[id]) return;
    draft.removals[id] = {
      operationId: randomUUID(), base: alias.base, suffix: alias.suffix, phase: "prepared",
      ...(auth[id] !== undefined ? { authHash: hash(auth[id]) } : {}),
      ...(provider !== undefined ? { providerHash: hash(provider) } : {}),
      aliasHash: hash(alias),
    };
  });
  state.poolDocument = readPoolDocument(dir);
  return state.poolDocument.removals[id];
}
async function removeCredential(dir, id, ctx, job) {
  const current = effectiveAuth(dir)[id];
  if (current === undefined) return;
  if (job.authHash && hash(current) !== job.authHash) throw new Error("Account credential changed concurrently; removal was postponed");
  const runtime = ctx?.modelRegistry?.getModelRuntime?.();
  if (runtime?.logout) {
    try { await runtime.logout(id); } catch (error) {
      if (effectiveAuth(dir)[id] !== undefined) throw error;
    }
  } else {
    mutateStoredAuth(join(dir, "auth.json"), auth => {
      if (job.authHash && auth[id] !== undefined && hash(auth[id]) !== job.authHash) {
        throw new Error("Account credential changed concurrently; removal was postponed");
      }
      const next = { ...auth }; delete next[id]; return next;
    });
    await ctx?.modelRegistry?.refresh?.({ providers: [id], allowNetwork: false });
  }
  if (effectiveAuth(dir)[id] !== undefined) throw new Error("Account login is still present; removal was postponed");
}
async function removeProviderEntry(dir, id, job) {
  const path = join(dir, "models.json");
  try { await mutatePrivateJson(path, raw => {
    if (raw.providers !== undefined && (!raw.providers || Object.getPrototypeOf(raw.providers) !== Object.prototype)) {
      throw new Error("Invalid models metadata; account removal was postponed");
    }
    const current = raw.providers?.[id];
    if (current === undefined) return raw;
    if (job.providerHash && hash(current) !== job.providerHash) throw new Error("Account Provider changed concurrently; removal was postponed");
    const providers = { ...raw.providers }; delete providers[id]; raw.providers = providers; return raw;
  }, { create: false }); }
  catch (error) { throw new Error(`Cannot update models.json: ${error.message}`); }
}
async function removeReferences(dir, id, ctx) {
  const settingsPaths = [join(dir, "settings.json")];
  if (ctx?.isProjectTrusted?.() !== false && ctx?.cwd) settingsPaths.push(join(ctx.cwd, ".pi", "settings.json"));
  for (const path of settingsPaths) await mutatePrivateJson(path, raw => {
    if (raw.enabledModels !== undefined && (!Array.isArray(raw.enabledModels) || raw.enabledModels.some(x => typeof x !== "string"))) {
      throw new Error("Invalid model settings; account references were retained");
    }
    if (raw.enabledModels) raw.enabledModels = raw.enabledModels.filter(pattern => {
      const reference = pattern.trim();
      return /[*?\[\]{}]|[+@!]\(/.test(reference) || !reference.startsWith(id + "/");
    });
    if (raw.defaultProvider === id) { delete raw.defaultProvider; delete raw.defaultModel; }
    return raw;
  }, { create: false });
  const preferencePaths = [join(dir, "xz-pi-pmodel.json")];
  if (ctx?.isProjectTrusted?.() !== false && ctx?.cwd) preferencePaths.push(join(ctx.cwd, ".pi", "xz-pi-pmodel.json"));
  for (const path of preferencePaths) await mutatePrivateJson(path, raw => {
    if (raw.providerOrder !== undefined) {
      if (!Array.isArray(raw.providerOrder) || raw.providerOrder.some(x => typeof x !== "string")) {
        throw new Error("Invalid pmodel preferences; account references were retained");
      }
      raw.providerOrder = raw.providerOrder.filter(provider => provider !== id);
    }
    if (raw.providers !== undefined) {
      if (!raw.providers || Object.getPrototypeOf(raw.providers) !== Object.prototype) {
        throw new Error("Invalid pmodel preferences; account references were retained");
      }
      const providers = { ...raw.providers }; delete providers[id]; raw.providers = providers;
    }
    return raw;
  }, { create: false });
}
function unregister(pi, state, id) {
  state.preparedAccounts.delete(id);
  try { pi.unregisterProvider?.(id); } catch { /* Persistent state is already authoritative. */ }
  state.ownedAliases.delete(id);
  state.nativeAliases?.delete(id);
  state.cursor?.forgetSlot?.(id);
}
export async function resumeAccountRemoval(pi, dir, state, id, ctx) {
  let job = readPoolDocument(dir).removals[id];
  if (!job) return { complete: true };
  if (job.phase === "prepared") {
    assertJobTarget(dir, id, job);
    await removeCredential(dir, id, ctx, job);
    await phase(dir, id, "credential-removed");
  }
  job = readPoolDocument(dir).removals[id];
  if (job.phase === "credential-removed") {
    await removeProviderEntry(dir, id, job);
    await phase(dir, id, "provider-removed");
  }
  job = readPoolDocument(dir).removals[id];
  if (job.phase === "provider-removed") {
    await removeReferences(dir, id, ctx);
    await phase(dir, id, "references-removed");
  }
  job = readPoolDocument(dir).removals[id];
  if (job.phase === "references-removed") {
    const alias = loadAliases(dir)[id];
    if (alias && hash(alias) !== job.aliasHash) throw new Error("Account alias changed concurrently; removal was postponed");
    if (alias) await removeAlias(dir, id);
    await phase(dir, id, "alias-removed");
  }
  unregister(pi, state, id);
  await mutatePoolDocument(dir, draft => { delete draft.removals[id]; });
  state.aliases = loadAliases(dir);
  ctx?.ui?.notify?.(`Provider ${id} has been deleted; choose a new provider and model`, "warning");
  return { complete: true };
}
async function prepareCurrentSelection(_pi, _state, id, ctx) {
  if (ctx?.model?.provider !== id) return;
  if (ctx?.isIdle?.() === false) throw new Error("Current window is working; account removal was postponed until it is idle");
}
export async function removeManagedAccount(pi, dir, state, id, ctx) {
  await prepareCurrentSelection(pi, state, id, ctx);
  await beginAccountRemoval(dir, state, id);
  return resumeAccountRemoval(pi, dir, state, id, ctx);
}
export { removeProviderEntry };
