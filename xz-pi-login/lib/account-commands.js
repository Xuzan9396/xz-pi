import { providerBase, registerOwnedAlias, nativeFamilyNames, rediscover } from "./accounts.js";
import { readJson } from "./support.js";
import { showText } from "./command-ui.js";
import { effectiveAuth } from "./credentials.js";
import { servingAccount } from "./management.js";
import { removeManagedAccount } from "./account-removal.ts";
import { addAlias, createAliasId, listAliases, loadAliases, normalizeSuffix, removeAlias } from "./account-aliases.js";
import { resolveAccountId, setAccountAliases } from "./slots.js";

function canPrefill(ctx) {
  return ctx?.mode === "tui" && ctx?.hasUI !== false;
}

function prefillLogin(ctx, id) {
  if (!canPrefill(ctx)) return;
  try {
    if (ctx.ui?.getEditorText?.() === "") ctx.ui.setEditorText?.("/login " + id);
  } catch {
    // Cosmetic failure cannot undo a prepared provider.
  }
}

function packageOwns(base, ctx) {
  return ctx?.modelRegistry?.getRegisteredProviderConfig?.(base) && !ctx.modelRegistry.getRegisteredNativeProvider?.(base);
}

function accountProvider(base, ctx, state) {
  const provider = providerBase(base, ctx?.modelRegistry, undefined, state);
  return { provider, owned: !provider && packageOwns(base, ctx) };
}

function refreshFamilyNames(ctx, state) {
  state.nativeFamilies = nativeFamilyNames(ctx?.modelRegistry, state.cursor, state);
  return state.nativeFamilies;
}

function collisionReason(id, auth, state, ctx) {
  if (Object.hasOwn(auth || {}, id)) return "a login already exists";
  if (state.aliases?.[id]) return "the alias already exists";
  if (state.preparedAccounts.has(id)) return "the alias is already prepared";
  if (state.ownedAliases.has(id)) return "the provider is already registered";
  if (state.nativeFamilies.includes(id)) return "that name is already a provider family";
  if (ctx?.modelRegistry?.getProvider?.(id)) return "that provider id is already registered";
  return null;
}

function isMetadataOnlyProvider(dir, id, ctx) {
  const registry = ctx?.modelRegistry;
  const provider = registry?.getProvider?.(id);
  if (!provider || provider.auth?.oauth || registry.getRegisteredNativeProvider?.(id)
    || registry.getRegisteredProviderConfig?.(id)) return false;
  // models.json modelOverrides can create an empty API-key-only shell even
  // though this account needs OAuth. This is user metadata, not an owned
  // transport; preserve it while explicitly attaching a native factory.
  const source = readJson(dir, "models.json")?.providers?.[id];
  if (!source || typeof source !== "object" || Array.isArray(source)
    || !source.modelOverrides || typeof source.modelOverrides !== "object" || Array.isArray(source.modelOverrides)
    || Object.keys(source).some(key => key !== "modelOverrides" && key !== "name")) return false;
  try {
    return provider.getModels().length === 0;
  } catch {
    return false;
  }
}

function restoreCollision(id, dir, state, ctx) {
  const collision = collisionReason(id, {}, state, ctx);
  return collision === "that provider id is already registered" && isMetadataOnlyProvider(dir, id, ctx)
    ? null : collision;
}

async function rollbackAlias(pi, dir, state, id) {
  try {
    state.aliases = await removeAlias(dir, id);
    setAccountAliases(state.aliases);
  } catch {
    // A persisted reservation is safer than losing another process's update.
  }
  state.preparedAccounts.delete(id);
  if (state.ownedAliases.has(id)) {
    try { pi.unregisterProvider?.(id); } catch { /* best effort */ }
    state.ownedAliases.delete(id);
    state.nativeAliases?.delete(id);
  }
  state.cursor?.forgetSlot?.(id);
}

