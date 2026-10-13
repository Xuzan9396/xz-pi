import { showText, hideWidget, statusText } from "./command-ui.js";
import { addShortcut, restoreCommand, accountsCommand, limitsCommand, removeCommand, canChoose, commandCompletions } from "./account-commands.js";
import { rediscover, syncPreparedAccounts } from "./accounts.js";

async function commandMenu(pi, dir, state, config, ctx) {
  const choice = await ctx.ui.select("XZ Login", [
    "Add account", "Account status", "Refresh accounts",
    "Usage / limits", "All accounts", "Restore existing login", "Remove account",
  ]);
  if (!choice) return;
  if (choice === "Add account") return addShortcut(pi, dir, state, [], ctx);
  if (choice === "Restore existing login") return restoreCommand(pi, dir, state, config, ["restore"], ctx);
  if (choice === "Remove account") return removeCommand(pi, dir, state, config, ["remove"], ctx);
  const action = {
    "Account status": "status", "Refresh accounts": "refresh",
    "Usage / limits": "limits", "All accounts": "accounts",
  }[choice];
  if (action) return onCommand(pi, dir, state, config, action, ctx);
}

function refreshCommand(pi, dir, state, _config, _tokens, ctx) {
  const families = rediscover(pi, dir, state, undefined, ctx?.modelRegistry);
  const summary = [...families.values()].map(
    family => `${family.base}×${family.slots.length}${family.status === "active" ? "" : ` (${family.status})`}`,
  );
  return showText(ctx, `xz-pi-login: tracking ${summary.join(", ") || "no account families"}.`);
}

function resetCommand(_pi, _dir, state, _config, _tokens, ctx) {
  for (const family of state.families.values()) {
    family.cooldowns.clear();
    family.drained.clear();
  }
  return showText(ctx, "Reset local cooldowns and request counts. Provider quota and logins are unchanged.");
}

const COMMANDS = new Map([
  ["accounts", accountsCommand], ["limits", limitsCommand], ["usage", limitsCommand], ["quota", limitsCommand],
  ["restore", restoreCommand], ["remove", removeCommand], ["reset", resetCommand],
  ["add", (pi, dir, state, _config, tokens, ctx) => addShortcut(pi, dir, state, tokens.slice(1), ctx)],
  ["hide", (_pi, _dir, _state, _config, _tokens, ctx) => { hideWidget(ctx); return "xz-pi-login: panel hidden."; }],
  ["rediscover", refreshCommand], ["refresh", refreshCommand],
]);

export function onCommand(pi, dir, state, config, raw, ctx) {
  syncPreparedAccounts(pi, dir, state, ctx);
  const tokens = String(Array.isArray(raw) ? raw.join(" ") : raw || "").trim().split(/\s+/);
  const sub = tokens[0];
  if (!sub || sub === "menu") {
    if (!canChoose(ctx)) return showText(ctx, statusText(dir, state, config, ctx));
    return commandMenu(pi, dir, state, config, ctx);
  }
  if (sub === "fast") return showText(ctx, "xz-pi-login: request fast tiers through the provider's native model or service tier.");
  const command = COMMANDS.get(sub);
  return command ? command(pi, dir, state, config, tokens, ctx) : showText(ctx, statusText(dir, state, config, ctx));
}

export { showText, hideWidget, standbyText } from "./command-ui.js";
export { commandCompletions };
