// Generic alias registration: clone a pi-ai builtin provider under a slot id.
//
// No family table: pi-ai's builtinProviders() yields every builtin family
// (openai-codex, anthropic, xai, kimi-coding, ...), and Pi's
// registerProvider(provider) preserves the complete native definition. The
// alias shares the base transport/auth implementation while Pi resolves
// credentials per provider id, so each alias authenticates as its own
// auth.json entry. Families with no builtin factory (extension transports
// like cursor/devin, custom providers like ollama) report unsupported —
// honestly, in status — instead of guessing.
const BUILTIN_WIRE = new WeakSet();

export function markBuiltinWire(provider) {
  if (provider && (typeof provider === "object" || typeof provider === "function")) BUILTIN_WIRE.add(provider);
  return provider;
}

// Use the catalog injected by the TypeScript entry, never a workspace peer.
// A fresh base instance keeps provider-owned model state separate per alias.
export function builtinBase(mod, baseId) {
  if (!mod || !(mod.builtinProviders instanceof Function)) return null;

  try {
    const found = mod.builtinProviders().find((p) => p && p.id === baseId);

    return markBuiltinWire(found) || null;
  } catch {
    return null;
  }
}

// Builtin APIs contain provider-id-specific auth and replay rules. Canonicalize
// their wire view only; callbacks/results keep the serving account identity.
// A package-supplied factory has no provenance marker and is never rewritten.
function builtinWireStream(base, aliasId, stream) {
  return (model, context, options = {}) => {
    const wireModel = { ...model, provider: base.id };

    const messages = context.messages.map(message => {
      if (message.role !== "assistant" || message.model !== model.id || message.api !== model.api) return message;
      if (message.provider === aliasId) return { ...message, provider: base.id };
      // The base account is a different physical identity too. Keep it distinct
      // from the current alias in the ephemeral wire view so native transcript
      // conversion cannot retain another account\'s thinking/text signatures.
      if (message.provider === base.id) return { ...message, provider: "xz-account-origin-" + base.id };
      return message;
    });

    const native = stream(wireModel, { ...context, messages }, {
      ...options,
      onPayload: options.onPayload && (payload => options.onPayload(payload, model)),
      onResponse: options.onResponse && (response => options.onResponse(response, model)),
      onProviderStreamEvent: options.onProviderStreamEvent && (event => options.onProviderStreamEvent(event, model)),
    });

    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of native) {
          yield aliasStreamEvent(event, aliasId);
        }
      },
      async result() {
        return { ...await native.result(), provider: aliasId };
      },
    };
  };
}

export function aliasDef(base, aliasId, suffix) {
  const def = { ...base, id: aliasId, name: `${base.name} (${suffix})` };
  // Native catalogs carry provider identity. Re-key every operation without
  // mutating the factory's catalog; OAuth, refresh and wire implementations
  // remain provider-owned. Never pass this object through legacy ProviderConfig.
  // Every alias publishes its own catalog, including before login. Pi's auth
  // availability filter decides whether it is selectable; an empty catalog
  // would survive login/refresh and make stored accounts disappear.
  const rekey = models => models.map(model => ({ ...model, provider: aliasId }));

  def.getModels = () => rekey(base.getModels());

  if (base.getAllModels) def.getAllModels = () => rekey(base.getAllModels());

  if (BUILTIN_WIRE.has(base)) {
    def.stream = builtinWireStream(base, aliasId, base.stream);

    if (base.streamSimple) def.streamSimple = builtinWireStream(base, aliasId, base.streamSimple);
  }

  if (base.refreshModels) {
    // A native factory restores its own id and emits base-shaped rows. The
    // host's persistent catalog and publication generation must remain scoped
    // to the alias; only its private restore input is translated back.
    def.refreshModels = context => base.refreshModels({
      ...context,
      stored: context.stored && { ...context.stored, models: context.stored.models.map(model => ({ ...model, provider: base.id })) },
      publish: change => context.publish({
        ...change,
        persist: change.persist && { ...change.persist, models: rekey(change.persist.models) },
      }),
    });
  }

  return def;
}

function aliasStreamEvent(event, aliasId) {
  const field = ["partial", "message", "error"].find(key => event[key]);

  return field ? { ...event, [field]: { ...event[field], provider: aliasId } } : event;
}