async function prepareNamedAccount(pi, dir, state, base, rawSuffix, ctx) {
  refreshFamilyNames(ctx, state);
  const suffix = normalizeSuffix(rawSuffix);
  if (!suffix) {
    return showText(ctx, "xz-pi-login: alias must match [a-z0-9][a-z0-9_-]{0,31}.");
  }
  const id = createAliasId(base, suffix);
  const auth = effectiveAuth(dir);
  const collision = collisionReason(id, auth, state, ctx);
  if (collision) {
    const orphan = collision === "a login already exists" && !loadAliases(dir)[id]
      && !state.ownedAliases.has(id) && (!ctx?.modelRegistry?.getProvider?.(id) || isMetadataOnlyProvider(dir, id, ctx));
    return showText(ctx, `xz-pi-login: ${id} already exists (${collision}).` + (orphan
      ? ` Its alias mapping is missing. Run /xz-login restore ${base} ${suffix} to restore the provider without replacing the login.`
      : ""));
  }

  const { provider, owned } = accountProvider(base, ctx, state);
  if (owned) return showText(ctx, `xz-pi-login: the provider package owns ${base}; it must expose a native account factory.`);
  if (!provider && base !== "cursor") return showText(ctx, `xz-pi-login: no native provider for ${base}; account not created.`);

  try {
    state.aliases = await addAlias(dir, base, suffix, candidate => {
      const reason = collisionReason(candidate, effectiveAuth(dir), state, ctx);
      if (reason) throw new Error("alias_exists");
    });
    setAccountAliases(state.aliases);
    state.preparedAccounts.add(id);

    if (base === "cursor" && state.cursor) {
      const ready = await state.cursor.prepare([id], ctx?.modelRegistry);
      if (!ready) throw new Error("cursor_registration_rejected");
    } else {
      registerOwnedAlias(pi, state, base, provider, id, suffix);
    }
  } catch (error) {
    await rollbackAlias(pi, dir, state, id);
    if (String(error?.message) === "alias_exists") {
      return showText(ctx, `xz-pi-login: ${id} already exists.`);
    }
    return showText(ctx, "xz-pi-login: provider registration failed; alias was not prepared.");
  }

  prefillLogin(ctx, id);
  return showText(ctx, `xz-pi-login: prepared ${id}. Run /login ${id}; the next command or task will discover the login. No credentials or current model changed.`);
}

export function canChoose(ctx) {
  return ctx?.hasUI !== false && ctx?.ui?.select != null;
}

function canInput(ctx) {
  return ctx?.hasUI !== false && ctx?.ui?.input != null;
}

export function commandCompletions(prefix, state) {
  const input = String(prefix || "").trimStart();
  let values = ["add", "restore", "status", "refresh", "hide", "menu", "accounts", "limits", "remove", "reset"];
  if (input.startsWith("add ")) values = state.nativeFamilies.map(name => "add " + name);
  else if (input.startsWith("restore ")) values = state.nativeFamilies.map(name => "restore " + name);
  else if (input.startsWith("remove ")) values = Object.keys(state.aliases || {}).sort().map(id => "remove " + id);
  const matches = values.filter(value => value.startsWith(input));
  return matches.length ? matches.map(value => ({ value, label: value })) : null;
}

function defaultAccountBase(tokens, ctx, state) {
  const provider = ctx?.model?.provider;
  return tokens[0] || resolveAccountId(provider)?.base;
}

export async function addShortcut(pi, dir, state, tokens, ctx) {
  if (tokens.length > 2) return showText(ctx, "Usage: /xz-login add [provider] [alias]");
  let base = defaultAccountBase(tokens, ctx, state);
  refreshFamilyNames(ctx, state);

  if (!base && canChoose(ctx)) {
    base = await ctx.ui.select("Add account — provider", state.nativeFamilies);
    if (!base) return;
  }
  if (!base) return showText(ctx, "Choose a model first, or use /xz-login add <provider> <alias>.");
  if (!state.nativeFamilies.includes(base) && !providerBase(base, ctx?.modelRegistry, undefined, state)) {
    return showText(ctx, `xz-pi-login: ${base} is not an available native provider.`);
  }

  let suffix = tokens[1];
  if (suffix === undefined && canInput(ctx)) {
    suffix = await ctx.ui.input("Account alias", "letters, numbers, _ or - (for example: work)");
    if (suffix === undefined) return;
  }
  if (suffix === undefined) return showText(ctx, "Usage: /xz-login add <provider> <alias>");
  return prepareNamedAccount(pi, dir, state, base, suffix, ctx);
}

