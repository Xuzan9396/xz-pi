import { join } from "node:path";
import { readAuthProviderIds } from "./auth-catalog.ts";
import { readPrivateJson } from "./pool-store.ts";
import { safeIdentity } from "./pool-contract.ts";

export function resolveStartupIntent({ event, ctx, argv = process.argv.slice(2), bootTime = Date.now() }) {
  const reason = event?.reason ?? "startup";
  if (argv.some(arg => ["--model", "--provider"].includes(arg) || /^(--model|--provider)=/.test(arg))) return "preserve";
  if (["reload", "resume", "fork"].includes(reason)) return "preserve";
  if (reason === "new") return "default";
  if (argv.some(arg => ["--resume", "-r", "--continue", "-c", "--session"].includes(arg) ||
      /^(--resume|--session)=/.test(arg))) return "preserve";
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  if (branch.some(entry => entry.type === "message" || entry.type === "compaction" ||
      entry.type === "model_change" && Date.parse(entry.timestamp) < bootTime - 1000)) return "preserve";
  return "default";
}

function configuredReference(settings) {
  if (settings.defaultProvider === undefined && settings.defaultModel === undefined) return undefined;
  if (!safeIdentity(settings.defaultProvider) || !safeIdentity(settings.defaultModel)) return null;
  return { provider: settings.defaultProvider, id: settings.defaultModel };
}

export function resolveDefaultSelection(dir, ctx) {
  const global = readPrivateJson(join(dir, "settings.json"));
  const project = ctx?.isProjectTrusted?.() === false ? {} : readPrivateJson(join(ctx?.cwd ?? "", ".pi", "settings.json"));
  const selected = configuredReference(project) ?? configuredReference(global);
  if (selected === null) throw new Error("Configured default model is invalid; choose a new provider and model");
  if (!selected) return undefined;
  if (!readAuthProviderIds(dir).includes(selected.provider)) {
    throw new Error(`Provider ${selected.provider} has been deleted; choose a new provider and model`);
  }
  return ctx.modelRegistry.find(selected.provider, selected.id) ??
    (() => { throw new Error(`Model ${selected.provider}/${selected.id} has been deleted; choose a new model`); })();
}

export const resolveGlobalSelection = resolveDefaultSelection;

export async function applyStartupPolicy(pi, dir, state, event, ctx, argv = process.argv.slice(2)) {
  const intent = resolveStartupIntent({ event, ctx, argv, bootTime: state.bootTime });
  state.startupBlocked = undefined;
  if (intent === "preserve" || state.explicitSelection && event?.reason !== "new") return;
  try {
    const target = resolveDefaultSelection(dir, ctx);
    if (!target || ctx.model?.provider === target.provider && ctx.model.id === target.id) return;
    state.applyingStartup = true;
    if (!await pi.setModel(target)) throw new Error("Configured default model has no usable authentication; choose a new provider and model");
  } catch (error) {
    state.startupBlocked = error instanceof Error ? error.message : String(error);
    ctx.ui?.notify?.(state.startupBlocked, "warning");
  } finally { state.applyingStartup = false; }
}

export function guardStartupInput(state, ctx) {
  if (!state.startupBlocked) return;
  ctx.ui?.notify?.(state.startupBlocked, "warning");
  return { action: "handled" };
}
export function rememberExplicitSelection(state, event) {
  if (!state.applyingStartup && ["set", "cycle"].includes(event?.source)) {
    state.explicitSelection = true;
    state.startupBlocked = undefined;
  }
}
