import * as hostBuiltins from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, readJson } from "./lib/support.js";
import { appendDebug } from "./lib/store.js";
import { commandCompletions, onCommand, showText, standbyText } from "./lib/commands.js";
import { findRivals } from "./lib/rivals.js";
import { loadConfig } from "./lib/config.js";
// Keep lifecycle exports under Pi's TypeScript loader. Native JS imports retain
// obsolete exports across /reload even when jiti's moduleCache is disabled.
import { createRuntimeState, registerStandalone, bindRuntimeHooks, finishStartup } from "./lib/runtime.ts";

function registerStandby(pi: ExtensionAPI, dir: string, rivals: string[]) {
  if (!rivals.length) return false;
  appendDebug(dir, "standby", { rivals });
  pi.registerCommand("xz-login", {
    description: "xz-pi-login is on standby (conflicting account router installed)",
    handler: (_raw, ctx) => showText(ctx, standbyText(rivals)),
  });
  return true;
}

export default function xzPiLogin(pi: ExtensionAPI) {
  const dir = agentDir();
  const config = loadConfig(dir);
  if (!config.enabled) return;

  const settings = readJson(dir, "settings.json") || {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const rivals = findRivals(packages);
  if (registerStandby(pi, dir, rivals)) return;

  // Pi transforms this TypeScript entry and binds static SDK imports to its
  // own modules. Inject that catalog into the JS helpers: native JS imports
  // can otherwise resolve a stale workspace peer before startup scope selection.
  const state = createRuntimeState(dir, config, hostBuiltins);
  registerStandalone(pi, dir, state);
  bindRuntimeHooks(pi, dir, state);
  pi.registerCommand("xz-login", {
    description: "Named accounts, logins and limits; add | restore | status | refresh | accounts | limits | remove | reset",
    getArgumentCompletions: prefix => commandCompletions(prefix, state),
    handler: (raw, ctx) => onCommand(pi, dir, state, config, raw, ctx),
  });

  // Complete config migration without rejecting extension loading on a
  // recoverable metadata failure: its registered logical models must remain.
  return finishStartup(pi, dir, state);
}