function supportsStoredLogin(base, provider, credential) {
  if (base === "cursor") return credential?.type === "oauth";
  if (credential?.type === "oauth") return Boolean(provider?.auth?.oauth);
  if (credential?.type === "api_key") return Boolean(provider?.auth?.apiKey);
  return false;
}

// Explicitly attach an existing credential to a user-chosen native factory.
// Never infer the base from an ID or automatically adopt auth.json entries.
export async function restoreCommand(pi, dir, state, _config, tokens, ctx) {
  if (tokens.length > 4 || (tokens.length === 4 && tokens[3] !== "confirm")) {
    return showText(ctx, "Usage: /xz-login restore <provider> <alias> [confirm]");
  }
  refreshFamilyNames(ctx, state);
  let base = tokens[1];
  if (!base && canChoose(ctx)) base = await ctx.ui.select("Restore existing login — provider", state.nativeFamilies);
  if (!base) return showText(ctx, "Usage: /xz-login restore <provider> <alias> [confirm]");
  let rawSuffix = tokens[2];
  if (rawSuffix === undefined && canInput(ctx)) rawSuffix = await ctx.ui.input("Existing account alias", "for example: work");
  if (rawSuffix === undefined) return showText(ctx, "Usage: /xz-login restore <provider> <alias> [confirm]");
  const suffix = normalizeSuffix(rawSuffix);
  if (!suffix) return showText(ctx, "xz-pi-login: alias must match [a-z0-9][a-z0-9_-]{0,31}.");
  state.aliases = loadAliases(dir);
  setAccountAliases(state.aliases);
  if (state.aliases[base]) return showText(ctx, "xz-pi-login: choose the base native provider, not an account alias.");
  const id = createAliasId(base, suffix);
  const collision = restoreCollision(id, dir, state, ctx);
  if (collision) return showText(ctx, `xz-pi-login: ${id} cannot be restored (${collision}); no login or mapping changed.`);
  const { provider, owned } = accountProvider(base, ctx, state);
  if (owned) return showText(ctx, `xz-pi-login: the provider package owns ${base}; it must expose a native account factory.`);
  if (!provider && base !== "cursor") return showText(ctx, `xz-pi-login: no native provider for ${base}; no login or mapping changed.`);
  const auth = effectiveAuth(dir);
  if (!Object.hasOwn(auth, id)) return showText(ctx, `xz-pi-login: no stored login for ${id}. Use /xz-login add ${base} ${suffix} instead.`);
  if (!supportsStoredLogin(base, provider, auth[id])) {
    return showText(ctx, `xz-pi-login: ${base} does not support this stored login's authentication type; no login or mapping changed.`);
  }
  const confirmed = await confirmAction(tokens.slice(3), ctx, "Restore existing login",
    `Register ${id} as an account of ${base} using its existing login? Only the alias mapping and provider registration change; credentials and the current model stay unchanged.`);
  if (!confirmed) return showText(ctx, `No login or mapping changed. To confirm explicitly: /xz-login restore ${base} ${suffix} confirm`);

  let reserved = false;
  try {
    state.aliases = await addAlias(dir, base, suffix, candidate => {
      if (restoreCollision(candidate, dir, state, ctx)) throw new Error("alias_exists");
      const current = effectiveAuth(dir);
      if (!Object.hasOwn(current, candidate)) throw new Error("login_missing");
      if (!supportsStoredLogin(base, provider, current[candidate])) throw new Error("login_type_changed");
    });
    reserved = true;
    setAccountAliases(state.aliases);
    if (base === "cursor") {
      if (!await state.cursor.prepare([id], ctx.modelRegistry)) throw new Error("registration_failed");
    } else {
      registerOwnedAlias(pi, state, base, provider, id, suffix);
    }
    const family = rediscover(pi, dir, state, undefined, ctx.modelRegistry).get(base);
    if (family?.status !== "active" || !family.slots.includes(id)) throw new Error("registration_failed");
  } catch (error) {
    if (reserved) await rollbackAlias(pi, dir, state, id);
    if (error?.message === "alias_exists") return showText(ctx, `xz-pi-login: ${id} was mapped or registered concurrently; the other operation was retained.`);
    if (error?.message === "login_missing" || error?.message === "login_type_changed") {
      return showText(ctx, `xz-pi-login: the stored login for ${id} changed during confirmation; no alias was restored.`);
    }
    return showText(ctx, `xz-pi-login: provider restoration failed for ${id}; the existing login was retained.`);
  }
  try {
    const result = await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: false, signal: AbortSignal.timeout(5_000) });
    if (result.aborted || result.errors.size > 0) throw new Error("refresh_failed");
  } catch {
    return showText(ctx, `xz-pi-login: restored ${id} with the existing login, but the catalog refresh failed. The mapping was retained; run /reload. No credentials or current model changed.`);
  }
  return showText(ctx, `xz-pi-login: restored ${id} with the existing login. No credentials or current model changed.`);
}

