import { fastCooldownKey } from "./fast.js";
import { resolveAccountId } from "./slots.js";
import { peekSession, ttlFor } from "./sessions.js";
import { servingAccount } from "./management.js";

function accountLine(family, session, id, now, ttlMs, fastModelId) {
  const until = family.cooldowns.get(id);
  const cooling = until !== undefined && until > now;
  if (cooling) return `  ${id}: cooling ${Math.ceil((until - now) / 60000)}m`;
  const turns = family.drained.get(id) || 0;
  const warm = session && now - (session.warm.get(id) || 0) < ttlMs;
  const fastUntil = fastModelId && family.cooldowns.get(fastCooldownKey(id, fastModelId));
  const tier = fastUntil > now ? ` · fast cooling ${Math.ceil((fastUntil - now) / 60000)}m` : "";
  return `  ${id}: ${turns} turns · ${warm ? "warm" : "cold"}${tier}`;
}

function servingModel(state, ctx, family) {
  const model = ctx ? ctx.model : null;
  const provider = servingAccount(state, ctx) ?? model?.provider;
  const account = provider ? resolveAccountId(provider) : null;
  return { model, serving: provider, inFamily: Boolean(model && account && account.base === family.base) };
}

function familyStatus(state, family, ctx, now) {
  if (family.status !== "active") return [`${family.base}: unsupported (${family.reason})`];
  const session = peekSession(family, ctx);
  const { model, serving, inFamily } = servingModel(state, ctx, family);
  const ttlMs = ttlFor(family, inFamily ? model : null);
  const via = family.via && family.via !== "clone" ? ` · ${family.via}` : "";
  const lists = family.carrier ? ` · lists ${family.carrier}` : "";
  const lines = [`${family.base}: ${family.slots.length} accounts · ttl ${Math.round(ttlMs / 60000)}m${via}${lists}`];
  for (const id of family.slots) lines.push(accountLine(family, session, id, now, ttlMs, inFamily ? model.id : null) + (id === serving ? " · serving" : ""));
  lines.push(`  add: /xz-login add ${family.base}`);
  return lines;
}

export function statusText(_dir, state, config, ctx) {
  const now = Date.now();
  const families = [...state.families.values()];
  const lines = [`xz-pi-login: named auth providers (/model, /pmodel) · ${families.length} families · ttl ${Math.round(state.config.ttlMs / 60000)}m · standalone`];
  for (const family of families) lines.push(...familyStatus(state, family, ctx, now));
  lines.push(`cooldown: ${Math.round(config.cooldownMs / 60000)}m`);
  return lines.join("\n");
}

export function showText(ctx, text) {
  const body = String(text);
  hideWidget(ctx);
  try { ctx?.ui?.notify?.(body, "info"); } catch { /* cosmetic */ }
  return body;
}

export function hideWidget(ctx) {
  try { ctx?.ui?.setWidget?.("xz-pi-login", undefined); } catch { /* cosmetic */ }
}

export function standbyText(rivals) {
  return [
    `xz-pi-login: STANDBY — conflicting account router installed (${rivals.join(", ")}).`,
    "Account Provider registrations and credential ownership may conflict with that extension.",
    "Disable the other account router and restart Pi to activate xz-pi-login.",
  ].join("\n");
}
