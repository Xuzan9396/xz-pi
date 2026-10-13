import { appendJournal, pruneCooldowns, pruneSessions } from "./store.js";
import { aliasDef, builtinBase, markBuiltinWire } from "./clone.js";
import { debugLine, readJson } from "./support.js";
import { carrierSlot, discoverFamilies, resolveAccountId, setAccountAliases } from "./slots.js";
import { loadAliases } from "./account-aliases.js";
import { customAccountBase } from "./custom.js";
import { modelMetadata } from "./catalog.js";

export { CATALOG_FIELDS } from "./catalog.js";


// An overlay is not an account factory. Reuse earlier native provenance only
// while the host still exposes an unchanged alias that we registered ourselves.
function establishedAccountBase(base, registry, state) {
  for (const [id, record] of state?.nativeAliases || []) {
    if (record.base !== base || !state.ownedAliases.has(id)) continue;

    if (registry.getRegisteredNativeProvider?.(id) === record.definition) return record.provider;
  }

  return null;
}

export function registerOwnedAlias(pi, state, base, provider, id, suffix) {
  const definition = aliasDef(provider, id, suffix);
  pi.registerProvider(definition);
  state.ownedAliases.add(id);
  state.nativeAliases ||= new Map();
  state.nativeAliases.set(id, { base, provider, definition });
}

function validSavedChat(model, ids) {
  return model?.id?.constructor === String && model.id.trim() !== "" && (!model.type || model.type === "chat") && !ids.has(model.id);
}

function appendSavedSource(provider, models, source, ids, extras) {
  const template = models.find(model => !source.api || model.api === source.api);

  if (!template) return;

  for (const model of source.models) {
    if (!validSavedChat(model, ids)) continue;
    extras.push({ ...template, ...modelMetadata(model), provider: provider.id, baseUrl: provider.baseUrl, type: "chat" });
    ids.add(model.id);
  }
}

function missingSavedModels(provider, models, sources) {
  const ids = new Set(models.map(model => model.id));
  const extras = [];

  for (const [id, source] of Object.entries(sources || {})) {
    if (resolveAccountId(id)?.base === provider.id && Array.isArray(source?.models)) appendSavedSource(provider, models, source, ids, extras);
  }

  return extras;
}

// Saved catalogs can supply newer chat IDs, not a new transport or credential.
// Stock entries stay authoritative; package-owned native factories are untouched.
function withSavedCatalog(provider, sources) {
  if (!sources) return provider;

  return {
    ...provider,
    getModels: () => {
      // Extend one snapshot: a second read may observe a different catalog.
      const models = provider.getModels();

      return [...models, ...missingSavedModels(provider, models, sources)];
    },
    getAllModels: () => {
      const all = provider.getAllModels?.();
      const models = provider.getModels();

      return [...(all || models), ...missingSavedModels(provider, models, sources)];
    },
  };
}

export function providerBase(base, registry, builtins, state) {
  if (builtins === undefined) builtins = state?.builtins;
  const native = registry?.getRegisteredNativeProvider?.(base);

  if (native) return native;

  // Legacy definitions can close over custom protocols or one credential.
  // A similarly named builtin is not an equivalent account factory.
  if (registry?.getRegisteredProviderConfig?.(base)) return establishedAccountBase(base, registry, state);

  const declared = state?.accountFactories?.get(base);

  if (declared) return declared;

  // The injected factory already comes from the host SDK at startup. Prefer
  // its live composed provider once models.json overlays are available.
  const builtin = builtins ? builtinBase(builtins, base) : null;
  let live;
  try { live = registry?.getProvider?.(base); } catch { /* host lookup is optional */ }

  // The live composed provider already includes models.json. Keep its stable
  // identity so rediscovery rebinds only when Pi really replaces it. Builtins
  // still need base-id wire canonicalization when cloned under an alias.
  if (live) return builtin ? markBuiltinWire(live) : live;

  const provider = builtin || customAccountBase(base, state?.savedModelProviders, builtins);
  return provider ? withSavedCatalog(provider, state?.savedModelProviders) : null;
}


function cloneFailureMessage(error) {
  return String((error && error.message) || error).slice(0, 160);
}