export async function confirmAction(tokens, ctx, title, message) {
  if (tokens.includes("confirm")) return true;
  if (ctx?.hasUI === false || !ctx?.ui?.confirm) return false;
  return ctx.ui.confirm(title, message);
}

export async function accountsCommand(_pi, dir, state, _config, tokens, ctx) {
  const ids = [...new Set([...Object.keys(effectiveAuth(dir)), ...Object.keys(state.aliases || {})])];
  return showText(ctx, await state.usage.describe(ids, tokens.includes("refresh"), ctx));
}

export async function limitsCommand(_pi, _dir, state, _config, tokens, ctx) {
  const account = servingAccount(state, ctx);
  return showText(ctx, account ? await state.usage.describe([account], tokens.includes("refresh"), ctx)
    : "No active provider selected.");
}

function forgetRemovedAlias(pi, state, id) {
  state.preparedAccounts.delete(id);
  if (state.ownedAliases.has(id)) {
    try { pi?.unregisterProvider?.(id); } catch { /* login is already gone */ }
    state.ownedAliases.delete(id);
    state.nativeAliases?.delete(id);
  }
  state.cursor?.forgetSlot?.(id);
}

export async function removeCommand(pi, dir, state, _config, tokens, ctx) {
  let id = tokens[1];
  const aliases = listAliases(dir);
  state.aliases = Object.fromEntries(aliases.map(({ id: aliasId, base, suffix }) => [aliasId, { base, suffix }]));
  setAccountAliases(state.aliases);

  if (!id && canChoose(ctx)) {
    id = await ctx.ui.select("Remove account", aliases.map(account => account.id));
    if (!id) return;
  }
  if (!id || !state.aliases[id]) return showText(ctx, "Usage: /xz-login remove <managed-provider-id>");
  const confirmed = await confirmAction(tokens.slice(2), ctx, "Remove account", `Log out and remove ${id}? Other accounts and defaults are unchanged.`);
  if (!confirmed) return showText(ctx, `No login changed. To confirm explicitly: /xz-login remove ${id} confirm`);

  try {
    await removeManagedAccount(pi, dir, state, id, ctx);
    setAccountAliases(state.aliases);
    rediscover(pi, dir, state, undefined, ctx?.modelRegistry);
    return showText(ctx, `Removed login, alias and Provider ${id}.`);
  } catch (error) {
    return showText(ctx, `xz-pi-login: ${String(error?.message || error)} Retry remove to continue safely.`);
  }
}
