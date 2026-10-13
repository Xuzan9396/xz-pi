import { readJson, safeOn } from "./support.js";
import { appendDebug } from "./store.js";
import { hideWidget } from "./commands.js";
import { nativeFamilyNames, rediscover, syncPreparedAccounts } from "./accounts.js";
import { onResponse, onTurnEnd, resetRequestState } from "./observations.js";
import { onBeforeRequest, onCompact, onContext, onWarmDecision } from "./requests.js";
import { sessionIdOf } from "./sessions.js";
import { createCursorAccounts } from "./cursor.js";
import { customAccountBase } from "./custom.js";
import { createAccountUsage } from "./management.js";
import { loadAliases } from "./account-aliases.js";
import { isManagedAlias, setAccountAliases } from "./slots.js";
import { readPoolDocument, emptyPoolDocument } from "./pool-store.ts";
import { applyPoolMigration } from "./pool-migration.ts";
import { resumeAccountRemoval } from "./account-removal.ts";
import { applyStartupPolicy, guardStartupInput, rememberExplicitSelection } from "./startup-policy.ts";

export function createRuntimeState(dir, config, builtins) {
  let aliases = {}, poolDocument = emptyPoolDocument(), bootstrapError;
  try { aliases = loadAliases(dir); poolDocument = readPoolDocument(dir); }
  catch { bootstrapError = "Legacy account metadata is invalid; configured references were retained"; }
  setAccountAliases(aliases);
  const state = {
    aliases, builtins,
    savedModelProviders: readJson(dir, "models.json")?.providers,
    families: new Map(), accountFactories: new Map(), nativeFamilies: nativeFamilyNames(undefined, undefined, { builtins }),
    preparedAccounts: new Set(), ownedAliases: new Set(), requests: new Map(),
    config, mode: "standalone", transportWarn: false,
    poolDocument, bootstrapError, bootTime: Date.now(), explicitSelection: false,
  };
  state.usage = createAccountUsage(dir, state);
  state.usageEnabled = readJson(dir, "config/xz-pi-login/config.json")?.showUsage !== false;
  return state;
}

function declareAccountFactories(pi, dir, state) {
  if (!pi.events) return;
  pi.events.on("xz-pi-login:account-provider", provider => {
    if (!provider?.id || isManagedAlias(provider.id, state.aliases) || !(provider.getModels instanceof Function)) return;
    state.accountFactories.set(provider.id, provider);
    rediscover(pi, dir, state);
  });
  pi.events.emit("xz-pi-login:request-account-providers", undefined);
}

export function registerStandalone(pi, dir, state) {
  state.cursor = createCursorAccounts(pi, dir, state);
  state.cursorStartupOwned = Object.values(state.aliases).some(record => record.base === "cursor");
  for (const base of ["qwen", "ollama"]) {
    const provider = customAccountBase(base, state.savedModelProviders, state.builtins);
    if (!provider) continue;
    try { pi.registerProvider(provider); } catch (error) {
      appendDebug(dir, "custom_provider_registration_failed", { base, message: String(error?.message || error).slice(0, 160) });
    }
  }
  declareAccountFactories(pi, dir, state);
  try { rediscover(pi, dir, state); }
  catch { state.bootstrapError = "Account providers could not be registered; configured references were retained"; }
}

async function startSession(pi, dir, state, event, ctx) {
  hideWidget(ctx);
  try {
    if (state.cursor?.credentialIds().length) await state.cursor.restore(ctx?.modelRegistry);
    for (const id of Object.keys(state.poolDocument.removals ?? {})) {
      await resumeAccountRemoval(pi, dir, state, id, ctx);
      state.poolDocument = readPoolDocument(dir);
    }
    rediscover(pi, dir, state, undefined, ctx?.modelRegistry);
    const migration = await applyPoolMigration(dir, state, ctx);
    for (const warning of migration.warnings ?? []) ctx.ui?.notify?.(warning, "warning");
    state.bootstrapError = undefined;
  } catch (error) {
    state.bootstrapError = error instanceof Error ? error.message : "Provider synchronization failed; configured references were retained";
    ctx.ui?.notify?.(state.bootstrapError, "warning");
  }
  if (event?.reason === "new") state.explicitSelection = false;
  await applyStartupPolicy(pi, dir, state, event, ctx);
}

async function startTask(pi, dir, state, ctx) {
  if (state.cursor?.credentialIds().length) await state.cursor.restore(ctx?.modelRegistry);
  syncPreparedAccounts(pi, dir, state, ctx);
  resetRequestState(state, ctx);
}
function observeResponse(pi, dir, state, usageEnabled, event, ctx) {
  const provider = (event.model || state.requests.get(sessionIdOf(ctx)) || ctx?.model)?.provider;
  state.usage.response(provider, event.headers);
  if (usageEnabled && provider) void state.usage.updateStatus(ctx, provider).catch(() => {});
  return onResponse(pi, dir, state, event, ctx);
}
export function bindRuntimeHooks(pi, dir, state) {
  const hooks = [
    ["session_start", (event, ctx) => startSession(pi, dir, state, event, ctx)],
    ["input", (_event, ctx) => guardStartupInput(state, ctx)],
    ["model_select", event => rememberExplicitSelection(state, event)],
    ["before_agent_start", (_event, ctx) => startTask(pi, dir, state, ctx)],
    ["context_with_system", (event, ctx) => onContext(dir, state, event, ctx)],
    ["before_provider_request", (event, ctx) => onBeforeRequest(pi, dir, state, event, ctx)],
    ["after_provider_response", (event, ctx) => observeResponse(pi, dir, state, state.usageEnabled, event, ctx)],
    ["agent_end", (event, ctx) => onTurnEnd(pi, dir, state, event, ctx)],
    ["session_compact", (_event, ctx) => onCompact(dir, state, ctx)],
    ["cache_warming_decision", (event, ctx) => onWarmDecision(dir, state, event, ctx)],
  ];
  for (const [name, handler] of hooks) safeOn(pi, name, handler);
}
export async function finishStartup(pi, dir, state) {
  if (state.cursorStartupOwned && state.cursor?.credentialIds().length) {
    try { await state.cursor.restore(); rediscover(pi, dir, state); }
    catch { appendDebug(dir, "cursor_setup_failed", { message: "Cursor account setup did not complete" }); }
  }
}
