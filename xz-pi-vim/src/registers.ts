import type { VimRegister } from "./types.js";

export const EMPTY_REGISTER: VimRegister = { text: "", kind: "character" };

export function normalizeRegister(text: string, kind: VimRegister["kind"]): VimRegister {
  return { text: kind === "line" ? text.replace(/\n*$/, "\n") : text, kind };
}