function registerSlot(pi, dir, state, base, id, builtinModule, registry) {
  if (id === base) return { via: "base" };
  if (state.builtins?.builtinProviders().some(provider => provider.id === id)) {
    return { reason: "alias id is a native provider family" };
  }

  if (base === "cursor" && state.cursor?.owns(id)) return { via: "cursor" };

  if (state.ownedAliases.has(id)) {
    // Catalogs belong to individual accounts, not the routing carrier. Only
    // rebind when the live factory changes; carrier swaps must not remove a
    // sibling from /model, /scoped-models or /pmodel.
    // A failed rebind keeps the old provider routable.
    const record = state.nativeAliases?.get(id);
    const liveProvider = registry ? providerBase(base, registry, builtinModule, state) : null;
    const providerChanged = liveProvider && liveProvider !== record?.provider;

    if (record && providerChanged) {
      try {
        registerOwnedAlias(pi, state, base, liveProvider, id, resolveAccountId(id).suffix);
        debugLine(state, dir, "slot_rebound", { id });
      } catch (error) {
        debugLine(state, dir, "slot_recatalog_failed", { id, message: cloneFailureMessage(error) });
      }
    }

    return { via: "clone" };
  }

  // Package-owned protocols/auth are never replaced or rolled back.
  if (registry?.getProvider?.(id)) return { via: "registered" };
  const suffix = resolveAccountId(id).suffix;
  const baseDef = providerBase(base, registry, builtinModule, state);

  if (!baseDef) return { reason: "no pi-ai builtin factory" };

  try {
    registerOwnedAlias(pi, state, base, baseDef, id, suffix);

    return { via: "clone", created: true };
  } catch (error) {
    debugLine(state, dir, "clone_failed", { id, message: cloneFailureMessage(error) });

    return { reason: "alias registration rejected" };
  }
}

function registerFamilySlots(pi, dir, state, base, slots, builtinModule, registry, carrier) {
  const created = [];
  const vias = new Set();

  for (const id of slots) {
    const result = registerSlot(pi, dir, state, base, id, builtinModule, registry);

    if (result.reason) return { ok: false, reason: result.reason, registered: created, carrier: null };

    vias.add(result.via);

    if (result.created) {
      created.push(id);
      debugLine(state, dir, "slot_registered", { id, how: "clone" });
    }
  }

  // Cursor catalogs live behind the bridge; converge the carrier there too.
  // Best effort: routing resolves across slots regardless of listing state.
  if (base === "cursor") {
    try {
      state.cursor?.syncCarrier?.(slots, carrier);
    } catch (error) {
      debugLine(state, dir, "cursor_carrier_sync_failed", { base, message: cloneFailureMessage(error) });
    }
  }

  return { ok: true, slots: [...slots], via: vias.has("cursor") ? "cursor" : registrationVia(vias.has("registered"), vias.has("clone")), carrier };
}

function registrationVia(adopted, cloned) {
  return adopted ? (cloned ? "mixed" : "registered") : "clone";
}

function ensureFamily(state, base) {
  let family = state.families.get(base);

  if (!family) {
    family = {
      base, slots: [], cooldowns: new Map(), drained: new Map(), sessions: new Map(),
      ttlMs: Object.hasOwn(state.config.ttlByFamily, base) ? state.config.ttlByFamily[base] : state.config.ttlMs,
      status: "pending", reason: null, via: null, carrier: null,
    };
    state.families.set(base, family);
  }

  return family;
}

function updateFamily(pi, state, family, slots, result) {
  if (result.ok) {
    family.slots = result.slots;
    family.status = "active";
    family.reason = null;
    family.via = result.via;
    family.carrier = result.carrier ?? null;

    return;
  }

  // Roll back only aliases created in this attempt, never older or base slots.
  for (const id of result.registered || []) {
    if (id === family.base) continue;

    try {
      pi.unregisterProvider(id);
      state.ownedAliases.delete(id);
      state.nativeAliases?.delete(id);
    } catch {
      // Best effort; a stale alias is cosmetic until restart.
    }
  }

  family.slots = slots;
  family.status = "unsupported";
  family.reason = result.reason;
  family.carrier = null;
}

// Discovery consumes IDs, never package keys. Host auth metadata permits
// config/runtime/environment accounts without copying credentials into auth.json.
// Our own aliases still require their login entries, not a shared environment key.
function registeredIds(registry) {
  return registry?.getRegisteredProviderIds?.() || [];
}

function configuredAccount(registry, id) {
  return registry.getProvider?.(id) && registry.getProviderAuthStatus?.(id)?.configured === true;
}

