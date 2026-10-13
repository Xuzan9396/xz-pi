import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicStorage } from "./credentials.js";

const VERSION = 1;
const SUFFIX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function aliasesPath(agentDir) {
  return join(agentDir, "config", "xz-pi-login", "accounts.json");
}

function emptyDocument() {
  return { version: VERSION, accounts: {} };
}

function validRecord(id, value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (typeof value.base !== "string" || !value.base.trim()) return false;
  if (typeof value.suffix !== "string" || !SUFFIX.test(value.suffix)) return false;
  return id === createAliasId(value.base, value.suffix);
}

function normalizeDocument(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.version !== VERSION) {
    throw new Error("Invalid xz-pi-login account alias document");
  }
  if (!value.accounts || Object.getPrototypeOf(value.accounts) !== Object.prototype) {
    throw new Error("Invalid xz-pi-login account alias map");
  }

  const accounts = {};
  for (const [id, record] of Object.entries(value.accounts)) {
    if (!validRecord(id, record)) throw new Error("Invalid xz-pi-login account alias: " + id);
    accounts[id] = { base: record.base, suffix: record.suffix };
  }
  return { version: VERSION, accounts };
}

function ensureStorage(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) return;
  try {
    writeFileSync(path, JSON.stringify(emptyDocument(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export function loadAliasDocument(agentDir) {
  const path = aliasesPath(agentDir);
  if (!existsSync(path)) return emptyDocument();
  return normalizeDocument(JSON.parse(readFileSync(path, "utf8")));
}

export function loadAliases(agentDir) {
  return loadAliasDocument(agentDir).accounts;
}

export function normalizeSuffix(value) {
  const suffix = String(value ?? "").trim().toLowerCase();
  return SUFFIX.test(suffix) ? suffix : null;
}

export function createAliasId(base, suffix) {
  return `${base}-${suffix}`;
}

export async function mutateAliases(agentDir, transform) {
  const path = aliasesPath(agentDir);
  ensureStorage(path);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 5, minTimeout: 10, maxTimeout: 100 } });
  try {
    const current = loadAliasDocument(agentDir);
    const draft = structuredClone(current);
    const transformed = transform(draft) ?? draft;
    const next = normalizeDocument(transformed);
    if (JSON.stringify(current) !== JSON.stringify(next)) atomicStorage(path, next);
    return next.accounts;
  } finally {
    await release();
  }
}

export function addAlias(agentDir, base, suffix, assertAvailable) {
  const id = createAliasId(base, suffix);
  return mutateAliases(agentDir, document => {
    if (document.accounts[id]) throw new Error("alias_exists");
    assertAvailable?.(id);
    document.accounts[id] = { base, suffix };
    return document;
  });
}

export function removeAlias(agentDir, id) {
  return mutateAliases(agentDir, document => {
    delete document.accounts[id];
    return document;
  });
}

export function listAliases(agentDir) {
  return Object.entries(loadAliases(agentDir))
    .map(([id, record]) => ({ id, ...record }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
