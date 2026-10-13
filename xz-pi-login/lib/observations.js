import { appendJournal, classifyResponse, markCooling, needsBackfill, recordTurn } from "./store.js";
import { debugLine } from "./support.js";
import { familyOf, peekSession, sessionIdOf, sessionState } from "./sessions.js";
import { fastCapability, fastCooldownKey, fastTierError } from "./fast.js";

// Account health and request evidence are observations only. This module never
// selects a model, changes thinking, edits context, or requests a continuation.
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

function failureCooldownKey(session, provider, modelId) {
  const fastKey = fastCooldownKey(provider, modelId);
  return session?.fastRequests?.has(fastKey) ? fastKey : provider;
}

function responseCooldownKey(status, model, session) {
  const sharedQuota = status === 401 || ([429, 402].includes(status) && fastCapability(model).kind !== "speed");
  return sharedQuota ? model.provider : failureCooldownKey(session, model.provider, model.id);
}

export function resetRequestState(state, ctx) {
  state.requests.delete(sessionIdOf(ctx));
  for (const family of state.families.values()) peekSession(family, ctx)?.fastRequests?.clear();
}

export function onResponse(_pi, dir, state, event, ctx) {
  const model = event?.model ?? state.requests.get(sessionIdOf(ctx)) ?? ctx?.model;
  const family = model ? familyOf(state, model.provider) : null;
  const status = event?.status;
  const action = classifyResponse(status);
  debugLine(state, dir, "response", {
    slot: model?.provider ?? null, status: status ?? null,
    action, family: family?.base ?? null,
  });
  if (!model || !family) return;
  const { session } = sessionState(family, ctx);
  if (action === "record") {
    recordTurn(family.drained, session.warm, model.provider, Date.now());
  } else if (action === "exhausted") {
    markCooling(family.cooldowns, responseCooldownKey(status, model, session), Date.now() + state.config.cooldownMs);
  }
}

function failureInfo(failure, model) {
  const slot = failure.provider ?? model?.provider ?? null;
  const text = failure.errorMessage || "";
  const exhausted = /\bHTTP\s+(?:401|402|403|429)\b|usage[_\s-]*limit|insufficient[_\s-]*quota|quota.{0,30}(?:exceed|exhaust)|(?:exceed|exhaust).{0,30}quota|rate[_\s-]*limit|too many requests|credit balance.{0,30}(?:low|exhaust)/i.test(text);
  return {
    slot, modelId: failure.model ?? model?.id,
    unauthorized: /\bHTTP\s+401\b/i.test(text),
    fastRejected: fastTierError(text), exhausted,
    transient: !exhausted && !/abort/i.test(text) && /\bstalled\b|\btimed?\s?out\b|ended before turnEnded|bridge connection lost|no upstream frames|no useful output|connect error/i.test(text),
    message: exhausted ? "quota-or-auth-error" : "provider-error",
  };
}

function failedTurn(event, model) {
  if (!Array.isArray(event?.messages)) return null;
  // A later success or user abort supersedes earlier failed retry attempts.
  const failure = event.messages.findLast(message => message?.stopReason);
  return failure?.stopReason === "error" ? failureInfo(failure, model) : null;
}

export function coolFailedTurn(dir, state, family, session, model, failure) {
  const ours = failure.slot !== null && family.slots.includes(failure.slot);
  const sharedQuota = failure.unauthorized || (failure.exhausted && fastCapability({ ...model, provider: failure.slot, id: failure.modelId }).kind !== "speed");
  const cooldownKey = sharedQuota ? failure.slot : failureCooldownKey(session, failure.slot, failure.modelId);
  const transientAccount = failure.transient && cooldownKey === failure.slot;
  if (ours) markCooling(family.cooldowns, cooldownKey, Date.now() + (transientAccount ? TRANSIENT_COOLDOWN_MS : state.config.cooldownMs));
  appendJournal(dir, "turn_failed", {
    family: family.base, slot: failure.slot, message: failure.message, cooled: ours,
    cooldownScope: transientAccount ? "transient" : cooldownKey === failure.slot ? "account" : "fast-tier",
  });
  return { ours, cooldownKey };
}

export function onTurnEnd(_pi, dir, state, event, ctx) {
  const id = sessionIdOf(ctx);
  const model = state.requests.get(id) ?? ctx?.model;
  state.requests.delete(id);
  const family = model ? familyOf(state, model.provider) : null;
  const session = family ? sessionState(family, ctx).session : null;
  const backfilled = Boolean(model && session && needsBackfill(session, model.provider));
  if (backfilled) session.warm.set(model.provider, Date.now());
  appendJournal(dir, "turn", {
    slot: model?.provider ?? null, model: model?.id ?? null,
    backfill: backfilled ? model.provider : null,
  });
  const failure = model && family ? failedTurn(event, model) : null;
  if (failure) coolFailedTurn(dir, state, family, session, model, failure);
}