// The legacy Cursor carrier follows live auth, not slot order alone: a stale base credential
// must not take the family catalog down with it when a sibling is healthy.
// Without a registry (startup, before the host snapshot exists) the auth
// snapshot decides; carrierSlot still falls back to slots[0] so the family
// always lists somewhere.
export function familyCarrier(slots, auth, registry) {
  if (registry) {
    const live = slots.find(id => {
      try {
        return configuredAccount(registry, id) === true;
      } catch {
        return false;
      }
    });

    if (live !== undefined) return live;
  }

  return carrierSlot(slots, id => Object.hasOwn(auth || {}, id));
}

function discoveryAccounts(auth, registry, state) {
  const ids = new Set(Object.keys(auth || {}));

  for (const id of registeredIds(registry)) {
    if (state.ownedAliases.has(id) || !resolveAccountId(id)) continue;

    if (configuredAccount(registry, id)) ids.add(id);
  }

  return Object.fromEntries([...ids].map(id => [id, true]));
}


export function rediscover(pi, dir, state, auth = readJson(dir, "auth.json"), registry) {
  state.aliases = loadAliases(dir);
  setAccountAliases(state.aliases);
  if (registry) state.nativeFamilies = nativeFamilyNames(registry, state.cursor, state);
  const builtinModule = state.builtins;
  const seen = new Set();

  // A prepared, not-yet-authenticated alias must still appear in native /login
  // after restart. Availability remains credential-specific.
  for (const [id, record] of Object.entries(state.aliases)) {
    if (record.base !== "cursor") registerSlot(pi, dir, state, record.base, id, builtinModule, registry);
  }

  for (const { base, slots } of discoverFamilies(discoveryAccounts(auth, registry, state), state.aliases)) {
    seen.add(base);
    const family = ensureFamily(state, base);
    const carrier = familyCarrier(slots, auth, registry);
    const result = registerFamilySlots(pi, dir, state, base, slots, builtinModule, registry, carrier);
    updateFamily(pi, state, family, slots, result);

    pruneCooldowns(family.cooldowns, Date.now());
    pruneSessions(family.sessions, Date.now());
    debugLine(state, dir, "rediscover", {
      base,
      slots,
      status: family.status,
      reason: family.reason,
      carrier: family.carrier,
    });
    appendJournal(dir, "rediscover", {
      family: base,
      slots,
      status: family.status,
      reason: family.reason,
      via: family.via,
      carrier: family.carrier,
    });
  }

  // Drop families whose credentials vanished; re-login re-adds them.
  // (Deleting during Map iteration is safe — the iterator skips removed keys.)
  for (const base of state.families.keys()) {
    if (!seen.has(base)) state.families.delete(base);
  }

  return state.families;
}


// Only prepared aliases need a login handoff. Reuse the same auth snapshot
// throughout discovery; a missing prepared credential leaves serving families alone.
// Existing discovery preserves warmth, cooldowns and native provider instances.
export function syncPreparedAccounts(pi, dir, state, ctx) {
  if (!state.preparedAccounts.size) return;
  const auth = readJson(dir, "auth.json");

  if (!auth || Array.isArray(auth)) return;
  const authenticated = [...state.preparedAccounts].filter(id => Object.hasOwn(auth, id));

  if (!authenticated.length) return;
  const families = rediscover(pi, dir, state, auth, ctx?.modelRegistry);

  clearPrepared(state, families, authenticated);
}

function clearPrepared(state, families, authenticated) {
  for (const id of authenticated) {
    const family = families.get(resolveAccountId(id).base);

    if (family?.status === "active" && family.slots.includes(id)) state.preparedAccounts.delete(id);
  }
}


function reconcileFamilyName(names, id, registry, cursor, state) {
  if (resolveAccountId(id)?.n !== 1) return;

  if (cursor?.owns(id) || registry.getRegisteredNativeProvider?.(id) || establishedAccountBase(id, registry, state)) names.add(id);
  else if (registry.getRegisteredProviderConfig?.(id)) names.delete(id);
}

export function nativeFamilyNames(registry, cursor, state) {
  const names = new Set([...state.builtins.builtinProviders().map(provider => provider.id), "cursor", "qwen", "ollama"]);

  for (const id of state?.accountFactories?.keys() || []) names.add(id);

  // Include families published by the live registry. Collapse our own
  // account models back to their base.
  try {
    for (const model of registry?.getAll?.() || []) {
      const id = resolveAccountId(model?.provider)?.base;
      if (id && registry.getProvider?.(id)) names.add(id);
    }
  } catch {
    // Completion discovery is best effort; registered IDs still follow below.
  }

  for (const id of registeredIds(registry)) reconcileFamilyName(names, id, registry, cursor, state);

  return [...names].sort();
}
