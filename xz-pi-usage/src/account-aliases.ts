import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AccountAlias {
  base: string;
  suffix?: string;
}

export type AccountAliases = Record<string, AccountAlias>;

export function accountAliasesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "config", "xz-pi-login", "accounts.json");
}

export async function readAccountAliases(path = accountAliasesPath()): Promise<AccountAliases> {
  try {
    const document: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!document || typeof document !== "object" || Array.isArray(document)) return {};
    const accounts = (document as { accounts?: unknown }).accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return {};
    const aliases: AccountAliases = {};
    for (const [id, value] of Object.entries(accounts)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const base = typeof (value as { base?: unknown }).base === "string"
        ? (value as { base: string }).base.trim()
        : "";
      const suffix = typeof (value as { suffix?: unknown }).suffix === "string"
        ? (value as { suffix: string }).suffix.trim()
        : "";
      if (id && base) aliases[id] = { base, ...(suffix ? { suffix } : {}) };
    }
    return aliases;
  } catch {
    return {};
  }
}

export function baseProviderId(providerId: string, aliases: AccountAliases = {}): string {
  let current = providerId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    const base = aliases[current]?.base;
    if (!base) break;
    seen.add(current);
    current = base;
  }
  return current;
}
