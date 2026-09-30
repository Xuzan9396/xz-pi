import test from "node:test";
import assert from "node:assert/strict";
import {
  createSearchSessionState,
  findSessionPreference,
  SEARCH_SESSION_ENTRY,
} from "../search-session.ts";
import type { SearchPreference } from "../search-types.ts";

function custom(data: unknown) {
  return { type: "custom", customType: SEARCH_SESSION_ENTRY, data } as never;
}

test("restores the latest valid preference from the active session branch", () => {
  const branch = [
    custom({ mode: "fixed", provider: "github-copilot", model: "grok-4.7" }),
    custom({ mode: "future" }),
    custom({ mode: "auto" }),
  ];
  assert.deepEqual(findSessionPreference(branch), { mode: "auto" });
  assert.equal(findSessionPreference([custom({ mode: "future" })]), undefined);
});

test("new sessions load the global default while resume and fork restore branch state", async () => {
  const appended: Array<{ type: string; data: SearchPreference }> = [];
  let savedDefault: SearchPreference = { mode: "current-provider" };
  let branch: unknown[] = [];
  const state = createSearchSessionState(
    (type, data) => appended.push({ type, data }),
    async () => savedDefault,
  );
  const ctx = { sessionManager: { getBranch: () => branch } } as never;

  await state.restore(ctx, "new");
  assert.deepEqual(state.current, { mode: "current-provider" });

  state.set({ mode: "fixed", provider: "xai-oci", model: "xai.grok-4.7" });
  assert.deepEqual(state.current, { mode: "fixed", provider: "xai-oci", model: "xai.grok-4.7" });
  assert.deepEqual(appended.at(-1), {
    type: SEARCH_SESSION_ENTRY,
    data: { mode: "fixed", provider: "xai-oci", model: "xai.grok-4.7" },
  });

  branch = [custom(appended.at(-1)?.data)];
  savedDefault = { mode: "auto" };
  await state.restore(ctx, "resume");
  assert.equal(state.current.mode, "fixed");
  await state.restore(ctx, "fork");
  assert.equal(state.current.mode, "fixed");

  await state.restore(ctx, "new");
  assert.deepEqual(state.current, { mode: "auto" });
});

test("setting a preference clones caller-owned data before persisting", async () => {
  const appended: SearchPreference[] = [];
  const state = createSearchSessionState(
    (_type, data) => appended.push(data),
    async () => ({ mode: "current-provider" }),
  );
  const preference = { mode: "fixed", provider: "xai-oci", model: "xai.grok-4.7" } as SearchPreference;
  state.set(preference);
  if (preference.mode === "fixed") preference.provider = "mutated";
  assert.equal(state.current.mode === "fixed" && state.current.provider, "xai-oci");
  assert.equal(appended[0]?.mode === "fixed" && appended[0].provider, "xai-oci");
});
