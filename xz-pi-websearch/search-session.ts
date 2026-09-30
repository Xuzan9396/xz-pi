import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cloneSearchPreference,
  DEFAULT_SEARCH_PREFERENCE,
  parseSearchPreference,
  type SearchPreference,
} from "./search-types.ts";

export const SEARCH_SESSION_ENTRY = "xz-pi-websearch.search-preference";
type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

export function findSessionPreference(entries: readonly SessionEntry[]): SearchPreference | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SEARCH_SESSION_ENTRY) continue;
    const preference = parseSearchPreference(entry.data);
    if (preference) return preference;
  }
  return undefined;
}

export interface SearchSessionState {
  readonly current: SearchPreference;
  restore(ctx: Pick<ExtensionContext, "sessionManager">, reason?: "startup" | "reload" | "new" | "resume" | "fork"): Promise<SearchPreference>;
  set(preference: SearchPreference): void;
}

export function createSearchSessionState(
  appendEntry: (customType: string, data: SearchPreference) => void,
  readDefault: () => Promise<SearchPreference> = async () => cloneSearchPreference(DEFAULT_SEARCH_PREFERENCE),
): SearchSessionState {
  let current = cloneSearchPreference(DEFAULT_SEARCH_PREFERENCE);

  return {
    get current() {
      return cloneSearchPreference(current);
    },
    async restore(ctx, reason) {
      const fromBranch = reason === "new" ? undefined : findSessionPreference(ctx.sessionManager.getBranch());
      current = cloneSearchPreference(fromBranch ?? await readDefault());
      return cloneSearchPreference(current);
    },
    set(preference) {
      current = cloneSearchPreference(preference);
      appendEntry(SEARCH_SESSION_ENTRY, cloneSearchPreference(current));
    },
  };
}
