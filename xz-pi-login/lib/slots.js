// Account identity is explicit. Custom provider ids are managed only when they
// are present in config/xz-pi-login/accounts.json; names are never guessed.
let accountAliases = Object.freeze({});

export function setAccountAliases(aliases) {
  accountAliases = Object.freeze({ ...(aliases || {}) });
  return accountAliases;
}

export function getAccountAliases() {
  return accountAliases;
}

export function resolveAccountId(providerId, aliases = accountAliases) {
  if (!providerId || providerId.constructor !== String) return null;
  const record = aliases?.[providerId];
  if (!record) return { base: providerId, suffix: null, alias: false, n: 1 };
  return { base: record.base, suffix: record.suffix, alias: true, n: 2 };
}

export function isManagedAlias(providerId, aliases = accountAliases) {
  return Boolean(providerId && aliases?.[providerId]);
}

export function managedAliasIds(aliases = accountAliases) {
  return Object.keys(aliases || {}).sort();
}

export function discoverFamilies(auth, aliases = accountAliases) {
  const groups = new Map();
  for (const [id, record] of Object.entries(aliases || {})) {
    if (!record?.base || !record?.suffix) continue;
    if (!groups.has(record.base)) groups.set(record.base, []);
    groups.get(record.base).push(id);
  }

  return [...groups]
    .map(([base, ids]) => ({
      base,
      slots: [
        ...(Object.hasOwn(auth || {}, base) ? [base] : []),
        ...ids.sort((left, right) => left.localeCompare(right)),
      ],
    }))
    .filter(family => family.slots.length > 0)
    .sort((left, right) => left.base.localeCompare(right.base));
}

// Legacy Cursor catalog carrier (also retained in family diagnostics).
// Native aliases publish independent catalogs and do not use this to hide
// siblings. Prefer the first configured account, then the first family member.
export function carrierSlot(slots, isConfigured) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  if (isConfigured instanceof Function) {
    const configured = slots.find(id => {
      try {
        return isConfigured(id) === true;
      } catch {
        return false;
      }
    });
    if (configured !== undefined) return configured;
  }
  return slots[0];
}
